import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import {
  useTrainingPlan, mondayOf, isoLocal, fmtDuration, fmtSigned, fmtSeconds, formZone, polarize,
  type LoadSummary, type Point, type Current, type ZoneChannel,
} from './useTrainingPlan'

// Tests du bilan hebdomadaire (`weekPlan` / `nextWeekPlan`) et des helpers purs de
// useTrainingPlan. Le composable ne fait aucun fetch : on lui passe la charge et les
// plans sous forme de Ref, ce qui rend tout ce fichier synchrone et sans DOM.
//
// Repère temporel figé : mercredi 15 juillet 2026 → lundi de la semaine = le 13,
// 2 jours écoulés (lun, mar), 5 restants (mer inclus).
const TODAY = new Date(2026, 6, 15, 12, 0, 0)
const MON = '2026-07-13'
const TUE = '2026-07-14'
const WED = '2026-07-15' // aujourd'hui
const THU = '2026-07-16'
const FRI = '2026-07-17'
const NEXT_MON = '2026-07-20'

// Série quotidienne sur 30 jours à CTL/ATL constants (TSB 0), pour que la cible de la
// semaine ne dépende que de la CTL de référence. Les jours cités dans `days` portent
// leur TSS et leur distance ; les autres sont des jours de repos.
function summary(days: Record<string, { tss: number; distanceM?: number }> = {}): LoadSummary {
  const series: Point[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(TODAY)
    d.setDate(d.getDate() - i)
    const iso = isoLocal(d)
    const day = days[iso]
    series.push({
      date: iso,
      tss: day?.tss ?? 0,
      ctl: 50, atl: 50, tsb: 0, acwr: 1,
      // `distance_m` est optionnel dans le payload : un jour sans distance vaut 0.
      ...(day?.distanceM === undefined ? {} : { distance_m: day.distanceM }),
    })
  }
  const last = series[series.length - 1]
  const current: Current = { ...last, form_zone: 'neutral', acwr_zone: 'optimal' }
  return {
    current,
    series,
    zones: null,
    coverage: { power: 0, hr: 0, estimated: 0, total: 0 },
    thresholds: {},
  }
}

function setup(
  days?: Record<string, { tss: number; distanceM?: number }>,
  loads?: Record<string, number>,
  distances?: Record<string, number>,
) {
  return useTrainingPlan(
    ref(summary(days)),
    loads ? ref(new Map(Object.entries(loads))) : undefined,
    distances ? ref(new Map(Object.entries(distances))) : undefined,
  )
}

