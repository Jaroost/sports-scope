<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES, MAP_STYLE_GROUPS, mapStyleFor } from '../mapStyles'
import { POI_CATEGORIES } from '../poiCategories'
import { ALL_COUNTRY_CODES, countryName, countryFlag } from '../countries'

const groupedStyles = computed(() =>
  MAP_STYLE_GROUPS
    .map(group => ({ group, styles: MAP_STYLES.filter(s => s.group === group) }))
    .filter(g => g.styles.length > 0),
)

interface Preferences {
  points_of_interest: {
    show_cemeteries: boolean
    show_bakeries: boolean
    show_localities: boolean
    show_water: boolean
    show_food: boolean
    show_viewpoints: boolean
    show_toilets: boolean
    show_picnic: boolean
    radius_m: number
    alert_m: number
  }
  map: {
    default_style: string
  }
  search: {
    country_codes: string[]
    worldwide_fallback: boolean
  }
  navigation: {
    default_style: string
    zoom: number
    pitch: number
    terrain: boolean
    nav_fps: number
    line_width: number
    line_color: string
    line_opacity: number
    turn_alert_m: number
    turn_hint_m: number
    turn_urgent_m: number
    turn_repeat_ms: number
    turn_repeat_urgent_ms: number
    turn_now_m: number
    turn_green_hold_m: number
    turn_green_hold_s: number
    sound_volume: number
    turn_marker_size: number
    turn_marker_color: string
    turn_marker_icon_color: string
    show_climb_card: boolean
    radar_close_m: number
  }
  display: {
    default_sport: string
    show_grade_colors: boolean
    show_elevation_chart: boolean
    route_color: string
    route_opacity: number
    route_width: number
  }
  climb_detection: {
    min_grade: number
    min_gain_m: number
    min_length_m: number
    grade_smoothing_m: number
    merge_gap_m: number
  }
  speeds: {
    cycling: number
    mtb: number
    hiking: number
  }
}

const props = defineProps<{
  preferences: Preferences
  defaults: Preferences
  // Sections à afficher (clés : poi, map, navigation, display, climb, speeds).
  // Omis ⇒ profil complet. Permet à ProfileDialog de n'exposer que les réglages
  // pertinents selon la page d'où il est ouvert.
  sections?: string[]
}>()

// Vrai si la section doit être affichée (toutes par défaut quand `sections` est omis).
function showSection(key: string): boolean {
  return !props.sections || props.sections.includes(key)
}

// Émis après chaque sauvegarde réussie : permet à un conteneur (ProfileDialog) de
// savoir qu'il faut recharger la page à la fermeture pour appliquer les nouvelles
// préférences. Sans effet sur la page /profile autonome.
const emit = defineEmits<{ saved: [] }>()

// Copie réactive locale : on n'écrit côté serveur qu'à la sauvegarde explicite.
const prefs = reactive<Preferences>(JSON.parse(JSON.stringify(props.preferences)))

// Restaure les valeurs d'origine (par défaut) dans le formulaire, sans toucher
// au compte Strava. L'utilisateur doit ensuite enregistrer pour persister.
function resetToDefaults() {
  if (!window.confirm(t('profile.reset_confirm'))) return
  Object.assign(prefs, JSON.parse(JSON.stringify(props.defaults)))
}

const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

const SPORTS = ['cycling', 'mtb', 'hiking'] as const

