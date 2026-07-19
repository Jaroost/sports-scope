<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, watch } from 'vue'
import { t } from '../i18n'
import { speedForSport, persistSportSpeed, isLoggedIn, SPORTS } from '../userPreferences'
import type { Sport } from '../userPreferences'
import { buildNewRouteUrl } from '../routeHelpers'
import { useAthleteState, speedSuggestionFor } from '../composables/useAthleteState'
import { usePlannedRides } from '../composables/usePlannedRides'
import { estimateRouteLoad } from '../routeLoad'
import { FEAS_COLOR, mondayOf, isoLocal } from '../composables/useTrainingPlan'
import { parseGpxWaypoints, GpxImportError } from '../gpxImport'
import { useStickyListHeader } from '../composables/useStickyListHeader'
import NewRouteModal from './NewRouteModal.vue'
import RoutesOverviewMap from './RoutesOverviewMap.vue'

// canDense : réservé aux admins (can :manage, :all). Débloque l'export d'un GPX
// densifié (1 point / 5 m) — utile pour les simulateurs de position GPS, à éviter
// pour les vraies montres (limite de points). Voir routes_controller#gpx (?step).
const props = defineProps<{ canDense?: boolean }>()

// Header collé sous la navbar ; expose --sticky-header-h pour borner le panneau
// de filtres en superposition.
const { stickyEl } = useStickyListHeader()

const routes = ref([]) // page courante renvoyée par le serveur
const loading = ref(true) // requête en cours (initiale ou refetch après filtre/page)
const hasLoaded = ref(false) // au moins une requête réussie
const error = ref(null)
const total = ref(0) // total historique (tous itinéraires, sans filtre)
const filteredTotal = ref(0) // nombre d'itinéraires correspondant aux filtres

// Bascule liste / carte d'ensemble. La carte n'est montée que quand on l'ouvre,
// et reçoit tous les itinéraires du filtre (pas seulement la page affichée).
// La vue choisie est mémorisée d'une visite à l'autre (localStorage).
const VIEW_STORAGE_KEY = 'sportsScope.routesView'
const view = ref<'list' | 'map'>('list')
try {
  const saved = localStorage.getItem(VIEW_STORAGE_KEY)
  if (saved === 'list' || saved === 'map') view.value = saved
} catch { /* ignore — localStorage indisponible */ }
watch(view, (v) => {
  try { localStorage.setItem(VIEW_STORAGE_KEY, v) } catch { /* ignore */ }
})

const mapRoutes = ref([])
const mapLoading = ref(false)
const mapLoaded = ref(false)
const mapCapped = ref(false)

// ─── Filtres + pagination (pilotés côté serveur) ──────────────────────────────
const showFilters = ref(false)
// Panneau paramètres (vitesses moyennes du profil), distinct des filtres. Les deux
// sont des overlays ancrés sous le même header : mutuellement exclusifs pour ne pas
// se superposer.
const showSettings = ref(false)
function toggleFilters() {
  showFilters.value = !showFilters.value
  if (showFilters.value) showSettings.value = false
}
function toggleSettings() {
  showSettings.value = !showSettings.value
  if (showSettings.value) showFilters.value = false
}
const search = ref('')
const sportFilter = ref('')
const minDistance = ref(null) // km
const maxDistance = ref(null)
const minElevation = ref(null) // m
const maxElevation = ref(null)
const dateFrom = ref('') // yyyy-mm-dd, sur updated_at
const dateTo = ref('')

// Types présents dans tout l'historique, fournis par le serveur — alimentent le
// menu. Repli sur le catalogue complet tant que rien n'est chargé.
const activityOptions = ref<Sport[]>([])

// Pagination — page/nombre de pages renvoyés par le serveur.
const page = ref(1)
const perPage = ref(20)
const totalPages = ref(0)

function isSet(v) {
  return v !== null && v !== undefined && v !== ''
}

const activeFilterCount = computed(() => {
  let n = 0
  if (search.value.trim()) n++
  if (sportFilter.value) n++
  if (isSet(minDistance.value)) n++
  if (isSet(maxDistance.value)) n++
  if (isSet(minElevation.value)) n++
  if (isSet(maxElevation.value)) n++
  if (dateFrom.value) n++
  if (dateTo.value) n++
  return n
})

// Badge du header : « filtrés / total » dès qu'un filtre restreint la liste,
// sinon le seul total historique.
const countBadge = computed(() => {
  if (!activeFilterCount.value) return String(total.value)
  return `${filteredTotal.value} / ${total.value}`
})

function clearFilters() {
  search.value = ''
  sportFilter.value = ''
  minDistance.value = null
  maxDistance.value = null
  minElevation.value = null
  maxElevation.value = null
  dateFrom.value = ''
  dateTo.value = ''
}

// --- Raccourcis de période (semaine/mois/année courante ou précédente) ---
// `mondayOf` / `isoLocal` viennent de useTrainingPlan : mêmes semaines ISO
// lundi→dimanche et même date locale que la barre de charge, une seule définition.
function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function datePresetRange(preset: string): [Date, Date] | null {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const monday = mondayOf(now)
  switch (preset) {
    case 'current_week': return [monday, addDays(monday, 6)]
    case 'previous_week': return [addDays(monday, -7), addDays(monday, -1)]
    case 'current_month': return [new Date(y, m, 1), new Date(y, m + 1, 0)]
    case 'previous_month': return [new Date(y, m - 1, 1), new Date(y, m, 0)]
    case 'current_year': return [new Date(y, 0, 1), new Date(y, 11, 31)]
    case 'previous_year': return [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)]
    default: return null
  }
}

const datePresets = ['current_week', 'previous_week', 'current_month', 'previous_month', 'current_year', 'previous_year']

