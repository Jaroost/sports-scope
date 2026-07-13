import { ref, computed, watch, type Ref } from 'vue'

// ─── Plan d'entraînement : « sortie objectif » + « que faire aujourd'hui » ─────
// Logique partagée entre le panneau complet de la page performance
// (TrainingLoadPanel.vue) et le widget compact de la page d'accueil
// (TodayPlanWidget.vue). On y centralise :
//   • l'objectif générique (localStorage) → plancher de fatigue (TSB) toléré,
//   • la sortie objectif datée (localStorage) → phase de prépa + faisabilité +
//     projection de fraîcheur le jour J,
//   • la recommandation du jour qui en découle (repos / facile / grosse séance).
// Le composant appelant fournit la charge (`/api/performance/training_load`) sous
// forme de Ref ; ce composable ne fait aucun fetch et ne s'occupe pas du rendu.

// ── Types du payload /api/performance/training_load ──────────────────────────
export interface DayActivity { source: string; external_id: string; name: string; tss: number; source_tss: string }
export interface Point { date: string; tss: number; ctl: number; atl: number; tsb: number; acwr: number | null; activities?: DayActivity[] }
export interface Current extends Point { form_zone: string; acwr_zone: string | null }
export interface Coverage { power: number; hr: number; estimated: number; total: number }
export interface Thresholds { ftp_current?: number | null; lthr?: number | null; lthr_source?: string | null; lthr_auto?: number | null; typical_speed_kmh?: number | null; longest_ride_min?: number | null }
// Répartition du temps par zone d'intensité (cf. ZoneDistribution côté serveur).
export interface ZoneBucket { zone: string; seconds: number; pct: number }
export interface ZoneChannel { total_seconds: number; zones: ZoneBucket[] }
export interface ZoneSummary { window_days: number; hr: ZoneChannel | null; power: ZoneChannel | null }
export interface LoadSummary {
  current: Current | null
  series: Point[]
  zones: ZoneSummary | null
  coverage: Coverage
  thresholds: Thresholds
}

// ── Zones de fraîcheur (TSB) ─────────────────────────────────────────────────
const ZONES: Record<string, { color: string }> = {
  very_fresh: { color: '#0d6efd' },
  fresh: { color: '#198754' },
  neutral: { color: '#6c757d' },
  productive: { color: '#fd7e14' },
  overreaching: { color: '#dc3545' },
}

export function zoneColor(key: string): string {
  return ZONES[key]?.color ?? '#6c757d'
}

// Zone de fraîcheur d'un TSB (mêmes seuils que TrainingLoad#form_zone côté serveur).
export function formZone(tsb: number): string {
  if (tsb >= 20) return 'very_fresh'
  if (tsb >= 5) return 'fresh'
  if (tsb >= -10) return 'neutral'
  if (tsb >= -30) return 'productive'
  return 'overreaching'
}

// ── Ratio charge aiguë/chronique (ACWR) ──────────────────────────────────────
const ACWR_ZONES: Record<string, string> = {
  detraining: '#0d6efd', optimal: '#198754', caution: '#fd7e14', high_risk: '#dc3545',
}
export function acwrColor(zone: string | null): string {
  return (zone && ACWR_ZONES[zone]) || '#6c757d'
}

// ── Zones d'intensité (FC / puissance) : palette froid → chaud, z1..z7 ────────
const INTENSITY_ZONE_COLORS: Record<string, string> = {
  z1: '#0d6efd', z2: '#20c997', z3: '#ffc107', z4: '#fd7e14', z5: '#dc3545', z6: '#b02a37', z7: '#7a1f2b',
}
export function intensityZoneColor(zone: string): string {
  return INTENSITY_ZONE_COLORS[zone] ?? '#6c757d'
}

