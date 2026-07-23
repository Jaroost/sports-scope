<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { type PropType } from 'vue'
import { Tooltip } from 'bootstrap'
import { t } from '../i18n'
import {
  formatHMS, formatKm, formatPace, formatPowerDuration,
  type ClimbSegment, type Efficiency, type SegmentStats, type SplitRow, type LapRow,
  type IntervalSegment,
} from '../activityHelpers'

interface ClimbWithVam extends ClimbSegment {
  duration: number | null
  vam: number | null
}

interface PeakPower {
  duration: number
  avgPower: number
  startIdx: number
  endIdx: number
}

const props = defineProps({
  movingStats: { type: Object as PropType<{ moving: number; elapsed: number; stopped: number; stopPct: number } | null>, default: null },
  globalVam: { type: Number, default: null },
  // Métriques d'entraînement de la sortie : NP / IF / TSS / VI (serveur + dérivé).
  trainingMetrics: { type: Object as PropType<{ np: number | null; intensity: number | null; tss: number | null; tssSource: string | null; vi: number | null } | null>, default: null },
  // Découplage aérobie { pct, basis } — dérive cardiaque 1re vs 2e moitié.
  decoupling: { type: Object as PropType<{ pct: number; basis: 'power' | 'pace' } | null>, default: null },
  // Facteur d'efficience { value, basis } — rendement aérobie global.
  efficiency: { type: Object as PropType<Efficiency | null>, default: null },
  // Allure ajustée pente (course) { gap, actual } — allures en min/km décimales.
  gradeAdjusted: { type: Object as PropType<{ gap: number; actual: number | null } | null>, default: null },
  // Récap du segment actuellement sélectionné (carte/graphe/clic table).
  segmentSummary: { type: Object as PropType<SegmentStats | null>, default: null },
  // Splits automatiques par km.
  splits: { type: Array as PropType<SplitRow[]>, default: () => [] },
  // Tours enregistrés par l'appareil (bouton « lap » / auto-lap) — vide si l'activité
  // n'en porte pas.
  laps: { type: Array as PropType<LapRow[]>, default: () => [] },
  climbsWithVam: { type: Array as PropType<ClimbWithVam[]>, default: () => [] },
  // Intervalles détectés automatiquement (efforts durs soutenus).
  intervals: { type: Array as PropType<IntervalSegment[]>, default: () => [] },
  peakPowers: { type: Array as PropType<PeakPower[]>, default: () => [] },
  // { current: {dur: w}, bests: {dur: { avg_watts, source, external_id, started_at }} } | null
  peakPowerRanks: { type: Object as PropType<Record<string, any> | null>, default: null },
  // Classement de la sortie (or/argent/bronze) sur distance/dénivelé/durée :
  // { sport, year, metrics: { key: { unit, value, overall:{rank,count}, year:{rank,count,year} } } } | null
  bestEfforts: { type: Object as PropType<Record<string, any> | null>, default: null },
  // The whole-activity selection (drives row highlight on map AND in here).
  selection: { type: Object, default: null },
  // v-model:hovered-climb-start-idx — synced with the map markers in the parent.
  hoveredClimbStartIdx: { type: Number, default: null },
  // v-model:hovered-peak-duration — local to this component but lifted for consistency.
  hoveredPeakDuration: { type: Number, default: null },
  // v-model:collapsed — persisted by the parent (localStorage).
  collapsed: { type: Boolean, default: false },
})

const emit = defineEmits([
  'select-segment',
  'update:hoveredClimbStartIdx',
  'update:hoveredPeakDuration',
  'update:collapsed',
])

// ─── Meilleurs efforts (or / argent / bronze) ────────────────────────────────
// Classement de la sortie sur distance / dénivelé / durée, en absolu et sur son
// année. Le tableau s'affiche dès qu'on a le classement ; les médailles (or /
// argent / bronze) ne décorent que le top 3, les autres rangs restent en gris.
const EFFORT_ORDER = ['distance', 'elevation', 'duration'] as const
const MEDAL_COLORS: Record<number, string> = { 1: '#f5b301', 2: '#9aa4b0', 3: '#cd7f32' }

function medalColor(rank: number | null | undefined): string | null {
  return rank != null ? (MEDAL_COLORS[rank] ?? null) : null
}
function medalTitle(rank: number | null | undefined): string {
  if (rank === 1) return t('strava.stats.effort_gold')
  if (rank === 2) return t('strava.stats.effort_silver')
  if (rank === 3) return t('strava.stats.effort_bronze')
  return ''
}

const effortRows = computed(() => {
  const m = props.bestEfforts?.metrics
  if (!m) return []
  return EFFORT_ORDER.filter((k) => m[k]).map((k) => ({ key: k, ...m[k] }))
})
// Le classement est-il disponible pour au moins une métrique ?
const hasEfforts = computed(() => effortRows.value.length > 0)
// La colonne « année » n'a de sens que si la sortie porte une date.
const effortYear = computed<number | null>(() => props.bestEfforts?.year ?? null)

function effortValue(key: string, value: number): string {
  if (key === 'distance') return formatKm(value)
  if (key === 'duration') return formatHMS(value)
  return `+${Math.round(value)} m`
}

const hasContent = computed(() =>
  props.movingStats || props.globalVam != null
  || props.trainingMetrics != null || props.decoupling != null
  || props.efficiency != null || props.gradeAdjusted != null
  || props.segmentSummary != null || props.splits.length > 0
  || props.laps.length > 0
  || props.climbsWithVam.length > 0
  || props.intervals.length > 0
  || props.peakPowers.length > 0
  || hasEfforts.value,
)

// ─── Analyseur de segment + splits : formatage adaptatif ─────────────────────
// Vitesse d'un segment : allure (course) ou km/h (autres). `seg` porte déjà `isRun`.
function speedLabel(seg: SegmentStats | SplitRow): string {
  if (seg.isRun) return seg.pace != null ? `${formatPace(seg.pace)}` : '–'
  return seg.avgSpeed != null ? `${(seg.avgSpeed * 3.6).toFixed(1)}` : '–'
}
function speedUnit(seg: SegmentStats | SplitRow): string {
  return seg.isRun ? t('strava.stats.pace_unit') : 'km/h'
}

