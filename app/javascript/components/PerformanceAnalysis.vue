<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'
import FtpPanel from './FtpPanel.vue'
import TrainingLoadPanel from './TrainingLoadPanel.vue'

const props = defineProps({
  admin: { type: Boolean, default: false },
})

// ── Types du payload /api/performance ───────────────────────────────────────
interface ActivityRef {
  source: string
  external_id: string
  name: string
  type: string | null
  started_at: string | null
}
interface RecordItem {
  key: string
  unit: string
  value: number
  activity: ActivityRef
}
interface Totals {
  count: number
  distance_m: number
  elevation: number
  moving_time_s: number
}
interface YearRow {
  year: number
  count: number
  distance_m: number
  elevation: number
  moving_time_s: number
}
interface Bucket {
  label: string | number
  value: number
  count: number
}
interface PeakEntry {
  avg_watts: number
  name: string
  source: string
  external_id: string
  started_at: string | null
}
interface SportGroup {
  count: number
  records: RecordItem[]
  totals: Totals
  by_year: YearRow[]
  best_periods: Record<string, Bucket | null>
  peak_power: Record<string, PeakEntry>
}
interface Payload {
  sports: { key: string; count: number }[]
  by_sport: Record<string, SportGroup>
  count: number
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<Payload | null>(null)

// Onglet de sport sélectionné, mémorisé en localStorage (comme l'onglet d'activité
// dans ActivityDetail) pour retrouver le même sport au rechargement.
const SPORT_STORAGE_KEY = 'sportsScope.performanceSport'
const storedSport = (typeof localStorage !== 'undefined' && localStorage.getItem(SPORT_STORAGE_KEY)) || 'all'
const selectedSport = ref(storedSport)

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

async function fetchData() {
  loading.value = true
  try {
    const res = await fetch('/api/performance', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as Payload
    // Le sport mémorisé peut ne plus exister (aucune activité de ce type) : repli sur « Tout ».
    if (!data.value.by_sport[selectedSport.value]) selectedSport.value = 'all'
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
  // Rendu du graphique APRÈS `loading = false` : sinon le template affiche encore le
  // spinner et le <canvas> n'est pas monté (ref null → graphique jamais dessiné).
  await nextTick()
  renderChart()
}

onMounted(fetchData)

// ── Sports (onglets) ─────────────────────────────────────────────────────────
const SPORT_ICONS: Record<string, string> = {
  all: 'fa-layer-group',
  cycling: 'fa-person-biking',
  running: 'fa-person-running',
  ski: 'fa-person-skiing',
  hiking: 'fa-person-hiking',
  swimming: 'fa-person-swimming',
  other: 'fa-bolt',
}
function sportIcon(key: string): string {
  return SPORT_ICONS[key] ?? 'fa-bolt'
}
function sportLabel(key: string): string {
  return t(`performance.sports.${key}`)
}

// Onglet « Tout » d'abord, puis chaque sport présent (déjà trié par volume).
const tabs = computed(() => {
  if (!data.value) return []
  return [{ key: 'all', count: data.value.count }, ...data.value.sports]
})

const group = computed<SportGroup | null>(() => {
  if (!data.value) return null
  return data.value.by_sport[selectedSport.value] ?? data.value.by_sport['all'] ?? null
})

function selectSport(key: string) {
  if (selectedSport.value === key) return
  selectedSport.value = key
}

// ── Formatage ────────────────────────────────────────────────────────────────
function formatValue(unit: string, v: number): string {
  switch (unit) {
    case 'distance': return `${(v / 1000).toFixed(1)} km`
    case 'duration': return formatDuration(v)
    case 'elevation': return `${Math.round(v).toLocaleString()} m`
    case 'speed': return `${(v * 3.6).toFixed(1)} km/h`
    case 'bpm': return `${Math.round(v)} bpm`
    case 'watts': return `${Math.round(v)} W`
    case 'rpm': return `${Math.round(v)} rpm`
    default: return String(v)
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}` : `${m}min`
}

function formatDistanceKm(m: number): string {
  return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function formatMonthLabel(label: string | number): string {
  const s = String(label)
  const m = s.match(/^(\d{4})-(\d{2})$/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1)
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }
  return s
}

function activityHref(a: { source: string; external_id: string }): string {
  const base = a.source === 'imported' ? '/imported_activities' : '/activities'
  return `${localePrefix}${base}/${a.external_id}`
}

// Icône FontAwesome par type de record.
const RECORD_ICONS: Record<string, string> = {
  longest_distance: 'fa-route',
  longest_duration: 'fa-clock',
  biggest_elevation: 'fa-mountain',
  max_speed: 'fa-gauge-high',
  max_heartrate: 'fa-heart-pulse',
  max_power: 'fa-bolt',
  max_cadence: 'fa-rotate',
}
function recordIcon(key: string): string {
  return RECORD_ICONS[key] ?? 'fa-trophy'
}

const totalsCards = computed(() => {
  const tot = group.value?.totals
  if (!tot) return []
  return [
    { icon: 'fa-list-check', label: t('performance.totals.count'), value: tot.count.toLocaleString() },
    { icon: 'fa-route', label: t('performance.totals.distance'), value: formatDistanceKm(tot.distance_m) },
    { icon: 'fa-mountain', label: t('performance.totals.elevation'), value: `${Math.round(tot.elevation).toLocaleString()} m` },
    { icon: 'fa-clock', label: t('performance.totals.time'), value: formatDuration(tot.moving_time_s) },
  ]
})

// Meilleures périodes présentées comme une liste ordonnée.
const periodCards = computed(() => {
  const bp = group.value?.best_periods
  if (!bp) return []
  const items: { icon: string; label: string; period: string; value: string }[] = []
  const push = (bucket: Bucket | null | undefined, icon: string, labelKey: string, unit: 'distance' | 'elevation', monthly: boolean) => {
    if (!bucket) return
    items.push({
      icon,
      label: t(labelKey),
      period: monthly ? formatMonthLabel(bucket.label) : String(bucket.label),
      value: unit === 'distance' ? formatDistanceKm(bucket.value) : `${Math.round(bucket.value).toLocaleString()} m`,
    })
  }
  push(bp.best_year_distance, 'fa-route', 'performance.periods.best_year_distance', 'distance', false)
  push(bp.best_month_distance, 'fa-route', 'performance.periods.best_month_distance', 'distance', true)
  push(bp.best_year_elevation, 'fa-mountain', 'performance.periods.best_year_elevation', 'elevation', false)
  push(bp.best_month_elevation, 'fa-mountain', 'performance.periods.best_month_elevation', 'elevation', true)
  return items
})

// ── Courbe puissance max / temps (Chart.js) ─────────────────────────────────
const chartCanvas = ref<HTMLCanvasElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chart: any = null

const peakEntries = computed(() => {
  const pp = group.value?.peak_power
  if (!pp) return []
  return Object.keys(pp)
    .map((k) => ({ duration: Number(k), ...pp[k] }))
    .filter((e) => Number.isFinite(e.duration) && e.avg_watts > 0)
    .sort((a, b) => a.duration - b.duration)
})

const hasPeakPower = computed(() => peakEntries.value.length > 0)

function formatShortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = seconds / 60
  return Number.isInteger(m) ? `${m}min` : `${m.toFixed(1)}min`
}

async function renderChart() {
  if (chart) { chart.destroy(); chart = null }
  if (!hasPeakPower.value || !chartCanvas.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  const entries = peakEntries.value
  const ctx = chartCanvas.value.getContext('2d')
  if (!ctx) return
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: entries.map((e) => formatShortDuration(e.duration)),
      datasets: [{
        label: t('performance.peak_power.axis'),
        data: entries.map((e) => Math.round(e.avg_watts)),
        borderColor: '#fc4c02',
        backgroundColor: 'rgba(252, 76, 2, 0.12)',
        pointBackgroundColor: '#fc4c02',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Clic sur un point → ouvre l'activité qui détient ce record de puissance.
      onClick: (_evt: unknown, els: { index: number }[]) => {
        const el = els && els[0]
        if (!el) return
        const entry = entries[el.index]
        if (entry) window.location.href = activityHref(entry)
      },
      // Curseur « main » quand on survole un point cliquable.
      onHover: (evt: { native?: Event }, els: unknown[]) => {
        const target = evt.native?.target as HTMLElement | undefined
        if (target) target.style.cursor = els.length ? 'pointer' : 'default'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item: { parsed: { y: number } }) => `${item.parsed.y} W`,
            // Nom + date de l'activité détentrice sous la valeur.
            afterLabel: (item: { dataIndex: number }) => {
              const entry = entries[item.dataIndex]
              if (!entry) return ''
              const date = entry.started_at ? ` · ${formatDate(entry.started_at)}` : ''
              return `${entry.name}${date}`
            },
            footer: () => t('performance.peak_power.click_hint'),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: t('performance.peak_power.axis') },
        },
        x: {
          title: { display: true, text: t('performance.peak_power.duration') },
        },
      },
    },
  })
}

// Persiste le sport choisi et re-render la courbe (le canvas peut apparaître/disparaître).
watch(selectedSport, async (sport) => {
  try { localStorage.setItem(SPORT_STORAGE_KEY, sport) } catch { /* ignore */ }
  await nextTick()
  renderChart()
})

onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
})
</script>

<template>
  <div>
    <div v-if="loading" class="text-muted d-flex align-items-center gap-2 py-4">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('performance.loading') }}</span>
    </div>

    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>

    <div v-else-if="data && data.count === 0" class="alert alert-info d-flex align-items-center gap-2">
      <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
      <span>{{ t('performance.no_data') }}</span>
    </div>

    <template v-else-if="data && group">
      <!-- Onglets par sport -->
      <ul class="nav nav-pills flex-wrap gap-2 mb-4 performance-sport-tabs">
        <li v-for="tab in tabs" :key="tab.key" class="nav-item">
          <button
            type="button"
            class="nav-link d-flex align-items-center gap-2"
            :class="{ active: selectedSport === tab.key }"
            @click="selectSport(tab.key)"
          >
            <i :class="`fa-solid ${sportIcon(tab.key)}`" aria-hidden="true"></i>
            <span>{{ sportLabel(tab.key) }}</span>
            <span class="badge rounded-pill performance-tab-count">{{ tab.count }}</span>
          </button>
        </li>
      </ul>

      <!-- Cumuls -->
      <div class="row g-3 mb-4">
        <div v-for="card in totalsCards" :key="card.label" class="col-6 col-lg-3">
          <div class="card shadow-sm border-0 h-100">
            <div class="card-body text-center py-3">
              <i :class="`fa-solid ${card.icon} text-warning fs-4 mb-2`" aria-hidden="true"></i>
              <div class="fs-4 fw-bold">{{ card.value }}</div>
              <div class="text-muted small">{{ card.label }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Records absolus -->
      <h2 class="h5 d-flex align-items-center gap-2 mb-3">
        <i class="fa-solid fa-medal text-warning" aria-hidden="true"></i>
        <span>{{ t('performance.records.title') }}</span>
      </h2>
      <div v-if="group.records.length" class="row g-3 mb-4">
        <div v-for="rec in group.records" :key="rec.key" class="col-12 col-md-6 col-xl-4">
          <a :href="activityHref(rec.activity)" class="card shadow-sm border-0 h-100 text-decoration-none text-reset performance-record-card">
            <div class="card-body d-flex align-items-center gap-3">
              <span class="performance-record-badge">
                <i :class="`fa-solid ${recordIcon(rec.key)}`" aria-hidden="true"></i>
              </span>
              <div class="flex-grow-1 min-w-0">
                <div class="text-muted small">{{ t(`performance.records.${rec.key}`) }}</div>
                <div class="fs-4 fw-bold">{{ formatValue(rec.unit, rec.value) }}</div>
                <div class="small text-truncate">
                  {{ rec.activity.name }}
                  <span v-if="rec.activity.started_at" class="text-muted">· {{ formatDate(rec.activity.started_at) }}</span>
                </div>
              </div>
              <i class="fa-solid fa-chevron-right text-muted" aria-hidden="true"></i>
            </div>
          </a>
        </div>
      </div>
      <p v-else class="text-muted">{{ t('performance.no_records') }}</p>

      <!-- Courbe puissance max / temps -->
      <template v-if="hasPeakPower">
        <h2 class="h5 d-flex align-items-center gap-2 mb-3">
          <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
          <span>{{ t('performance.peak_power.title') }}</span>
        </h2>
        <div class="card shadow-sm border-0 mb-4">
          <div class="card-body">
            <p class="text-muted small mb-2">
              {{ t('performance.peak_power.subtitle') }}
              <span class="ms-1"><i class="fa-solid fa-hand-pointer me-1" aria-hidden="true"></i>{{ t('performance.peak_power.click_hint') }}</span>
            </p>
            <div class="performance-chart-wrap">
              <canvas ref="chartCanvas"></canvas>
            </div>
          </div>
        </div>
      </template>

      <!-- FTP & progression (vélo uniquement). Placé AVANT « Forme & fatigue » car la
           FTP alimente le calcul de la charge (TSS ← IF = NP/FTP) : on montre d'abord
           le seuil, puis l'état de forme qui en découle. -->
      <FtpPanel v-if="selectedSport === 'all' || selectedSport === 'cycling'" />

      <!-- Forme & fatigue : charge globale (tous sports), donc affichée sur chaque
           onglet. Sans v-if lié au sport, le panneau reste monté et ne se recharge pas
           à chaque changement d'onglet. -->
      <TrainingLoadPanel :admin="props.admin" />

      <!-- Meilleures périodes -->
      <template v-if="periodCards.length">
        <h2 class="h5 d-flex align-items-center gap-2 mb-3">
          <i class="fa-solid fa-calendar-check text-warning" aria-hidden="true"></i>
          <span>{{ t('performance.periods.title') }}</span>
        </h2>
        <div class="row g-3 mb-4">
          <div v-for="(p, i) in periodCards" :key="i" class="col-12 col-md-6 col-xl-3">
            <div class="card shadow-sm border-0 h-100">
              <div class="card-body">
                <div class="text-muted small d-flex align-items-center gap-2">
                  <i :class="`fa-solid ${p.icon}`" aria-hidden="true"></i>{{ p.label }}
                </div>
                <div class="fs-5 fw-bold text-capitalize">{{ p.period }}</div>
                <div class="text-warning fw-semibold">{{ p.value }}</div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Historique par année -->
      <template v-if="group.by_year.length">
        <h2 class="h5 d-flex align-items-center gap-2 mb-3">
          <i class="fa-solid fa-chart-column text-warning" aria-hidden="true"></i>
          <span>{{ t('performance.by_year.title') }}</span>
        </h2>
        <div class="card shadow-sm border-0 mb-2">
          <div class="table-responsive">
            <table class="table table-sm mb-0 align-middle">
              <thead>
                <tr>
                  <th>{{ t('performance.by_year.year') }}</th>
                  <th class="text-end">{{ t('performance.by_year.count') }}</th>
                  <th class="text-end">{{ t('performance.totals.distance') }}</th>
                  <th class="text-end">{{ t('performance.totals.elevation') }}</th>
                  <th class="text-end">{{ t('performance.totals.time') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in group.by_year" :key="row.year">
                  <td class="fw-semibold">{{ row.year }}</td>
                  <td class="text-end">{{ row.count }}</td>
                  <td class="text-end">{{ formatDistanceKm(row.distance_m) }}</td>
                  <td class="text-end">{{ Math.round(row.elevation).toLocaleString() }} m</td>
                  <td class="text-end">{{ formatDuration(row.moving_time_s) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.performance-sport-tabs .nav-link {
  border: 1px solid var(--bs-border-color);
  color: var(--bs-body-color);
}
.performance-sport-tabs .nav-link.active {
  background-color: #fc4c02;
  border-color: #fc4c02;
  color: #fff;
}
.performance-tab-count {
  background: rgba(0, 0, 0, 0.12);
  font-size: 0.7rem;
}
.performance-sport-tabs .nav-link.active .performance-tab-count {
  background: rgba(255, 255, 255, 0.28);
}
.performance-record-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: rgba(252, 76, 2, 0.12);
  color: #fc4c02;
  font-size: 1.1rem;
}
.performance-record-card {
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.performance-record-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.12) !important;
}
.performance-chart-wrap {
  position: relative;
  height: 320px;
}
.min-w-0 {
  min-width: 0;
}
</style>
