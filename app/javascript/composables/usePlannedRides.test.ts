import { describe, it, expect, beforeAll, vi } from 'vitest'
import { ref } from 'vue'
import type { AthleteState } from '../routeLoad'

// Tests de la couche « itinéraires prévus » : la vitesse retenue pour chiffrer un plan,
// son TSS estimé, et les deux agrégats par jour consommés par useTrainingPlan
// (TSS prévu et distance prévue).
//
// L'état de usePlannedRides est un singleton de module alimenté par un seul fetch : on
// stubbe donc `fetch` AVANT le premier import, et toute la suite travaille sur ce même
// jeu de plans.

const MON = '2026-07-13'
const FRI = '2026-07-17'

type RouteSummary = {
  id: number
  share_token: string
  name: string
  activity: 'cycling' | 'mtb' | 'hiking'
  distance_m: number | null
  elevation_gain_m: number | null
  avg_speed_kmh: number | null
}

function route(id: number, over: Partial<RouteSummary> = {}): RouteSummary {
  return {
    id,
    share_token: `tok-${id}`,
    name: `route ${id}`,
    activity: 'cycling',
    distance_m: 50_000,
    elevation_gain_m: 500,
    avg_speed_kmh: null,
    ...over,
  }
}

const PLANS = [
  { id: 1, planned_on: MON, position: 0, created_at: '2026-07-10T08:00:00Z', route: route(1, { distance_m: 40_000 }) },
  { id: 2, planned_on: FRI, position: 0, created_at: '2026-07-10T08:00:00Z', route: route(2, { distance_m: 60_000 }) },
  { id: 3, planned_on: FRI, position: 1, created_at: '2026-07-10T08:00:00Z', route: route(3, { distance_m: 25_000 }) },
  // Itinéraire sans distance : ni TSS ni km estimables, il ne doit peser sur rien.
  { id: 4, planned_on: FRI, position: 2, created_at: '2026-07-10T08:00:00Z', route: route(4, { distance_m: null }) },
]

const ATHLETE: AthleteState = { ftp: 250, weightKg: 70, ctl: 50, atl: 50 }

let mod: typeof import('./usePlannedRides')

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ planned_rides: PLANS }),
  })))
  mod = await import('./usePlannedRides')
  const { loaded } = mod.usePlannedRides()
  await vi.waitFor(() => expect(loaded.value).toBe(true))
})

describe('planSpeedOverride / planSpeedKmh', () => {
  it('retient la vitesse de l’itinéraire quand elle est dans les bornes', () => {
    const plan = { ...PLANS[0], route: route(1, { avg_speed_kmh: 22 }) }

    expect(mod.planSpeedOverride(plan)).toBe(22)
    expect(mod.planSpeedKmh(plan)).toBe(22)
  })

  it('ignore une vitesse hors bornes ou absente et retombe sur le profil', () => {
    for (const v of [null, 0, 2, 90, Number.NaN]) {
      const plan = { ...PLANS[0], route: route(1, { avg_speed_kmh: v }) }
      expect(mod.planSpeedOverride(plan)).toBeNull()
      // La vitesse du profil pour le sport : hors page, la valeur par défaut.
      expect(mod.planSpeedKmh(plan)).toBeGreaterThan(0)
    }
  })
})

describe('planTss', () => {
  it('rend null sans seuils athlète ou sans distance', () => {
    expect(mod.planTss(PLANS[1], null)).toBeNull()
    expect(mod.planTss(PLANS[3], ATHLETE)).toBeNull()
  })

  it('chiffre un plan et croît avec la distance', () => {
    const short = mod.planTss(PLANS[0], ATHLETE)! // 40 km
    const long = mod.planTss(PLANS[1], ATHLETE)! // 60 km

    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
  })
})

describe('usePlannedLoads', () => {
  it('cumule le TSS par jour et ignore les plans non estimables', () => {
    const { plannedLoads } = mod.usePlannedLoads(ref(ATHLETE))
    const friday = plannedLoads.value.get(FRI)!

    expect(plannedLoads.value.get(MON)).toBeCloseTo(mod.planTss(PLANS[0], ATHLETE)!, 5)
    // Vendredi porte trois plans, dont un sans distance : seuls les deux autres comptent.
    expect(friday).toBeCloseTo(mod.planTss(PLANS[1], ATHLETE)! + mod.planTss(PLANS[2], ATHLETE)!, 5)
  })

  it('n’estime aucun TSS sans seuils athlète', () => {
    const { plannedLoads } = mod.usePlannedLoads(ref(null))

    expect(plannedLoads.value.size).toBe(0)
  })

  it('cumule les distances par jour, sans dépendre des seuils athlète', () => {
    const { plannedDistances } = mod.usePlannedLoads(ref(null))

    expect(plannedDistances.value.get(MON)).toBe(40_000)
    expect(plannedDistances.value.get(FRI)).toBe(85_000) // 60 000 + 25 000, le plan sans distance exclu
  })
})