// Colonnes des splits : n'afficher que celles qui portent une donnée sur au moins
// une tranche (une sortie sans capteur de puissance ne montre pas la colonne W).
const anyRun = computed(() => props.splits.some((s) => s.isRun))
const splitsHasHr = computed(() => props.splits.some((s) => s.avgHr != null))
const splitsHasPower = computed(() => props.splits.some((s) => s.avgPower != null))
const splitsHasGap = computed(() => props.splits.some((s) => s.gap != null))
const splitsHasGain = computed(() => props.splits.some((s) => s.gain > 0))

// Mêmes colonnes conditionnelles pour les tours : un tour peut porter des données
// que les splits n'ont pas (et inversement), donc on teste la liste des tours.
const lapsAnyRun = computed(() => props.laps.some((l) => l.isRun))
const lapsHasHr = computed(() => props.laps.some((l) => l.avgHr != null))
const lapsHasPower = computed(() => props.laps.some((l) => l.avgPower != null))
const lapsHasGap = computed(() => props.laps.some((l) => l.gap != null))
const lapsHasGain = computed(() => props.laps.some((l) => l.gain > 0))
const lapsHasName = computed(() => props.laps.some((l) => l.name != null))

// EF : libellé de valeur (2 décimales) + clé du mode de calcul selon la base.
function efValue(v: number): string { return v.toFixed(2) }

// GAP vs allure vécue : écart en secondes/km (négatif = équivalent plat plus rapide,
// donc terrain qui a ralenti). null sans allure réelle de référence.
const gapDeltaSec = computed(() => {
  const g = props.gradeAdjusted
  if (!g || g.actual == null) return null
  return Math.round((g.gap - g.actual) * 60)
})

// Un split est-il celui actuellement sélectionné ? (surlignage croisé carte/graphe)
// (mêmes helpers pour les lignes de tours : même forme, même sélection)
function isSplitSelected(s: SegmentStats): boolean {
  const sel = props.selection as { startIdx: number; endIdx: number } | null
  return !!sel && sel.startIdx === s.startIdx && sel.endIdx === s.endIdx
}
function selectSplit(s: SegmentStats) { emit('select-segment', s.startIdx, s.endIdx) }
function clearSelection() { emit('select-segment', null, null) }

// ─── Badges d'interprétation ────────────────────────────────────────────────
// Chaque métrique technique reçoit un badge « à quoi ça correspond » : une clé de
// libellé + une couleur. Les seuils suivent les conventions usuelles (Coggan/Friel).
interface Badge { key: string; color: string }

// TSS : charge de la séance. Vert (légère) → rouge (très élevée).
function tssBadge(tss: number): Badge {
  if (tss < 50) return { key: 'light', color: '#198754' }
  if (tss < 100) return { key: 'moderate', color: '#0d6efd' }
  if (tss < 150) return { key: 'high', color: '#fd7e14' }
  return { key: 'very_high', color: '#dc3545' }
}

// IF : zone d'intensité (NP/FTP). Récup < 0,70 → VO2max ≥ 1,05.
function ifBadge(v: number): Badge {
  if (v < 0.70) return { key: 'recovery', color: '#6c757d' }
  if (v < 0.85) return { key: 'endurance', color: '#198754' }
  if (v < 0.95) return { key: 'tempo', color: '#fd7e14' }
  if (v < 1.05) return { key: 'threshold', color: '#dc3545' }
  return { key: 'vo2max', color: '#6f42c1' }
}

// VI : régularité de l'effort (NP/moyenne). Régulier < 1,05 → haché ≥ 1,15.
function viBadge(v: number): Badge {
  if (v < 1.05) return { key: 'steady', color: '#198754' }
  if (v < 1.15) return { key: 'moderate', color: '#fd7e14' }
  return { key: 'surgy', color: '#dc3545' }
}

// Découplage : durabilité aérobie. Bon < 5 %, modéré 5–8 %, marqué au-delà.
function decouplingBadge(pct: number): Badge {
  if (pct < 5) return { key: 'good', color: '#198754' }
  if (pct < 8) return { key: 'moderate', color: '#fd7e14' }
  return { key: 'high', color: '#dc3545' }
}

// NP : « à quoi ça correspond » = combien au-dessus de la puissance moyenne, càd
// (VI − 1). Sert de badge descriptif, distinct du VI brut. null sans puissance moy.
const npVsAvgPct = computed(() => {
  const vi = props.trainingMetrics?.vi
  return vi != null ? (vi - 1) * 100 : null
})

function isClimbSelected(c) {
  const s = props.selection
  return !!s && s.startIdx === c.startIdx && s.endIdx === c.endIdx
}

function isPeakPowerSelected(pp) {
  const s = props.selection
  return !!s && s.startIdx === pp.startIdx && s.endIdx === pp.endIdx
}

// Rang de podium (1 = or, 2 = argent, 3 = bronze) de la sortie sur cette durée
// parmi tout l'historique, calculé côté serveur (`podium`). null hors du podium.
// Décerne les mêmes médailles que le tableau « meilleurs efforts ».
function peakPowerMedal(pp): number | null {
  const rank = props.peakPowerRanks?.podium?.[String(pp.duration)]
  return typeof rank === 'number' && rank >= 1 && rank <= 3 ? rank : null
}
const PEAK_MEDAL_CLASS: Record<number, string> = {
  1: 'peak-power-badge-gold', 2: 'peak-power-badge-silver', 3: 'peak-power-badge-bronze',
}

function peakPowerBestFor(pp) {
  return props.peakPowerRanks?.bests?.[String(pp.duration)] || null
}

function selectClimb(c) { emit('select-segment', c.startIdx, c.endIdx) }
function selectPeak(pp) { emit('select-segment', pp.startIdx, pp.endIdx) }

// ─── Intervalles détectés ────────────────────────────────────────────────────
function isIntervalSelected(iv: IntervalSegment): boolean {
  const s = props.selection as { startIdx: number; endIdx: number } | null
  return !!s && s.startIdx === iv.startIdx && s.endIdx === iv.endIdx
}
function selectInterval(iv: IntervalSegment) { emit('select-segment', iv.startIdx, iv.endIdx) }

