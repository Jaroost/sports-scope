import { ref, computed, watch, type Ref } from 'vue'
import type { AthleteState } from '../routeLoad'
import {
  userPreferences,
  persistTrainingPlan,
  TRAINING_GOALS,
  type TrainingGoal,
} from '../userPreferences'

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
export interface DayActivity { source: string; external_id: string; name: string; tss: number; source_tss: string; started_at?: string | null; activity_type?: string | null; distance_m?: number }
// `distance_m` : somme des distances des activités du jour (0 les jours de repos).
export interface Point { date: string; tss: number; ctl: number; atl: number; tsb: number; acwr: number | null; activities?: DayActivity[]; distance_m?: number }
export interface Current extends Point { form_zone: string; acwr_zone: string | null }
export interface Coverage { power: number; hr: number; estimated: number; total: number }
// `lthr_method` : comment l'estimation a été obtenue — `lthr_20min` / `lthr_60min`
// (un effort mesuré sur la courbe cardio d'une sortie) ou `hr_max_proxy` (le repli
// grossier, sans aucune sortie vélo détaillée). `lthr_stale` : l'estimation a dû
// sortir de la fenêtre glissante de 6 semaines.
export interface Thresholds { ftp_current?: number | null; weight_kg?: number | null; lthr?: number | null; lthr_source?: string | null; lthr_auto?: number | null; lthr_method?: string | null; lthr_stale?: boolean | null; typical_speed_kmh?: number | null; longest_ride_min?: number | null }
// Répartition du temps par zone d'intensité (cf. ZoneDistribution côté serveur).
// `lo`/`hi` : bornes de la zone en valeur absolue (bpm / W) d'après le seuil courant —
// nil quand la zone est ouverte de ce côté (première / dernière) ou sans seuil.
export interface ZoneBucket { zone: string; seconds: number; pct: number; lo?: number | null; hi?: number | null }
export interface ZoneChannel { total_seconds: number; zones: ZoneBucket[] }
export interface ZoneSummary { window_days: number; hr: ZoneChannel | null; power: ZoneChannel | null }
export interface LoadSummary {
  current: Current | null
  series: Point[]
  zones: ZoneSummary | null
  coverage: Coverage
  thresholds: Thresholds
}