// Durée lisible depuis des secondes (ex. « 12 h 30 », « 45 min »).
export function fmtSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h} h ${String(m).padStart(2, '0')}`
  if (h) return `${h} h`
  return `${m} min`
}

// ── Objectif générique → plancher de fatigue (TSB) ───────────────────────────
export const GOALS = ['improve_fast', 'improve_slow', 'maintain', 'peak'] as const
export type Goal = typeof GOALS[number]
const GOAL_FLOOR: Record<Goal, number> = { improve_fast: -30, improve_slow: -20, maintain: -8, peak: 5 }
const GOAL_STORAGE_KEY = 'sportsScope.trainingGoal'

// Style (icône + couleur) de chaque action recommandée.
export const ACTION_STYLE: Record<string, { icon: string; color: string }> = {
  rest: { icon: 'fa-bed', color: '#6c757d' },
  easy: { icon: 'fa-person-biking', color: '#198754' },
  big: { icon: 'fa-fire', color: '#dc3545' },
  event: { icon: 'fa-flag-checkered', color: '#0d6efd' },
}

// ── Sortie objectif datée ────────────────────────────────────────────────────
export interface TargetEvent { date: string; distanceKm: number; intensity: 'easy' | 'tempo' | 'race' }
const EVENT_STORAGE_KEY = 'sportsScope.targetEvent'
const EVENT_INTENSITY: Record<string, { if: number; sf: number }> = {
  easy: { if: 0.65, sf: 1.0 }, tempo: { if: 0.80, sf: 1.12 }, race: { if: 0.88, sf: 1.22 },
}
export const PHASE_COLOR: Record<string, string> = { build: '#0d6efd', taper: '#fd7e14', final: '#dc3545', event_day: '#198754', past: '#6c757d' }
export const FEAS_COLOR: Record<string, string> = { ok: '#198754', demanding: '#fd7e14', hard: '#dc3545' }

export type Reco = { action: string; tss: number; minutes: number; effort: string; distanceKm: number | null; reason: string; tsb: number; days?: number }

// ── Formatage ────────────────────────────────────────────────────────────────
export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return `${h}h${String(m).padStart(2, '0')}`
  if (h) return `${h}h`
  return `${m} min`
}

export function fmtSigned(v: number): string {
  return v > 0 ? `+${Math.round(v)}` : String(Math.round(v))
}

export function eventDateFmt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' })
}

export function useTrainingPlan(data: Ref<LoadSummary | null>) {
  const current = computed<Current | null>(() => data.value?.current ?? null)

  // ── Objectif générique (persisté) ──────────────────────────────────────────
  const storedGoal = (typeof localStorage !== 'undefined' && localStorage.getItem(GOAL_STORAGE_KEY)) as Goal | null
  const goal = ref<Goal>(storedGoal && GOALS.includes(storedGoal) ? storedGoal : 'improve_slow')
  watch(goal, (g) => { try { localStorage.setItem(GOAL_STORAGE_KEY, g) } catch { /* ignore */ } })

  // Convertit un TSS en durée approx. (min, arrondie au 1/4 h) pour une intensité donnée :
  // TSS = heures × IF² × 100 ⟹ heures = TSS / (IF² × 100). Rend la reco parlante.
  function tssToMinutes(tss: number, intensity: number): number {
    const minutes = (tss / (intensity * intensity * 100)) * 60
    return Math.max(15, Math.round(minutes / 15) * 15)
  }

  // Durée + distance approximatives d'un TSS à une intensité ('endurance' | 'hard').
  function planFromTss(tss: number, kind: 'endurance' | 'hard') {
    const ifv = kind === 'hard' ? 0.80 : 0.65
    const minutes = tssToMinutes(tss, ifv)
    const speed = data.value?.thresholds?.typical_speed_kmh ?? null
    const distanceKm = speed ? Math.round((speed * minutes) / 60) : null
    return { minutes, effort: kind, distanceKm }
  }

  function restReco(reason: string, tsb: number, days?: number): Reco {
    return { action: 'rest', tss: 0, minutes: 0, effort: '', distanceKm: null, reason, tsb: Math.round(tsb), days }
  }

  // Reco basée sur l'objectif générique (sans événement daté). `floor` = plancher de
  // fatigue (TSB) acceptable ; plus il est bas, plus on tolère de charge.
  function fatigueReco(c: Current, floor: number, reasons: { rest: string; easy: string; big: string }, days?: number): Reco {
    const headroom = c.tsb - floor
    if (c.tsb <= -30 || headroom < 0) return restReco(c.tsb <= -30 ? 'reason_overreaching' : reasons.rest, c.tsb, days)
    if (headroom < 12) { const tss = Math.round(0.6 * c.ctl); return { action: 'easy', tss, ...planFromTss(tss, 'endurance'), reason: reasons.easy, tsb: Math.round(c.tsb), days } }
    const tss = Math.round(1.4 * c.ctl); return { action: 'big', tss, ...planFromTss(tss, 'hard'), reason: reasons.big, tsb: Math.round(c.tsb), days }
  }

  // ── Sortie objectif datée (persistée) ──────────────────────────────────────
  function loadStoredEvent(): TargetEvent | null {
    try {
      const raw = localStorage.getItem(EVENT_STORAGE_KEY)
      if (raw) { const e = JSON.parse(raw); if (e?.date && e?.intensity) return e as TargetEvent }
    } catch { /* ignore */ }
    return null
  }
  const targetEvent = ref<TargetEvent | null>(loadStoredEvent())
  watch(targetEvent, (e) => {
    try { e ? localStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify(e)) : localStorage.removeItem(EVENT_STORAGE_KEY) } catch { /* ignore */ }
  }, { deep: true })

  // Éditeur d'événement
  const editingEvent = ref(false)
  const evDate = ref('')
  const evDistance = ref<string | number>('')
  const evIntensity = ref<'easy' | 'tempo' | 'race'>('tempo')
  const todayISO = new Date().toISOString().slice(0, 10)

  function openEventEditor() {
    const ev = targetEvent.value
    evDate.value = ev?.date ?? ''
    evDistance.value = ev?.distanceKm ?? ''
    evIntensity.value = ev?.intensity ?? 'tempo'
    editingEvent.value = true
  }
  function saveEvent() {
    const dist = Number(evDistance.value)
    if (!evDate.value || !dist) return
    targetEvent.value = { date: evDate.value, distanceKm: Math.round(dist), intensity: evIntensity.value }
    editingEvent.value = false
  }
  function removeEvent() { targetEvent.value = null; editingEvent.value = false }

  function daysUntil(dateStr: string): number {
    const [y, m, d] = dateStr.split('-').map(Number)
    if (!y || !m || !d) return NaN
    const now = new Date()
    const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return Math.round((new Date(y, m - 1, d).getTime() - t0.getTime()) / 86400000)
  }

  // Schéma d'affûtage : TSS planifié à `remaining` jours de l'objectif.
  function plannedTss(remaining: number, ctl0: number): number {
    if (remaining <= 0) return 0
    if (remaining <= 3) return 0.25 * ctl0
    if (remaining <= 14) return ctl0 * (0.3 + (0.5 * (remaining - 3)) / 11)
    return ctl0
  }

  const eventInfo = computed(() => {
    const ev = targetEvent.value
    const c = current.value
    if (!ev || !c) return null
    const days = daysUntil(ev.date)
    if (Number.isNaN(days)) return null
    const cfg = EVENT_INTENSITY[ev.intensity] ?? EVENT_INTENSITY.tempo
    const speed = (data.value?.thresholds?.typical_speed_kmh ?? 22) * cfg.sf
    const durationMin = ev.distanceKm ? Math.round((ev.distanceKm / speed) * 60) : 0
    const tss = durationMin ? Math.round((durationMin / 60) * cfg.if ** 2 * 100) : 0
    const phase = days < 0 ? 'past' : days === 0 ? 'event_day' : days <= 3 ? 'final' : days <= 14 ? 'taper' : 'build'
    return { days, durationMin, tss, phase, intensity: ev.intensity, distanceKm: ev.distanceKm, date: ev.date }
  })

  const feasibility = computed(() => {
    const ev = eventInfo.value; const c = current.value
    if (!ev || !c || !ev.tss) return null
    const ratio = ev.tss / Math.max(c.ctl, 1)
    const longest = data.value?.thresholds?.longest_ride_min ?? null
    const durRatio = longest ? ev.durationMin / longest : null
    const levels = ['ok', 'demanding', 'hard'] as const
    let idx: number
    if (ratio <= 1.5 && (durRatio === null || durRatio <= 1.2)) idx = 0
    else if (ratio <= 2.5 && (durRatio === null || durRatio <= 1.7)) idx = 1
    else idx = 2
    // Durabilité prouvée : si tu as déjà tenu récemment une sortie de durée comparable
    // (ou plus longue), on abaisse le verdict d'un cran. L'expérience réelle prime sur
    // le simple ratio TSS/CTL, qui pénalise les profils « longues sorties peu fréquentes »
    // (CTL basse mais endurance démontrée — typiquement le mode touriste).
    if (durRatio !== null && durRatio <= 1.1 && idx > 0) idx -= 1
    return { level: levels[idx], ratio: Math.round(ratio * 10) / 10 }
  })

  // Projection de la fraîcheur (TSB) le jour J, en simulant l'affûtage recommandé.
  const projection = computed(() => {
    const ev = eventInfo.value; const c = current.value
    if (!ev || !c || ev.days <= 0) return null
    const kc = 1 - Math.exp(-1 / 42), ka = 1 - Math.exp(-1 / 7)
    let ctl = c.ctl, atl = c.atl
    for (let i = 1; i <= ev.days; i++) {
      const tss = plannedTss(ev.days - i, c.ctl)
      ctl += (tss - ctl) * kc
      atl += (tss - atl) * ka
    }
    const tsb = Math.round(ctl - atl)
    return { tsb, verdict: tsb >= 5 ? 'ready' : tsb >= -5 ? 'ok' : 'tired' }
  })

  // Reco datée : pilotée par la phase de préparation.
  function eventRecommendation(c: Current, ev: NonNullable<typeof eventInfo.value>): Reco {
    if (ev.phase === 'event_day') return { action: 'event', tss: 0, minutes: 0, effort: '', distanceKm: null, reason: 'reason_event_day', tsb: Math.round(c.tsb), days: 0 }
    if (ev.phase === 'build') return fatigueReco(c, -25, { rest: 'reason_build_rest', easy: 'reason_build', big: 'reason_build' }, ev.days)
    // taper / final : on suit le schéma d'affûtage
    const tssVal = Math.round(plannedTss(ev.days, c.ctl))
    const reason = ev.phase === 'final' ? 'reason_final' : 'reason_taper'
    if (tssVal < 20) return restReco(reason, c.tsb, ev.days)
    return { action: 'easy', tss: tssVal, ...planFromTss(tssVal, 'endurance'), reason, tsb: Math.round(c.tsb), days: ev.days }
  }

  const recommendation = computed<Reco | null>(() => {
    const c = current.value
    if (!c) return null
    const ev = eventInfo.value
    if (ev && ev.phase !== 'past') return eventRecommendation(c, ev)
    return fatigueReco(c, GOAL_FLOOR[goal.value], { rest: 'reason_rest', easy: 'reason_easy', big: 'reason_big' })
  })

  return {
    current,
    // objectif générique
    goal,
    // sortie objectif
    targetEvent, eventInfo, feasibility, projection,
    // éditeur
    editingEvent, evDate, evDistance, evIntensity, todayISO,
    openEventEditor, saveEvent, removeEvent,
    // recommandation
    recommendation,
  }
}
