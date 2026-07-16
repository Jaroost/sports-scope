<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'
import { activityIcon, sportType } from '../activityHelpers'
import ActivitiesOverviewMap from './ActivitiesOverviewMap.vue'

const props = defineProps({
  endpoint: { type: String, default: '/strava/activities' },
})

// Bascule liste / carte d'ensemble. La carte n'est chargée qu'à l'ouverture, et
// récupère toutes les sorties du filtre courant (pas seulement la page affichée).
const view = ref('list')
const mapActivities = ref([])
const mapLoading = ref(false)
const mapLoaded = ref(false)
const mapCapped = ref(false)

const loading = ref(true) // requête en cours (initiale ou refetch après filtre/page)
const hasLoaded = ref(false) // au moins une requête réussie
const error = ref(null)
const activities = ref([]) // page courante renvoyée par le serveur
const cachedAt = ref(null)
const total = ref(null) // total historique (toutes activités, sans filtre)

const title = computed(() => t('strava.recent_activities'))
const emptyText = computed(() => t('strava.no_activities'))

// --- Filtres + pagination (pilotés côté serveur) ---
const showFilters = ref(false)
const sportFilter = ref('')
const minDistance = ref(null) // km
const maxDistance = ref(null)
const minElevation = ref(null) // m
const maxElevation = ref(null)
const minDuration = ref(null) // min
const maxDuration = ref(null)
const dateFrom = ref('') // yyyy-mm-dd
const dateTo = ref('')

// Liste des sports de tout l'historique, fournie par le serveur — alimente le menu.
const sportOptions = ref([])

// Pagination — page/nombre de pages renvoyés par le serveur.
const page = ref(1)
const perPage = ref(50)
const totalPages = ref(0)
const filteredTotal = ref(0) // nombre d'activités correspondant aux filtres