// Seuils + forme du jour extraits d'une charge DÉJÀ chargée, de quoi estimer le TSS
// d'un itinéraire (cf. routeLoad.ts). Même forme que `useAthleteState`, mais sans
// requête : les composants qui ont déjà le payload complet n'ont pas à le redemander.
export function athleteFromSummary(data: LoadSummary | null): AthleteState | null {
  if (!data) return null
  return {
    ftp: data.thresholds?.ftp_current ?? null,
    weightKg: data.thresholds?.weight_kg ?? null,
    ctl: data.current?.ctl ?? null,
    atl: data.current?.atl ?? null,
  }
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

// Plage d'une zone en valeur absolue, pour le survol : « < 138 bpm », « 138–153 bpm »,
// « ≥ 170 W ». Chaîne vide sans seuil (le serveur n'a alors envoyé aucune borne).
export function zoneRange(z: ZoneBucket, unit: string): string {
  if (z.lo == null && z.hi == null) return ''
  if (z.lo == null) return `< ${z.hi} ${unit}`
  if (z.hi == null) return `≥ ${z.lo} ${unit}`
  return `${z.lo}–${z.hi} ${unit}`
}

// ── Polarisation d'un canal de zones (facile / modéré / intense) + verdict ────
// Facile = base aérobie (z1+z2), Modéré = « zone grise » tempo (z3), Intense = seuil
// et au-delà (z4+). Modèle polarisé visé : ~80 / ~5 / ~15. Le verdict priorise le
// problème le plus important. Partagé entre ZoneDistribution (barre + badge) et le
// badge de sous-onglet (PerformanceAnalysis).
export type ZoneVerdict = 'well_polarized' | 'too_much_intensity' | 'too_much_grey' | 'too_easy' | 'balanced'
export const ZONE_VERDICT_COLOR: Record<ZoneVerdict, string> = {
  well_polarized: '#198754', too_much_intensity: '#dc3545',
  too_much_grey: '#fd7e14', too_easy: '#0d6efd', balanced: '#6c757d',
}
export function polarize(channel: ZoneChannel): { easy: number; moderate: number; hard: number; verdict: ZoneVerdict } {
  let easy = 0
  let moderate = 0
  let hard = 0
  for (const z of channel.zones) {
    if (z.zone === 'z1' || z.zone === 'z2') easy += z.pct
    else if (z.zone === 'z3') moderate += z.pct
    else hard += z.pct
  }
  easy = Math.round(easy)
  moderate = Math.round(moderate)
  hard = Math.round(hard)
  let verdict: ZoneVerdict
  if (easy < 60) verdict = 'too_much_intensity'
  else if (moderate > 20) verdict = 'too_much_grey'
  else if (hard < 5) verdict = 'too_easy'
  else if (easy >= 75 && moderate <= 12) verdict = 'well_polarized'
  else verdict = 'balanced'
  return { easy, moderate, hard, verdict }
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
//
// L'objectif vit sur le compte (`preferences.training`), plus dans le navigateur : le
// plancher qu'il fixe pilote aussi le budget que l'app compagnon affiche au guidon, et
// elle lit le site depuis le WebView de l'appareil. Deux stockages locaux donneraient
// deux plafonds pour un seul athlète.
export const GOALS = TRAINING_GOALS
export type Goal = TrainingGoal
const GOAL_FLOOR: Record<Goal, number> = { improve_fast: -30, improve_slow: -20, maintain: -8, peak: 5 }

// Pendant une prépa datée, ce n'est plus l'objectif générique qui fixe le plancher :
// en construction on s'autorise plus de fatigue qu'en temps ordinaire, et à l'affûtage
// on cherche au contraire à en sortir — c'est le plancher de `peak` qui vaut alors.
const EVENT_BUILD_FLOOR = -25

// Les clés d'avant. Elles ne servent plus qu'une fois — voir `adoptLegacy`.
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

// ── Reprise du navigateur ────────────────────────────────────────────────────
//
// L'objectif et la sortie visée ont vécu dans le `localStorage` : un compte qui en
// avait un ne doit pas le perdre en passant au réglage de compte. On l'adopte donc une
// fois, puis on efface les clés — l'opération n'est ainsi pas répétable, et le
// navigateur suivant n'a plus rien à dire.
//
// **Le compte gagne dès qu'il a été réglé.** On ne reprend que ce qui est encore sur
// ses valeurs d'usine, sans quoi un vieux navigateur ouvert des mois plus tard
// écraserait l'objectif choisi depuis. Le cas limite assumé : avoir explicitement
// choisi « progresser doucement » sur le compte pendant qu'un ancien navigateur portait
// autre chose — il est alors repris une fois, ce qui se corrige d'un clic.
function legacyPlan(): { goal?: Goal; event?: TargetEvent | null } {
  if (typeof localStorage === 'undefined') return {}
  const plan: { goal?: Goal; event?: TargetEvent | null } = {}
  try {
    const goal = localStorage.getItem(GOAL_STORAGE_KEY) as Goal | null
    if (goal && GOALS.includes(goal)) plan.goal = goal
    localStorage.removeItem(GOAL_STORAGE_KEY)

    const raw = localStorage.getItem(EVENT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.date && parsed?.distanceKm && parsed?.intensity) plan.event = parsed as TargetEvent
    }
    localStorage.removeItem(EVENT_STORAGE_KEY)
  } catch { /* stockage refusé (navigation privée) : rien à reprendre */ }
  return plan
}

// L'objectif du compte, la reprise appliquée. Les deux réglages sont repris ensemble :
// pendant une prépa datée, c'est l'affûtage qui pilote la charge et l'objectif générique
// ne sert plus — n'en reprendre qu'un donnerait un plan que ni l'un ni l'autre ne décrit.
function initialPlan(): { goal: Goal; event: TargetEvent | null; adopted: boolean } {
  const stored = userPreferences().training
  const account = {
    goal: stored.goal,
    event: stored.event
      ? { date: stored.event.date, distanceKm: stored.event.distance_km, intensity: stored.event.intensity }
      : null,
  }
  const untouched = account.goal === 'improve_slow' && account.event === null
  // Appelé dans tous les cas : même quand le compte gagne, les clés d'avant doivent
  // disparaître, sinon ce navigateur reste porteur d'un objectif périmé qu'on
  // retrouverait un jour dans un journal ou dans un rapport de bug.
  const legacy = legacyPlan()
  if (!untouched) return { ...account, adopted: false }

  return {
    goal: legacy.goal ?? account.goal,
    event: legacy.event ?? account.event,
    adopted: legacy.goal !== undefined || legacy.event != null,
  }
}
const EVENT_INTENSITY: Record<string, { if: number; sf: number }> = {
  easy: { if: 0.65, sf: 1.0 }, tempo: { if: 0.80, sf: 1.12 }, race: { if: 0.88, sf: 1.22 },
}
export const PHASE_COLOR: Record<string, string> = { build: '#0d6efd', taper: '#fd7e14', final: '#dc3545', event_day: '#198754', past: '#6c757d' }
export const FEAS_COLOR: Record<string, string> = { ok: '#198754', demanding: '#fd7e14', hard: '#dc3545' }

export type Reco = { action: string; tss: number; minutes: number; effort: string; distanceKm: number | null; reason: string; tsb: number; days?: number }

// ── Le budget de charge poussé à l'app compagnon ─────────────────────────────
//
// Ce que le cycliste lit au guidon : ce qu'il reste à faire aujourd'hui, jusqu'où il
// peut aller sans se cramer, et où en est la semaine. Volontairement plat et sans
// unité implicite (tout est du TSS) : c'est un contrat inter-dépôt, lu par
// `TrainingBudget` côté Dart.
//
// `date` n'est pas décoratif : l'appli garde le dernier budget reçu sur disque pour
// les départs hors ligne, et un budget de la semaine dernière doit se reconnaître
// comme tel plutôt que de s'afficher comme celui du jour.
export interface TrainingBudget {
  date: string
  // `done` ne compte QUE les sorties déjà enregistrées : la sortie en cours n'est
  // téléversée nulle part, c'est le téléphone qui l'ajoute.
  day: { done: number; target: number; max: number }
  week: { target: number; done: number; planned: number; remaining: number }
  form: { ctl: number; atl: number; tsb: number; zone: string }
  risk: { acwr: number | null; zone: string | null }
}

// ── Cible de volume hebdomadaire ─────────────────────────────────────────────
// La CTL est une EWMA du TSS quotidien : à l'équilibre, TSS/jour = CTL, donc
// maintenir sa forme coûte 7 × CTL par semaine. Pour la faire monter de ΔCTL en une
// semaine, il faut en plus ΔCTL / k_ctl (≈ 42 TSS par point de CTL) :
//   cible = 7 × CTL + ΔCTL / k_ctl
// La CTL de référence est celle du DÉBUT de semaine, pas celle du jour : sinon la
// cible se déplacerait chaque jour et ne serait plus une cible.
const K_CTL = 1 - Math.exp(-1 / 42)
const K_ATL = 1 - Math.exp(-1 / 7)
const GOAL_RAMP: Record<Goal, number> = { improve_fast: 5, improve_slow: 3, maintain: 0, peak: -5 }

// Segments de la barre de la semaine. Le vert du fait et l'orange du prévu reprennent
// la sémantique déjà en place dans ce fichier (cf. WEEK_PACE_COLOR, FEAS_COLOR).
export const WEEK_SEGMENT_COLOR = { done: '#198754', planned: '#fd7e14' } as const

export type WeekPace = 'ahead' | 'on_track' | 'behind'
// « En avance » n'est pas un compliment : dépasser sa cible, c'est encaisser plus de
// charge que prévu — d'où l'orange, comme la fatigue.
export const WEEK_PACE_COLOR: Record<WeekPace, string> = {
  ahead: '#fd7e14', on_track: '#198754', behind: '#6c757d',
}
export type WeekPlan = {
  target: number
  done: number
  planned: number // TSS des itinéraires prévus sur les jours à venir
  // Volume de la semaine en km — le pendant « distance » de done / planned. Le TSS dit
  // ce que la semaine coûte, les km disent ce qu'elle représente sur le terrain.
  doneKm: number
  plannedKm: number
  remaining: number // ce qu'il reste à PLACER : target − done − planned
  donePct: number
  plannedPct: number
  // Vrai quand fait + prévu dépasse la cible : la barre se cale alors sur le total
  // (fait + prévu) plutôt que sur la cible, et `targetPct` situe la cible à l'intérieur.
  overPlanned: boolean
  targetPct: number // position de la cible sur la barre, en % de sa largeur (0–100)
  daysLeft: number
  // Jours restants (aujourd'hui compris) sur lesquels rien n'est encore prévu : c'est
  // sur eux que se répartit `remaining`.
  daysToPlace: number
  // Part quotidienne de la cible : `remaining / daysToPlace`. C'est ce que la reco du
  // jour vise, pour que les deux blocs (jour / semaine) décrivent le même plan.
  dailyNeed: number
  minutesLeft: number
  ramp: number | null // null pendant une prépa datée : c'est l'affûtage qui pilote
  rampTss: number | null // ramp converti en TSS (ramp / K_CTL) : le « + / − X TSS » affiché
  pace: WeekPace
}

// Lundi (local) de la semaine contenant `d`. `Date#getDay()` renvoie 0 le dimanche.
export function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

// Date locale en ISO. `toISOString()` passerait par UTC et décalerait le jour.
export function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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

// `plannedLoads` : TSS prévu par jour (ISO → TSS), cf. usePlannedRides. Optionnel —
// sans lui la barre garde ses deux états (fait / restant), comme avant. Ce
// composable ne fait toujours AUCUN fetch : c'est l'appelant qui compose les
// sources (charge, plans, seuils athlète).
// `plannedDistances` : distance prévue par jour (ISO → mètres), même origine — sans
// elle le total km de la semaine ne porte que le réalisé.
export function useTrainingPlan(
  data: Ref<LoadSummary | null>,
  plannedLoads?: Ref<Map<string, number>>,
  plannedDistances?: Ref<Map<string, number>>,
) {
  const current = computed<Current | null>(() => data.value?.current ?? null)

  // ── Objectif générique (persisté sur le compte) ────────────────────────────
  // Les deux réglages partent du même instantané : la reprise du navigateur les lit
  // ensemble, et deux appels en donneraient deux versions (le premier efface les clés).
  const initial = initialPlan()
  const goal = ref<Goal>(initial.goal)

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

  // TSS maximal aujourd'hui qui laisse le TSB de DEMAIN au-dessus du plancher `floor`.
  // TSB' = tsb + x·(K_CTL − K_ATL) − ctl·K_CTL + atl·K_ATL, et (K_CTL − K_ATL) < 0 :
  // la contrainte TSB' ≥ floor donne donc bien une borne SUPÉRIEURE sur x.
  // C'est ce qui rend le plancher opérant : il ne coupe plus l'entraînement par bandes
  // arbitraires, il plafonne exactement la charge que la fatigue permet d'encaisser.
  function fatigueCap(c: Current, floor: number): number {
    return (floor - c.tsb + c.ctl * K_CTL - c.atl * K_ATL) / (K_CTL - K_ATL)
  }

  // Reco du jour : on vise la part quotidienne de la cible hebdo (`need`), bornée par ce
  // que le plancher de fatigue autorise. Les deux blocs de la page décrivent alors le même
  // plan — auparavant la reco sortait d'un jeu de bandes (0,6 × CTL / 1,4 × CTL) sans
  // rapport avec la cible, et sous-livrait ~100 TSS par semaine en permanence.
  // `reasons.capped` sert quand c'est la fatigue, et non la cible, qui fixe le chiffre.
  function dayReco(
    c: Current,
    floor: number,
    need: number,
    reasons: { rest: string; normal: string; capped: string },
    days?: number,
  ): Reco {
    if (c.tsb <= -30) return restReco('reason_overreaching', c.tsb, days)
    const cap = fatigueCap(c, floor)
    const tss = Math.round(Math.max(0, Math.min(need, cap)))
    // Sous 20 TSS il n'y a plus de séance à proposer : c'est un jour de repos.
    if (tss < 20) return restReco(reasons.rest, c.tsb, days)
    const capped = cap < need - 1
    // Au-delà de ~0,9 × CTL la séance ne passe plus en pure endurance : on la propose à
    // intensité, ce qui la raccourcit (cf. planFromTss).
    const kind = tss >= 0.9 * c.ctl ? 'hard' : 'endurance'
    return {
      action: kind === 'hard' ? 'big' : 'easy',
      tss,
      ...planFromTss(tss, kind),
      reason: capped ? reasons.capped : reasons.normal,
      tsb: Math.round(c.tsb),
      days,
    }
  }

  // ── Sortie objectif datée (persistée sur le compte) ────────────────────────
  const targetEvent = ref<TargetEvent | null>(initial.event)

  // Un seul enregistrement pour les deux : le serveur assainit `training` d'un bloc, et
  // deux PATCH partant du même cache se recouvriraient.
  function persist() {
    persistTrainingPlan({
      goal: goal.value,
      event: targetEvent.value
        ? {
            date: targetEvent.value.date,
            distance_km: targetEvent.value.distanceKm,
            intensity: targetEvent.value.intensity,
          }
        : null,
    })
  }
  watch([goal, targetEvent], persist, { deep: true })

  // La reprise du navigateur, elle, s'écrit sans attendre qu'on touche à quoi que ce
  // soit — c'est ce qui la rend définitive. Seulement quand il y a eu reprise : un PATCH
  // à chaque ouverture de la page Performances réécrirait les mêmes deux valeurs.
  if (initial.adopted) persist()

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

  // ── Semaine en cours : cible de volume + avancée réelle ────────────────────
  // Volontairement fondé sur les données réelles (TSS déjà encaissé depuis lundi)
  // plutôt que sur un plan simulé : une projection jour par jour serait fausse dès
  // le premier écart, alors qu'une cible reste vraie quoi que tu fasses.
  // Bilan d'une semaine (offset 0 = en cours, 1 = suivante, …). Généralisé pour que la
  // semaine suivante ait sa propre cible et sa propre barre : sans ça, on planifie « à
  // l'aveugle » les jours à venir. On ne SIMULE pas la charge future (fidèle à la
  // philosophie « une cible reste vraie ») — pour une semaine future, la base de calcul
  // est la CTL réelle d'aujourd'hui et le « fait » vaut 0.
  function buildWeekPlan(weekOffset: number): WeekPlan | null {
    const series = data.value?.series ?? []
    const c = current.value
    if (!series.length || !c) return null

    const today = new Date()
    const monday = mondayOf(today)
    monday.setDate(monday.getDate() + weekOffset * 7)
    const mondayISO = isoLocal(monday)
    const todayLocalISO = isoLocal(today)

    // Référence de CTL : semaine en cours → la veille du lundi (réelle) ; semaine future
    // → la dernière CTL réelle connue (aujourd'hui), faute de projeter la charge à venir.
    let baselineCtl: number
    if (weekOffset === 0) {
      const beforeWeek = series.filter((p) => p.date < mondayISO)
      baselineCtl = (beforeWeek.length ? beforeWeek[beforeWeek.length - 1] : series[0]).ctl
    } else {
      baselineCtl = c.ctl
    }

    // Jours écoulés dans la semaine considérée (0 pour une semaine future) et jours
    // restants à planifier. `elapsedToday` sert au décalage jour↔objectif.
    const elapsedToday = (today.getDay() + 6) % 7
    const elapsed = weekOffset === 0 ? elapsedToday : 0
    const daysLeft = 7 - elapsed

    // Pendant une prépa datée, l'affûtage pilote : la cible de la semaine est la somme
    // du TSS planifié pour chacun de ses jours, cohérente avec la reco du jour.
    const ev = eventInfo.value
    const onEvent = !!ev && ev.phase !== 'past'
    let target: number
    if (onEvent && ev) {
      // Le jour `i` de la semaine (lundi = 0) est à `(i - elapsedToday) + 7·offset` jours
      // d'aujourd'hui, donc à `ev.days - …` jours de l'objectif.
      target = 0
      for (let i = 0; i < 7; i++) {
        const offsetFromToday = (i - elapsedToday) + weekOffset * 7
        target += plannedTss(ev.days - offsetFromToday, baselineCtl)
      }
    } else {
      target = 7 * baselineCtl + GOAL_RAMP[goal.value] / K_CTL
    }
    target = Math.max(0, Math.round(target))

    // « Fait » : seulement la semaine en cours porte du réel ; une semaine future = 0.
    const elapsedDays = weekOffset === 0
      ? series.filter((p) => p.date >= mondayISO && p.date <= todayLocalISO)
      : []
    const done = Math.round(elapsedDays.reduce((sum, p) => sum + p.tss, 0))
    // Distance déjà parcourue depuis lundi (m → km).
    const doneKm = Math.round(elapsedDays.reduce((sum, p) => sum + (p.distance_m ?? 0), 0) / 1000)

    // Charge prévue restant à encaisser. On ne compte QUE les jours à venir : un
    // plan d'un jour passé n'a pas été tenu, il ne promet plus rien.
    // Aujourd'hui est le cas limite — le TSS réel du jour est déjà dans `done`, donc
    // on ne prend que ce que le plan ajoute PAR-DESSUS, sinon la sortie déjà faite
    // serait comptée deux fois (une fois en vert, une fois en orange).
    let planned = 0
    // Distance prévue (m) sur ces mêmes jours, avec la même règle anti-double-comptage.
    let plannedM = 0
    // Jours restants encore libres : ce sont eux qui devront porter `remaining`.
    let daysToPlace = 0
    const todayPoint = series.find((p) => p.date === todayLocalISO)
    const realToday = todayPoint?.tss ?? 0
    const realTodayM = todayPoint?.distance_m ?? 0
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday)
      day.setDate(day.getDate() + i)
      const iso = isoLocal(day)
      if (iso < todayLocalISO) continue
      const meters = plannedDistances?.value.get(iso) ?? 0
      if (meters) plannedM += iso > todayLocalISO ? meters : Math.max(0, meters - realTodayM)
      const tss = plannedLoads?.value.get(iso) ?? 0
      if (!tss) { daysToPlace += 1; continue }
      if (iso > todayLocalISO) planned += tss
      else planned += Math.max(0, tss - realToday)
    }
    planned = Math.round(planned)
    const plannedKm = Math.round(plannedM / 1000)

    // Ce qu'il reste à PLACER une fois le prévu déduit — la question que se pose
    // l'utilisateur en composant sa semaine.
    const remaining = Math.max(0, target - done - planned)
    // Équivalent en durée du reste, à intensité endurance (même conversion que la reco).
    const minutesLeft = remaining > 0 ? Math.round(remaining / (0.65 * 0.65 * 100) * 60) : 0

    // Rythme : on compare à ce qui devrait être fait à l'ENTRÉE dans la journée (les
    // jours pleinement écoulés). Le lundi, il n'y a rien à juger.
    const expected = (target * elapsed) / 7
    let pace: WeekPace = 'on_track'
    if (expected > 0) {
      if (done < expected * 0.9) pace = 'behind'
      else if (done > expected * 1.25) pace = 'ahead'
    }

    // Largeurs des segments. Tant que fait + prévu tient sous la cible, la barre se cale
    // sur la cible (le reste à placer apparaît en gris). Dès qu'on planifie AU-DELÀ de la
    // cible, la barre se cale sur le total (fait + prévu) : on voit alors tout le prévu,
    // et un repère marque où se situe la cible (`targetPct`).
    const overPlanned = done + planned > target
    const barMax = Math.max(target, done + planned)
    const donePct = barMax > 0 ? Math.round((done / barMax) * 100) : 0
    const plannedPct = barMax > 0 ? Math.round((planned / barMax) * 100) : 0
    const targetPct = barMax > 0 ? Math.min(100, Math.round((target / barMax) * 100)) : 0

    return {
      target,
      done,
      planned,
      doneKm,
      plannedKm,
      remaining,
      donePct,
      plannedPct,
      overPlanned,
      targetPct,
      daysLeft,
      daysToPlace,
      dailyNeed: daysToPlace > 0 ? remaining / daysToPlace : 0,
      minutesLeft,
      ramp: onEvent ? null : GOAL_RAMP[goal.value],
      // Le coût en TSS de la progression visée : c'est ce que le ramp ajoute (ou retire)
      // à la base 7 × CTL. K_CTL ≈ 1/42,5, d'où « ~42 TSS par point de forme ».
      rampTss: onEvent ? null : Math.round(GOAL_RAMP[goal.value] / K_CTL),
      pace,
    }
  }

  const weekPlan = computed<WeekPlan | null>(() => buildWeekPlan(0))
  // Semaine suivante : tout est « à prévoir » (aucun réel), pour piloter la planification
  // à l'avance dans le WeekPlanner.
  const nextWeekPlan = computed<WeekPlan | null>(() => buildWeekPlan(1))

  // ── Recommandation du jour ────────────────────────────────────────────────
  // Définie APRÈS la semaine : elle en dérive sa cible (`dailyNeed`). L'ordre compte,
  // les deux blocs ne doivent plus pouvoir diverger.

  // Ce que vise la journée : la sortie déjà prévue aujourd'hui si elle existe (c'est la
  // décision de l'utilisateur, elle prime), sinon la part quotidienne de la cible hebdo.
  function todayNeed(c: Current): number {
    const todayISOLocal = isoLocal(new Date())
    const plannedToday = plannedLoads?.value.get(todayISOLocal) ?? 0
    if (plannedToday > 0) return plannedToday
    return weekPlan.value?.dailyNeed ?? c.ctl
  }

  // Reco datée : pilotée par la phase de préparation.
  function eventRecommendation(c: Current, ev: NonNullable<typeof eventInfo.value>): Reco {
    if (ev.phase === 'event_day') return { action: 'event', tss: 0, minutes: 0, effort: '', distanceKm: null, reason: 'reason_event_day', tsb: Math.round(c.tsb), days: 0 }
    // En construction, la cible de la semaine vient déjà du schéma d'affûtage : la reco
    // du jour en prend sa part, avec un plancher de fatigue plus permissif.
    if (ev.phase === 'build') return dayReco(c, EVENT_BUILD_FLOOR, todayNeed(c), { rest: 'reason_build_rest', normal: 'reason_build', capped: 'reason_capped' }, ev.days)
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
    return dayReco(c, GOAL_FLOOR[goal.value], todayNeed(c), { rest: 'reason_rest', normal: 'reason_week', capped: 'reason_capped' })
  })

  // ── Le budget de charge, tel que l'app compagnon l'affiche au guidon ────────
  //
  // Même dérivation que les deux blocs de la page, et c'est tout l'intérêt : le
  // cycliste ne doit pas lire un plafond sur son téléphone et un autre sur le site.
  // C'est aussi la raison pour laquelle ce calcul reste ici, en TypeScript, plutôt
  // que d'être refait côté serveur pour l'appli — la logique de planification (cible
  // hebdo, affûtage, plancher de fatigue) est un morceau qu'on ne veut pas voir
  // exister en deux exemplaires. La page le calcule et le pousse par le pont
  // (`pushTrainingBudget`, companionBridge.ts).
  //
  // Le plancher retenu est **celui qu'a utilisé la reco du jour**, sans quoi le
  // plafond décrirait un autre plan que le chiffre affiché juste à côté.
  const dayFloor = computed<number>(() => {
    const ev = eventInfo.value
    if (!ev || ev.phase === 'past') return GOAL_FLOOR[goal.value]
    return ev.phase === 'build' ? EVENT_BUILD_FLOOR : GOAL_FLOOR.peak
  })

  const budget = computed<TrainingBudget | null>(() => {
    const c = current.value
    const week = weekPlan.value
    if (!c || !week) return null

    // Ce qui est DÉJÀ enregistré aujourd'hui — donc sans la sortie en cours, que
    // personne n'a encore téléversée. C'est le téléphone qui ajoute par-dessus le TSS
    // qu'il calcule en roulant : lui seul sait où en est l'effort.
    const todayPoint = data.value?.series?.find((p) => p.date === isoLocal(new Date()))

    return {
      date: isoLocal(new Date()),
      day: {
        done: Math.round(todayPoint?.tss ?? 0),
        target: recommendation.value?.tss ?? 0,
        // Le plafond ne descend pas sous la cible : `dayReco` borne déjà la reco par
        // le cap, donc les deux ne peuvent se croiser que par arrondi — et une jauge
        // dont la cible dépasse le maximum ne se dessine pas.
        max: Math.max(0, Math.round(fatigueCap(c, dayFloor.value)), recommendation.value?.tss ?? 0),
      },
      week: {
        target: week.target,
        done: week.done,
        planned: week.planned,
        remaining: week.remaining,
      },
      form: { ctl: Math.round(c.ctl), atl: Math.round(c.atl), tsb: Math.round(c.tsb), zone: c.form_zone },
      risk: { acwr: c.acwr, zone: c.acwr_zone },
    }
  })

  return {
    budget,
    current,
    // objectif générique
    goal,
    // sortie objectif
    targetEvent, eventInfo, feasibility, projection,
    // éditeur
    editingEvent, evDate, evDistance, evIntensity, todayISO,
    openEventEditor, saveEvent, removeEvent,
    // recommandation
    recommendation, weekPlan, nextWeekPlan,
  }
}