function setDatePreset(preset: string) {
  const range = datePresetRange(preset)
  if (!range) return
  dateFrom.value = isoLocal(range[0])
  dateTo.value = isoLocal(range[1])
}

// Raccourci actuellement actif (pour surligner le bouton), ou null.
const activeDatePreset = computed(() => {
  if (!dateFrom.value || !dateTo.value) return null
  return datePresets.find((preset) => {
    const range = datePresetRange(preset)
    return range && isoLocal(range[0]) === dateFrom.value && isoLocal(range[1]) === dateTo.value
  }) || null
})

// Paramètres de filtre communs à la liste et à la carte. Les bornes de date
// portent sur `updated_at` (dernière modification), la date affichée sur chaque
// ligne ; `to` est inclusif côté serveur.
function filterParams() {
  const p = new URLSearchParams()
  if (search.value.trim()) p.set('q', search.value.trim())
  if (sportFilter.value) p.set('sport', sportFilter.value)
  if (isSet(minDistance.value)) p.set('min_dist', String(minDistance.value))
  if (isSet(maxDistance.value)) p.set('max_dist', String(maxDistance.value))
  if (isSet(minElevation.value)) p.set('min_elev', String(minElevation.value))
  if (isSet(maxElevation.value)) p.set('max_elev', String(maxElevation.value))
  if (dateFrom.value) p.set('from', dateFrom.value)
  if (dateTo.value) p.set('to', dateTo.value)
  return p
}

// Mémorise les filtres + l'état du panneau d'une visite à l'autre. La
// restauration se fait avant l'enregistrement des watchers pour ne pas
// déclencher de requête superflue : le fetch initial (onMounted) part déjà avec
// les filtres restaurés.
const FILTERS_STORAGE_KEY = 'sportsScope.routesFilters'
try {
  const raw = localStorage.getItem(FILTERS_STORAGE_KEY)
  if (raw) {
    const s = JSON.parse(raw)
    if (typeof s.search === 'string') search.value = s.search
    if (typeof s.sport === 'string') sportFilter.value = s.sport
    if (s.minDistance != null) minDistance.value = s.minDistance
    if (s.maxDistance != null) maxDistance.value = s.maxDistance
    if (s.minElevation != null) minElevation.value = s.minElevation
    if (s.maxElevation != null) maxElevation.value = s.maxElevation
    if (typeof s.dateFrom === 'string') dateFrom.value = s.dateFrom
    if (typeof s.dateTo === 'string') dateTo.value = s.dateTo
    if (typeof s.showFilters === 'boolean') showFilters.value = s.showFilters
  }
} catch { /* ignore — corrompu ou indisponible */ }

watch(
  [search, sportFilter, minDistance, maxDistance, minElevation, maxElevation, dateFrom, dateTo, showFilters],
  () => {
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
        search: search.value,
        sport: sportFilter.value,
        minDistance: minDistance.value,
        maxDistance: maxDistance.value,
        minElevation: minElevation.value,
        maxElevation: maxElevation.value,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
        showFilters: showFilters.value,
      }))
    } catch { /* ignore */ }
  },
)

// Itinéraire sélectionné depuis la carte : on revient sur la liste, on défile
// jusqu'à sa ligne et on la fait clignoter le temps de la repérer.
const selectedRouteId = ref(null)
const rowEls = ref({}) // { [routeId]: HTMLElement } — pour le scroll/highlight

function setRowRef(id, el) {
  if (el) rowEls.value[id] = el
  else delete rowEls.value[id]
}

function onSelectRouteFromMap(id) {
  view.value = 'list'
  selectedRouteId.value = id
  nextTick(() => {
    rowEls.value[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => { if (selectedRouteId.value === id) selectedRouteId.value = null }, 2500)
  })
}
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const gpxInputEl = ref(null)
const importingGpx = ref(false)

// Estimation du temps de parcours et icône de la liste : pilotées par la catégorie
// d'activité enregistrée avec chaque itinéraire (cycling | mtb | hiking). La vitesse
// moyenne correspondante vient du profil utilisateur.
function activityOf(r): Sport {
  return r?.activity === 'mtb' || r?.activity === 'hiking' ? r.activity : 'cycling'
}

function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// Couleur d'un segment de l'aperçu selon la catégorie de pente calculée côté
// serveur : 1 = montée (rouge), 2 = descente (bleu), 0 = plat (gris neutre).
// Ces teintes restent lisibles en thème clair comme sombre.
function gradeColor(cat: number) {
  if (cat === 1) return '#e0503f'
  if (cat === 2) return '#2f8fed'
  return '#9aa0a6'
}

// Share feedback: holds the id of the route whose link was just copied, so the
// button can flash a checkmark for a couple of seconds.
const sharedId = ref(null)
// Même mécanique pour le partage du lien « vue en lecture seule » (créateur).
const sharedViewId = ref(null)
// Share GPX file state: holds the id of the route currently being fetched/shared.
const sharingGpxId = ref(null)

// Inline rename state
const editingId = ref(null)
const editingName = ref('')
const savingId = ref(null)
const editInputs = ref({}) // { [routeId]: HTMLInputElement } — for autofocus

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

// Construit la query string à partir des filtres actifs + pagination.
function buildQuery() {
  const p = filterParams()
  p.set('page', String(page.value))
  p.set('per', String(perPage.value))
  return p.toString()
}

