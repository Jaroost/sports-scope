import { ref, computed, type Ref } from 'vue'
import { estimateRouteLoad } from '../routeLoad'
import type { AthleteState } from '../routeLoad'
import type { Sport } from '../userPreferences'
import { speedForSport } from '../userPreferences'

// ─── Itinéraires prévus sur un jour ───────────────────────────────────────────
// La brique qui relie le coût d'un itinéraire (routeLoad.ts) à la cible de volume
// de la semaine (useTrainingPlan.ts) : accrocher un itinéraire à une date, et le
// voir apparaître en orange sur la barre de charge.
//
// L'état est partagé entre tous les appelants d'une page (planificateur de la page
// performance, liste des itinéraires) : un plan ajouté depuis la liste apparaît
// immédiatement dans la barre, sans re-fetch ni rechargement.
//
// Le TSS n'est pas servi par l'API mais recalculé ici depuis les dimensions de
// l'itinéraire, avec les seuils du moment (cf. le commentaire d'en-tête du modèle
// PlannedRide côté serveur).

export interface PlannedRouteSummary {
  id: number
  share_token: string
  name: string
  activity: Sport
  distance_m: number | null
  elevation_gain_m: number | null
  // Vitesse moyenne ajustée pour CE tracé, ou null quand l'itinéraire suit le réglage
  // du profil pour son sport (cf. Route#avg_speed_kmh / routeStore.avgSpeedOverride).
  avg_speed_kmh: number | null
}

export interface PlannedRide {
  id: number
  planned_on: string // ISO local (YYYY-MM-DD)
  position: number // ordre intra-jour choisi par l'utilisateur
  created_at: string // ISO8601 (horodatage complet) — date à laquelle le plan a été posé
  route: PlannedRouteSummary
}

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

const JSON_HEADERS = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-CSRF-Token': csrfToken(),
})

const plannedRides = ref<PlannedRide[]>([])
const loaded = ref(false)
let request: Promise<void> | null = null

async function fetchPlannedRides(): Promise<void> {
  try {
    const res = await fetch('/api/planned_rides', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    // Non connecté (401/302) ou erreur : pas de plan, et ce n'est pas bloquant —
    // la barre retombe simplement sur vert + gris, comme avant.
    if (!res.ok) return
    const payload = await res.json()
    plannedRides.value = Array.isArray(payload.planned_rides) ? payload.planned_rides : []
  } catch {
    /* ignore */
  } finally {
    loaded.value = true
  }
}

export function usePlannedRides() {
  request ??= fetchPlannedRides()

  // Ajoute un itinéraire sur un jour. Renvoie le plan créé, ou null en cas d'échec.
  // Le serveur renvoie l'existant (200) si le même itinéraire est déjà prévu ce
  // jour-là, d'où le remplacement par id plutôt qu'un push aveugle.
  async function addPlan(routeId: number, dateISO: string): Promise<PlannedRide | null> {
    try {
      const res = await fetch('/api/planned_rides', {
        method: 'POST',
        headers: JSON_HEADERS(),
        credentials: 'same-origin',
        body: JSON.stringify({ route_id: routeId, planned_on: dateISO }),
      })
      if (!res.ok) return null
      const plan = (await res.json()).planned_ride as PlannedRide
      const idx = plannedRides.value.findIndex((p) => p.id === plan.id)
      if (idx >= 0) plannedRides.value.splice(idx, 1, plan)
      else plannedRides.value.push(plan)
      return plan
    } catch {
      return null
    }
  }

  // Déplace un plan sur un autre jour. Le serveur répond 204 quand la cible fait
  // doublon (il a supprimé celui-ci) : on retire alors la ligne localement.
  async function movePlan(id: number, dateISO: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/planned_rides/${id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS(),
        credentials: 'same-origin',
        body: JSON.stringify({ planned_on: dateISO }),
      })
      if (!res.ok) return false
      if (res.status === 204) {
        plannedRides.value = plannedRides.value.filter((p) => p.id !== id)
        return true
      }
      const plan = (await res.json()).planned_ride as PlannedRide
      const idx = plannedRides.value.findIndex((p) => p.id === plan.id)
      if (idx >= 0) plannedRides.value.splice(idx, 1, plan)
      return true
    } catch {
      return false
    }
  }

  // Réordonne les plans d'un jour. `orderedIds` = ids dans le nouvel ordre. Mise à jour
  // optimiste des positions locales (l'affichage suit `position`), puis persistance.
  async function reorderPlans(orderedIds: number[]): Promise<boolean> {
    orderedIds.forEach((id, idx) => {
      const p = plannedRides.value.find((x) => x.id === id)
      if (p) p.position = idx
    })
    try {
      const res = await fetch('/api/planned_rides/reorder', {
        method: 'POST',
        headers: JSON_HEADERS(),
        credentials: 'same-origin',
        body: JSON.stringify({ ordered_ids: orderedIds }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async function removePlan(id: number): Promise<boolean> {
    try {
      const res = await fetch(`/api/planned_rides/${id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken() },
        credentials: 'same-origin',
      })
      if (!res.ok) return false
      plannedRides.value = plannedRides.value.filter((p) => p.id !== id)
      return true
    } catch {
      return false
    }
  }

  return { plannedRides, loaded, addPlan, movePlan, reorderPlans, removePlan }
}

// Vitesse ajustée pour ce tracé, ou null s'il suit le réglage du profil. Bornes
// identiques à speedForSport / Route::SPEED_RANGE : hors bornes, la valeur ne vient
// pas d'un réglage sensé, on retombe sur le profil.
export function planSpeedOverride(plan: PlannedRide): number | null {
  const v = plan.route.avg_speed_kmh
  return typeof v === 'number' && Number.isFinite(v) && v >= 3 && v <= 80 ? v : null
}

// Vitesse retenue pour estimer la durée (et donc le TSS) d'un plan : celle de
// l'itinéraire si le créateur l'a ajustée, sinon celle du profil pour son sport —
// même règle que la liste des itinéraires (RoutesList.speedFor).
export function planSpeedKmh(plan: PlannedRide): number {
  return planSpeedOverride(plan) ?? speedForSport(plan.route.activity)
}

// TSS estimé d'un plan, avec les seuils du moment. null si l'estimation est
// impossible (pas de charge chargée, itinéraire sans distance).
export function planTss(plan: PlannedRide, athlete: AthleteState | null): number | null {
  if (!athlete) return null
  const sport = plan.route.activity
  const load = estimateRouteLoad(
    {
      distanceM: plan.route.distance_m ?? 0,
      elevGainM: plan.route.elevation_gain_m ?? 0,
      speedKmh: planSpeedKmh(plan),
      sport,
    },
    athlete,
  )
  return load?.tss ?? null
}

// TSS planifié par jour (ISO → somme des TSS), sous la forme attendue par
// `useTrainingPlan`. Les plans dont le TSS n'est pas estimable sont ignorés :
// mieux vaut une barre qui sous-estime qu'une barre qui invente.
export function usePlannedLoads(athlete: Ref<AthleteState | null>) {
  const { plannedRides } = usePlannedRides()

  const plannedLoads = computed(() => {
    const out = new Map<string, number>()
    for (const plan of plannedRides.value) {
      const tss = planTss(plan, athlete.value)
      if (tss == null) continue
      out.set(plan.planned_on, (out.get(plan.planned_on) ?? 0) + tss)
    }
    return out
  })

  return { plannedLoads }
}