describe('useTrainingPlan — bilan de la semaine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => { vi.useRealTimers() })

  it('ne rend rien sans série de charge', () => {
    const { weekPlan } = useTrainingPlan(ref(null))
    expect(weekPlan.value).toBeNull()
  })

  it('cumule le TSS et les km faits depuis lundi, aujourd’hui inclus', () => {
    const { weekPlan } = setup({
      '2026-07-12': { tss: 90, distanceM: 100_000 }, // dimanche précédent : hors semaine
      [MON]: { tss: 60, distanceM: 40_000 },
      [WED]: { tss: 40, distanceM: 25_000 },
    })

    expect(weekPlan.value!.done).toBe(100)
    expect(weekPlan.value!.doneKm).toBe(65)
    expect(weekPlan.value!.daysLeft).toBe(5)
  })

  it('arrondit les km au kilomètre et traite un jour sans distance comme 0', () => {
    const { weekPlan } = setup({
      [MON]: { tss: 30, distanceM: 12_400 },
      [TUE]: { tss: 30 }, // home-trainer : pas de distance dans le payload
      [WED]: { tss: 30, distanceM: 12_400 },
    })

    // 24 800 m → 24,8 km → 25
    expect(weekPlan.value!.doneKm).toBe(25)
  })

  it('compte en prévu les jours à venir et ignore les plans des jours passés', () => {
    const { weekPlan } = setup(
      { [MON]: { tss: 60, distanceM: 40_000 } },
      { [MON]: 100, [FRI]: 80 },
      { [MON]: 90_000, [FRI]: 60_000 },
    )

    // Le plan du lundi n'a pas été tenu : il ne promet plus rien.
    expect(weekPlan.value!.planned).toBe(80)
    expect(weekPlan.value!.plannedKm).toBe(60)
  })

  it('ne compte aujourd’hui que ce que le plan ajoute par-dessus le réel', () => {
    const { weekPlan } = setup(
      { [WED]: { tss: 40, distanceM: 25_000 } },
      { [WED]: 50 },
      { [WED]: 30_000 },
    )

    // La sortie du jour est déjà en vert : seuls les 10 TSS / 5 km restants sont en orange.
    expect(weekPlan.value!.done).toBe(40)
    expect(weekPlan.value!.doneKm).toBe(25)
    expect(weekPlan.value!.planned).toBe(10)
    expect(weekPlan.value!.plannedKm).toBe(5)
  })

  it('ne descend jamais sous zéro quand la sortie du jour dépasse le plan', () => {
    const { weekPlan } = setup(
      { [WED]: { tss: 90, distanceM: 80_000 } },
      { [WED]: 50 },
      { [WED]: 30_000 },
    )

    expect(weekPlan.value!.planned).toBe(0)
    expect(weekPlan.value!.plannedKm).toBe(0)
  })

  it('compte les km d’un plan même quand son TSS n’est pas estimable', () => {
    // `plannedLoads` ignore les plans sans TSS estimable, pas `plannedDistances` :
    // la distance d'un itinéraire est toujours connue, elle.
    const { weekPlan } = setup({}, {}, { [FRI]: 60_000 })

    expect(weekPlan.value!.planned).toBe(0)
    expect(weekPlan.value!.plannedKm).toBe(60)
  })

  it('retombe sur 0 km prévu quand l’appelant ne fournit pas les distances', () => {
    const { weekPlan } = setup({ [MON]: { tss: 60, distanceM: 40_000 } }, { [FRI]: 80 })

    expect(weekPlan.value!.planned).toBe(80)
    expect(weekPlan.value!.plannedKm).toBe(0)
    expect(weekPlan.value!.doneKm).toBe(40)
  })

  it('compte comme « à placer » les jours restants sans plan', () => {
    const { weekPlan } = setup({}, { [WED]: 50, [FRI]: 80 })

    // Restants : mer, jeu, ven, sam, dim — mer et ven sont pris.
    expect(weekPlan.value!.daysToPlace).toBe(3)
  })

  it('déduit le prévu du reste à placer', () => {
    const { weekPlan } = setup({ [MON]: { tss: 60 } }, { [FRI]: 80 })
    const wp = weekPlan.value!

    expect(wp.target).toBeGreaterThan(0)
    expect(wp.remaining).toBe(Math.max(0, wp.target - wp.done - wp.planned))
  })

  it('cale la barre sur la cible, puis sur le total dès qu’on planifie au-delà', () => {
    const under = setup({ [MON]: { tss: 60 } }, { [FRI]: 80 }).weekPlan.value!
    expect(under.overPlanned).toBe(false)
    expect(under.targetPct).toBe(100)

    const over = setup({ [MON]: { tss: 900 } }, { [FRI]: 900 }).weekPlan.value!
    expect(over.overPlanned).toBe(true)
    expect(over.targetPct).toBeLessThan(100)
    expect(over.donePct + over.plannedPct).toBeGreaterThan(90)
  })
})

describe('useTrainingPlan — rythme de la semaine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => { vi.useRealTimers() })

  it('juge « en retard » une semaine encore vide en milieu de semaine', () => {
    expect(setup().weekPlan.value!.pace).toBe('behind')
  })

  it('juge « en avance » quand le réel dépasse largement le prorata', () => {
    expect(setup({ [MON]: { tss: 2000 } }).weekPlan.value!.pace).toBe('ahead')
  })

  it('ne juge rien le lundi : aucun jour pleinement écoulé', () => {
    vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0)) // lundi
    const wp = setup().weekPlan.value!

    expect(wp.pace).toBe('on_track')
    expect(wp.daysLeft).toBe(7)
  })
})