function isSet(v) {
  return v !== null && v !== undefined && v !== ''
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

// --- Raccourcis de période (année/mois courant ou précédent) ---
function pad2(n) {
  return String(n).padStart(2, '0')
}
function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// Lundi (00:00 locale) de la semaine contenant `d` — semaines ISO lundi→dimanche.
function mondayOf(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (date.getDay() + 6) % 7 // 0 = lundi
  date.setDate(date.getDate() - dow)
  return date
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

// Renvoie l'intervalle [from, to] (dates locales) correspondant à un raccourci.
function datePresetRange(preset) {
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

function setDatePreset(preset) {
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

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

// Paramètres de filtre communs à la liste et à la carte.
function filterParams() {
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
  return p
}

// Construit la query string à partir des filtres actifs + pagination.
function buildQuery() {
  const p = filterParams()
  p.set('page', String(page.value))
  p.set('per', String(perPage.value))
  return p.toString()
}

// Récupère les tracés de toutes les sorties du filtre (pas de pagination) pour la
// carte d'ensemble. Le serveur plafonne le nombre renvoyé (MAX_MAP_ACTIVITIES).
async function fetchMapActivities() {
  mapLoading.value = true
  try {
    const p = filterParams()
    p.set('map', '1')
    const res = await fetch(`${props.endpoint}?${p.toString()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    mapActivities.value = payload.activities || []
    mapCapped.value = (payload.filtered_total ?? 0) > (payload.max ?? Infinity)
    mapLoaded.value = true
    error.value = null
  } catch (e) {
    error.value = e.message
  } finally {
    mapLoading.value = false
  }
}

// Sert la liste depuis la base ; la (re)synchronisation Strava est déclenchée par le
// bouton « Tout rafraîchir » voisin (composant StravaBackfill → POST /strava/refresh).
async function fetchActivities() {
  loading.value = true
  try {
    const res = await fetch(`${props.endpoint}?${buildQuery()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    activities.value = payload.activities || []
    cachedAt.value = payload.cached_at || null
    total.value = payload.total ?? activities.value.length
    filteredTotal.value = payload.filtered_total ?? activities.value.length
    totalPages.value = payload.total_pages ?? 1
    perPage.value = payload.per_page ?? perPage.value
    // Le serveur borne la page dans [1, total_pages] : on resynchronise l'état local.
    if (payload.page) page.value = payload.page
    if (payload.sports) sportOptions.value = payload.sports
    error.value = null
    hasLoaded.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// ─── Persistance des filtres + vue (localStorage) ────────────────────────────
// Les filtres et la vue choisie (liste/carte) sont mémorisés d'une visite à
// l'autre. La restauration se fait avant l'enregistrement des watchers pour ne
// pas déclencher de requête superflue : le fetch initial (onMounted) part déjà
// avec les filtres restaurés.
const STORAGE_KEY = 'sportsScope.activitiesFilters'

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    if (typeof s.sport === 'string') sportFilter.value = s.sport
    if (s.minDistance != null) minDistance.value = s.minDistance
    if (s.maxDistance != null) maxDistance.value = s.maxDistance
    if (s.minElevation != null) minElevation.value = s.minElevation
    if (s.maxElevation != null) maxElevation.value = s.maxElevation
    if (s.minDuration != null) minDuration.value = s.minDuration
    if (s.maxDuration != null) maxDuration.value = s.maxDuration
    if (typeof s.dateFrom === 'string') dateFrom.value = s.dateFrom
    if (typeof s.dateTo === 'string') dateTo.value = s.dateTo
    if (s.view === 'list' || s.view === 'map') view.value = s.view
    if (typeof s.showFilters === 'boolean') showFilters.value = s.showFilters
  } catch { /* ignore — corrompu ou indisponible */ }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sport: sportFilter.value,
      minDistance: minDistance.value,
      maxDistance: maxDistance.value,
      minElevation: minElevation.value,
      maxElevation: maxElevation.value,
      minDuration: minDuration.value,
      maxDuration: maxDuration.value,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      view: view.value,
      showFilters: showFilters.value,
    }))
  } catch { /* ignore */ }
}

loadPersisted()

// Un changement de filtre ramène à la page 1 puis refetch, avec un léger debounce
// pour ne pas requêter à chaque frappe dans les champs numériques/date. La carte
// est marquée périmée : rechargée aussitôt si affichée, sinon à sa réouverture.
let filterTimer
function onFilterChange() {
  page.value = 1
  mapLoaded.value = false
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    fetchActivities()
    if (view.value === 'map') fetchMapActivities()
  }, 350)
}

watch(
  [sportFilter, minDistance, maxDistance, minElevation, maxElevation, minDuration, maxDuration, dateFrom, dateTo],
  onFilterChange,
)

// À l'ouverture de la carte, charge les tracés si on ne les a pas déjà (ou s'ils
// sont périmés après un changement de filtre).
watch(view, (v) => {
  if (v === 'map' && !mapLoaded.value && !mapLoading.value) fetchMapActivities()
})

// Mémorise l'état (filtres + vue + panneau) à chaque changement.
watch(
  [sportFilter, minDistance, maxDistance, minElevation, maxElevation, minDuration, maxDuration,
    dateFrom, dateTo, view, showFilters],
  persist,
)

