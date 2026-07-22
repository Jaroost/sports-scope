<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'
import { activityIcon, sportType } from '../activityHelpers'
import { useStickyListHeader } from '../composables/useStickyListHeader'
import ActivitiesOverviewMap from './ActivitiesOverviewMap.vue'
import ActivityThumb from './ActivityThumb.vue'

const props = defineProps({
  endpoint: { type: String, default: '/strava/activities' },
})

// Header collé sous la navbar ; expose --sticky-header-h pour borner le panneau
// de filtres en superposition.
const { stickyEl } = useStickyListHeader()

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
const total = ref(null) // total historique (toutes activités, sans filtre)

const title = computed(() => t('strava.recent_activities'))
const emptyText = computed(() => t('strava.no_activities'))

// --- Filtres + pagination (pilotés côté serveur) ---
const showFilters = ref(false)
const search = ref('') // nom de la sortie ou lieu traversé
const sportFilter = ref('')
const gearFilter = ref('') // gear_id Strava (vélo ou chaussure)
const deviceFilter = ref('') // matériel d'enregistrement (device_name)
const minDistance = ref(null) // km
const maxDistance = ref(null)
const minElevation = ref(null) // m
const maxElevation = ref(null)
const minDuration = ref(null) // min
const maxDuration = ref(null)
const dateFrom = ref('') // yyyy-mm-dd
const dateTo = ref('')

// Sports de tout l'historique, fournis par le serveur — alimentent le menu : les
// types Strava bruts (« Ride », « VirtualRide »…) et les catégories qui les
// regroupent (« cycling »…), comme les onglets de la page performance.
const sportOptions = ref([])
const sportCategoryOptions = ref([])

// Matériel présent dans l'historique, fourni par le serveur : liste
// { id: gear_id, name, type } (type ∈ bike|shoe) pour le menu déroulant du filtre,
// groupée par type. `deviceOptions` : noms d'appareils d'enregistrement (device_name).
const gearOptions = ref([])
const deviceOptions = ref([])
const bikeGears = computed(() => gearOptions.value.filter((g) => g.type === 'bike'))
const shoeGears = computed(() => gearOptions.value.filter((g) => g.type === 'shoe'))

// Une catégorie est portée par le même `sportFilter` qu'un type brut, préfixée pour
// les distinguer : un seul état à mémoriser, réinitialiser et compter.
const SPORT_CATEGORY_PREFIX = 'cat:'
function sportCategoryLabel(key) {
  return t(`performance.sports.${key}`)
}

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
  if (search.value.trim()) n++
  if (sportFilter.value) n++
  if (gearFilter.value) n++
  if (deviceFilter.value) n++
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

// Badge du header : « filtrées / total » dès qu'un filtre restreint la liste,
// sinon le seul total historique.
const countBadge = computed(() => {
  if (total.value === null) return null
  if (!activeFilterCount.value) return String(total.value)
  return `${filteredTotal.value} / ${total.value}`
})