// La sortie porte-t-elle au moins un intervalle avec du dénivelé net à afficher ?
const intervalsHaveGrade = computed(() => props.intervals.some((iv) => iv.avgGrade != null))

// Métrique d'effort principale d'un intervalle, selon le signal qui l'a détecté
// (puissance → FC → allure). Chaîne prête à afficher, « – » si absente.
function intervalEffort(iv: IntervalSegment): string {
  if (iv.basis === 'power' && iv.avgPower != null) return `${Math.round(iv.avgPower)} W`
  if (iv.basis === 'heartrate' && iv.avgHr != null) return `${Math.round(iv.avgHr)} bpm`
  if (iv.basis === 'pace' && iv.pace != null) return formatPace(iv.pace)
  return '–'
}

function setHoveredClimb(idx) { emit('update:hoveredClimbStartIdx', idx) }
function setHoveredPeak(dur)  { emit('update:hoveredPeakDuration', dur) }

function toggleCollapsed() { emit('update:collapsed', !props.collapsed) }

// ─── Tooltips Bootstrap ──────────────────────────────────────────────────────
// Les infobulles explicatives (cartes de charge/intensité + pastilles) passent en
// tooltips Bootstrap : contenu HTML mis en forme, boîte large et lisible plutôt que
// le title natif d'une seule ligne. On (ré)instancie à chaque changement de contenu
// visible car les sections sont montées/démontées par des v-if.
const rootEl = ref<HTMLElement | null>(null)
let tips: Tooltip[] = []

function disposeTooltips() {
  tips.forEach((tip) => tip.dispose())
  tips = []
}

function initTooltips() {
  disposeTooltips()
  const el = rootEl.value
  if (!el) return
  el.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((node) => {
    tips.push(new Tooltip(node, { container: 'body' }))
  })
}

onMounted(() => nextTick(initTooltips))
onBeforeUnmount(disposeTooltips)
watch(
  () => [
    props.trainingMetrics, props.decoupling, props.efficiency, props.gradeAdjusted,
    props.globalVam, props.segmentSummary, props.collapsed, hasEfforts.value,
    props.intervals.length,
  ],
  () => nextTick(initTooltips),
)
</script>

