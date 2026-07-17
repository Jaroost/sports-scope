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
  total_count: number
  sport_types: string[]
}

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<Payload | null>(null)
const hasLoaded = ref(false) // au moins une requête réussie (garde le panneau visible pendant les refetch)

// ── Filtres (mêmes que la liste du dashboard, pilotés côté serveur) ───────────
const showFilters = ref(false)
const sportFilter = ref('')
const minDistance = ref<number | null>(null) // km
const maxDistance = ref<number | null>(null)
const minElevation = ref<number | null>(null) // m
const maxElevation = ref<number | null>(null)
const minDuration = ref<number | null>(null) // min
const maxDuration = ref<number | null>(null)
const dateFrom = ref('') // yyyy-mm-dd
const dateTo = ref('')

// Liste des types de sport de tout l'historique, fournie par le serveur.
const sportOptions = ref<string[]>([])

function isSet(v: number | null): boolean {
  return v !== null && v !== undefined && (v as unknown as string) !== ''
}

const activeFilterCount = computed(() => {
  let n = 0
  if (sportFilter.value) n++
  if (isSet(minDistance.value)) n++
  if (isSet(maxDistance.value)) n++
  if (isSet(minElevation.value)) n++
  if (isSet(maxElevation.value)) n++
  if (isSet(minDuration.value)) n++
  if (isSet(maxDuration.value)) n++
  if (dateFrom.value) n++
  if (dateTo.value) n++
  return n
})

function clearFilters() {
  sportFilter.value = ''
  minDistance.value = null
  maxDistance.value = null
  minElevation.value = null
  maxElevation.value = null
  minDuration.value = null
  maxDuration.value = null
  dateFrom.value = ''
  dateTo.value = ''
}

// ── Raccourcis de période (année/mois courant ou précédent) ──────────────────
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// Lundi (00:00 locale) de la semaine contenant `d` — semaines ISO lundi→dimanche.
function mondayOf(d: Date): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (date.getDay() + 6) % 7 // 0 = lundi
  date.setDate(date.getDate() - dow)
  return date
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

// Renvoie l'intervalle [from, to] (dates locales) correspondant à un raccourci.
function datePresetRange(preset: string): [Date, Date] | null {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const monday = mondayOf(now)
  switch (preset) {
    case 'current_week':
      return [monday, addDays(monday, 6)]
    case 'previous_week':
      return [addDays(monday, -7), addDays(monday, -1)]
    case 'current_year':
      return [new Date(y, 0, 1), new Date(y, 11, 31)]
    case 'current_month':
      return [new Date(y, m, 1), new Date(y, m + 1, 0)]
    case 'previous_year':
      return [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)]
    case 'previous_month':
      return [new Date(y, m - 1, 1), new Date(y, m, 0)]
    default:
      return null
  }
}

const datePresets = ['current_week', 'previous_week', 'current_month', 'previous_month', 'current_year', 'previous_year']

function setDatePreset(preset: string) {
  const range = datePresetRange(preset)
  if (!range) return
  dateFrom.value = isoDate(range[0])
  dateTo.value = isoDate(range[1])
}

// Raccourci actuellement actif (pour surligner le bouton), ou null.
const activeDatePreset = computed(() => {
  if (!dateFrom.value || !dateTo.value) return null
  return (
    datePresets.find((preset) => {
      const range = datePresetRange(preset)
      return range && isoDate(range[0]) === dateFrom.value && isoDate(range[1]) === dateTo.value
    }) || null
  )
})

// Construit la query string à partir des filtres actifs.
function buildQuery(): string {
  const p = new URLSearchParams()
  if (sportFilter.value) p.set('sport', sportFilter.value)
  if (isSet(minDistance.value)) p.set('min_dist', String(minDistance.value))
  if (isSet(maxDistance.value)) p.set('max_dist', String(maxDistance.value))
  if (isSet(minElevation.value)) p.set('min_elev', String(minElevation.value))
  if (isSet(maxElevation.value)) p.set('max_elev', String(maxElevation.value))
  if (isSet(minDuration.value)) p.set('min_dur', String(minDuration.value))
  if (isSet(maxDuration.value)) p.set('max_dur', String(maxDuration.value))
  if (dateFrom.value) p.set('from', dateFrom.value)
  if (dateTo.value) p.set('to', dateTo.value)
  return p.toString()
}