function goToPage(p) {
  if (p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
  fetchActivities()
}

onMounted(() => {
  fetchActivities()
  // Vue carte restaurée : la watch(view) ne se déclenche pas au montage, on charge
  // donc les tracés explicitement.
  if (view.value === 'map') fetchMapActivities()
})

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(2)} km`
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}

function formatCachedAt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function tssHint(source) {
  const key = source === 'power' ? 'tss_hint_power' : source === 'hr' ? 'tss_hint_hr' : 'tss_hint_estimated'
  return t(`strava.${key}`)
}

// Couleur d'un segment de l'aperçu selon la catégorie de pente calculée côté
// serveur : 1 = montée (rouge), 2 = descente (bleu), 0 = plat (gris neutre).
// Mêmes teintes que la liste des itinéraires (RoutesList).
function gradeColor(cat) {
  if (cat === 1) return '#e0503f'
  if (cat === 2) return '#2f8fed'
  return '#9aa0a6'
}

</script>

<template>
  <div class="card shadow-sm border-0">
    <div class="card-header activity-card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <h2 class="h5 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
        <span>{{ title }}</span>
        <span v-if="total !== null" class="badge rounded-pill text-bg-secondary" :title="t('strava.activity_count')">{{ total }}</span>
      </h2>
      <div class="d-flex align-items-center flex-wrap gap-2 gap-md-3">
        <div class="btn-group btn-group-sm" role="group" :aria-label="title">
          <button
            type="button"
            class="btn d-flex align-items-center gap-1"
            :class="view === 'list' ? 'btn-warning' : 'btn-outline-secondary'"
            :aria-pressed="view === 'list'"
            @click="view = 'list'"
          >
            <i class="fa-solid fa-list-ul" aria-hidden="true"></i>
            <span>{{ t('routes.view_list') }}</span>
          </button>
          <button
            type="button"
            class="btn d-flex align-items-center gap-1"
            :class="view === 'map' ? 'btn-warning' : 'btn-outline-secondary'"
            :aria-pressed="view === 'map'"
            @click="view = 'map'"
          >
            <i class="fa-solid fa-map-location-dot" aria-hidden="true"></i>
            <span>{{ t('routes.view_map') }}</span>
          </button>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          :class="{ active: showFilters }"
          :aria-expanded="showFilters"
          @click="showFilters = !showFilters"
        >
          <i class="fa-solid fa-filter" aria-hidden="true"></i>
          <span>{{ t('strava.filters.toggle') }}</span>
          <span v-if="activeFilterCount" class="badge rounded-pill text-bg-warning">{{ activeFilterCount }}</span>
        </button>
        <small v-if="cachedAt" class="text-muted d-flex align-items-center gap-1" :title="t('strava.last_updated')">
          <i class="fa-regular fa-clock" aria-hidden="true"></i>
          <span class="d-none d-md-inline">{{ t('strava.last_updated') }}</span>
          {{ formatCachedAt(cachedAt) }}
        </small>
      </div>
    </div>
    <div v-if="showFilters && hasLoaded && !error" class="card-body border-bottom activity-filters">
      <div class="row g-3">
        <div class="col-12 col-md-4">
          <label class="form-label small mb-1">{{ t('strava.filters.sport') }}</label>
          <select v-model="sportFilter" class="form-select form-select-sm">
            <option value="">{{ t('strava.filters.all_sports') }}</option>
            <option v-for="s in sportOptions" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div class="col-6 col-md-4">
          <label class="form-label small mb-1">{{ t('strava.filters.distance') }}</label>
          <div class="d-flex align-items-center gap-1">
            <input v-model="minDistance" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('strava.filters.min')" />
            <span class="text-muted">–</span>
            <input v-model="maxDistance" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('strava.filters.max')" />
          </div>
        </div>
        <div class="col-6 col-md-4">
          <label class="form-label small mb-1">{{ t('strava.filters.elevation') }}</label>
          <div class="d-flex align-items-center gap-1">
            <input v-model="minElevation" type="number" min="0" step="10" class="form-control form-control-sm" :placeholder="t('strava.filters.min')" />
            <span class="text-muted">–</span>
            <input v-model="maxElevation" type="number" min="0" step="10" class="form-control form-control-sm" :placeholder="t('strava.filters.max')" />
          </div>
        </div>
        <div class="col-6 col-md-4">
          <label class="form-label small mb-1">{{ t('strava.filters.duration') }}</label>
          <div class="d-flex align-items-center gap-1">
            <input v-model="minDuration" type="number" min="0" step="5" class="form-control form-control-sm" :placeholder="t('strava.filters.min')" />
            <span class="text-muted">–</span>
            <input v-model="maxDuration" type="number" min="0" step="5" class="form-control form-control-sm" :placeholder="t('strava.filters.max')" />
          </div>
        </div>
        <div class="col-6 col-md-4">
          <label class="form-label small mb-1">{{ t('strava.filters.from') }}</label>
          <input v-model="dateFrom" type="date" class="form-control form-control-sm" />
        </div>
        <div class="col-6 col-md-4">
          <label class="form-label small mb-1">{{ t('strava.filters.to') }}</label>
          <input v-model="dateTo" type="date" class="form-control form-control-sm" />
        </div>
        <div class="col-12">
          <label class="form-label small mb-1">{{ t('strava.filters.period') }}</label>
          <div class="d-flex flex-wrap gap-2">
            <button
              v-for="preset in datePresets"
              :key="preset"
              type="button"
              class="btn btn-sm btn-outline-secondary"
              :class="{ active: activeDatePreset === preset }"
              @click="setDatePreset(preset)"
            >
              {{ t(`strava.filters.${preset}`) }}
            </button>
          </div>
        </div>
      </div>
      <div class="d-flex justify-content-between align-items-center mt-3">
        <small class="text-muted d-flex align-items-center gap-2">
          <span
            v-if="loading"
            class="spinner-border spinner-border-sm text-warning"
            aria-hidden="true"
          ></span>
          {{ t('strava.filters.results', { count: filteredTotal, total: total ?? 0 }) }}
        </small>
        <button
          type="button"
          class="btn btn-sm btn-link text-decoration-none"
          :disabled="!activeFilterCount"
          @click="clearFilters"
        >
          <i class="fa-solid fa-xmark me-1" aria-hidden="true"></i>{{ t('strava.filters.clear') }}
        </button>
      </div>
    </div>
    <div v-if="view === 'map'" class="card-body p-2">
      <div v-if="mapCapped" class="alert alert-info d-flex align-items-center gap-2 py-2 px-3 mb-2 small">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        <span>{{ t('strava.map_capped') }}</span>
      </div>
      <div v-if="mapLoading && !mapLoaded" class="text-muted d-flex align-items-center gap-2 p-2">
        <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
        <span>Loading…</span>
      </div>
      <ActivitiesOverviewMap
        v-else
        :activities="mapActivities"
        :locale-prefix="localePrefix"
      />
    </div>
    <div v-show="view === 'list'" class="card-body">
      <div v-if="loading && !hasLoaded" class="text-muted d-flex align-items-center gap-2">
        <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
        <span>Loading…</span>
      </div>
      <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>{{ error }}</span>
      </div>
      <div v-else-if="total === 0" class="text-muted d-flex align-items-center gap-2">
        <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
        <span>{{ emptyText }}</span>
      </div>
      <div v-else-if="filteredTotal === 0" class="text-muted d-flex align-items-center gap-2">
        <i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i>
        <span>{{ t('strava.filters.none_match') }}</span>
      </div>
      <ul v-else class="list-unstyled mb-0 d-flex flex-column gap-1" :class="{ 'opacity-50': loading }">
        <li
          v-for="activity in activities"
          :key="activity.id"
        >
          <a
            :href="`${localePrefix}/activities/${activity.id}`"
            class="activity-row d-flex justify-content-between align-items-center text-decoration-none text-reset"
          >
            <div class="d-flex align-items-center gap-3">
              <span
                v-if="activity.preview_segments && activity.preview_segments.length"
                class="activity-track-preview"
                :title="sportType(activity)"
              >
                <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                  <path
                    v-for="(s, i) in activity.preview_segments"
                    :key="i"
                    :d="s.d"
                    fill="none"
                    :stroke="gradeColor(s.c)"
                    stroke-width="6"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                </svg>
                <span class="activity-track-preview__badge">
                  <i :class="`fa-solid ${activityIcon(sportType(activity))}`" aria-hidden="true"></i>
                </span>
              </span>
              <span v-else class="activity-type-badge">
                <i :class="`fa-solid ${activityIcon(sportType(activity))}`" aria-hidden="true"></i>
              </span>
              <div>
                <div class="fw-semibold">{{ activity.name }}</div>
                <small class="text-muted">
                  <i class="fa-solid fa-tag me-1" aria-hidden="true"></i>{{ sportType(activity) }}
                  <span class="mx-1">·</span>
                  <i class="fa-regular fa-calendar me-1" aria-hidden="true"></i>{{ new Date(activity.start_date_local).toLocaleDateString() }}
                  <span v-if="formatDaysAgo(activity.start_date_local)" class="days-ago-badge ms-1">{{ formatDaysAgo(activity.start_date_local) }}</span>
                </small>
              </div>
            </div>
            <div class="d-flex align-items-center gap-3">
              <span
                v-if="activity.tss != null"
                class="tss-badge"
                :class="`tss-badge--${activity.tss_source || 'estimated'}`"
                :title="tssHint(activity.tss_source)"
              >
                <span class="tss-value">{{ Math.round(activity.tss) }}</span>
                <span class="tss-unit">{{ t('strava.tss_label') }}</span>
              </span>
              <div class="text-start activity-metrics">
                <!-- Distance masquée à 0 : une activité sans GPS (squash, muscu…) n'en a pas,
                     et « 0.00 km » se lit comme une mesure alors qu'il n'y a rien à mesurer. -->
                <div v-if="activity.distance" class="fw-semibold">
                  <i class="fa-solid fa-route me-1 text-warning" aria-hidden="true"></i>{{ formatDistance(activity.distance) }}
                </div>
                <small class="text-muted">
                  <i class="fa-regular fa-clock me-1" aria-hidden="true"></i>{{ formatDuration(activity.moving_time) }}
                </small>
              </div>
            </div>
          </a>
        </li>
      </ul>
      <nav v-if="hasLoaded && !error && totalPages > 1" class="d-flex justify-content-between align-items-center mt-3" :aria-label="t('strava.filters.title')">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          :disabled="page <= 1 || loading"
          @click="goToPage(page - 1)"
        >
          <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
          <span>{{ t('strava.pagination.prev') }}</span>
        </button>
        <small class="text-muted">{{ t('strava.pagination.page', { page, total: totalPages }) }}</small>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          :disabled="page >= totalPages || loading"
          @click="goToPage(page + 1)"
        >
          <span>{{ t('strava.pagination.next') }}</span>
          <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
        </button>
      </nav>
    </div>
  </div>
</template>

<style scoped>
/* Bloc chiffré de droite (distance + durée). Sa taille est réservée pour deux lignes,
   même quand la distance est masquée (activité sans GPS) : sans ça, le bloc rétrécit et
   la pastille TSS qui le précède remonte et se décale d'une ligne à l'autre. La largeur
   couvre la plus longue distance plausible (« 999.99 km » + icône).
   Contenu calé à gauche : les durées ont des largeurs très variables (« 45min » vs
   « 1h 05min ») — alignées à droite, leurs icônes se décalaient à chaque ligne. */
.activity-metrics {
  min-width: 6.5rem;
  min-height: 2.75rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  flex-shrink: 0;
}

/* Vignette du tracé : même encombrement que le badge d'activité (2.25rem), coin
   arrondi. Les teintes des segments (montée/descente/plat) portent le dénivelé,
   comme la liste des itinéraires. */
.activity-track-preview {
  position: relative;
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.04));
}
.activity-track-preview svg {
  width: 100%;
  height: 100%;
}

/* Pastille d'icône du type d'activité, superposée en bas à droite de la
   vignette : conserve l'identification du sport en plus du tracé. */
.activity-track-preview__badge {
  position: absolute;
  right: -0.25rem;
  bottom: -0.25rem;
  width: 1.15rem;
  height: 1.15rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(13, 110, 253, 0.1);
  color: #0d6efd;
  font-size: 0.65rem;
  border: 1.5px solid var(--bs-body-bg, #fff);
}
</style>
