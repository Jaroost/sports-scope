<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'

const props = defineProps({
  endpoint: { type: String, default: '/strava/activities' },
})

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

// Renvoie l'intervalle [from, to] (dates locales) correspondant à un raccourci.
function datePresetRange(preset) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (preset) {
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

const datePresets = ['current_year', 'current_month', 'previous_year', 'previous_month']

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

// Construit la query string à partir des filtres actifs + pagination.
function buildQuery() {
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
  p.set('page', String(page.value))
  p.set('per', String(perPage.value))
  return p.toString()
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

// Un changement de filtre ramène à la page 1 puis refetch, avec un léger debounce
// pour ne pas requêter à chaque frappe dans les champs numériques/date.
let filterTimer
function onFilterChange() {
  page.value = 1
  clearTimeout(filterTimer)
  filterTimer = setTimeout(fetchActivities, 350)
}

watch(
  [sportFilter, minDistance, maxDistance, minElevation, maxElevation, minDuration, maxDuration, dateFrom, dateTo],
  onFilterChange,
)

function goToPage(p) {
  if (p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
  fetchActivities()
}

onMounted(() => fetchActivities())

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

function activityIcon(type) {
  const t = (type || '').toLowerCase()
  if (t.includes('run')) return 'fa-person-running'
  if (t.includes('ride') || t.includes('cycl') || t.includes('bike') || t.includes('velo')) return 'fa-person-biking'
  if (t.includes('swim')) return 'fa-person-swimming'
  if (t.includes('walk') || t.includes('hike')) return 'fa-person-hiking'
  if (t.includes('ski')) return 'fa-person-skiing'
  if (t.includes('row')) return 'fa-water'
  if (t.includes('yoga')) return 'fa-spa'
  if (t.includes('workout') || t.includes('weight')) return 'fa-dumbbell'
  return 'fa-bolt'
}
</script>

<template>
  <div class="card shadow-sm border-0">
    <div class="card-header activity-card-header d-flex justify-content-between align-items-center">
      <h2 class="h5 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
        <span>{{ title }}</span>
        <span v-if="total !== null" class="badge rounded-pill text-bg-secondary" :title="t('strava.activity_count')">{{ total }}</span>
      </h2>
      <div class="d-flex align-items-center gap-3">
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
        <small v-if="cachedAt" class="text-muted d-flex align-items-center gap-1">
          <i class="fa-regular fa-clock" aria-hidden="true"></i>
          {{ t('strava.last_updated') }} {{ formatCachedAt(cachedAt) }}
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
    <div class="card-body">
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
                :title="activity.type"
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
                  <i :class="`fa-solid ${activityIcon(activity.type)}`" aria-hidden="true"></i>
                </span>
              </span>
              <span v-else class="activity-type-badge">
                <i :class="`fa-solid ${activityIcon(activity.type)}`" aria-hidden="true"></i>
              </span>
              <div>
                <div class="fw-semibold">{{ activity.name }}</div>
                <small class="text-muted">
                  <i class="fa-solid fa-tag me-1" aria-hidden="true"></i>{{ activity.type }}
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
              <div class="text-end">
                <div class="fw-semibold">
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