// Onglet de sport sélectionné, mémorisé en localStorage (comme l'onglet d'activité
// dans ActivityDetail) pour retrouver le même sport au rechargement.
const SPORT_STORAGE_KEY = 'sportsScope.performanceSport'
const storedSport = (typeof localStorage !== 'undefined' && localStorage.getItem(SPORT_STORAGE_KEY)) || 'all'
const selectedSport = ref(storedSport)

// ── Onglets principaux : ce qui suit les filtres vs ce qui n'en dépend pas ───
// « Records & volumes » agrège les activités renvoyées par /api/performance, donc
// les filtres s'y appliquent. « Forme & seuils » (FTP, charge d'entraînement) est
// calculé sur tout l'historique par ses propres panneaux : les filtres n'y changent
// rien, d'où la séparation en deux onglets pour lever l'ambiguïté.
const MAIN_TABS = [
  { key: 'records', icon: 'fa-medal' },
  { key: 'fitness', icon: 'fa-heart-pulse' },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

const TAB_STORAGE_KEY = 'sportsScope.performanceTab'
const storedTab = (typeof localStorage !== 'undefined' && localStorage.getItem(TAB_STORAGE_KEY)) || 'records'
const activeTab = ref<MainTab>(storedTab === 'fitness' ? 'fitness' : 'records')

watch(activeTab, (tab) => {
  try { localStorage.setItem(TAB_STORAGE_KEY, tab) } catch { /* ignore */ }
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

async function fetchData() {
  loading.value = true
  try {
    const query = buildQuery()
    const res = await fetch(`/api/performance${query ? `?${query}` : ''}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as Payload
    sportOptions.value = data.value.sport_types || []
    // Le sport mémorisé peut ne plus exister (aucune activité de ce type, filtres inclus) : repli sur « Tout ».
    if (!data.value.by_sport[selectedSport.value]) selectedSport.value = 'all'
    error.value = null
    hasLoaded.value = true
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

// Un changement de filtre relance la requête, avec un léger debounce pour ne pas
// requêter à chaque frappe dans les champs numériques/date.
let filterTimer: ReturnType<typeof setTimeout> | undefined
watch(
  [sportFilter, minDistance, maxDistance, minElevation, maxElevation, minDuration, maxDuration, dateFrom, dateTo],
  () => {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(fetchData, 350)
  },
)

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

// Intervalle [from, to] (ISO) couvrant le seau : une année pleine, ou le mois
// « YYYY-MM » du premier au dernier jour.
function bucketRange(label: string | number, monthly: boolean): [string, string] | null {
  const s = String(label)
  if (monthly) {
    const m = s.match(/^(\d{4})-(\d{2})$/)
    if (!m) return null
    const year = Number(m[1])
    const month = Number(m[2]) - 1
    return [isoDate(new Date(year, month, 1)), isoDate(new Date(year, month + 1, 0))]
  }
  if (!/^\d{4}$/.test(s)) return null
  const year = Number(s)
  return [isoDate(new Date(year, 0, 1)), isoDate(new Date(year, 11, 31))]
}

// Lien vers la liste du dashboard filtrée sur la période du seau : on repart des
// filtres actifs (le seau a été calculé sur ces mêmes activités), on remplace les
// bornes de dates, et on ajoute l'onglet de sport courant. `sport_category` regroupe
// les `activity_type` comme les onglets ici ; le filtre `sport` (type exact) du
// panneau reste prioritaire côté serveur, on ne l'ajoute donc que s'il est absent.
function periodHref(label: string | number, monthly: boolean): string | null {
  const range = bucketRange(label, monthly)
  if (!range) return null
  const p = new URLSearchParams(buildQuery())
  p.set('from', range[0])
  p.set('to', range[1])
  if (!sportFilter.value && selectedSport.value !== 'all') p.set('sport_category', selectedSport.value)
  return `${localePrefix}/dashboard?${p.toString()}`
}

// Lignes de l'historique par année : même destination que les cartes de période.
function yearHref(year: number): string | null {
  return periodHref(year, false)
}

// Clic n'importe où sur la ligne (le lien sur l'année couvre le clavier). On laisse
// passer les clics sur le lien lui-même et les clics modifiés (ctrl/cmd = nouvel
// onglet), que le navigateur gère mieux que nous.
function openYear(year: number, evt: MouseEvent) {
  if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return
  if ((evt.target as HTMLElement | null)?.closest('a')) return
  const href = yearHref(year)
  if (href) window.location.href = href
}

// Meilleures périodes présentées comme une liste ordonnée.
const periodCards = computed(() => {
  const bp = group.value?.best_periods
  if (!bp) return []
  const items: { icon: string; label: string; period: string; value: string; href: string | null }[] = []
  const push = (bucket: Bucket | null | undefined, icon: string, labelKey: string, unit: 'distance' | 'elevation', monthly: boolean) => {
    if (!bucket) return
    items.push({
      icon,
      label: t(labelKey),
      period: monthly ? formatMonthLabel(bucket.label) : String(bucket.label),
      value: unit === 'distance' ? formatDistanceKm(bucket.value) : `${Math.round(bucket.value).toLocaleString()} m`,
      href: periodHref(bucket.label, monthly),
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
      // Le point le plus proche en X répond au survol, sans avoir à le toucher.
      interaction: { mode: 'index', intersect: false },
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
    <div v-if="loading && !hasLoaded" class="text-muted d-flex align-items-center gap-2 py-4">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('performance.loading') }}</span>
    </div>

    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>

    <div v-else-if="data && data.total_count === 0" class="alert alert-info d-flex align-items-center gap-2">
      <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
      <span>{{ t('performance.no_data') }}</span>
    </div>

    <template v-else-if="data">
      <!-- Onglets principaux : pastilles comme sur le tableau de bord. -->
      <div class="btn-group btn-group-sm mb-3 dashboard-tabs" role="tablist" :aria-label="t('performance.title')">
        <button
          v-for="tab in MAIN_TABS"
          :key="tab.key"
          type="button"
          class="btn btn-outline-secondary dashboard-tab d-flex align-items-center gap-1"
          :class="{ active: activeTab === tab.key }"
          role="tab"
          :aria-selected="activeTab === tab.key"
          @click="activeTab = tab.key"
        >
          <i :class="`fa-solid ${tab.icon}`" aria-hidden="true"></i>
          <span>{{ t(`performance.tabs.${tab.key}`) }}</span>
        </button>
      </div>
      <p class="text-muted small">
        {{ activeTab === 'records' ? t('performance.tabs.records_hint') : t('performance.tabs.fitness_hint') }}
      </p>

      <!-- Les deux panneaux restent montés (v-show) : basculer d'onglet ne relance
           ni le chargement de FtpPanel/TrainingLoadPanel ni le rendu du graphique. -->
      <div v-show="activeTab === 'records'">
      <!-- Barre + panneau de filtres collés ensemble : ils pilotent tous deux le
           contenu qui défile dessous. Un seul conteneur sticky pour les deux —
           empiler deux sticky obligerait à caler le panneau sur la hauteur de la
           barre, valeur en dur qui casserait dès que la barre change de taille
           (onglets de sport qui passent sur deux lignes). -->
      <div class="performance-filters-sticky">
        <!-- Barre : onglets de sport à gauche, bouton « Filtrer » à droite. -->
        <div class="performance-sticky-bar d-flex justify-content-between align-items-center gap-3 py-2 mb-3">
          <ul v-if="tabs.length" class="nav nav-pills flex-wrap gap-2 mb-0 performance-sport-tabs">
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
          <div class="btn-group btn-group-sm ms-auto flex-shrink-0">
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
              :class="{ active: showFilters }"
              :aria-expanded="showFilters"
              @click="showFilters = !showFilters"
            >
              <i class="fa-solid fa-filter" aria-hidden="true"></i>
              <span>{{ t('performance.filters.toggle') }}</span>
              <span v-if="activeFilterCount" class="badge rounded-pill text-bg-warning">{{ activeFilterCount }}</span>
            </button>
            <!-- Réinitialisation à portée de main, sans avoir à déplier le panneau.
                 Affiché seulement quand il y a quelque chose à réinitialiser. -->
            <button
              v-if="activeFilterCount"
              type="button"
              class="btn btn-sm btn-danger d-flex align-items-center"
              :title="t('performance.filters.clear')"
              :aria-label="t('performance.filters.clear')"
              @click="clearFilters"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div v-if="showFilters" class="card shadow-sm border-0 mb-4 activity-filters">
          <div class="card-body">
            <div class="row g-3">
              <div class="col-12 col-md-4">
                <label class="form-label small mb-1">{{ t('performance.filters.sport') }}</label>
                <select v-model="sportFilter" class="form-select form-select-sm">
                  <option value="">{{ t('performance.filters.all_sports') }}</option>
                  <option v-for="s in sportOptions" :key="s" :value="s">{{ s }}</option>
                </select>
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small mb-1">{{ t('performance.filters.distance') }}</label>
                <div class="d-flex align-items-center gap-1">
                  <input v-model.number="minDistance" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('performance.filters.min')" />
                  <span class="text-muted">–</span>
                  <input v-model.number="maxDistance" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('performance.filters.max')" />
                </div>
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small mb-1">{{ t('performance.filters.elevation') }}</label>
                <div class="d-flex align-items-center gap-1">
                  <input v-model.number="minElevation" type="number" min="0" step="10" class="form-control form-control-sm" :placeholder="t('performance.filters.min')" />
                  <span class="text-muted">–</span>
                  <input v-model.number="maxElevation" type="number" min="0" step="10" class="form-control form-control-sm" :placeholder="t('performance.filters.max')" />
                </div>
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small mb-1">{{ t('performance.filters.duration') }}</label>
                <div class="d-flex align-items-center gap-1">
                  <input v-model.number="minDuration" type="number" min="0" step="5" class="form-control form-control-sm" :placeholder="t('performance.filters.min')" />
                  <span class="text-muted">–</span>
                  <input v-model.number="maxDuration" type="number" min="0" step="5" class="form-control form-control-sm" :placeholder="t('performance.filters.max')" />
                </div>
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small mb-1">{{ t('performance.filters.from') }}</label>
                <input v-model="dateFrom" type="date" class="form-control form-control-sm" />
              </div>
              <div class="col-6 col-md-4">
                <label class="form-label small mb-1">{{ t('performance.filters.to') }}</label>
                <input v-model="dateTo" type="date" class="form-control form-control-sm" />
              </div>
              <div class="col-12">
                <label class="form-label small mb-1">{{ t('performance.filters.period') }}</label>
                <div class="d-flex flex-wrap gap-2">
                  <button
                    v-for="preset in datePresets"
                    :key="preset"
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    :class="{ active: activeDatePreset === preset }"
                    @click="setDatePreset(preset)"
                  >
                    {{ t(`performance.filters.${preset}`) }}
                  </button>
                </div>
              </div>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-3">
              <small class="text-muted d-flex align-items-center gap-2">
                <span v-if="loading" class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
                {{ t('performance.filters.results', { count: data.count, total: data.total_count }) }}
              </small>
              <div class="d-flex align-items-center gap-2">
                <button
                  type="button"
                  class="btn btn-sm btn-link text-decoration-none"
                  :disabled="!activeFilterCount"
                  @click="clearFilters"
                >
                  <i class="fa-solid fa-xmark me-1" aria-hidden="true"></i>{{ t('performance.filters.clear') }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                  @click="showFilters = false"
                >
                  <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                  <span>{{ t('performance.filters.close') }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Aucune activité ne correspond aux filtres actifs -->
      <div v-if="data.count === 0" class="alert alert-info d-flex align-items-center gap-2">
        <i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i>
        <span>{{ t('performance.filters.none_match') }}</span>
      </div>

      <template v-else-if="group">
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

      <!-- Meilleures périodes -->
      <template v-if="periodCards.length">
        <h2 class="h5 d-flex align-items-center gap-2 mb-3">
          <i class="fa-solid fa-calendar-check text-warning" aria-hidden="true"></i>
          <span>{{ t('performance.periods.title') }}</span>
        </h2>
        <div class="row g-3 mb-4">
          <div v-for="(p, i) in periodCards" :key="i" class="col-12 col-md-6 col-xl-3">
            <!-- Carte cliquable → liste des activités de cette période. `component`
                 dynamique : sans lien exploitable (étiquette inattendue) on retombe
                 sur une simple carte non cliquable. -->
            <component
              :is="p.href ? 'a' : 'div'"
              :href="p.href || undefined"
              class="card shadow-sm border-0 h-100 text-decoration-none text-reset"
              :class="{ 'performance-record-card': p.href }"
            >
              <div class="card-body">
                <div class="text-muted small d-flex align-items-center gap-2">
                  <i :class="`fa-solid ${p.icon}`" aria-hidden="true"></i>{{ p.label }}
                </div>
                <div class="fs-5 fw-bold text-capitalize d-flex align-items-center justify-content-between gap-2">
                  <span>{{ p.period }}</span>
                  <i v-if="p.href" class="fa-solid fa-chevron-right text-muted fs-6" aria-hidden="true"></i>
                </div>
                <div class="text-warning fw-semibold">{{ p.value }}</div>
              </div>
            </component>
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
                <!-- Ligne cliquable → activités de l'année. Le lien porté par la
                     cellule « année » assure l'accès clavier ; le clic sur le reste
                     de la ligne est un raccourci à la souris. -->
                <tr
                  v-for="row in group.by_year"
                  :key="row.year"
                  :class="{ 'performance-year-row': yearHref(row.year) }"
                  @click="openYear(row.year, $event)"
                >
                  <td class="fw-semibold">
                    <a
                      v-if="yearHref(row.year)"
                      :href="yearHref(row.year) || undefined"
                      class="text-reset text-decoration-none d-inline-flex align-items-center gap-2"
                    >
                      {{ row.year }}
                      <i class="fa-solid fa-chevron-right text-muted small" aria-hidden="true"></i>
                    </a>
                    <template v-else>{{ row.year }}</template>
                  </td>
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

      <div v-show="activeTab === 'fitness'">
        <!-- FTP & progression (vélo). Placé AVANT « Forme & fatigue » car la FTP
             alimente le calcul de la charge (TSS ← IF = NP/FTP) : on montre d'abord
             le seuil, puis l'état de forme qui en découle. -->
        <FtpPanel />
        <TrainingLoadPanel :admin="props.admin" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Barre + panneau de filtres collés sous la navbar `fixed-top` (3.5rem, même
   offset que le header de ActivityCharts) : les onglets de sport, le bouton
   « Filtrer » et les champs du panneau restent atteignables pendant le défilement
   des records et des graphiques.
   max-height + overflow : panneau déplié, l'ensemble dépasse la hauteur d'écran sur
   mobile, et un élément sticky plus haut que la fenêtre laisse son bas inaccessible. */
.performance-filters-sticky {
  position: sticky;
  top: 3.5rem;
  z-index: 5;
  background: var(--bs-body-bg);
  max-height: calc(100dvh - 3.5rem);
  overflow-y: auto;
}

.performance-sticky-bar {
  background: var(--bs-body-bg);
  border-bottom: 1px solid var(--bs-border-color);
}

/* Sur mobile, les onglets défilent horizontalement plutôt que de passer à la ligne :
   une barre sticky sur plusieurs lignes mangerait la moitié de l'écran. */
@media (max-width: 767px) {
  .performance-sticky-bar .performance-sport-tabs {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .performance-sticky-bar .performance-sport-tabs::-webkit-scrollbar {
    display: none;
  }
  .performance-sticky-bar .nav-item {
    flex: 0 0 auto;
  }
}

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
.performance-year-row {
  cursor: pointer;
}
.performance-year-row:hover {
  background: rgba(252, 76, 2, 0.06);
}
.performance-chart-wrap {
  position: relative;
  height: 320px;
}
.min-w-0 {
  min-width: 0;
}
</style>