function clearFilters() {
  search.value = ''
  sportFilter.value = ''
  gearFilter.value = ''
  deviceFilter.value = ''
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
  if (search.value.trim()) p.set('q', search.value.trim())
  if (sportFilter.value.startsWith(SPORT_CATEGORY_PREFIX)) {
    p.set('sport_category', sportFilter.value.slice(SPORT_CATEGORY_PREFIX.length))
  } else if (sportFilter.value) {
    p.set('sport', sportFilter.value)
  }
  if (gearFilter.value) p.set('gear', gearFilter.value)
  if (deviceFilter.value) p.set('device', deviceFilter.value)
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
    total.value = payload.total ?? activities.value.length
    filteredTotal.value = payload.filtered_total ?? activities.value.length
    totalPages.value = payload.total_pages ?? 1
    perPage.value = payload.per_page ?? perPage.value
    // Le serveur borne la page dans [1, total_pages] : on resynchronise l'état local.
    if (payload.page) page.value = payload.page
    if (payload.sports) sportOptions.value = payload.sports
    if (payload.sport_categories) sportCategoryOptions.value = payload.sport_categories
    if (payload.gears) gearOptions.value = payload.gears
    if (payload.devices) deviceOptions.value = payload.devices
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
    if (typeof s.search === 'string') search.value = s.search
    if (typeof s.sport === 'string') sportFilter.value = s.sport
    if (typeof s.gear === 'string') gearFilter.value = s.gear
    if (typeof s.device === 'string') deviceFilter.value = s.device
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
      search: search.value,
      sport: sportFilter.value,
      gear: gearFilter.value,
      device: deviceFilter.value,
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

// Filtres passés dans l'URL (liens « meilleures périodes » de la page performance) :
// ils l'emportent sur les filtres mémorisés — on repart d'une ardoise vide pour que
// la liste corresponde exactement à ce qui a été cliqué, sans filtre résiduel invisible.
function applyUrlFilters() {
  const p = new URLSearchParams(window.location.search)
  const keys = ['q', 'sport', 'sport_category', 'gear', 'device', 'min_dist', 'max_dist', 'min_elev', 'max_elev', 'min_dur', 'max_dur', 'from', 'to']
  if (!keys.some((k) => p.has(k))) return false

  clearFilters()
  const num = (key) => {
    const raw = p.get(key)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  search.value = p.get('q') || ''
  const category = p.get('sport_category')
  sportFilter.value = p.get('sport') || (category ? SPORT_CATEGORY_PREFIX + category : '')
  gearFilter.value = p.get('gear') || ''
  deviceFilter.value = p.get('device') || ''
  minDistance.value = num('min_dist')
  maxDistance.value = num('max_dist')
  minElevation.value = num('min_elev')
  maxElevation.value = num('max_elev')
  minDuration.value = num('min_dur')
  maxDuration.value = num('max_dur')
  dateFrom.value = p.get('from') || ''
  dateTo.value = p.get('to') || ''
  // Panneau replié : on arrive ici pour voir les activités, pas les filtres (le
  // compteur du bouton signale déjà qu'il y en a d'actifs).
  showFilters.value = false
  return true
}

loadPersisted()
if (applyUrlFilters()) persist() // sinon un rechargement sans query string ressortirait les anciens filtres

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
  [search, sportFilter, gearFilter, deviceFilter, minDistance, maxDistance, minElevation, maxElevation, minDuration, maxDuration, dateFrom, dateTo],
  onFilterChange,
)

// À l'ouverture de la carte, charge les tracés si on ne les a pas déjà (ou s'ils
// sont périmés après un changement de filtre).
watch(view, (v) => {
  if (v === 'map' && !mapLoaded.value && !mapLoading.value) fetchMapActivities()
})

// Mémorise l'état (filtres + vue + panneau) à chaque changement.
watch(
  [search, sportFilter, gearFilter, deviceFilter, minDistance, maxDistance, minElevation, maxElevation, minDuration, maxDuration,
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

function tssHint(source) {
  const key = source === 'power' ? 'tss_hint_power' : source === 'hr' ? 'tss_hint_hr' : 'tss_hint_estimated'
  return t(`strava.${key}`)
}

// Vignette (tracé et/ou photos) plutôt que la simple pastille de sport : il faut
// au moins une vue à montrer. Sans tracé ni photo, on retombe sur la pastille.
function hasThumb(activity) {
  return activity.preview_segments?.length > 0 || activity.photo_thumbs?.length > 0
}

</script>

<template>
  <div class="card shadow-sm border-0">
    <div ref="stickyEl" class="activity-sticky-top">
      <div class="card-header activity-card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h2 class="h5 mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
          <span>{{ title }}</span>
          <span v-if="countBadge" class="badge rounded-pill text-bg-secondary" :title="t('strava.activity_count')">{{ countBadge }}</span>
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
          <div class="btn-group btn-group-sm">
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
            <!-- Réinitialisation à portée de main, sans avoir à déplier le panneau.
                 Affiché seulement quand il y a quelque chose à réinitialiser. -->
            <button
              v-if="activeFilterCount"
              type="button"
              class="btn btn-sm btn-danger d-flex align-items-center"
              :title="t('strava.filters.clear')"
              :aria-label="t('strava.filters.clear')"
              @click="clearFilters"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>
      <div v-if="showFilters && hasLoaded && !error" class="card-body border-bottom activity-filters-overlay">
        <div class="row g-3">
          <div class="col-12 col-md-4">
            <label class="form-label small mb-1">{{ t('strava.filters.search') }}</label>
            <input
              v-model="search"
              type="search"
              class="form-control form-control-sm"
              :placeholder="t('strava.filters.search_placeholder')"
            />
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label small mb-1">{{ t('strava.filters.sport') }}</label>
            <select v-model="sportFilter" class="form-select form-select-sm">
              <option value="">{{ t('strava.filters.all_sports') }}</option>
              <optgroup v-if="sportCategoryOptions.length" :label="t('strava.filters.sport_categories')">
                <option
                  v-for="c in sportCategoryOptions"
                  :key="c"
                  :value="SPORT_CATEGORY_PREFIX + c"
                >{{ sportCategoryLabel(c) }}</option>
              </optgroup>
              <optgroup :label="t('strava.filters.sport_types')">
                <option v-for="s in sportOptions" :key="s" :value="s">{{ s }}</option>
              </optgroup>
            </select>
          </div>
          <!-- Matériel : n'apparaît que si l'historique contient du matériel identifié.
               Groupé par type (vélos / chaussures). -->
          <div v-if="gearOptions.length" class="col-12 col-md-4">
            <label class="form-label small mb-1">{{ t('strava.filters.gear') }}</label>
            <select v-model="gearFilter" class="form-select form-select-sm">
              <option value="">{{ t('strava.filters.all_gears') }}</option>
              <optgroup v-if="bikeGears.length" :label="t('strava.filters.gear_bikes')">
                <option v-for="g in bikeGears" :key="g.id" :value="g.id">{{ g.name }}</option>
              </optgroup>
              <optgroup v-if="shoeGears.length" :label="t('strava.filters.gear_shoes')">
                <option v-for="g in shoeGears" :key="g.id" :value="g.id">{{ g.name }}</option>
              </optgroup>
            </select>
          </div>
          <!-- Matériel d'enregistrement : n'apparaît que si des appareils sont connus
               (remplis à l'ouverture des activités et par « Tout rafraîchir »). -->
          <div v-if="deviceOptions.length" class="col-12 col-md-4">
            <label class="form-label small mb-1">{{ t('strava.filters.device') }}</label>
            <select v-model="deviceFilter" class="form-select form-select-sm">
              <option value="">{{ t('strava.filters.all_devices') }}</option>
              <option v-for="d in deviceOptions" :key="d" :value="d">{{ d }}</option>
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
          <div class="d-flex align-items-center gap-2">
            <button
              type="button"
              class="btn btn-sm btn-link text-decoration-none"
              :disabled="!activeFilterCount"
              @click="clearFilters"
            >
              <i class="fa-solid fa-xmark me-1" aria-hidden="true"></i>{{ t('strava.filters.clear') }}
            </button>
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
              @click="showFilters = false"
            >
              <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
              <span>{{ t('strava.filters.close') }}</span>
            </button>
          </div>
        </div>
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
          v-for="(activity, rowIndex) in activities"
          :key="activity.id"
        >
          <a
            :href="`${localePrefix}/activities/${activity.id}`"
            class="activity-row d-flex justify-content-between align-items-center text-decoration-none text-reset"
          >
            <div class="activity-row__main d-flex align-items-center gap-3">
              <ActivityThumb
                v-if="hasThumb(activity)"
                :preview-segments="activity.preview_segments"
                :photos="activity.photo_thumbs"
                :icon-class="activityIcon(sportType(activity))"
                :label="sportType(activity)"
                :index="rowIndex"
              />
              <span v-else class="activity-type-badge">
                <i :class="`fa-solid ${activityIcon(sportType(activity))}`" aria-hidden="true"></i>
              </span>
              <div class="min-width-0">
                <div class="fw-semibold">{{ activity.name }}</div>
                <small class="text-muted">
                  <i class="fa-solid fa-tag me-1" aria-hidden="true"></i>{{ sportType(activity) }}
                  <span class="mx-1">·</span>
                  <i class="fa-regular fa-calendar me-1" aria-hidden="true"></i>{{ new Date(activity.start_date_local).toLocaleDateString() }}
                  <span v-if="formatDaysAgo(activity.start_date_local)" class="days-ago-badge ms-1">{{ formatDaysAgo(activity.start_date_local) }}</span>
                </small>
              </div>
            </div>
            <div class="activity-row__stats d-flex align-items-center gap-3">
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
/* Header collé sous la navbar `fixed-top` (offset `--navbar-h`, hauteur réelle
   mesurée par trackNavbar — la navbar wrappe sur deux lignes avec beaucoup de
   menus ; fallback 3.5rem) : la liste est longue, on garde le titre, le compteur et la
   bascule liste/carte sous la main pendant le défilement. Le conteneur ne réserve
   que la hauteur du header — le panneau de filtres, hors flux, flotte par-dessus la
   liste (voir .activity-filters-overlay).
   - fond opaque : `card-header` est semi-transparent, la liste défilerait au travers ;
   - z-index : au-dessus des lignes de la liste et du canvas MapLibre de la vue carte. */
.activity-sticky-top {
  position: sticky;
  top: var(--navbar-h, 3.5rem);
  z-index: 5;
  background: var(--bs-card-bg, var(--bs-body-bg));
}

/* Panneau de filtres en superposition, ancré sous le header. Sorti du flux pour ne
   pas rogner la hauteur visible de la liste : celle-ci défile derrière lui.
   - max-height + overflow : sur mobile le panneau dépasse l'écran, et son bas
     deviendrait inaccessible (le défilement de la page ne le ramène pas, il est
     collé au header). `--sticky-header-h` est mesurée par useStickyListHeader ;
     le repli couvre le header sur une ligne, avant la première mesure.
   - ombre : marque le détachement au-dessus de la liste. */
.activity-filters-overlay {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--bs-card-bg, var(--bs-body-bg));
  box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.15);
  max-height: calc(100dvh - var(--navbar-h, 3.5rem) - var(--sticky-header-h, 3.5rem));
  overflow-y: auto;
}

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

.min-width-0 {
  min-width: 0;
}

/* Sur téléphone, la ligne d'activité tient mal sur une seule rangée : le nom, le
   sport, la date, le TSS, la distance et la durée se serrent tous côte à côte. On
   passe en trois rangées — nom / sport + date / mesures — en laissant le bloc de
   droite passer à la ligne sous la vignette et le texte. */
@media (max-width: 575.98px) {
  .activity-row {
    flex-wrap: wrap;
    row-gap: 0.5rem;
  }
  .activity-row__main {
    width: 100%;
  }
  .activity-row__stats {
    width: 100%;
    justify-content: flex-start;
  }
  /* Distance et durée côte à côte : elles partagent la rangée avec le TSS, plus
     besoin de les empiler. */
  .activity-row__stats .activity-metrics {
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    min-height: 0;
  }
}
</style>