async function fetchRoutes() {
  loading.value = true
  try {
    const res = await fetch(`/api/routes?${buildQuery()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    routes.value = Array.isArray(payload.routes) ? payload.routes : []
    total.value = payload.total ?? routes.value.length
    filteredTotal.value = payload.filtered_total ?? routes.value.length
    totalPages.value = payload.total_pages ?? 1
    perPage.value = payload.per_page ?? perPage.value
    // Le serveur borne la page dans [1, total_pages] : on resynchronise l'état local.
    if (payload.page) page.value = payload.page
    if (Array.isArray(payload.activities)) activityOptions.value = payload.activities
    error.value = null
    hasLoaded.value = true
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Récupère les tracés de tous les itinéraires du filtre (hors pagination) pour la
// carte d'ensemble. Le serveur plafonne le nombre renvoyé (MAX_MAP_ROUTES).
async function fetchMapRoutes() {
  mapLoading.value = true
  try {
    const p = filterParams()
    p.set('map', '1')
    const res = await fetch(`/api/routes?${p.toString()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    mapRoutes.value = Array.isArray(payload.routes) ? payload.routes : []
    mapCapped.value = (payload.filtered_total ?? 0) > (payload.max ?? Infinity)
    mapLoaded.value = true
    error.value = null
  } catch (e) {
    error.value = e.message
  } finally {
    mapLoading.value = false
  }
}

// Un changement de filtre ramène à la page 1 puis refetch, avec un léger debounce
// pour ne pas requêter à chaque frappe. La carte est marquée périmée : rechargée
// aussitôt si affichée, sinon à sa réouverture.
let filterTimer
function onFilterChange() {
  page.value = 1
  mapLoaded.value = false
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    fetchRoutes()
    if (view.value === 'map') fetchMapRoutes()
  }, 350)
}

watch(
  [search, sportFilter, minDistance, maxDistance, minElevation, maxElevation, dateFrom, dateTo],
  onFilterChange,
)

// À l'ouverture de la carte, charge les tracés si on ne les a pas déjà (ou s'ils
// sont périmés après un changement de filtre).
watch(view, (v) => {
  if (v === 'map' && !mapLoaded.value && !mapLoading.value) fetchMapRoutes()
})