<template>
  <div v-if="hasContent" ref="rootEl" class="card shadow-sm border-0 mt-3">
    <div class="card-header activity-card-header d-flex align-items-center gap-2">
      <i class="fa-solid fa-chart-simple text-warning" aria-hidden="true"></i>
      <h3 class="h6 mb-0">{{ t('strava.stats.title') }}</h3>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary ms-auto"
        :title="collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
        :aria-pressed="collapsed"
        @click="toggleCollapsed"
      >
        <i :class="collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
      </button>
    </div>
    <div v-if="!collapsed" class="card-body">
      <!-- Meilleurs efforts : classement de la sortie (distance / dénivelé / durée)
           parmi les activités du même sport, en absolu et sur son année. Or / argent /
           bronze pour le top 3 ; affiché seulement si la sortie décroche une médaille. -->
      <div v-if="hasEfforts" class="stats-section mb-3">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-medal text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.efforts_title') }}</span>
          <i
            class="fa-regular fa-circle-question text-muted"
            data-bs-toggle="tooltip"
            :data-bs-title="t('strava.stats.efforts_hint', { sport: t(`performance.sports.${bestEfforts.sport}`) })"
            aria-hidden="true"
          ></i>
        </h4>
        <div class="table-responsive">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th>{{ t('strava.stats.effort_overall') }}</th>
                <th v-if="effortYear != null">{{ t('strava.stats.effort_year', { year: effortYear }) }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in effortRows" :key="`effort-${row.key}`">
                <td class="effort-label">{{ t(`strava.stats.effort_${row.key}`) }}</td>
                <td class="text-muted">{{ effortValue(row.key, row.value) }}</td>
                <td>
                  <span class="effort-rank">
                    <i
                      v-if="medalColor(row.overall.rank)"
                      class="fa-solid fa-medal effort-medal"
                      :style="{ color: medalColor(row.overall.rank) }"
                      :title="medalTitle(row.overall.rank)"
                      aria-hidden="true"
                    ></i>
                    <span :class="{ 'text-muted': !medalColor(row.overall.rank) }">
                      {{ t('strava.stats.effort_rank', { rank: row.overall.rank }) }}
                    </span>
                    <span class="effort-pool text-muted">{{ t('strava.stats.effort_pool', { count: row.overall.count }) }}</span>
                  </span>
                </td>
                <td v-if="effortYear != null">
                  <span v-if="row.year" class="effort-rank">
                    <i
                      v-if="medalColor(row.year.rank)"
                      class="fa-solid fa-medal effort-medal"
                      :style="{ color: medalColor(row.year.rank) }"
                      :title="medalTitle(row.year.rank)"
                      aria-hidden="true"
                    ></i>
                    <span :class="{ 'text-muted': !medalColor(row.year.rank) }">
                      {{ t('strava.stats.effort_rank', { rank: row.year.rank }) }}
                    </span>
                    <span class="effort-pool text-muted">{{ t('strava.stats.effort_pool', { count: row.year.count }) }}</span>
                  </span>
                  <span v-else class="text-muted">–</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Analyseur du segment sélectionné (drague A/B, clic sur un col / un pic de
           puissance / un split). Récap complet de la tranche ; se referme au clic sur ×. -->
      <div v-if="segmentSummary" class="segment-panel mb-3">
        <div class="segment-head">
          <i class="fa-solid fa-arrows-left-right-to-line text-warning" aria-hidden="true"></i>
          <span class="segment-title">{{ t('strava.stats.segment_title') }}</span>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary segment-clear"
            :title="t('strava.stats.segment_clear')"
            @click="clearSelection"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
        <div class="segment-grid">
          <div v-if="segmentSummary.duration != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.seg_time') }}</span>
            <strong>{{ formatHMS(segmentSummary.duration) }}</strong>
          </div>
          <div v-if="segmentSummary.distance != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.seg_distance') }}</span>
            <strong>{{ formatKm(segmentSummary.distance) }}</strong>
          </div>
          <div v-if="segmentSummary.pace != null || segmentSummary.avgSpeed != null" class="segment-item">
            <span class="segment-item-label">{{ segmentSummary.isRun ? t('strava.stream.pace') : t('strava.stream.velocity_smooth') }}</span>
            <strong>{{ speedLabel(segmentSummary) }} <span class="segment-unit">{{ speedUnit(segmentSummary) }}</span></strong>
          </div>
          <div v-if="segmentSummary.gap != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.gap') }}</span>
            <strong>{{ formatPace(segmentSummary.gap) }} <span class="segment-unit">{{ t('strava.stats.pace_unit') }}</span></strong>
          </div>
          <div v-if="segmentSummary.avgHr != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stream.heartrate') }}</span>
            <strong>{{ Math.round(segmentSummary.avgHr) }} <span class="segment-unit">bpm</span></strong>
          </div>
          <div v-if="segmentSummary.avgPower != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.col_power') }}</span>
            <strong>
              {{ Math.round(segmentSummary.avgPower) }} <span class="segment-unit">W</span>
              <span v-if="segmentSummary.np != null" class="text-muted segment-np">· NP {{ Math.round(segmentSummary.np) }}</span>
            </strong>
          </div>
          <div v-if="segmentSummary.avgCadence != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stream.cadence') }}</span>
            <strong>{{ Math.round(segmentSummary.avgCadence) }} <span class="segment-unit">rpm</span></strong>
          </div>
          <div v-if="segmentSummary.gain > 0" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.col_gain') }}</span>
            <strong>+{{ Math.round(segmentSummary.gain) }} <span class="segment-unit">m</span></strong>
          </div>
          <div v-if="segmentSummary.avgGrade != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stream.grade_smooth') }}</span>
            <strong>{{ segmentSummary.avgGrade.toFixed(1) }} <span class="segment-unit">%</span></strong>
          </div>
          <div v-if="segmentSummary.vam != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.col_vam') }}</span>
            <strong>{{ Math.round(segmentSummary.vam) }} <span class="segment-unit">m/h</span></strong>
          </div>
          <div v-if="segmentSummary.ef != null" class="segment-item">
            <span class="segment-item-label">{{ t('strava.stats.ef') }}</span>
            <strong>{{ efValue(segmentSummary.ef) }}</strong>
          </div>
        </div>
      </div>

      <!-- Charge & intensité : NP / IF / TSS / VI + découplage aérobie.
           Chaque carte porte un badge « à quoi ça correspond » + son mode de calcul. -->
      <div v-if="trainingMetrics || decoupling" class="stats-section mb-3">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-gauge-high text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.training_title') }}</span>
        </h4>
        <div class="row g-3 metric-cards-row">
          <!-- TSS -->
          <div v-if="trainingMetrics && trainingMetrics.tss != null" class="col-12 col-sm-6 col-xl-4">
            <div class="metric-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t('strava.stats.tss_hint')">
              <div class="metric-head">
                <i class="fa-solid fa-fire-flame-curved text-danger" aria-hidden="true"></i>
                <span class="metric-label">{{ t('strava.stats.tss') }}</span>
                <span class="metric-badge" :style="{ backgroundColor: tssBadge(trainingMetrics.tss).color }">
                  {{ t(`strava.stats.tss_level_${tssBadge(trainingMetrics.tss).key}`) }}
                </span>
              </div>
              <div class="metric-value">{{ Math.round(trainingMetrics.tss) }}</div>
              <details class="metric-details">
                <summary>{{ t('strava.stats.calc_label') }}</summary>
                <div class="metric-calc">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  <span>{{ t('strava.stats.tss_calc') }}</span>
                </div>
              </details>
            </div>
          </div>
          <!-- IF -->
          <div v-if="trainingMetrics && trainingMetrics.intensity != null" class="col-12 col-sm-6 col-xl-4">
            <div class="metric-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t('strava.stats.if_hint')">
              <div class="metric-head">
                <i class="fa-solid fa-bolt-lightning text-warning" aria-hidden="true"></i>
                <span class="metric-label">{{ t('strava.stats.if_label') }}</span>
                <span class="metric-badge" :style="{ backgroundColor: ifBadge(trainingMetrics.intensity).color }">
                  {{ t(`strava.stats.if_zone_${ifBadge(trainingMetrics.intensity).key}`) }}
                </span>
              </div>
              <div class="metric-value">{{ trainingMetrics.intensity.toFixed(2) }}</div>
              <details class="metric-details">
                <summary>{{ t('strava.stats.calc_label') }}</summary>
                <div class="metric-calc">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  <span>{{ t('strava.stats.if_calc') }}</span>
                </div>
              </details>
            </div>
          </div>
          <!-- NP -->
          <div v-if="trainingMetrics && trainingMetrics.np != null" class="col-12 col-sm-6 col-xl-4">
            <div class="metric-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t('strava.stats.np_hint')">
              <div class="metric-head">
                <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
                <span class="metric-label">{{ t('strava.stats.np') }}</span>
                <span
                  v-if="npVsAvgPct != null"
                  class="metric-badge metric-badge-neutral"
                >
                  {{ t('strava.stats.np_vs_avg', { pct: (npVsAvgPct >= 0 ? '+' : '') + Math.round(npVsAvgPct) }) }}
                </span>
              </div>
              <div class="metric-value">{{ Math.round(trainingMetrics.np) }} <span class="metric-unit">W</span></div>
              <details class="metric-details">
                <summary>{{ t('strava.stats.calc_label') }}</summary>
                <div class="metric-calc">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  <span>{{ t('strava.stats.np_calc') }}</span>
                </div>
              </details>
            </div>
          </div>
          <!-- VI -->
          <div v-if="trainingMetrics && trainingMetrics.vi != null" class="col-12 col-sm-6 col-xl-4">
            <div class="metric-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t('strava.stats.vi_hint')">
              <div class="metric-head">
                <i class="fa-solid fa-wave-square text-info" aria-hidden="true"></i>
                <span class="metric-label">{{ t('strava.stats.vi') }}</span>
                <span class="metric-badge" :style="{ backgroundColor: viBadge(trainingMetrics.vi).color }">
                  {{ t(`strava.stats.vi_level_${viBadge(trainingMetrics.vi).key}`) }}
                </span>
              </div>
              <div class="metric-value">{{ trainingMetrics.vi.toFixed(2) }}</div>
              <details class="metric-details">
                <summary>{{ t('strava.stats.calc_label') }}</summary>
                <div class="metric-calc">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  <span>{{ t('strava.stats.vi_calc') }}</span>
                </div>
              </details>
            </div>
          </div>
          <!-- Découplage aérobie -->
          <div v-if="decoupling" class="col-12 col-sm-6 col-xl-4">
            <div class="metric-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t(`strava.stats.decoupling_hint_${decoupling.basis}`)">
              <div class="metric-head">
                <i class="fa-solid fa-heart-circle-bolt" :style="{ color: decouplingBadge(decoupling.pct).color }" aria-hidden="true"></i>
                <span class="metric-label">{{ t('strava.stats.decoupling') }}</span>
                <span class="metric-badge" :style="{ backgroundColor: decouplingBadge(decoupling.pct).color }">
                  {{ t(`strava.stats.decoupling_level_${decouplingBadge(decoupling.pct).key}`) }}
                </span>
              </div>
              <div class="metric-value" :style="{ color: decouplingBadge(decoupling.pct).color }">
                {{ decoupling.pct > 0 ? '+' : '' }}{{ decoupling.pct.toFixed(1) }} <span class="metric-unit">%</span>
              </div>
              <details class="metric-details">
                <summary>{{ t('strava.stats.calc_label') }}</summary>
                <div class="metric-calc">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  <span>{{ t(`strava.stats.decoupling_calc_${decoupling.basis}`) }}</span>
                </div>
              </details>
            </div>
          </div>
          <!-- Facteur d'efficience (EF) -->
          <div v-if="efficiency" class="col-12 col-sm-6 col-xl-4">
            <div class="metric-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t(`strava.stats.ef_hint_${efficiency.basis}`)">
              <div class="metric-head">
                <i class="fa-solid fa-gauge text-success" aria-hidden="true"></i>
                <span class="metric-label">{{ t('strava.stats.ef') }}</span>
                <span class="metric-badge metric-badge-neutral">
                  {{ t(`strava.stats.ef_basis_${efficiency.basis}`) }}
                </span>
              </div>
              <div class="metric-value">{{ efValue(efficiency.value) }}</div>
              <details class="metric-details">
                <summary>{{ t('strava.stats.calc_label') }}</summary>
                <div class="metric-calc">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>
                  <span>{{ t(`strava.stats.ef_calc_${efficiency.basis}`) }}</span>
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>

      <!-- Top-line stats: temps actif / arrêts / VAM globale -->
      <div v-if="movingStats || globalVam != null" class="row g-3 mb-3 stats-pills-row">
        <div v-if="movingStats" class="col-6 col-md-3">
          <div class="stat-card">
            <span class="stat-icon"><i class="fa-solid fa-person-biking text-success" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.moving') }}</div>
              <strong>{{ formatHMS(movingStats.moving) }}</strong>
            </div>
          </div>
        </div>
        <div v-if="movingStats" class="col-6 col-md-3">
          <div class="stat-card">
            <span class="stat-icon"><i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.elapsed') }}</div>
              <strong>{{ formatHMS(movingStats.elapsed) }}</strong>
            </div>
          </div>
        </div>
        <div v-if="movingStats" class="col-6 col-md-3">
          <div class="stat-card">
            <span class="stat-icon"><i class="fa-solid fa-pause text-secondary" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">
                {{ t('strava.stats.stopped') }}
                <span v-if="movingStats.elapsed > 0" class="text-muted">· {{ movingStats.stopPct.toFixed(0) }} %</span>
              </div>
              <strong>{{ formatHMS(movingStats.stopped) }}</strong>
            </div>
          </div>
        </div>
        <div v-if="globalVam != null" class="col-6 col-md-3">
          <div class="stat-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t('strava.stats.vam_hint')">
            <span class="stat-icon"><i class="fa-solid fa-mountain text-success" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.vam_global') }}</div>
              <strong>{{ Math.round(globalVam) }} m/h</strong>
            </div>
          </div>
        </div>
        <div v-if="gradeAdjusted" class="col-6 col-md-3">
          <div class="stat-card" data-bs-toggle="tooltip" data-bs-html="true" data-bs-custom-class="stat-tooltip" :data-bs-title="t('strava.stats.gap_hint')">
            <span class="stat-icon"><i class="fa-solid fa-person-running text-primary" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.gap') }}</div>
              <strong>{{ formatPace(gradeAdjusted.gap) }} {{ t('strava.stats.pace_unit') }}</strong>
              <div v-if="gapDeltaSec != null && gapDeltaSec !== 0" class="text-muted small">
                {{ gapDeltaSec < 0 ? '−' : '+' }}{{ Math.abs(gapDeltaSec) }} {{ t('strava.stats.gap_delta') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tours enregistrés par l'appareil (bouton « lap » ou auto-lap). Placés avant
           les splits : ce sont les coupures voulues par l'athlète, les splits n'étant
           qu'un découpage kilométrique recalculé. Mêmes lignes cliquables. -->
      <div v-if="laps.length > 0" class="stats-section">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-flag-checkered text-primary" aria-hidden="true"></i>
          <span>{{ t('strava.stats.laps_title') }}</span>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th>{{ t('strava.stats.lap_col_num') }}</th>
                <th v-if="lapsHasName">{{ t('strava.stats.lap_col_name') }}</th>
                <th :title="t('strava.stats.col_time')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                </th>
                <th :title="t('strava.stats.seg_distance')">
                  <i class="fa-solid fa-ruler-horizontal text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.seg_distance') }}</span>
                </th>
                <th :title="lapsAnyRun ? t('strava.stream.pace') : t('strava.stream.velocity_smooth')">
                  <i :class="lapsAnyRun ? 'fa-solid fa-person-running' : 'fa-solid fa-gauge-high'" class="text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ lapsAnyRun ? t('strava.stream.pace') : t('strava.stream.velocity_smooth') }}</span>
                </th>
                <th v-if="lapsHasGap" :title="t('strava.stats.gap')">
                  <i class="fa-solid fa-mountain-sun text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.gap') }}</span>
                </th>
                <th v-if="lapsHasHr" :title="t('strava.stream.heartrate')">
                  <i class="fa-solid fa-heart-pulse text-danger" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stream.heartrate') }}</span>
                </th>
                <th v-if="lapsHasPower" :title="t('strava.stats.col_power')">
                  <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_power') }}</span>
                </th>
                <th v-if="lapsHasGain" :title="t('strava.stats.col_gain')">
                  <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_gain') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="l in laps"
                :key="`lap-${l.index}`"
                class="climb-row"
                :class="{ 'climb-row-active': isSplitSelected(l) }"
                role="button"
                tabindex="0"
                :title="t('strava.stats.lap_click')"
                :aria-pressed="isSplitSelected(l)"
                @click="selectSplit(l)"
                @keydown.enter.prevent="selectSplit(l)"
                @keydown.space.prevent="selectSplit(l)"
              >
                <td>
                  {{ l.index }}
                  <i
                    v-if="l.auto"
                    class="fa-solid fa-robot text-muted split-partial"
                    :title="t('strava.stats.lap_auto')"
                    aria-hidden="true"
                  ></i>
                </td>
                <td v-if="lapsHasName" class="text-truncate" style="max-width: 10rem;">{{ l.name || '–' }}</td>
                <td>{{ l.duration != null ? formatHMS(l.duration) : '–' }}</td>
                <td>{{ l.distance != null ? formatKm(l.distance) : '–' }}</td>
                <td>{{ speedLabel(l) }} <span class="text-muted small">{{ speedUnit(l) }}</span></td>
                <td v-if="lapsHasGap">{{ l.gap != null ? formatPace(l.gap) : '–' }}</td>
                <td v-if="lapsHasHr">{{ l.avgHr != null ? Math.round(l.avgHr) : '–' }}</td>
                <td v-if="lapsHasPower">{{ l.avgPower != null ? `${Math.round(l.avgPower)} W` : '–' }}</td>
                <td v-if="lapsHasGain">{{ l.gain > 0 ? `+${Math.round(l.gain)} m` : '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Splits automatiques par km. Lignes cliquables : sélectionnent la tranche
           sur la carte + le graphique (même mécanisme que les cols). -->
      <div v-if="splits.length > 0" class="stats-section">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-stopwatch text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.splits_title') }}</span>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th>{{ t('strava.stats.split_col_km') }}</th>
                <th :title="t('strava.stats.col_time')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                </th>
                <th :title="anyRun ? t('strava.stream.pace') : t('strava.stream.velocity_smooth')">
                  <i :class="anyRun ? 'fa-solid fa-person-running' : 'fa-solid fa-gauge-high'" class="text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ anyRun ? t('strava.stream.pace') : t('strava.stream.velocity_smooth') }}</span>
                </th>
                <th v-if="splitsHasGap" :title="t('strava.stats.gap')">
                  <i class="fa-solid fa-mountain-sun text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.gap') }}</span>
                </th>
                <th v-if="splitsHasHr" :title="t('strava.stream.heartrate')">
                  <i class="fa-solid fa-heart-pulse text-danger" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stream.heartrate') }}</span>
                </th>
                <th v-if="splitsHasPower" :title="t('strava.stats.col_power')">
                  <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_power') }}</span>
                </th>
                <th v-if="splitsHasGain" :title="t('strava.stats.col_gain')">
                  <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_gain') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in splits"
                :key="`split-${s.index}`"
                class="climb-row"
                :class="{ 'climb-row-active': isSplitSelected(s) }"
                role="button"
                tabindex="0"
                :title="t('strava.stats.split_click')"
                :aria-pressed="isSplitSelected(s)"
                @click="selectSplit(s)"
                @keydown.enter.prevent="selectSplit(s)"
                @keydown.space.prevent="selectSplit(s)"
              >
                <td>
                  {{ s.index }}
                  <span v-if="s.partial" class="split-partial text-muted">{{ formatKm(s.distance) }}</span>
                </td>
                <td>{{ s.duration != null ? formatHMS(s.duration) : '–' }}</td>
                <td>{{ speedLabel(s) }} <span class="text-muted small">{{ speedUnit(s) }}</span></td>
                <td v-if="splitsHasGap">{{ s.gap != null ? formatPace(s.gap) : '–' }}</td>
                <td v-if="splitsHasHr">{{ s.avgHr != null ? Math.round(s.avgHr) : '–' }}</td>
                <td v-if="splitsHasPower">{{ s.avgPower != null ? `${Math.round(s.avgPower)} W` : '–' }}</td>
                <td v-if="splitsHasGain">{{ s.gain > 0 ? `+${Math.round(s.gain)} m` : '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Climbs (per-climb VAM) -->
      <!-- Intervalles détectés automatiquement (efforts durs soutenus). Cliquer une
           ligne la surligne sur la carte et le graphique via la sélection partagée. -->
      <div v-if="intervals.length > 0" class="stats-section">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-stopwatch-20 text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.intervals_title') }}</span>
          <i
            class="fa-regular fa-circle-question text-muted"
            data-bs-toggle="tooltip"
            :data-bs-title="t('strava.stats.intervals_hint')"
            aria-hidden="true"
          ></i>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th>#</th>
                <th :title="t('strava.stats.col_time')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                </th>
                <th :title="t('strava.stats.col_length')">
                  <i class="fa-solid fa-route text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_length') }}</span>
                </th>
                <th :title="t('strava.stats.intervals_effort')">
                  <i class="fa-solid fa-fire text-danger" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.intervals_effort') }}</span>
                </th>
                <th v-if="intervalsHaveGrade" :title="t('strava.stats.col_grade')">
                  <i class="fa-solid fa-slash text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_grade') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="iv in intervals"
                :key="`interval-${iv.index}`"
                class="climb-row"
                :class="{ 'climb-row-active': isIntervalSelected(iv) }"
                role="button"
                tabindex="0"
                :title="t('strava.stats.intervals_click')"
                :aria-pressed="isIntervalSelected(iv)"
                @click="selectInterval(iv)"
                @keydown.enter.prevent="selectInterval(iv)"
                @keydown.space.prevent="selectInterval(iv)"
              >
                <td>{{ iv.index }}</td>
                <td>{{ iv.duration != null ? formatHMS(iv.duration) : '–' }}</td>
                <td>{{ iv.distance != null ? formatKm(iv.distance) : '–' }}</td>
                <td>{{ intervalEffort(iv) }}</td>
                <td v-if="intervalsHaveGrade">{{ iv.avgGrade != null ? `${iv.avgGrade.toFixed(1)} %` : '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="climbsWithVam.length > 0" class="stats-section">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.climbs_title') }}</span>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th>#</th>
                <th :title="t('strava.stats.col_length')">
                  <i class="fa-solid fa-route text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_length') }}</span>
                </th>
                <th :title="t('strava.stats.col_gain')">
                  <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_gain') }}</span>
                </th>
                <th :title="t('strava.stats.col_grade')">
                  <i class="fa-solid fa-slash text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_grade') }}</span>
                </th>
                <th :title="t('strava.stats.col_time')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                </th>
                <th :title="t('strava.stats.col_vam')">
                  <i class="fa-solid fa-mountain text-success" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_vam') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(c, i) in climbsWithVam"
                :key="`climb-${i}`"
                class="climb-row"
                :class="{
                  'climb-row-active': isClimbSelected(c),
                  'climb-row-hover': hoveredClimbStartIdx === c.startIdx,
                }"
                role="button"
                tabindex="0"
                :title="t('strava.click_to_select_climb')"
                :aria-pressed="isClimbSelected(c)"
                @click="selectClimb(c)"
                @keydown.enter.prevent="selectClimb(c)"
                @keydown.space.prevent="selectClimb(c)"
                @mouseenter="setHoveredClimb(c.startIdx)"
                @mouseleave="setHoveredClimb(null)"
                @focus="setHoveredClimb(c.startIdx)"
                @blur="setHoveredClimb(null)"
              >
                <td>
                  <span class="climb-cat-badge" :class="`climb-cat-${c.category || 'HC'}`">
                    <span>{{ c.category ? `Cat ${c.category}` : 'HC' }}</span>
                  </span>
                </td>
                <td>{{ formatKm(c.lengthM) }}</td>
                <td>+{{ Math.round(c.gain) }} m</td>
                <td>{{ c.avgGrade.toFixed(1) }} %</td>
                <td>{{ c.duration != null ? formatHMS(c.duration) : '–' }}</td>
                <td>{{ c.vam != null ? `${Math.round(c.vam)} m/h` : '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Peak average power per duration (shortest → longest). -->
      <div v-if="peakPowers.length > 0" class="stats-section mt-3">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.peak_power_title') }}</span>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th :title="t('strava.stats.col_duration')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_duration') }}</span>
                </th>
                <th :title="t('strava.stats.col_power')">
                  <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_power') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="pp in peakPowers"
                :key="`peak-${pp.duration}`"
                class="climb-row"
                :class="{
                  'climb-row-active': isPeakPowerSelected(pp),
                  'climb-row-hover': hoveredPeakDuration === pp.duration,
                }"
                role="button"
                tabindex="0"
                :title="t('strava.click_to_select_peak_power')"
                :aria-pressed="isPeakPowerSelected(pp)"
                @click="selectPeak(pp)"
                @keydown.enter.prevent="selectPeak(pp)"
                @keydown.space.prevent="selectPeak(pp)"
                @mouseenter="setHoveredPeak(pp.duration)"
                @mouseleave="setHoveredPeak(null)"
                @focus="setHoveredPeak(pp.duration)"
                @blur="setHoveredPeak(null)"
              >
                <td>{{ formatPowerDuration(pp.duration) }}</td>
                <td class="d-flex align-items-center gap-2 flex-wrap">
                  <span>{{ Math.round(pp.avgPower) }} W</span>
                  <!-- Podium historique sur cette durée : or / argent / bronze. Le rang 1
                       porte le libellé « Record », l'argent et le bronze leur médaille. -->
                  <span
                    v-if="peakPowerMedal(pp)"
                    class="peak-power-badge"
                    :class="PEAK_MEDAL_CLASS[peakPowerMedal(pp)]"
                    :title="peakPowerMedal(pp) === 1 ? t('strava.stats.peak_power_pr_hint') : medalTitle(peakPowerMedal(pp))"
                  >
                    <i class="fa-solid fa-medal" aria-hidden="true"></i>
                    <span>{{ peakPowerMedal(pp) === 1 ? t('strava.stats.peak_power_pr') : medalTitle(peakPowerMedal(pp)) }}</span>
                  </span>
                  <!-- Meilleur historique à battre : montré tant que la sortie n'est pas le
                       record (argent/bronze ou hors podium). -->
                  <span
                    v-if="peakPowerMedal(pp) !== 1 && peakPowerBestFor(pp)"
                    class="peak-power-best text-muted small"
                    :title="t('strava.stats.peak_power_best_hint')"
                  >
                    <i class="fa-regular fa-star" aria-hidden="true"></i>
                    {{ Math.round(peakPowerBestFor(pp).avg_watts) }} W
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }

/* Inline category badge — paints its background from `currentColor` (set by
   the .climb-cat-* class) so each category gets its bucket colour. */
.climb-cat-badge {
  display: inline-flex;
  align-items: center;
  background: currentColor;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.4;
}
.climb-cat-badge > span { color: #fff; }

.stats-section + .stats-section { border-top: 1px dashed rgba(0, 0, 0, 0.08); padding-top: 0.75rem; }

/* Meilleurs efforts : médaille + rang + taille du groupe sur une ligne. */
.effort-label { font-weight: 600; }
.effort-rank {
  display: inline-flex;
  align-items: baseline;
  gap: 0.35rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.effort-medal { font-size: 0.95rem; align-self: center; }
.effort-pool { font-weight: 400; font-size: 0.78rem; }

/* Analyseur de segment : encadré teinté à la couleur de sélection (orange Strava). */
.segment-panel {
  border: 1px solid rgba(252, 76, 2, 0.35);
  border-radius: 0.5rem;
  background: rgba(252, 76, 2, 0.06);
  padding: 0.6rem 0.75rem;
}
.segment-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.segment-title { font-weight: 600; font-size: 0.9rem; }
.segment-clear { margin-left: auto; line-height: 1; }
.segment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 0.5rem 0.9rem;
}
.segment-item { display: flex; flex-direction: column; }
.segment-item-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--bs-secondary-color, #6c757d);
}
.segment-item strong { font-variant-numeric: tabular-nums; font-size: 0.95rem; }
.segment-unit { font-size: 0.75rem; font-weight: 600; color: var(--bs-secondary-color, #6c757d); }
.segment-np { font-size: 0.75rem; font-weight: 500; margin-left: 0.15rem; }
.split-partial { font-size: 0.72rem; margin-left: 0.3rem; }

/* Cartes « Charge & intensité » : en-tête (icône + libellé + badge d'interprétation),
   valeur mise en avant, puis la formule de calcul en petit. */
.metric-card {
  height: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.1));
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg, #f8f9fa);
}
.metric-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.15rem;
}
.metric-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--bs-secondary-color, #6c757d);
}
.metric-badge {
  margin-left: auto;
  color: #fff;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  white-space: nowrap;
}
.metric-badge-neutral {
  background: var(--bs-secondary-bg, #e9ecef);
  color: var(--bs-secondary-color, #495057);
  font-variant-numeric: tabular-nums;
}
.metric-value {
  font-size: 1.35rem;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.metric-unit {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--bs-secondary-color, #6c757d);
}
.metric-calc {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  margin-top: 0.25rem;
  font-size: 0.72rem;
  color: var(--bs-secondary-color, #6c757d);
}
.metric-calc i { font-size: 0.66rem; opacity: 0.7; }

/* « Détail du calcul » replié par défaut (élément natif <details>). La flèche
   maison remplace le marqueur natif pour rester discret et cohérent. */
.metric-details { margin-top: 0.3rem; }
.metric-details > summary {
  cursor: pointer;
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  color: var(--bs-secondary-color, #6c757d);
}
.metric-details > summary::-webkit-details-marker { display: none; }
.metric-details > summary::before {
  content: "\25B8"; /* ▸ */
  font-size: 0.6rem;
  line-height: 1;
}
.metric-details[open] > summary::before { content: "\25BE"; /* ▾ */ }
.stats-table th {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6c757d;
  font-weight: 600;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.stats-table td {
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
}
.stats-table-scroll {
  max-height: 360px;
  overflow-y: auto;
}
.stats-table-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
}

/* Clickable rows mirror selection state on the map + chart. The hover/active
   colouring is applied on the <td> because Bootstrap paints --bs-table-bg on
   cells, which masks any background set on the <tr>. */
.climb-row { cursor: pointer; }
.climb-row > td { transition: background-color 0.12s, box-shadow 0.12s; }
.climb-row:hover > td,
.climb-row-hover > td {
  background-color: rgba(252, 76, 2, 0.12);
}
.climb-row:focus-visible { outline: none; }
.climb-row:focus-visible > td {
  box-shadow: inset 0 2px 0 rgba(252, 76, 2, 0.55),
              inset 0 -2px 0 rgba(252, 76, 2, 0.55);
}
.climb-row:focus-visible > td:first-child { box-shadow: inset 2px 0 0 rgba(252, 76, 2, 0.55), inset 0 2px 0 rgba(252, 76, 2, 0.55), inset 0 -2px 0 rgba(252, 76, 2, 0.55); }
.climb-row:focus-visible > td:last-child  { box-shadow: inset -2px 0 0 rgba(252, 76, 2, 0.55), inset 0 2px 0 rgba(252, 76, 2, 0.55), inset 0 -2px 0 rgba(252, 76, 2, 0.55); }
.climb-row-active > td,
.climb-row-active:hover > td,
.climb-row-active.climb-row-hover > td {
  background-color: rgba(252, 76, 2, 0.22);
  font-weight: 600;
}

/* Podium badges on the peak-power table — gold / silver / bronze, matching the
   medals used by the « meilleurs efforts » table. */
.peak-power-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.peak-power-badge-gold {
  background: rgba(245, 179, 1, 0.18);
  color: #b45309;
  border: 1px solid rgba(180, 83, 9, 0.35);
}
.peak-power-badge-silver {
  background: rgba(154, 164, 176, 0.20);
  color: #4b5563;
  border: 1px solid rgba(107, 114, 128, 0.35);
}
.peak-power-badge-bronze {
  background: rgba(205, 127, 50, 0.18);
  color: #92400e;
  border: 1px solid rgba(146, 64, 14, 0.35);
}
.peak-power-best {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-variant-numeric: tabular-nums;
}
</style>

<!-- Tooltips Bootstrap : appendus au <body>, donc styles NON scoped. Boîte plus
     large, texte aligné à gauche et listes lisibles pour les infobulles riches. -->
<style>
.stat-tooltip {
  --bs-tooltip-max-width: 300px;
  --bs-tooltip-bg: #1f2937;
  --bs-tooltip-opacity: 1;
}
.stat-tooltip .tooltip-inner {
  text-align: left;
  padding: 0.55rem 0.7rem;
  font-size: 0.8rem;
  line-height: 1.4;
}
.stat-tooltip .tooltip-inner strong { font-weight: 700; }
.stat-tooltip .tooltip-inner ol,
.stat-tooltip .tooltip-inner ul {
  margin: 0.35rem 0 0.35rem 0;
  padding-left: 1.1rem;
}
.stat-tooltip .tooltip-inner li { margin-bottom: 0.1rem; }
.stat-tooltip .tooltip-inner p { margin: 0 0 0.4rem 0; }
.stat-tooltip .tooltip-inner p:last-child { margin-bottom: 0; }
</style>