describe('useTrainingPlan — semaine suivante', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => { vi.useRealTimers() })

  it('ne porte aucun réalisé et cumule les plans de sa propre semaine', () => {
    const { nextWeekPlan } = setup(
      { [MON]: { tss: 60, distanceM: 40_000 } },
      { [FRI]: 80, [NEXT_MON]: 120 },
      { [FRI]: 60_000, [NEXT_MON]: 95_000 },
    )
    const wp = nextWeekPlan.value!

    expect(wp.done).toBe(0)
    expect(wp.doneKm).toBe(0)
    expect(wp.planned).toBe(120)
    expect(wp.plannedKm).toBe(95)
    expect(wp.daysLeft).toBe(7)
    expect(wp.daysToPlace).toBe(6)
  })
})

// Le budget poussé à l'app compagnon (cf. pushTrainingBudget). Il n'a pas de calcul à
// lui : tout l'enjeu est qu'il dise EXACTEMENT ce que la page affiche, sans quoi le
// cycliste lirait un plafond au guidon et un autre sur le site.
//
// Repères de la série de test : CTL = ATL = 50, TSB = 0, objectif par défaut
// (« progresser doucement », plancher −20). Il en découle une cible hebdo de 478 TSS
// (7 × 50 + 3 / K_CTL) et un plafond de fatigue de 232 TSS.
describe('useTrainingPlan — budget de l’app compagnon', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => { vi.useRealTimers() })

  // Charge dont on force l'état du jour (fatigue, risque), la série restant identique.
  function withCurrent(over: Partial<Current>, days?: Record<string, { tss: number }>) {
    const base = summary(days)
    return useTrainingPlan(ref({ ...base, current: { ...base.current, ...over } }))
  }

  it('ne rend rien sans charge', () => {
    const { budget } = useTrainingPlan(ref(null))
    expect(budget.value).toBeNull()
  })

  it('date le budget du jour et compte ce qui est déjà enregistré', () => {
    const { budget } = setup({ [MON]: { tss: 60 }, [WED]: { tss: 45 } })

    expect(budget.value!.date).toBe(WED)
    expect(budget.value!.day.done).toBe(45)
  })

  it('reprend la cible de la reco du jour et plafonne à ce que la fatigue autorise', () => {
    const { budget, recommendation } = setup()

    // 478 de cible hebdo répartis sur les 5 jours restants → ~96 TSS aujourd'hui.
    expect(budget.value!.day.target).toBe(96)
    expect(budget.value!.day.target).toBe(recommendation.value!.tss)
    expect(budget.value!.day.max).toBe(232)
  })

  it('ne propose plus rien quand la fatigue a mangé le plafond', () => {
    const { budget } = withCurrent({ tsb: -35, atl: 85 })

    expect(budget.value!.day.target).toBe(0)
    // Le plafond calculé est négatif (on est DÉJÀ sous le plancher) : il se lit zéro,
    // pas « moins quarante-quatre ».
    expect(budget.value!.day.max).toBe(0)
  })

  it('ne laisse jamais la cible dépasser le plafond', () => {
    // Fraîcheur négative sans être à l'arrêt : le plafond descend sous la part
    // quotidienne de la cible, et c'est lui qui doit gagner.
    const { budget } = withCurrent({ tsb: -18, atl: 68 })
    const { day } = budget.value!

    expect(day.max).toBeLessThan(96)
    expect(day.target).toBeLessThanOrEqual(day.max)
  })

  it('recopie la semaine du planificateur, sans la recalculer', () => {
    const { budget, weekPlan } = setup({ [MON]: { tss: 60 } }, { [FRI]: 80 })

    expect(budget.value!.week).toEqual({
      target: weekPlan.value!.target,
      done: weekPlan.value!.done,
      planned: weekPlan.value!.planned,
      remaining: weekPlan.value!.remaining,
    })
  })

  it('porte la fatigue et le risque tels que le serveur les a classés', () => {
    const { budget } = withCurrent({ tsb: -12, ctl: 62, atl: 74, acwr: 1.18, form_zone: 'productive', acwr_zone: 'optimal' })

    expect(budget.value!.form).toEqual({ ctl: 62, atl: 74, tsb: -12, zone: 'productive' })
    expect(budget.value!.risk).toEqual({ acwr: 1.18, zone: 'optimal' })
  })

  it('laisse passer un risque inconnu plutôt que d’inventer une zone', () => {
    // ACWR nul avant 28 jours d'historique : l'appli affichera un tiret.
    const { budget } = withCurrent({ acwr: null, acwr_zone: null })

    expect(budget.value!.risk).toEqual({ acwr: null, zone: null })
  })
})