function sportIcon(s: (typeof SPORTS)[number]): string {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// ─── Recherche de lieux : pays privilégiés (ordre = priorité) ───────────────
// Liste réordonnable par glisser-déposer ; chaque pays peut être retiré, et on
// peut en ajouter depuis le sélecteur (pays absents de la liste, triés par nom).
const countryToAdd = ref('')
const dragCountryIndex = ref<number | null>(null)
const dragOverCountryIndex = ref<number | null>(null)

// Pays sélectionnables = tous ceux pas encore dans la liste, triés par nom localisé.
const availableCountries = computed(() => {
  const chosen = new Set(prefs.search.country_codes)
  return ALL_COUNTRY_CODES
    .filter((cc) => !chosen.has(cc))
    .map((cc) => ({ cc, name: countryName(cc) }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

function addCountry() {
  const cc = countryToAdd.value
  if (cc && !prefs.search.country_codes.includes(cc)) prefs.search.country_codes.push(cc)
  countryToAdd.value = ''
}

function removeCountry(cc: string) {
  const i = prefs.search.country_codes.indexOf(cc)
  if (i !== -1) prefs.search.country_codes.splice(i, 1)
}

function onCountryDragStart(i: number) {
  dragCountryIndex.value = i
}

function onCountryDragOver(i: number) {
  dragOverCountryIndex.value = i
}

function onCountryDrop(to: number) {
  const from = dragCountryIndex.value
  if (from !== null && from !== to) {
    const arr = prefs.search.country_codes
    const [moved] = arr.splice(from, 1)
    arr.splice(to, 0, moved)
  }
  onCountryDragEnd()
}

function onCountryDragEnd() {
  dragCountryIndex.value = null
  dragOverCountryIndex.value = null
}

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function save() {
  saving.value = true
  error.value = null
  try {
    const res = await fetch('/api/profile/preferences', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ preferences: prefs }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    // On réaligne sur les valeurs assainies renvoyées par le serveur (clamps).
    Object.assign(prefs, payload.preferences)
    saved.value = true
    emit('saved')
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { saved.value = false }, 2500)
  } catch (e) {
    error.value = (e as Error).message || 'error'
  } finally {
    saving.value = false
  }
}

// ─── Aperçu de la navigation ────────────────────────────────────────────────
// Petite carte MapLibre qui reflète en direct les réglages de la section
// Navigation (style, zoom, inclinaison) et se centre sur la position GPS
// actuelle (repli sur la Suisse si la géoloc échoue ou est refusée).
const SWITZERLAND_CENTER: [number, number] = [8.23, 46.8]
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
// Même inset haut que la caméra de navigation (cf. RouteNavigation.followPadding) :
// ancre le coureur dans le tiers inférieur pour que le cadrage — donc le ressenti du
// zoom et de l'inclinaison — corresponde à ce que l'écran affichera réellement.
const PREVIEW_TOP_PAD_RATIO = 0.45

// Reporte sur l'aperçu le padding caméra de la navigation. Recalculé sur 'resize'
// (la preview a un ratio fixe façon téléphone, donc sa hauteur varie avec la largeur).
function applyPreviewPadding() {
  if (!previewMap) return
  const h = previewMap.getContainer()?.clientHeight || 0
  previewMap.setPadding({ top: Math.round(h * PREVIEW_TOP_PAD_RATIO), bottom: 0, left: 0, right: 0 })
}

// Tracé de démonstration sur l'aperçu : une courte ligne centrée sur la position,
// rendue avec les mêmes couleurs que la navigation (bordure + tracé violet), pour
// que le réglage de largeur soit représentatif. (Re)pose les couches après un
// setStyle (qui efface sources et layers).
function applyPreviewRoute() {
  if (!previewMap) return
  const data = previewRouteFeature(previewCenter)
  if (previewMap.getSource('preview-route')) {
    previewMap.getSource('preview-route').setData(data)
    return
  }
  previewMap.addSource('preview-route', { type: 'geojson', data })
  const w = prefs.navigation.line_width
  previewMap.addLayer({ id: 'preview-route-border', type: 'line', source: 'preview-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': 'rgba(0,0,0,0.28)', 'line-width': w + 4 } })
  previewMap.addLayer({ id: 'preview-route-line', type: 'line', source: 'preview-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': prefs.navigation.line_color, 'line-width': w, 'line-opacity': prefs.navigation.line_opacity } })
  applyPreviewTurnMarker()
}

// Pastille orange de changement de direction posée sur l'aperçu (même rendu que la
// navigation), pour visualiser en direct le réglage de taille. (Re)pose la couche
// après un setStyle. La pose au-dessus du tracé.
function applyPreviewTurnMarker() {
  if (!previewMap) return
  // Décalé vers le haut le long du tracé pour ne pas recouvrir la flèche du coureur,
  // posée pile au centre.
  const turnCenter: [number, number] = [previewCenter[0], previewCenter[1] + 0.0004]
  const data = { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: turnCenter } }
  if (previewMap.getSource('preview-turn')) {
    previewMap.getSource('preview-turn').setData(data)
    return
  }
  previewMap.addSource('preview-turn', { type: 'geojson', data })
  previewMap.addLayer({ id: 'preview-turn-dot', type: 'circle', source: 'preview-turn', paint: { 'circle-radius': prefs.navigation.turn_marker_size, 'circle-color': prefs.navigation.turn_marker_color, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
  addPreviewArrowLayer()
}

// (Re)pose l'image de la flèche et sa couche symbole. Idempotente : on retire d'abord
// l'image et la couche existantes, ce qui permet de recoloriser la flèche à chaud
// (updateImage ne force pas un re-rendu fiable des symboles déjà placés).
function addPreviewArrowLayer() {
  if (!previewMap || !previewMap.getSource('preview-turn')) return
  // Flèche directionnelle (vers la gauche) par-dessus la pastille — même rendu que la
  // navigation (taille fixe), pour juger de la lisibilité selon la taille du marqueur.
  if (previewMap.getLayer('preview-turn-arrow')) previewMap.removeLayer('preview-turn-arrow')
  if (previewMap.hasImage('preview-turn-arrow')) previewMap.removeImage('preview-turn-arrow')
  previewMap.addImage('preview-turn-arrow', createArrowImage(prefs.navigation.turn_marker_icon_color), { pixelRatio: ARROW_SCALE })
  previewMap.addLayer({
    id: 'preview-turn-arrow',
    type: 'symbol',
    source: 'preview-turn',
    layout: {
      'icon-image': 'preview-turn-arrow',
      'icon-rotate': -90, // pointe vers la gauche (l'image pointe vers le haut)
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      // Proportionnelle à la pastille, un poil plus petite pour tenir dans le cercle.
      'icon-size': prefs.navigation.turn_marker_size / 15,
    },
  })
}

// Flèche blanche pointant vers le haut, identique à celle de la navigation
// (RouteNavigation.createArrowImage). Suréchantillonnée (ARROW_SCALE×) et enregistrée
// avec pixelRatio = ARROW_SCALE : taille logique 22 px, bitmap net une fois agrandie.
const ARROW_SCALE = 32

function createArrowImage(color: string): ImageData {
  const base = 22
  const size = base * ARROW_SCALE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.scale(ARROW_SCALE, ARROW_SCALE)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(base / 2, 1)
  ctx.lineTo(base - 2, base - 2)
  ctx.lineTo(base / 2, base - 7)
  ctx.lineTo(2, base - 2)
  ctx.closePath()
  ctx.fill()
  return ctx.getImageData(0, 0, size, size)
}

// Met à jour à chaud la largeur du tracé de l'aperçu (bordure = tracé + 4 px).
function applyPreviewRouteWidth(w: number) {
  if (!previewMap?.getLayer('preview-route-line')) return
  previewMap.setPaintProperty('preview-route-line', 'line-width', w)
  previewMap.setPaintProperty('preview-route-border', 'line-width', w + 4)
}

// Courte ligne verticale (~150 m) centrée sur un point, pour visualiser le tracé.
function previewRouteFeature(center: [number, number]) {
  const [lng, lat] = center
  const dLat = 0.0007 // ~78 m de part et d'autre
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: [[lng, lat - dLat], [lng, lat], [lng, lat + dLat]] },
  }
}

// Active/désactive le relief 3D sur l'aperçu (idempotente : aussi après un setStyle).
function applyPreviewTerrain() {
  if (!previewMap) return
  if (prefs.navigation.terrain) {
    if (!previewMap.getSource('terrain-dem')) {
      previewMap.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
    }
    previewMap.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
  } else {
    previewMap.setTerrain(null)
  }
}

const previewEl = ref<HTMLElement | null>(null)
const previewLocating = ref(true)
const previewLocationError = ref(false)

let previewMap: any = null
let previewMarker: any = null
let previewMaplibre: any = null
let previewCenter: [number, number] = SWITZERLAND_CENTER

onMounted(() => { void initPreview() })

onBeforeUnmount(() => {
  if (previewMap) { previewMap.remove(); previewMap = null }
})

async function initPreview() {
  previewMaplibre = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  previewMap = new previewMaplibre.Map({
    container: previewEl.value,
    style: mapStyleFor(prefs.navigation.default_style) as any,
    center: previewCenter,
    zoom: prefs.navigation.zoom,
    pitch: prefs.navigation.pitch,
    attributionControl: false,
    interactive: false,
  })
  previewMap.on('styleimagemissing', (e: any) => {
    previewMap.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  previewMap.on('load', () => { applyPreviewRoute(); applyPreviewTerrain(); applyPreviewPadding() })
  previewMap.on('resize', applyPreviewPadding)

  // Réagit en direct aux réglages : le zoom, l'inclinaison, le relief et la largeur du
  // tracé s'appliquent à chaud ; le changement de style recharge le fond (et replace
  // le marqueur, le tracé et le relief).
  watch(() => prefs.navigation.zoom, (z) => previewMap?.setZoom(z))
  watch(() => prefs.navigation.pitch, (p) => previewMap?.setPitch(p))
  watch(() => prefs.navigation.terrain, applyPreviewTerrain)
  watch(() => prefs.navigation.line_width, applyPreviewRouteWidth)
  watch(() => prefs.navigation.line_color, (c) => previewMap?.getLayer('preview-route-line') && previewMap.setPaintProperty('preview-route-line', 'line-color', c))
  watch(() => prefs.navigation.line_opacity, (o) => previewMap?.getLayer('preview-route-line') && previewMap.setPaintProperty('preview-route-line', 'line-opacity', o))
  watch(() => prefs.navigation.turn_marker_size, (r) => {
    if (previewMap?.getLayer('preview-turn-dot')) previewMap.setPaintProperty('preview-turn-dot', 'circle-radius', r)
    if (previewMap?.getLayer('preview-turn-arrow')) previewMap.setLayoutProperty('preview-turn-arrow', 'icon-size', r / 13)
  })
  watch(() => prefs.navigation.turn_marker_color, (c) => {
    if (previewMap?.getLayer('preview-turn-dot')) previewMap.setPaintProperty('preview-turn-dot', 'circle-color', c)
  })
  watch(() => prefs.navigation.turn_marker_icon_color, () => addPreviewArrowLayer())
  watch(() => prefs.navigation.default_style, (id) => {
    previewMap?.setStyle(mapStyleFor(id), { diff: false })
    previewMap?.once('style.load', () => { applyPreviewRoute(); applyPreviewTerrain() })
  })

  locatePreview()
}

function locatePreview() {
  if (!('geolocation' in navigator)) { previewLocating.value = false; previewLocationError.value = true; return }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      previewLocating.value = false
      previewLocationError.value = false
      previewCenter = [pos.coords.longitude, pos.coords.latitude]
      previewMap?.setCenter(previewCenter)
      placePreviewMarker(previewCenter)
      applyPreviewRoute()
    },
    () => { previewLocating.value = false; previewLocationError.value = true },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  )
}

function placePreviewMarker(coords: [number, number]) {
  if (!previewMap) return
  if (previewMarker) { previewMarker.setLngLat(coords); return }
  const el = document.createElement('div')
  el.className = 'nav-preview-arrow'
  el.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2 L20 21 L12 16 L4 21 Z" fill="#4285f4" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  previewMarker = new previewMaplibre.Marker({ element: el, anchor: 'center' }).setLngLat(coords).addTo(previewMap)
}
</script>

<template>
  <form class="user-profile" @submit.prevent="save">
    <!-- Points d'intérêt -->
    <section v-if="showSection('poi')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-location-dot text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.poi.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.poi.help') }}</p>
        <div
          v-for="cat in POI_CATEGORIES"
          :key="cat.key"
          class="form-check form-switch mb-2"
        >
          <input :id="`poi-${cat.key}`" v-model="prefs.points_of_interest[cat.prefField]" class="form-check-input" type="checkbox">
          <label class="form-check-label" :for="`poi-${cat.key}`">
            <i class="fa-solid me-1" :class="cat.icon" :style="{ color: cat.color }" aria-hidden="true"></i>{{ t(`profile.poi.${cat.labelKey}`) }}
          </label>
        </div>
        <label for="poi-radius" class="form-label mb-1 mt-2">
          {{ t('profile.poi.radius') }} : <strong>{{ prefs.points_of_interest.radius_m }} m</strong>
        </label>
        <input id="poi-radius" v-model.number="prefs.points_of_interest.radius_m" type="range" class="form-range" min="200" max="5000" step="100">
        <label for="poi-alert" class="form-label mb-1 mt-2">
          {{ t('profile.poi.alert') }} : <strong>{{ prefs.points_of_interest.alert_m }} m</strong>
        </label>
        <p class="text-muted small mb-1">{{ t('profile.poi.alert_help') }}</p>
        <input id="poi-alert" v-model.number="prefs.points_of_interest.alert_m" type="range" class="form-range" min="20" max="1000" step="10">
      </div>
    </section>

    <!-- Type de carte -->
    <section v-if="showSection('map')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-map text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.map.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.map.help') }}</p>
        <div class="d-flex flex-column gap-3">
          <div v-for="g in groupedStyles" :key="g.group" class="card map-style-group">
            <div class="card-body p-2">
              <h3 class="h6 text-muted text-uppercase small fw-semibold mb-2 px-1">
                {{ t(`profile.map.group_${g.group}`) }}
              </h3>
              <div class="d-flex flex-wrap gap-2">
                <label
                  v-for="style in g.styles"
                  :key="style.id"
                  class="map-style-option"
                  :class="{ active: prefs.map.default_style === style.id }"
                >
                  <input v-model="prefs.map.default_style" class="visually-hidden" type="radio" name="map-style" :value="style.id">
                  <i :class="`fa-solid ${style.icon}`" aria-hidden="true"></i>
                  <span>{{ t(`profile.map.style_${style.id}`) }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Recherche de lieux : pays privilégiés -->
    <section v-if="showSection('search')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-magnifying-glass text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.search.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.search.help') }}</p>

        <ul v-if="prefs.search.country_codes.length" class="country-list list-unstyled mb-3">
          <li
            v-for="(cc, i) in prefs.search.country_codes"
            :key="cc"
            class="country-item"
            :class="{ dragging: dragCountryIndex === i, dragover: dragOverCountryIndex === i && dragCountryIndex !== i }"
            draggable="true"
            @dragstart="onCountryDragStart(i)"
            @dragover.prevent="onCountryDragOver(i)"
            @drop.prevent="onCountryDrop(i)"
            @dragend="onCountryDragEnd"
          >
            <i class="fa-solid fa-grip-vertical country-grip" aria-hidden="true"></i>
            <span class="country-rank">{{ i + 1 }}</span>
            <span class="country-flag" aria-hidden="true">{{ countryFlag(cc) }}</span>
            <span class="country-name">{{ countryName(cc) }}</span>
            <button
              type="button"
              class="btn btn-sm btn-link text-danger country-remove p-0"
              :aria-label="t('profile.search.remove')"
              :title="t('profile.search.remove')"
              @click="removeCountry(cc)"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </li>
        </ul>
        <p v-else class="text-muted small fst-italic mb-3">{{ t('profile.search.empty') }}</p>

        <div class="d-flex align-items-center gap-2 mb-3" style="max-width: 360px;">
          <select v-model="countryToAdd" class="form-select form-select-sm" @change="addCountry">
            <option value="">{{ t('profile.search.add_placeholder') }}</option>
            <option v-for="c in availableCountries" :key="c.cc" :value="c.cc">
              {{ countryFlag(c.cc) }} {{ c.name }}
            </option>
          </select>
        </div>

        <div class="form-check form-switch mb-1">
          <input id="search-worldwide" v-model="prefs.search.worldwide_fallback" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="search-worldwide">{{ t('profile.search.worldwide_fallback') }}</label>
        </div>
        <p class="text-muted small mb-0">
          <i class="fa-solid fa-circle-info me-1" aria-hidden="true"></i>{{ t('profile.search.worldwide_help') }}
        </p>
      </div>
    </section>

    <!-- Navigation (mode GPS) -->
    <section v-if="showSection('navigation')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-location-arrow text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.navigation.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.navigation.help') }}</p>
        <div class="d-flex flex-column gap-3 mb-3">
          <div v-for="g in groupedStyles" :key="g.group" class="card map-style-group">
            <div class="card-body p-2">
              <h3 class="h6 text-muted text-uppercase small fw-semibold mb-2 px-1">
                {{ t(`profile.map.group_${g.group}`) }}
              </h3>
              <div class="d-flex flex-wrap gap-2">
                <label
                  v-for="style in g.styles"
                  :key="style.id"
                  class="map-style-option"
                  :class="{ active: prefs.navigation.default_style === style.id }"
                >
                  <input v-model="prefs.navigation.default_style" class="visually-hidden" type="radio" name="nav-map-style" :value="style.id">
                  <i :class="`fa-solid ${style.icon}`" aria-hidden="true"></i>
                  <span>{{ t(`profile.map.style_${style.id}`) }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>
        <div class="row g-3">
          <div class="col-sm-6">
            <label for="nav-zoom" class="form-label mb-1">
              {{ t('profile.navigation.zoom') }} : <strong>{{ prefs.navigation.zoom }}</strong>
            </label>
            <input id="nav-zoom" v-model.number="prefs.navigation.zoom" type="range" class="form-range" min="14" max="40" step="0.5">
          </div>
          <div class="col-sm-6">
            <label for="nav-pitch" class="form-label mb-1">
              {{ t('profile.navigation.pitch') }} : <strong>{{ prefs.navigation.pitch }}°</strong>
            </label>
            <input id="nav-pitch" v-model.number="prefs.navigation.pitch" type="range" class="form-range" min="0" max="90" step="5">
          </div>
          <div class="col-12">
            <div class="form-check form-switch">
              <input id="nav-terrain" v-model="prefs.navigation.terrain" class="form-check-input" type="checkbox" role="switch">
              <label for="nav-terrain" class="form-check-label">{{ t('profile.navigation.terrain') }}</label>
            </div>
          </div>
          <div class="col-12">
            <div class="form-check form-switch">
              <input id="nav-show-climb-card" v-model="prefs.navigation.show_climb_card" class="form-check-input" type="checkbox" role="switch">
              <label for="nav-show-climb-card" class="form-check-label">{{ t('profile.navigation.show_climb_card') }}</label>
            </div>
            <p class="text-muted small mb-0">{{ t('profile.navigation.show_climb_card_help') }}</p>
          </div>
          <div class="col-sm-6">
            <label for="nav-radar-close" class="form-label mb-1">
              {{ t('profile.navigation.radar_close_m') }} : <strong>{{ prefs.navigation.radar_close_m }} m</strong>
            </label>
            <input id="nav-radar-close" v-model.number="prefs.navigation.radar_close_m" type="range" class="form-range" min="10" max="100" step="5">
            <p class="text-muted small mb-0">{{ t('profile.navigation.radar_close_m_help') }}</p>
          </div>
          <div class="col-sm-6">
            <label for="nav-sound-volume" class="form-label mb-1">
              <i class="fa-solid fa-volume-high me-1" aria-hidden="true"></i>{{ t('profile.navigation.sound_volume') }} : <strong>{{ prefs.navigation.sound_volume }} %</strong>
            </label>
            <input id="nav-sound-volume" v-model.number="prefs.navigation.sound_volume" type="range" class="form-range" min="0" max="200" step="5">
          </div>
          <div class="col-sm-6">
            <label for="nav-fps" class="form-label mb-1">
              {{ t('profile.navigation.nav_fps') }} : <strong>{{ prefs.navigation.nav_fps }} fps</strong>
            </label>
            <input id="nav-fps" v-model.number="prefs.navigation.nav_fps" type="range" class="form-range" min="0.5" max="60" step="0.5">
          </div>
          <div class="col-sm-6">
            <label for="nav-line-width" class="form-label mb-1">
              {{ t('profile.navigation.line_width') }} : <strong>{{ prefs.navigation.line_width }} px</strong>
            </label>
            <input id="nav-line-width" v-model.number="prefs.navigation.line_width" type="range" class="form-range" min="2" max="200" step="1">
          </div>
          <div class="col-sm-6">
            <label for="nav-line-color" class="form-label mb-1">{{ t('profile.navigation.line_color') }}</label>
            <input id="nav-line-color" v-model="prefs.navigation.line_color" type="color" class="form-control form-control-color">
          </div>
          <div class="col-sm-6">
            <label for="nav-line-opacity" class="form-label mb-1">
              {{ t('profile.navigation.line_opacity') }} : <strong>{{ Math.round(prefs.navigation.line_opacity * 100) }} %</strong>
            </label>
            <input id="nav-line-opacity" v-model.number="prefs.navigation.line_opacity" type="range" class="form-range" min="0.1" max="1" step="0.1">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-marker-size" class="form-label mb-1">
              {{ t('profile.navigation.turn_marker_size') }} : <strong>{{ prefs.navigation.turn_marker_size }} px</strong>
            </label>
            <input id="nav-turn-marker-size" v-model.number="prefs.navigation.turn_marker_size" type="range" class="form-range" min="5" max="200" step="1">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-marker-color" class="form-label mb-1">{{ t('profile.navigation.turn_marker_color') }}</label>
            <input id="nav-turn-marker-color" v-model="prefs.navigation.turn_marker_color" type="color" class="form-control form-control-color">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-marker-icon-color" class="form-label mb-1">{{ t('profile.navigation.turn_marker_icon_color') }}</label>
            <input id="nav-turn-marker-icon-color" v-model="prefs.navigation.turn_marker_icon_color" type="color" class="form-control form-control-color">
          </div>
        </div>

        <!-- Aperçu en direct -->
        <div class="mt-3">
          <label class="form-label mb-1">{{ t('profile.navigation.preview') }}</label>
          <p class="text-muted small mb-2">{{ t('profile.navigation.preview_help') }}</p>
          <div class="nav-preview">
            <div ref="previewEl" class="nav-preview-map"></div>
            <div v-if="previewLocating" class="nav-preview-overlay text-muted">
              <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('profile.navigation.locating') }}
            </div>
            <div v-else-if="previewLocationError" class="nav-preview-badge">
              <i class="fa-solid fa-location-crosshairs me-1" aria-hidden="true"></i>{{ t('profile.navigation.location_error') }}
            </div>
          </div>
        </div>

        <hr class="my-3">
        <h3 class="h6 text-muted text-uppercase small fw-semibold mb-3">
          <i class="fa-solid fa-turn-right me-1" aria-hidden="true"></i>{{ t('profile.navigation.turns_title') }}
        </h3>
        <div class="row g-3">
          <div class="col-sm-6">
            <label for="nav-turn-alert" class="form-label mb-1">
              {{ t('profile.navigation.turn_alert_m') }} : <strong>{{ prefs.navigation.turn_alert_m }} m</strong>
            </label>
            <input id="nav-turn-alert" v-model.number="prefs.navigation.turn_alert_m" type="range" class="form-range" min="50" max="500" step="10">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-hint" class="form-label mb-1">
              {{ t('profile.navigation.turn_hint_m') }} : <strong>{{ prefs.navigation.turn_hint_m }} m</strong>
            </label>
            <input id="nav-turn-hint" v-model.number="prefs.navigation.turn_hint_m" type="range" class="form-range" min="50" max="500" step="10">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-urgent" class="form-label mb-1">
              {{ t('profile.navigation.turn_urgent_m') }} : <strong>{{ prefs.navigation.turn_urgent_m }} m</strong>
            </label>
            <input id="nav-turn-urgent" v-model.number="prefs.navigation.turn_urgent_m" type="range" class="form-range" min="5" max="50" step="1">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-repeat" class="form-label mb-1">
              {{ t('profile.navigation.turn_repeat_ms') }} : <strong>{{ (prefs.navigation.turn_repeat_ms / 1000).toFixed(1) }} s</strong>
            </label>
            <input id="nav-turn-repeat" v-model.number="prefs.navigation.turn_repeat_ms" type="range" class="form-range" min="500" max="10000" step="500">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-repeat-urgent" class="form-label mb-1">
              {{ t('profile.navigation.turn_repeat_urgent_ms') }} : <strong>{{ (prefs.navigation.turn_repeat_urgent_ms / 1000).toFixed(1) }} s</strong>
            </label>
            <input id="nav-turn-repeat-urgent" v-model.number="prefs.navigation.turn_repeat_urgent_ms" type="range" class="form-range" min="500" max="10000" step="500">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-now" class="form-label mb-1">
              {{ t('profile.navigation.turn_now_m') }} : <strong>{{ prefs.navigation.turn_now_m }} m</strong>
            </label>
            <input id="nav-turn-now" v-model.number="prefs.navigation.turn_now_m" type="range" class="form-range" min="0" max="50" step="1">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-green-hold" class="form-label mb-1">
              {{ t('profile.navigation.turn_green_hold_m') }} : <strong>{{ prefs.navigation.turn_green_hold_m }} m</strong>
            </label>
            <input id="nav-turn-green-hold" v-model.number="prefs.navigation.turn_green_hold_m" type="range" class="form-range" min="0" max="500" step="10">
          </div>
          <div class="col-sm-6">
            <label for="nav-turn-green-hold-s" class="form-label mb-1">
              {{ t('profile.navigation.turn_green_hold_s') }} : <strong>{{ prefs.navigation.turn_green_hold_s }} s</strong>
            </label>
            <input id="nav-turn-green-hold-s" v-model.number="prefs.navigation.turn_green_hold_s" type="range" class="form-range" min="2" max="60" step="1">
          </div>
        </div>
      </div>
    </section>

    <!-- Préférences d'affichage -->
    <section v-if="showSection('display')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-eye text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.display.title') }}</h2>
      </div>
      <div class="card-body">
        <div class="row g-3 mb-1">
          <div class="col-sm-6">
            <label for="disp-sport" class="form-label">{{ t('profile.display.default_sport') }}</label>
            <select id="disp-sport" v-model="prefs.display.default_sport" class="form-select">
              <option v-for="s in SPORTS" :key="s" :value="s">{{ t(`profile.display.sport_${s}`) }}</option>
            </select>
          </div>
        </div>
        <hr class="my-3">
        <div class="form-check form-switch mb-2">
          <input id="disp-grade" v-model="prefs.display.show_grade_colors" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="disp-grade">{{ t('profile.display.show_grade_colors') }}</label>
        </div>
        <div class="form-check form-switch">
          <input id="disp-elev" v-model="prefs.display.show_elevation_chart" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="disp-elev">{{ t('profile.display.show_elevation_chart') }}</label>
        </div>
        <hr class="my-3">
        <div class="row g-3">
          <div class="col-sm-6">
            <label for="disp-route-color" class="form-label mb-1">{{ t('profile.display.route_color') }}</label>
            <input id="disp-route-color" v-model="prefs.display.route_color" type="color" class="form-control form-control-color">
            <p class="text-muted small mb-0 mt-1">{{ t('profile.display.route_color_help') }}</p>
          </div>
          <div class="col-sm-6">
            <label for="disp-route-opacity" class="form-label mb-1">
              {{ t('profile.display.route_opacity') }} : <strong>{{ Math.round(prefs.display.route_opacity * 100) }} %</strong>
            </label>
            <input id="disp-route-opacity" v-model.number="prefs.display.route_opacity" type="range" class="form-range" min="0.1" max="1" step="0.1">
          </div>
          <div class="col-sm-6">
            <label for="disp-route-width" class="form-label mb-1">
              {{ t('profile.display.route_width') }} : <strong>{{ prefs.display.route_width }} px</strong>
            </label>
            <input id="disp-route-width" v-model.number="prefs.display.route_width" type="range" class="form-range" min="2" max="12" step="1">
          </div>
        </div>
      </div>
    </section>

    <!-- Détection de cols -->
    <section v-if="showSection('climb')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-mountain text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.climb.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.climb.help') }}</p>
        <div class="row g-3">
          <div class="col-sm-4">
            <label for="climb-grade" class="form-label">{{ t('profile.climb.min_grade') }}</label>
            <div class="input-group">
              <input id="climb-grade" v-model.number="prefs.climb_detection.min_grade" type="number" class="form-control" min="0" max="15" step="0.5">
              <span class="input-group-text">%</span>
            </div>
          </div>
          <div class="col-sm-4">
            <label for="climb-gain" class="form-label">{{ t('profile.climb.min_gain') }}</label>
            <div class="input-group">
              <input id="climb-gain" v-model.number="prefs.climb_detection.min_gain_m" type="number" class="form-control" min="0" max="1000" step="10">
              <span class="input-group-text">m</span>
            </div>
          </div>
          <div class="col-sm-4">
            <label for="climb-length" class="form-label">{{ t('profile.climb.min_length') }}</label>
            <div class="input-group">
              <input id="climb-length" v-model.number="prefs.climb_detection.min_length_m" type="number" class="form-control" min="50" max="5000" step="50">
              <span class="input-group-text">m</span>
            </div>
          </div>
          <div class="col-sm-4">
            <label for="climb-merge-gap" class="form-label">{{ t('profile.climb.merge_gap') }}</label>
            <div class="input-group">
              <input id="climb-merge-gap" v-model.number="prefs.climb_detection.merge_gap_m" type="number" class="form-control" min="0" max="2000" step="50">
              <span class="input-group-text">m</span>
            </div>
            <div class="form-text">{{ t('profile.climb.merge_gap_help') }}</div>
          </div>
        </div>
        <hr class="my-3">
        <label for="climb-smoothing" class="form-label mb-1">
          {{ t('profile.climb.grade_smoothing') }} : <strong>{{ prefs.climb_detection.grade_smoothing_m }} m</strong>
        </label>
        <input id="climb-smoothing" v-model.number="prefs.climb_detection.grade_smoothing_m" type="range" class="form-range" min="10" max="200" step="5">
        <p class="text-muted small mb-0">{{ t('profile.climb.grade_smoothing_help') }}</p>
      </div>
    </section>

    <!-- Vitesses moyennes -->
    <section v-if="showSection('speeds')" class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-gauge-high text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.speeds.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.speeds.help') }}</p>
        <div class="row g-3">
          <div v-for="s in SPORTS" :key="s" class="col-sm-4">
            <label :for="`speed-${s}`" class="form-label d-flex align-items-center gap-2">
              <i :class="`fa-solid ${sportIcon(s)} text-muted`" aria-hidden="true"></i>
              {{ t(`profile.display.sport_${s}`) }}
            </label>
            <div class="input-group">
              <input
                :id="`speed-${s}`"
                v-model.number="prefs.speeds[s]"
                type="number"
                class="form-control"
                min="3"
                max="80"
                step="0.5"
              >
              <span class="input-group-text">km/h</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Barre de sauvegarde -->
    <div class="d-flex align-items-center gap-3 sticky-bottom py-2">
      <button type="submit" class="btn btn-primary" :disabled="saving">
        <i class="fa-solid fa-floppy-disk me-1" aria-hidden="true"></i>
        {{ saving ? t('profile.saving') : t('profile.save') }}
      </button>
      <button type="button" class="btn btn-outline-secondary" :disabled="saving" @click="resetToDefaults">
        <i class="fa-solid fa-rotate-left me-1" aria-hidden="true"></i>{{ t('profile.reset') }}
      </button>
      <span v-if="saved" class="text-success">
        <i class="fa-solid fa-circle-check me-1" aria-hidden="true"></i>{{ t('profile.saved') }}
      </span>
      <span v-if="error" class="text-danger">
        <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ t('profile.save_error') }}
      </span>
    </div>
  </form>