function goToPage(p) {
  if (p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
  fetchRoutes()
}

// Après une création/suppression, la page courante et les totaux sont périmés :
// on refait la requête plutôt que de rafistoler la liste locale.
function refreshAfterMutation() {
  mapLoaded.value = false
  fetchRoutes()
  if (view.value === 'map') fetchMapRoutes()
}

function startEdit(route) {
  editingId.value = route.id
  editingName.value = route.name || ''
  nextTick(() => {
    const el = editInputs.value[route.id]
    if (el) { el.focus(); el.select() }
  })
}

function cancelEdit() {
  editingId.value = null
  editingName.value = ''
}

async function saveName(route) {
  const newName = editingName.value.trim()
  if (!newName || newName === route.name) { cancelEdit(); return }
  savingId.value = route.id
  try {
    const res = await fetch(`/api/routes/${route.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name: newName }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const updated = payload.route
    const idx = routes.value.findIndex((r) => r.id === route.id)
    if (idx >= 0 && updated) {
      routes.value[idx] = { ...routes.value[idx], name: updated.name }
    }
    cancelEdit()
  } catch (e) {
    error.value = e.message
  } finally {
    savingId.value = null
  }
}

async function removeRoute(route) {
  if (!window.confirm(t('routes.delete_confirm'))) return
  try {
    const res = await fetch(`/api/routes/${route.id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    refreshAfterMutation()
  } catch (e) {
    error.value = e.message
  }
}

async function duplicateRoute(route) {
  const proposed = `${route.name} (copie)`.slice(0, 80)
  const raw = window.prompt(t('routes.duplicate_prompt'), proposed)
  if (raw == null) return
  const name = raw.trim().slice(0, 80) || proposed
  try {
    const res = await fetch(`/api/routes/${route.id}/duplicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    })
    if (!res.ok && res.status !== 201) throw new Error(`HTTP ${res.status}`)
    // La copie est la plus récemment modifiée : elle arrive en tête de la page 1.
    page.value = 1
    refreshAfterMutation()
  } catch (e) {
    error.value = e.message
  }
}

// Share the navigation link (works for signed-out recipients — the navigate
// page and its API are public). Uses the native share sheet on mobile, falling
// back to clipboard copy (then a prompt) on desktop.
async function shareRoute(route) {
  const url = `${window.location.origin}${localePrefix}/routes/${route.share_token}/navigate`
  try {
    if (navigator.share) {
      await navigator.share({ title: route.name, url })
      return
    }
  } catch (e) {
    if (e?.name === 'AbortError') return // user dismissed the share sheet
  }
  try {
    await navigator.clipboard.writeText(url)
    sharedId.value = route.id
    setTimeout(() => { if (sharedId.value === route.id) sharedId.value = null }, 2000)
  } catch {
    window.prompt(t('routes.share'), url)
  }
}

// Partage le lien « vue en lecture seule » : ouvre l'itinéraire dans le créateur,
// non modifiable, accessible sans compte (page + API publiques par jeton).
async function shareViewRoute(route) {
  const url = `${window.location.origin}${localePrefix}/routes/${route.share_token}/view`
  try {
    if (navigator.share) {
      await navigator.share({ title: route.name, url })
      return
    }
  } catch (e) {
    if (e?.name === 'AbortError') return // user dismissed the share sheet
  }
  try {
    await navigator.clipboard.writeText(url)
    sharedViewId.value = route.id
    setTimeout(() => { if (sharedViewId.value === route.id) sharedViewId.value = null }, 2000)
  } catch {
    window.prompt(t('routes.share_view'), url)
  }
}

// Share a public GPX download URL via the Web Share API (Level 1 — works on
// all mobile browsers without file-type restrictions or user-gesture issues).
// Falls back to clipboard copy, then a prompt on desktop.
async function shareGpxFile(route) {
  const url = `${window.location.origin}/api/routes/shared/${route.share_token}/gpx`
  try {
    if (navigator.share) {
      await navigator.share({ title: route.name, url })
      return
    }
  } catch (e) {
    if (e?.name === 'AbortError') return
  }
  try {
    await navigator.clipboard.writeText(url)
    sharingGpxId.value = route.id
    setTimeout(() => { if (sharingGpxId.value === route.id) sharingGpxId.value = null }, 2000)
  } catch {
    window.prompt(t('routes.share_gpx'), url)
  }
}

// ─── Modale « nouvel itinéraire » ─────────────────────────────────────────────
// Partagée entre la création vierge (bouton « Nouveau ») et l'import GPX :
// récupère le nom + le type avant d'ouvrir le créateur. Quand `pendingGpx`
// porte des waypoints, la confirmation finalise plutôt l'import.
const showNewRouteModal = ref(false)
const newRouteName = ref('')
const pendingGpx = ref<{ waypoints: unknown[] } | null>(null)

function createNew() {
  pendingGpx.value = null
  newRouteName.value = ''
  showNewRouteModal.value = true
}

function onNewRouteConfirm({ name, sport, profile }: { name: string; sport: Sport; profile: string }) {
  showNewRouteModal.value = false
  if (pendingGpx.value) {
    sessionStorage.setItem('sportsScope.gpxImport', JSON.stringify({
      name,
      activity: sport,
      profile,
      waypoints: pendingGpx.value.waypoints,
    }))
    pendingGpx.value = null
    window.location.href = `${localePrefix}/routes/new?fromGpx=1`
    return
  }
  window.location.href = buildNewRouteUrl({ name, sport, profile })
}

function onNewRouteClose() {
  showNewRouteModal.value = false
  pendingGpx.value = null
}

// ─── GPX import ──────────────────────────────────────────────────────────────
// Parse client-side, hand the sampled waypoints + a default name to the
// builder via sessionStorage, then redirect to /routes/new?fromGpx=1. The
// builder reads the payload on mount and runs BRouter so the imported route
// gets road-snapping + elevation like a hand-drawn one.
function openGpxPicker() {
  gpxInputEl.value?.click()
}

function onGpxFileChange(ev) {
  const file = ev.target.files?.[0]
  if (file) processGpxFile(file)
  ev.target.value = ''
}

async function processGpxFile(file) {
  error.value = null
  importingGpx.value = true
  try {
    const waypoints = parseGpxWaypoints(await file.text())
    const baseName = file.name.replace(/\.gpx$/i, '').trim().slice(0, 80)
    // On laisse l'utilisateur confirmer/ajuster le nom (pré-rempli avec le nom
    // du fichier) et choisir le type avant d'ouvrir le créateur.
    pendingGpx.value = { waypoints }
    newRouteName.value = baseName
    showNewRouteModal.value = true
  } catch (e) {
    const key = e instanceof GpxImportError && e.code === 'no_points'
      ? 'routes.error_gpx_no_points'
      : 'routes.error_gpx_invalid'
    error.value = t(key)
  } finally {
    importingGpx.value = false
  }
}

function setInputRef(id, el) {
  if (el) editInputs.value[id] = el
  else delete editInputs.value[id]
}

function formatKm(m) {
  if (m == null) return '–'
  return `${(m / 1000).toFixed(1)} km`
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

// ─── Vitesses moyennes du profil ─────────────────────────────────────────────
// Elles pilotent le temps de parcours ET le TSS estimés de chaque itinéraire de la
// liste : on les règle donc ici, là où on lit les chiffres, plutôt qu'en imposant
// un aller-retour par la page profil. Copie réactive locale car `speedForSport`
// lit un cache non réactif : sans elle, les estimations ne se recalculeraient pas.
const speeds = reactive(
  Object.fromEntries(SPORTS.map((s) => [s, speedForSport(s)])) as Record<Sport, number>,
)
const canEditSpeeds = isLoggedIn()
const speedError = ref(false)

// Enregistrement sur le profil, après une pause dans la saisie (le champ change à
// chaque frappe). Une valeur hors bornes n'est pas envoyée : le serveur la
// clamperait et l'affichage mentirait jusqu'au prochain chargement.
let speedTimer
function onSpeedInput(sport) {
  const v = speeds[sport]
  clearTimeout(speedTimer)
  if (!Number.isFinite(v) || v < 3 || v > 80) return
  speedTimer = setTimeout(() => {
    persistSportSpeed(sport, v)
      .then(() => { speedError.value = false })
      .catch(() => { speedError.value = true })
  }, 600)
}

// Vitesse réellement tenue (médiane des sorties vélo), applicable en un clic.
// SPEED_STEP doit rester le `step` du champ (cf. template) : la suggestion y est
// alignée, sinon le navigateur refuse la valeur.
const SPEED_STEP = 0.5

function speedSuggestion(sport) {
  return speedSuggestionFor(athlete.value, sport, speeds[sport], SPEED_STEP)
}

function applySpeedSuggestion(sport) {
  const suggestion = speedSuggestion(sport)
  if (!suggestion) return
  speeds[sport] = suggestion.speed
  onSpeedInput(sport)
}

// Estimated ride time: distance / speed. Mirrors the builder — the chosen
// avg speed already accounts for terrain, so no climb penalty is added.
function estimatedSecondsFor(r) {
  const d = r?.distance_m
  const v = speeds[activityOf(r)]
  if (!d || !Number.isFinite(v) || v <= 0) return 0
  return Math.round(((d / 1000) / v) * 3600)
}

// TSS estimé : même modèle que le créateur (routeLoad.ts), avec la vitesse du
// profil pour le sport de l'itinéraire. null tant que la charge n'est pas chargée
// ou si l'estimation est impossible (compte sans activité) → pastille masquée.
const { athlete } = useAthleteState()

// Indexé par itinéraire : recalculé quand la page change ou quand la charge
// arrive, pas à chaque rendu de ligne.
const routeLoads = computed(() => {
  const out = new Map()
  if (!athlete.value) return out
  for (const r of routes.value) {
    const sport = activityOf(r)
    const load = estimateRouteLoad(
      {
        distanceM: r?.distance_m ?? 0,
        elevGainM: r?.elevation_gain_m ?? 0,
        speedKmh: speeds[sport],
        sport,
      },
      athlete.value,
    )
    if (load) out.set(r.id, load)
  }
  return out
})

// ─── Planification sur la semaine ────────────────────────────────────────────
// Accrocher un itinéraire à un jour depuis la liste : c'est ici qu'on lit son coût,
// donc ici qu'on décide de le caser. La barre de la page performance s'en nourrit.
const { plannedRides, addPlan, removePlan } = usePlannedRides()
const canPlan = isLoggedIn()

// Jours restants de la semaine en cours, aujourd'hui inclus. Le passé n'est plus
// planifiable : sa charge est déjà écrite.
const planDays = computed(() => {
  const today = new Date()
  const sunday = mondayOf(today)
  sunday.setDate(sunday.getDate() + 6)
  const out = []
  for (const d = new Date(today.getFullYear(), today.getMonth(), today.getDate()); d <= sunday; d.setDate(d.getDate() + 1)) {
    out.push({ iso: isoLocal(d), label: d.toLocaleDateString(undefined, { weekday: 'long' }) })
  }
  return out
})

function plannedEntry(routeId, iso) {
  return plannedRides.value.find((p) => p.route.id === routeId && p.planned_on === iso)
}

function isPlanned(routeId, iso) {
  return !!plannedEntry(routeId, iso)
}

// Bascule : un second clic sur un jour déjà coché retire le plan — sans ça, il
// faudrait aller sur la page performance pour corriger une erreur de clic.
function togglePlan(routeId, iso) {
  const existing = plannedEntry(routeId, iso)
  return existing ? removePlan(existing.id) : addPlan(routeId, iso)
}

function formatDuration(totalSec) {
  if (!totalSec || totalSec < 0) return '–'
  const h = Math.floor(totalSec / 3600)
  const m = Math.round((totalSec - h * 3600) / 60)
  if (h === 0) return `${m} min`
  return `${h} h ${String(m).padStart(2, '0')}`
}

onMounted(() => {
  fetchRoutes()
  // Vue carte restaurée : la watch(view) ne se déclenche pas au montage, on charge
  // donc les tracés explicitement.
  if (view.value === 'map') fetchMapRoutes()
})
</script>

<template>
  <div>
    <div class="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-2">
      <h1 class="h3 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>
        {{ t('routes.list_title') }}
      </h1>
      <div class="d-flex align-items-center gap-2">
        <button
          type="button"
          class="btn btn-outline-secondary d-flex align-items-center gap-1"
          :disabled="importingGpx"
          :title="t('routes.import_gpx_title')"
          @click="openGpxPicker"
        >
          <span v-if="importingGpx" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          <i v-else class="fa-solid fa-file-arrow-up" aria-hidden="true"></i>
          <span>{{ t('routes.import_gpx') }}</span>
        </button>
        <button type="button" @click="createNew" class="btn btn-warning d-flex align-items-center gap-1">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
          <span>{{ t('routes.new') }}</span>
        </button>
      </div>
      <input
        ref="gpxInputEl"
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        class="d-none"
        @change="onGpxFileChange"
      />
    </div>

    <div class="card shadow-sm border-0">
      <div ref="stickyEl" class="activity-sticky-top">
        <div class="card-header activity-card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
          <h2 class="h5 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
            <span>{{ t('routes.list_title') }}</span>
            <span v-if="hasLoaded && !error" class="badge rounded-pill text-bg-secondary">{{ countBadge }}</span>
          </h2>
          <div class="d-flex align-items-center gap-3">
            <div class="btn-group btn-group-sm" role="group" :aria-label="t('routes.list_title')">
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
                @click="toggleFilters"
              >
                <i class="fa-solid fa-filter" aria-hidden="true"></i>
                <span>{{ t('routes.filters.toggle') }}</span>
                <span v-if="activeFilterCount" class="badge rounded-pill text-bg-warning">{{ activeFilterCount }}</span>
              </button>
              <!-- Réinitialisation à portée de main, sans avoir à déplier le panneau.
                   Affiché seulement quand il y a quelque chose à réinitialiser. -->
              <button
                v-if="activeFilterCount"
                type="button"
                class="btn btn-sm btn-danger d-flex align-items-center"
                :title="t('routes.filters.clear')"
                :aria-label="t('routes.filters.clear')"
                @click="clearFilters"
              >
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>
            <!-- Paramètres du profil (vitesses moyennes) : réglages, pas des filtres,
                 d'où un bouton dédié. Réservé aux utilisateurs connectés (seul contenu
                 du panneau). -->
            <button
              v-if="canEditSpeeds"
              type="button"
              class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
              :class="{ active: showSettings }"
              :aria-expanded="showSettings"
              :title="t('routes.settings.toggle')"
              @click="toggleSettings"
            >
              <i class="fa-solid fa-gear" aria-hidden="true"></i>
              <span class="d-none d-sm-inline">{{ t('routes.settings.toggle') }}</span>
            </button>
          </div>
        </div>

        <div v-if="showFilters && hasLoaded && !error" class="card-body border-bottom activity-filters-overlay">
          <div class="row g-3">
            <div class="col-12 col-md-4">
              <label class="form-label small mb-1">{{ t('routes.filters.search') }}</label>
              <input
                v-model="search"
                type="search"
                class="form-control form-control-sm"
                :placeholder="t('routes.filters.search_placeholder')"
              />
            </div>
            <div class="col-12 col-md-4">
              <label class="form-label small mb-1">{{ t('routes.filters.sport') }}</label>
              <select v-model="sportFilter" class="form-select form-select-sm">
                <option value="">{{ t('routes.filters.all_sports') }}</option>
                <option v-for="s in activityOptions" :key="s" :value="s">{{ t(`routes.wt_sport_${s}`) }}</option>
              </select>
            </div>
            <div class="col-6 col-md-4">
              <label class="form-label small mb-1">{{ t('routes.filters.distance') }}</label>
              <div class="d-flex align-items-center gap-1">
                <input v-model="minDistance" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('routes.filters.min')" />
                <span class="text-muted">–</span>
                <input v-model="maxDistance" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('routes.filters.max')" />
              </div>
            </div>
            <div class="col-6 col-md-4">
              <label class="form-label small mb-1">{{ t('routes.filters.elevation') }}</label>
              <div class="d-flex align-items-center gap-1">
                <input v-model="minElevation" type="number" min="0" step="10" class="form-control form-control-sm" :placeholder="t('routes.filters.min')" />
                <span class="text-muted">–</span>
                <input v-model="maxElevation" type="number" min="0" step="10" class="form-control form-control-sm" :placeholder="t('routes.filters.max')" />
              </div>
            </div>
            <div class="col-6 col-md-4">
              <label class="form-label small mb-1">{{ t('routes.filters.from') }}</label>
              <input v-model="dateFrom" type="date" class="form-control form-control-sm" />
            </div>
            <div class="col-6 col-md-4">
              <label class="form-label small mb-1">{{ t('routes.filters.to') }}</label>
              <input v-model="dateTo" type="date" class="form-control form-control-sm" />
            </div>
            <div class="col-12">
              <label class="form-label small mb-1">{{ t('routes.filters.period') }}</label>
              <div class="d-flex flex-wrap gap-2">
                <button
                  v-for="preset in datePresets"
                  :key="preset"
                  type="button"
                  class="btn btn-sm btn-outline-secondary"
                  :class="{ active: activeDatePreset === preset }"
                  @click="setDatePreset(preset)"
                >
                  {{ t(`routes.filters.${preset}`) }}
                </button>
              </div>
            </div>
          </div>
          <div class="d-flex justify-content-between align-items-center mt-3">
            <small class="text-muted d-flex align-items-center gap-2">
              <span v-if="loading" class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
              {{ t('routes.filters.results', { count: filteredTotal, total: total }) }}
            </small>
            <div class="d-flex align-items-center gap-2">
              <button
                type="button"
                class="btn btn-sm btn-link text-decoration-none"
                :disabled="!activeFilterCount"
                @click="clearFilters"
              >
                <i class="fa-solid fa-xmark me-1" aria-hidden="true"></i>{{ t('routes.filters.clear') }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                @click="showFilters = false"
              >
                <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                <span>{{ t('routes.filters.close') }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Panneau paramètres : vitesses moyennes du profil. Réglages (pas des
             filtres) qui pilotent le temps de parcours et le TSS estimés affichés dans
             la liste, d'où leur réglage ici. Même overlay ancré que les filtres. -->
        <div v-if="showSettings && canEditSpeeds" class="card-body border-bottom activity-filters-overlay">
          <label class="form-label small mb-1">{{ t('routes.speeds.title') }}</label>
          <p class="text-muted small mb-2">{{ t('routes.speeds.help') }}</p>
          <div class="d-flex flex-wrap gap-3">
            <div v-for="s in SPORTS" :key="s" class="d-flex align-items-center gap-2">
              <label :for="`speed-${s}`" class="small text-nowrap mb-0 d-flex align-items-center gap-1">
                <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
                {{ t(`routes.wt_sport_${s}`) }}
              </label>
              <div class="input-group input-group-sm speed-input-group">
                <input
                  :id="`speed-${s}`"
                  v-model.number="speeds[s]"
                  type="number"
                  min="3"
                  max="80"
                  :step="SPEED_STEP"
                  class="form-control"
                  @input="onSpeedInput(s)"
                />
                <span class="input-group-text">km/h</span>
              </div>
              <button
                v-if="speedSuggestion(s)"
                type="button"
                class="btn btn-sm btn-outline-primary py-0 px-2 text-nowrap"
                :title="t('routes.speed_suggestion_hint', { speed: speedSuggestion(s).speed, count: speedSuggestion(s).samples })"
                @click="applySpeedSuggestion(s)"
              >
                <i class="fa-solid fa-wand-magic-sparkles me-1" aria-hidden="true"></i>
                {{ t('routes.speed_suggestion', { speed: speedSuggestion(s).speed }) }}
              </button>
            </div>
          </div>
          <p v-if="speedError" class="text-danger small mb-0 mt-2">
            <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>
            {{ t('routes.speeds.save_error') }}
          </p>
          <div class="d-flex justify-content-end mt-3">
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
              @click="showSettings = false"
            >
              <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
              <span>{{ t('routes.settings.close') }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="view === 'map'" class="card-body p-2">
        <div v-if="mapCapped" class="alert alert-info d-flex align-items-center gap-2 py-2 px-3 mb-2 small">
          <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
          <span>{{ t('routes.map_capped') }}</span>
        </div>
        <div v-if="mapLoading && !mapLoaded" class="text-muted d-flex align-items-center gap-2 p-2">
          <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
          <span>Loading…</span>
        </div>
        <RoutesOverviewMap
          v-else
          :routes="mapRoutes"
          :locale-prefix="localePrefix"
          @select-route="onSelectRouteFromMap"
        />
      </div>

      <div v-show="view === 'list'" class="card-body">
        <div v-if="loading && !hasLoaded" class="text-muted d-flex align-items-center gap-2">
          <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
          <span>Loading…</span>
        </div>
        <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span class="flex-grow-1">{{ error }}</span>
          <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
        </div>
        <div v-else-if="total === 0" class="text-muted d-flex align-items-center gap-2">
          <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
          <span>{{ t('routes.empty') }}</span>
        </div>
        <div v-else-if="filteredTotal === 0" class="text-muted d-flex align-items-center gap-2">
          <i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i>
          <span>{{ t('routes.filters.none_match') }}</span>
        </div>
        <ul v-else class="list-unstyled mb-0 d-flex flex-column gap-1" :class="{ 'opacity-50': loading }">
          <li
            v-for="r in routes"
            :key="r.id"
            :ref="(el) => setRowRef(r.id, el)"
            :class="{ 'route-row-selected': selectedRouteId === r.id }"
          >
            <div v-if="editingId === r.id" class="activity-row d-flex align-items-center gap-2">
              <input
                :ref="(el) => setInputRef(r.id, el)"
                v-model="editingName"
                type="text"
                class="form-control form-control-sm flex-grow-1"
                :maxlength="80"
                :disabled="savingId === r.id"
                @keydown.enter.prevent="saveName(r)"
                @keydown.escape.prevent="cancelEdit"
              />
              <button
                type="button"
                class="btn btn-sm btn-success"
                :title="t('routes.save_name')"
                :disabled="savingId === r.id || !editingName.trim()"
                @click="saveName(r)"
              >
                <span v-if="savingId === r.id" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                <i v-else class="fa-solid fa-check" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :title="t('routes.cancel')"
                :disabled="savingId === r.id"
                @click="cancelEdit"
              >
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>
            <div v-else class="activity-row d-flex align-items-center gap-3">
              <a
                :href="`${localePrefix}/routes/${r.id}/edit`"
                class="flex-grow-1 d-flex align-items-center gap-3 text-decoration-none text-reset min-width-0"
              >
                <span class="route-preview" :title="t(`routes.wt_sport_${activityOf(r)}`)">
                  <svg
                    v-if="r.preview_segments && r.preview_segments.length"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="xMidYMid meet"
                    aria-hidden="true"
                  >
                    <path
                      v-for="(s, i) in r.preview_segments"
                      :key="i"
                      :d="s.d"
                      fill="none"
                      :stroke="gradeColor(s.c)"
                      stroke-width="6"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                    />
                  </svg>
                  <i v-else :class="`fa-solid ${sportIcon(activityOf(r))}`" aria-hidden="true"></i>
                </span>
                <div class="min-width-0 flex-grow-1">
                  <div class="fw-semibold text-truncate">{{ r.name }}</div>
                  <small class="text-muted d-flex flex-wrap align-items-center gap-x-3 gap-y-1">
                    <span class="d-inline-flex align-items-center gap-1">
                      <i :class="`fa-solid ${sportIcon(activityOf(r))}`" aria-hidden="true"></i>{{ t(`routes.wt_sport_${activityOf(r)}`) }}
                    </span>
                    <span class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>{{ formatKm(r.distance_m) }}
                    </span>
                    <span v-if="r.elevation_gain_m != null" class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>+{{ Math.round(r.elevation_gain_m) }} m
                    </span>
                    <span
                      v-if="estimatedSecondsFor(r) > 0"
                      class="d-inline-flex align-items-center gap-1"
                      :title="t('routes.estimated_time_hint', { speed: speeds[activityOf(r)] })"
                    >
                      <i class="fa-regular fa-clock" aria-hidden="true"></i>{{ formatDuration(estimatedSecondsFor(r)) }}
                    </span>
                    <span
                      v-if="routeLoads.get(r.id)"
                      class="d-inline-flex align-items-center gap-1"
                      :title="t('routes.tss.hint_short')"
                    >
                      <i class="fa-solid fa-bolt" style="color: #6f42c1" aria-hidden="true"></i>
                      <span>{{ t('routes.tss.label') }} ≈ {{ routeLoads.get(r.id).tss }}</span>
                      <span
                        v-if="routeLoads.get(r.id).level"
                        class="fw-semibold"
                        :style="{ color: FEAS_COLOR[routeLoads.get(r.id).level] }"
                        :title="t(`routes.tss.level_${routeLoads.get(r.id).level}_hint`)"
                      >{{ t(`routes.tss.level_${routeLoads.get(r.id).level}`) }}</span>
                    </span>
                    <span class="d-inline-flex align-items-center gap-1">
                      <i class="fa-regular fa-calendar" aria-hidden="true"></i>{{ formatDate(r.updated_at) }}
                    </span>
                  </small>
                </div>
              </a>
              <div class="d-flex align-items-center gap-1 route-row-actions">
                <a
                  :href="`${localePrefix}/routes/${r.share_token}/navigate`"
                  class="btn btn-sm btn-outline-primary"
                  :title="t('routes.navigate')"
                  :aria-label="t('routes.navigate')"
                >
                  <i class="fa-solid fa-location-arrow" aria-hidden="true"></i>
                </a>

                <!-- Planifier : le flux décrit par l'utilisateur — créer un itinéraire,
                     lire son TSS, l'accrocher à un jour. Seuls les jours restants de la
                     semaine sont proposés ; le passé n'est plus planifiable. -->
                <div v-if="canPlan" class="dropdown">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    data-bs-toggle="dropdown"
                    data-bs-auto-close="true"
                    aria-expanded="false"
                    :title="t('routes.plan.add_to_week')"
                    :aria-label="t('routes.plan.add_to_week')"
                  >
                    <i class="fa-regular fa-calendar-plus" aria-hidden="true"></i>
                  </button>
                  <ul class="dropdown-menu dropdown-menu-end">
                    <li><h6 class="dropdown-header">{{ t('routes.plan.pick_day') }}</h6></li>
                    <li v-for="d in planDays" :key="d.iso">
                      <button
                        type="button"
                        class="dropdown-item d-flex align-items-center gap-2"
                        @click="togglePlan(r.id, d.iso)"
                      >
                        <i
                          :class="isPlanned(r.id, d.iso) ? 'fa-solid fa-check text-success' : 'fa-regular fa-calendar'"
                          aria-hidden="true"
                        ></i>
                        <span class="text-capitalize">{{ d.label }}</span>
                      </button>
                    </li>
                  </ul>
                </div>

                <div class="dropdown">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    data-bs-toggle="dropdown"
                    data-bs-auto-close="true"
                    aria-expanded="false"
                    :aria-label="t('routes.more_actions')"
                  >
                    <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
                  </button>
                  <ul class="dropdown-menu dropdown-menu-end">
                    <li><h6 class="dropdown-header">{{ t('routes.group_share') }}</h6></li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareRoute(r)">
                        <i class="" :class="sharedId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-location-arrow'" aria-hidden="true"></i>
                        <span>{{ sharedId === r.id ? t('routes.share_copied') : t('routes.share') }}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareViewRoute(r)">
                        <i :class="sharedViewId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-eye'" aria-hidden="true"></i>
                        <span>{{ sharedViewId === r.id ? t('routes.share_copied') : t('routes.share_view') }}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareGpxFile(r)">
                        <i :class="sharingGpxId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-file-export'" aria-hidden="true"></i>
                        <span>{{ sharingGpxId === r.id ? t('routes.share_copied') : t('routes.share_gpx') }}</span>
                      </button>
                    </li>
                    <li><hr class="dropdown-divider"></li>
                    <li><h6 class="dropdown-header">{{ t('routes.group_export') }}</h6></li>
                    <li>
                      <a :href="`/api/routes/${r.id}/gpx`" class="dropdown-item d-flex align-items-center gap-2" download>
                        <i class="fa-solid fa-download" aria-hidden="true"></i>
                        <span>{{ t('routes.export_gpx') }}</span>
                      </a>
                    </li>
                    <li v-if="props.canDense">
                      <a :href="`/api/routes/${r.id}/gpx?step=5`" class="dropdown-item d-flex align-items-center gap-2" download>
                        <i class="fa-solid fa-download" aria-hidden="true"></i>
                        <span>{{ t('routes.export_gpx_dense') }}</span>
                      </a>
                    </li>
                    <li><hr class="dropdown-divider"></li>
                    <li><h6 class="dropdown-header">{{ t('routes.group_edit') }}</h6></li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="startEdit(r)">
                        <i class="fa-solid fa-pen" aria-hidden="true"></i>
                        <span>{{ t('routes.rename') }}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="duplicateRoute(r)">
                        <i class="fa-solid fa-copy" aria-hidden="true"></i>
                        <span>{{ t('routes.duplicate') }}</span>
                      </button>
                    </li>
                  </ul>
                </div>

                <button
                  type="button"
                  class="btn btn-sm btn-outline-danger"
                  :title="t('routes.delete')"
                  @click="removeRoute(r)"
                >
                  <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </li>
        </ul>
        <nav
          v-if="hasLoaded && !error && totalPages > 1"
          class="d-flex justify-content-between align-items-center mt-3"
          :aria-label="t('routes.list_title')"
        >
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="page <= 1 || loading"
            @click="goToPage(page - 1)"
          >
            <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
            <span>{{ t('routes.pagination.prev') }}</span>
          </button>
          <small class="text-muted">{{ t('routes.pagination.page', { page, total: totalPages }) }}</small>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="page >= totalPages || loading"
            @click="goToPage(page + 1)"
          >
            <span>{{ t('routes.pagination.next') }}</span>
            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </button>
        </nav>
      </div>
    </div>

    <NewRouteModal
      :show="showNewRouteModal"
      :initial-name="newRouteName"
      @confirm="onNewRouteConfirm"
      @close="onNewRouteClose"
    />
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

.min-width-0 {
  min-width: 0;
}

/* Vignette du tracé : même encombrement que l'ancien badge d'activité. Le SVG
   utilise currentColor pour rester lisible en thème clair/sombre ; on teinte le
   trait avec l'accent warning. L'icône de repli (pas d'aperçu) est centrée. */
.route-preview {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.04));
  color: var(--bs-warning, #ffc107);
}
.route-preview svg {
  width: 100%;
  height: 100%;
}

/* Tighter horizontal/vertical gaps for the meta line under each route name —
   bootstrap doesn't ship gap-x/gap-y utilities for inline gaps. */
.gap-x-3 { column-gap: 0.75rem; }
.gap-y-1 { row-gap: 0.25rem; }

/* Action button cluster stays at fixed size; only the row's anchor area
   gets the translateX hover bump from .activity-row in application.scss. */
.route-row-actions {
  flex-shrink: 0;
}

/* Flash de repérage quand on arrive depuis la carte (« voir dans la liste ») :
   la ligne clignote brièvement en jaune puis revient à la normale. */
.route-row-selected .activity-row {
  animation: route-row-flash 2.5s ease-out;
  border-radius: 0.5rem;
}
@keyframes route-row-flash {
  0%, 12% { background-color: rgba(255, 193, 7, 0.4); }
  100% { background-color: transparent; }
}


/* On phones the row is too cramped to keep the name + 5 actions on one line,
   so the action cluster wraps onto its own full-width line below the name and
   spreads the buttons out for easier tapping. */
@media (max-width: 575.98px) {
  .activity-row {
    flex-wrap: wrap;
  }
  .route-row-actions {
    width: 100%;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
  .route-row-actions > .btn,
  .route-row-actions > .dropdown > .btn {
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
  }
}
</style>