describe('useTrainingPlan — helpers purs', () => {
  it('mondayOf ramène au lundi, y compris depuis un dimanche', () => {
    expect(isoLocal(mondayOf(new Date(2026, 6, 15)))).toBe(MON) // mercredi
    expect(isoLocal(mondayOf(new Date(2026, 6, 13)))).toBe(MON) // lundi lui-même
    expect(isoLocal(mondayOf(new Date(2026, 6, 19)))).toBe(MON) // dimanche
  })

  it('isoLocal reste sur le jour local, sans détour par UTC', () => {
    expect(isoLocal(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(isoLocal(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })

  it('fmtDuration écrit les heures et les minutes', () => {
    expect(fmtDuration(45)).toBe('45 min')
    expect(fmtDuration(120)).toBe('2h')
    expect(fmtDuration(150)).toBe('2h30')
    expect(fmtDuration(125)).toBe('2h05')
  })

  it('fmtSeconds arrondit à la minute', () => {
    expect(fmtSeconds(2700)).toBe('45 min')
    expect(fmtSeconds(7200)).toBe('2 h')
    expect(fmtSeconds(9000)).toBe('2 h 30')
  })

  it('fmtSigned préfixe le positif', () => {
    expect(fmtSigned(3.4)).toBe('+3')
    expect(fmtSigned(-3.4)).toBe('-3')
    expect(fmtSigned(0)).toBe('0')
  })

  it('formZone reprend les seuils du serveur', () => {
    expect(formZone(25)).toBe('very_fresh')
    expect(formZone(5)).toBe('fresh')
    expect(formZone(0)).toBe('neutral')
    expect(formZone(-15)).toBe('productive')
    expect(formZone(-31)).toBe('overreaching')
  })

  it('polarize classe z1+z2 en facile, z3 en gris, z4+ en intense', () => {
    const channel: ZoneChannel = {
      total_seconds: 100,
      zones: [
        { zone: 'z1', seconds: 50, pct: 50 },
        { zone: 'z2', seconds: 30, pct: 30 },
        { zone: 'z3', seconds: 10, pct: 10 },
        { zone: 'z4', seconds: 10, pct: 10 },
      ],
    }
    const p = polarize(channel)

    expect(p).toMatchObject({ easy: 80, moderate: 10, hard: 10, verdict: 'well_polarized' })
  })

  it('polarize alerte sur un excès d’intensité et sur la zone grise', () => {
    const chan = (zones: Array<[string, number]>): ZoneChannel => ({
      total_seconds: 100,
      zones: zones.map(([zone, pct]) => ({ zone, seconds: pct, pct })),
    })

    expect(polarize(chan([['z1', 40], ['z4', 60]])).verdict).toBe('too_much_intensity')
    expect(polarize(chan([['z1', 70], ['z3', 25], ['z4', 5]])).verdict).toBe('too_much_grey')
    expect(polarize(chan([['z1', 98], ['z4', 2]])).verdict).toBe('too_easy')
  })
})