</template>

<style scoped>
.user-profile {

}

.map-style-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  min-width: 84px;
  padding: 0.75rem 0.5rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.85rem;
  transition: border-color 0.15s, background-color 0.15s;
}

.map-style-option i {
  font-size: 1.25rem;
}

.map-style-option:hover {
  background-color: var(--bs-tertiary-bg);
}

.map-style-option.active {
  border-color: var(--bs-primary);
  background-color: var(--bs-primary-bg-subtle);
  color: var(--bs-primary);
}

.sticky-bottom {
  background: var(--bs-body-bg);
}

/* Liste réordonnable des pays privilégiés (recherche de lieux) */
.country-list {
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.country-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.4rem;
  background: var(--bs-body-bg);
  cursor: grab;
  transition: border-color 0.15s, background-color 0.15s, opacity 0.15s;
}

.country-item:active { cursor: grabbing; }
.country-item.dragging { opacity: 0.45; }
.country-item.dragover { border-color: var(--bs-primary); background: var(--bs-primary-bg-subtle); }

.country-grip { color: var(--bs-secondary-color); cursor: grab; }

.country-rank {
  min-width: 1.4rem;
  text-align: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--bs-secondary-color);
}

.country-flag { font-size: 1.1rem; line-height: 1; }
.country-name { flex: 1; font-size: 0.9rem; }
.country-remove { line-height: 1; }

/* Cadre façon téléphone en portrait : même proportions que l'écran de navigation,
   pour que le réglage du zoom/inclinaison soit représentatif du rendu réel. */
.nav-preview {
  position: relative;
  width: 100%;
  max-width: 240px;
  margin-inline: auto;
  aspect-ratio: 9 / 18;
  border-radius: 1.25rem;
  overflow: hidden;
  border: 1px solid var(--bs-border-color);
}

.nav-preview-map {
  position: absolute;
  inset: 0;
}

.nav-preview-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.7);
  font-weight: 500;
  z-index: 1;
}

.nav-preview-badge {
  position: absolute;
  left: 0.5rem;
  bottom: 0.5rem;
  z-index: 1;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 0.5rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}
</style>

<style>
.nav-preview-arrow {
  pointer-events: none;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
}
</style>
