<script setup lang="ts">
import { reactive, ref, computed, onMounted, onBeforeUnmount, useTemplateRef, watch, nextTick } from 'vue'
import { type PropType } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import { ActivityMapState } from '../pageState'
import MapStyleDropdown from './MapStyleDropdown.vue'
import RouteFromActivityModal from './RouteFromActivityModal.vue'
import {
  activityIcon,
  sportType,
  routeSportFor,
  decodePolyline,
  pickPhotoUrl,
  type PhotoLike,
} from '../activityHelpers'
// Détection de cols, segments colorés par pente et buckets : on réutilise les mêmes
// helpers que le créateur d'itinéraire — donc les seuils de col et la fenêtre de
// lissage de pente du profil utilisateur — pour que l'analyse et la création
// d'itinéraire restent cohérentes.
import { simplifyIndices, nudgeIndicesOffTurns, buildGradedSegments, detectClimbs, GRADE_BUCKETS } from '../routeHelpers'
import { sportPreferences, routeProfileForSport, turnAnomalyDiameterForSport } from '../userPreferences'
import { repairAgainstTrack } from '../routeRepair'
import { buildTooltipHtml } from '../activityTooltip'

const props = defineProps({
  activity: { type: Object as PropType<Record<string, any>>, required: true },
  streams: { type: Object as PropType<Record<string, any> | null>, default: null },
  photos: { type: Array as PropType<PhotoLike[]>, default: () => [] },
  // Current cross-component selection — { startIdx, endIdx } | null.
  selection: { type: Object, default: null },
  // Prévisualisation venue d'un panneau frère (survol d'une ligne de l'onglet
  // Segments) : même rendu que la sélection, mais sans la committer ni zoomer —
  // exactement ce que fait le survol d'un marqueur de col sur la carte.
  previewRange: { type: Object, default: null },
  // v-model:hovered-climb-start-idx — synchronizes hover state with
  // ActivityStats so pointing at a row highlights the corresponding marker
  // and vice versa.
  hoveredClimbStartIdx: { type: Number, default: null },
  // v-model:lightbox-index — set when the user clicks a photo marker so
  // PhotoGallery pops the corresponding photo.
  lightboxIndex: { type: Number, default: null },
  // For the route-hover tooltip we need to know which streams are currently
  // visible on a chart (to surface their values) and the parent's x-axis
  // mode. Both are owned by ActivityCharts → passed through ActivityDetail.
  visibleStreams: { type: Array, default: () => [] },
  xAxis: { type: String, default: 'distance' },
  // For the bottom-left "Create route from activity" button — handed back
  // through an emit so the parent owns the redirect/sessionStorage handoff.
  localePrefix: { type: String, default: '' },
  // Carte collée en haut (onglet Segments) : la classe ne peut PAS venir du parent,
  // ce composant a deux nœuds racines (la carte + la modale) — Vue ne sait pas à qui
  // attacher les attributs d'un fragment et les jette. D'où une prop explicite.
  sticky: { type: Boolean, default: false },
})

const emit = defineEmits([
  'select-segment',
  'clear-selection',
  'update:hoveredClimbStartIdx',
  'update:lightboxIndex',
  // Remonté au parent pour que ActivityCharts colore aussi le profil d'altitude par pente.
  'update:showGrade',
])

// ─── Page state (persisted to localStorage) ──────────────────────────────
const state = reactive(new ActivityMapState())

// Couleur (hors mode pente), opacité et épaisseur du tracé : réglables par sport dans le
// profil, exactement comme le créateur d'itinéraire. Une activité importée n'a pas de
// sport au sens du profil (son type vient de Strava ou du fichier .fit) : on affiche donc
// le tracé aux couleurs du sport par défaut du compte. La bordure et la sélection se
// déduisent de l'épaisseur pour rester proportionnées.
const { color: ROUTE_COLOR, opacity: ROUTE_OPACITY, width: ROUTE_WIDTH } = sportPreferences().route
// Sur petit écran tactile, on élargit légèrement le tracé (même logique que le créateur).
const ROUTE_LINE_DISPLAY_SCALE = window.matchMedia('(max-width: 767px), (max-height: 500px)').matches ? 1.3 : 1
const ROUTE_LINE_WIDTH = ROUTE_WIDTH * ROUTE_LINE_DISPLAY_SCALE
const ROUTE_BORDER_WIDTH = (ROUTE_WIDTH + 3) * ROUTE_LINE_DISPLAY_SCALE
const SELECTED_LINE_WIDTH = (ROUTE_WIDTH + 2) * ROUTE_LINE_DISPLAY_SCALE

// Imperative map state — kept as `let`/non-reactive caches because the map
// library hands us instances that don't play well with deep reactivity.
const mapEl = useTemplateRef('mapEl')
let mapInstance = null
let markerA = null
let markerB = null
let hoverMarker = null
let isDragging = false
let dragRafPending = false
// Auto-zoom de la carte sur la sélection committée (clic sur un col du panneau stats,
// drag sur un graphique…). `suppressSelectionFit` court-circuite ce zoom pour les
// gestes internes à la carte (drag des poignées, clic sur un marqueur de col qui zoome
// déjà lui-même). Le timer débounce les sélections émises en continu (poignées de graphique).
let suppressSelectionFit = false
let selectionFitTimer: ReturnType<typeof setTimeout> | null = null
const climbMarkers = []
// Map climb.startIdx → marker DOM element so the parent-driven hover state
// (hoveredClimbStartIdx prop) can add/remove the `.climb-marker-active` class.
const climbMarkerEls = new Map()
const photoMarkers = []
let _maplibregl = null

// ─── Derived geometry ────────────────────────────────────────────────────
const polyline = computed(() => props.activity?.map?.summary_polyline || props.activity?.map?.polyline || '')
// Prefer the high-resolution latlng stream when available (Strava stores it as [lat, lng] pairs).
const routeCoords = computed(() => {
  const latlng = props.streams?.latlng?.data
  if (Array.isArray(latlng) && latlng.length > 0) {
    return latlng.map(([lat, lng]) => [lng, lat])
  }
  if (polyline.value) return decodePolyline(polyline.value)
  return []
})
const hasRoute = computed(() => routeCoords.value.length > 0)
const hasLatLngStream = computed(() => Array.isArray(props.streams?.latlng?.data) && props.streams.latlng.data.length > 0)

// Tolérance (m) de simplification du tracé pour l'AFFICHAGE. Une trace Strava peut compter
// des dizaines de milliers de points quasi superposés (le GPS qui « grouille » sur place
// pendant un arrêt) : les rendre bruts sature le pavage MapLibre et fige la carte. À ~3 m
// on ne perd rien de visible aux échelles d'une activité, mais on divise le nombre de
// sommets par 10 à 40.
const DISPLAY_SIMPLIFY_TOLERANCE_M = 3
// Tracé simplifié réservé aux COUCHES de la carte (ligne, dégradé de pente, flèches de
// direction). On sous-échantillonne altitude et distance sur les MÊMES indices que les
// coordonnées pour préserver l'alignement exigé par buildGradedSegments. Toutes les
// interactions (survol, sélection, marqueurs de cols/photos) continuent d'indexer les
// streams pleine résolution — cette simplification est purement visuelle.
const displayRoute = computed(() => {
  const coords = routeCoords.value
  const altitudes = props.streams?.altitude?.data
  const distances = props.streams?.distance?.data
  if (coords.length < 3) return { coords, altitudes, distances }
  const idx = simplifyIndices(coords as [number, number][], DISPLAY_SIMPLIFY_TOLERANCE_M)
  if (idx.length >= coords.length) return { coords, altitudes, distances }
  return {
    coords: idx.map((i) => coords[i]),
    altitudes: Array.isArray(altitudes) ? idx.map((i) => altitudes[i]) : altitudes,
    distances: Array.isArray(distances) ? idx.map((i) => distances[i]) : distances,
  }
})

const startEndDisplay = computed(() => {
  const a = props.activity
  if (!a?.start_date_local) return null
  // Strava ships start_date_local as a wall-clock local time but with a "Z"
  // suffix — strip it so JS doesn't shift it by the browser's UTC offset.
  const startMs = new Date(a.start_date_local.replace(/Z$/, '')).getTime()
  if (Number.isNaN(startMs)) return null
  const elapsed = a.elapsed_time
  const endMs = elapsed ? startMs + elapsed * 1000 : null
  const fmtFull = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } as const
  const fmtHM = { hour: '2-digit', minute: '2-digit' } as const
  const start = new Date(startMs)
  const end = endMs != null ? new Date(endMs) : null
  if (!end) return { start: start.toLocaleString(undefined, fmtFull), end: null, duration: null }
  const sameDay = start.toDateString() === end.toDateString()
  return {
    start: start.toLocaleString(undefined, fmtFull),
    end: sameDay ? end.toLocaleTimeString(undefined, fmtHM) : end.toLocaleString(undefined, fmtFull),
    duration: formatDuration(elapsed),
  }
})

function formatDuration(seconds) {
  if (!seconds) return '–'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}min` : (m > 0 ? `${m}min ${s}s` : `${s}s`)
}

// Aide de la pilule TSS selon la source du calcul (puissance / FC / estimation).
function tssHint(source) {
  const key = source === 'power' ? 'tss_hint_power' : source === 'hr' ? 'tss_hint_hr' : 'tss_hint_estimated'
  return t(`strava.${key}`)
}

// Valeur par défaut proposée dans la modale « créer un itinéraire depuis l'activité » :
// nombre de points max après simplification. Plus de points = re-routage BRouter plus
// fidèle à la trace d'origine ; 100 reste sous les limites pratiques de BRouter.
const ROUTE_FROM_ACTIVITY_MAX_WAYPOINTS = 100

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

// ─── Index helpers ───────────────────────────────────────────────────────
function latLngToIndex(lng, lat) {
  const arr = props.streams?.latlng?.data
  if (!arr || arr.length === 0) return 0
  let bestIdx = 0
  let bestD = Infinity
  for (let i = 0; i < arr.length; i++) {
    const dLat = arr[i][0] - lat
    const dLng = arr[i][1] - lng
    const d = dLat * dLat + dLng * dLng
    if (d < bestD) { bestD = d; bestIdx = i }
  }
  return bestIdx
}

function setMapStyle(id) {
  if (!mapInstance || id === state.mapStyleId) return
  state.mapStyleId = id
  // `diff: false` forces a full wipe — without it, maplibre preserves custom
  // items across the swap and our re-addImage() call throws.
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  mapInstance.once('style.load', () => installRouteLayers())
}

// ─── Map layers ──────────────────────────────────────────────────────────
function gradePaintExpression() {
  if (!state.showGrade) return ROUTE_COLOR
  return [
    'match', ['get', 'bucket'],
    0, GRADE_BUCKETS[0].color,
    1, GRADE_BUCKETS[1].color,
    2, GRADE_BUCKETS[2].color,
    3, GRADE_BUCKETS[3].color,
    4, GRADE_BUCKETS[4].color,
    5, GRADE_BUCKETS[5].color,
    6, GRADE_BUCKETS[6].color,
    '#fc4c02',
  ]
}

// Adds the route geometry / arrows / selection overlay to the current style.
// Safe to call after a setStyle() swap because all layers/sources belong to
// the style and are wiped when the style changes.
function installRouteLayers() {
  if (!mapInstance) return
  // Géométrie simplifiée pour l'affichage (cf. displayRoute) — coords/altitude/distance
  // restent alignées par index.
  const { coords, altitudes, distances } = displayRoute.value
  if (!coords.length) return
  // Pente lissée depuis l'altitude (fenêtre du profil), comme le créateur d'itinéraire —
  // le stream `grade_smooth` de Strava (lissage maison) n'est volontairement pas utilisé.
  const segments = buildGradedSegments(coords as [number, number][], altitudes, distances)
  const hasGrades = segments.length > 0 && altitudes?.length && distances?.length

  mapInstance.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
  })

  if (hasGrades) {
    mapInstance.addSource('route-graded', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: segments },
    })
    mapInstance.addLayer({
      id: 'route-border',
      type: 'line',
      source: 'route-graded',
      layout: ROUTE_LINE_LAYOUT,
      paint: { ...ROUTE_BORDER_PAINT, 'line-width': ROUTE_BORDER_WIDTH },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route-graded',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': gradePaintExpression(), 'line-width': ROUTE_LINE_WIDTH, 'line-opacity': ROUTE_OPACITY },
    })
  } else {
    mapInstance.addLayer({
      id: 'route-border',
      type: 'line',
      source: 'route',
      layout: ROUTE_LINE_LAYOUT,
      paint: { ...ROUTE_BORDER_PAINT, 'line-width': ROUTE_BORDER_WIDTH },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': ROUTE_COLOR, 'line-width': ROUTE_LINE_WIDTH, 'line-opacity': ROUTE_OPACITY },
    })
  }

  mapInstance.addImage('route-arrow', buildArrowImage(28), { pixelRatio: 2 })
  mapInstance.addLayer({
    id: 'route-direction',
    type: 'symbol',
    source: 'route',
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 90,
      'icon-image': 'route-arrow',
      'icon-size': 0.85,
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  })

  mapInstance.addSource('selected-route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })
  mapInstance.addLayer({
    id: 'selected-route-line',
    type: 'line',
    source: 'selected-route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#00b4d8', 'line-width': SELECTED_LINE_WIDTH },
  })

  // Re-apply the 3D terrain if it was on before the style switch.
  if (state.is3D) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
  }

  refreshSelectedRoute()
}

// ─── Climb markers ───────────────────────────────────────────────────────
function installClimbMarkers(maplibregl) {
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  climbMarkerEls.clear()
  if (!state.showClimbs) return
  const latlng = props.streams?.latlng?.data
  const altitudes = props.streams?.altitude?.data
  const distances = props.streams?.distance?.data
  if (!latlng || !altitudes || !distances) return
  const climbs = detectClimbs(altitudes, distances)
  climbs.forEach((climb) => {
    const pt = latlng[climb.startIdx]
    if (!pt) return
    const el = buildClimbMarkerEl(climb)
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' })
      .setLngLat([pt[1], pt[0]])
      .addTo(mapInstance)
    climbMarkers.push(marker)
    climbMarkerEls.set(climb.startIdx, el)
  })
}

function buildClimbMarkerEl(climb) {
  const el = document.createElement('div')
  const catClass = climb.category ? `climb-cat-${climb.category}` : 'climb-cat-uncat'
  el.className = `climb-marker ${catClass}`
  const lengthStr = climb.lengthM >= 1000
    ? `${(climb.lengthM / 1000).toFixed(1)} km`
    : `${Math.round(climb.lengthM)} m`
  el.innerHTML = `
    <i class="fa-solid fa-mountain" aria-hidden="true"></i>
    <span class="climb-marker-stats">+${Math.round(climb.gain)}m&nbsp;·&nbsp;${climb.avgGrade.toFixed(1)}%</span>
    ${climb.category ? `<span class="climb-marker-cat">${climb.category}</span>` : ''}
  `
  el.title = `${t('strava.click_to_select_climb')}\n${climb.category ? 'Cat ' + climb.category + ' · ' : ''}${lengthStr} · +${Math.round(climb.gain)} m · ${climb.avgGrade.toFixed(1)} %`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    // Clic = on committe la sélection (le parent pin le tronçon) puis on zoome dessus.
    // On garde la prévisualisation jusqu'au mouseleave : le temps que props.selection
    // se mette à jour, le tronçon reste affiché sans clignoter. On zoome directement ici
    // (et on court-circuite l'auto-zoom du watch) pour un zoom fiable à chaque clic.
    suppressSelectionFit = true
    emit('select-segment', climb.startIdx, climb.endIdx)
    fitMapToSegment(climb.startIdx, climb.endIdx)
  })
  // Stop the mousedown so the user clicking the badge doesn't start a map pan.
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  // Survol : on surligne la ligne du tableau de stats (hoveredClimbStartIdx) ET on
  // prévisualise le tronçon comme sélectionné sur la carte (tronçon bleu + poignées).
  el.addEventListener('mouseenter', () => {
    emit('update:hoveredClimbStartIdx', climb.startIdx)
    previewSelection.value = { startIdx: climb.startIdx, endIdx: climb.endIdx }
  })
  el.addEventListener('mouseleave', () => {
    if (props.hoveredClimbStartIdx === climb.startIdx) emit('update:hoveredClimbStartIdx', null)
    previewSelection.value = null
  })
  return el
}

function toggleClimbs() {
  state.showClimbs = !state.showClimbs
  if (!state.showClimbs) {
    climbMarkers.forEach((m) => m.remove())
    climbMarkers.length = 0
  } else if (_maplibregl) {
    installClimbMarkers(_maplibregl)
  }
}

// ─── Photo markers ───────────────────────────────────────────────────────
function installPhotoMarkers(maplibregl) {
  photoMarkers.forEach((m) => m.remove())
  photoMarkers.length = 0
  if (!state.showPhotos || !mapInstance) return
  props.photos.forEach((photo, idx) => {
    const loc = photo.location
    if (!Array.isArray(loc) || loc.length < 2) return
    const el = buildPhotoMarkerEl(photo, idx)
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([loc[1], loc[0]])
      .addTo(mapInstance)
    photoMarkers.push(marker)
  })
}

function buildPhotoMarkerEl(photo, idx) {
  const el = document.createElement('div')
  el.className = 'photo-marker'
  const thumb = pickPhotoUrl(photo, 256)
  el.innerHTML = thumb ? `<img src="${thumb}" alt="">` : `<i class="fa-solid fa-camera"></i>`
  el.title = photo.caption || t('strava.photo_marker_title')
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    emit('update:lightboxIndex', idx)
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return el
}

function togglePhotos() {
  state.showPhotos = !state.showPhotos
  if (!state.showPhotos) {
    photoMarkers.forEach((m) => m.remove())
    photoMarkers.length = 0
  } else if (_maplibregl) {
    installPhotoMarkers(_maplibregl)
  }
}

// ─── Draggable selection handles ─────────────────────────────────────────
// Chevron de sens du parcours — identique au créateur d'itinéraire : trait blanc
// cerné d'un liseré sombre semi-transparent, lisible sur tous les fonds de carte.
function buildArrowImage(size = 28): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const draw = () => {
    ctx.beginPath()
    ctx.moveTo(size * 0.34, size * 0.24)
    ctx.lineTo(size * 0.7, size * 0.5)
    ctx.lineTo(size * 0.34, size * 0.76)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'
  ctx.lineWidth = size * 0.22
  draw()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = size * 0.12
  draw()
  return ctx.getImageData(0, 0, size, size)
}

function createFlagElement(kind) {
  const el = document.createElement('div')
  el.dataset.kind = kind
  el.style.cursor = 'grab'
  el.style.width = '28px'
  el.style.height = '36px'
  el.innerHTML = flagSvg(kind)
  return el
}

function flagSvg(kind) {
  if (kind === 'start') {
    return `
      <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
        <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
        <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
        <path d="M4 4 L24 4 L24 18 L4 18 Z" fill="#22c55e" stroke="#15803d" stroke-width="1"/>
      </svg>`
  }
  const cells = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = 4 + col * 5
      const y = 4 + row * 5
      const dark = (row + col) % 2 === 0
      cells.push(`<rect x="${x}" y="${y}" width="5" height="5" fill="${dark ? '#ef4444' : '#ffffff'}"/>`)
    }
  }
  return `
    <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
      <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
      <rect x="4" y="4" width="20" height="15" fill="none" stroke="#7f1d1d" stroke-width="1"/>
      ${cells.join('')}
    </svg>`
}

function setFlagKind(el, kind) {
  if (el.dataset.kind === kind) return
  el.dataset.kind = kind
  el.innerHTML = flagSvg(kind)
}

function applyMarkerRoles() {
  if (!markerA || !markerB || !hasLatLngStream.value) return
  const a = markerA.getLngLat()
  const b = markerB.getLngLat()
  const aIdx = latLngToIndex(a.lng, a.lat)
  const bIdx = latLngToIndex(b.lng, b.lat)
  const aIsStart = aIdx <= bIdx
  setFlagKind(markerA.getElement(), aIsStart ? 'start' : 'end')
  setFlagKind(markerB.getElement(), aIsStart ? 'end' : 'start')
}

function installMapHandles(maplibregl) {
  const data = props.streams.latlng.data
  if (data.length < 2) return
  const start = data[0]
  const end = data[data.length - 1]

  const elA = createFlagElement('start')
  const elB = createFlagElement('end')
  markerA = new maplibregl.Marker({ element: elA, draggable: true, anchor: 'bottom-left' })
    .setLngLat([start[1], start[0]])
    .addTo(mapInstance)
  markerB = new maplibregl.Marker({ element: elB, draggable: true, anchor: 'bottom-left' })
    .setLngLat([end[1], end[0]])
    .addTo(mapInstance)

  markerA.on('dragstart', () => { isDragging = true })
  markerB.on('dragstart', () => { isDragging = true })
  markerA.on('drag', () => scheduleMarkerSync())
  markerB.on('drag', () => scheduleMarkerSync())
  markerA.on('dragend', () => { isDragging = false; syncFromMarkers() })
  markerB.on('dragend', () => { isDragging = false; syncFromMarkers() })

  applyMarkerRoles()
}

function scheduleMarkerSync() {
  if (dragRafPending) return
  dragRafPending = true
  requestAnimationFrame(() => {
    dragRafPending = false
    syncFromMarkers()
  })
}

function syncFromMarkers() {
  if (!markerA || !markerB) return
  const a = markerA.getLngLat()
  const b = markerB.getLngLat()
  const aIdx = latLngToIndex(a.lng, a.lat)
  const bIdx = latLngToIndex(b.lng, b.lat)
  const maxIdx = props.streams.latlng.data.length - 1
  const lo = Math.min(aIdx, bIdx)
  const hi = Math.max(aIdx, bIdx)
  const isFullRange = lo === 0 && hi === maxIdx
  // Geste interne à la carte : on ne re-zoome pas, l'utilisateur vise déjà l'endroit voulu.
  suppressSelectionFit = true
  if (isFullRange) emit('clear-selection')
  else emit('select-segment', lo, hi)
  applyMarkerRoles()
}

// Survol d'un marqueur de col : on prévisualise le tronçon comme « sélectionné »
// (tronçon bleu + poignées A/B) sans toucher à la sélection committée du parent.
// La sélection effectivement affichée est donc la prévisualisation si elle existe,
// sinon `props.selection`. Même logique que le créateur d'itinéraire.
const previewSelection = ref<{ startIdx: number; endIdx: number } | null>(null)
const effectiveSelection = computed(() => previewSelection.value || props.previewRange || props.selection)

function refreshSelectedRoute() {
  if (!mapInstance || !mapInstance.getSource('selected-route')) return
  const sel = effectiveSelection.value
  if (!hasLatLngStream.value || !sel) {
    mapInstance.getSource('selected-route').setData({ type: 'FeatureCollection', features: [] })
    return
  }
  const data = props.streams.latlng.data
  const { startIdx, endIdx } = sel
  const coords = data.slice(startIdx, endIdx + 1).map(([lat, lng]) => [lng, lat])
  mapInstance.getSource('selected-route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
  })
}

// Repositions the A/B drag handles to match a `selection` set from elsewhere
// (chart selection, climb-marker click, table-row click).
function syncMarkersFromSelection() {
  if (!markerA || !markerB || !hasLatLngStream.value) return
  const data = props.streams.latlng.data
  const sel = effectiveSelection.value
  if (sel) {
    const a = data[sel.startIdx]
    const b = data[sel.endIdx]
    if (a) markerA.setLngLat([a[1], a[0]])
    if (b) markerB.setLngLat([b[1], b[0]])
  } else {
    // No selection → markers go back to the start/end of the route.
    markerA.setLngLat([data[0][1], data[0][0]])
    markerB.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
  }
  applyMarkerRoles()
}

// Zoome sur le tronçon [startIdx, endIdx] (clic sur un col), comme le créateur.
function fitMapToSegment(startIdx: number, endIdx: number) {
  if (!mapInstance || !hasLatLngStream.value) return
  const data = props.streams.latlng.data
  const slice = data.slice(Math.min(startIdx, endIdx), Math.max(startIdx, endIdx) + 1)
  if (slice.length < 2) return
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const [lat, lng] of slice) {
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  mapInstance.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 500 })
}

// ─── Hover tooltip + cursor ──────────────────────────────────────────────
function showMapTooltip(idx: number) {
  const wrap = mapEl.value?.parentNode
  if (!wrap || idx == null) return
  let el = wrap.querySelector<HTMLElement>('.chart-tooltip')
  if (!el) {
    el = document.createElement('div')
    el.className = 'chart-tooltip chart-tooltip-pinned'
    wrap.appendChild(el)
  }
  el.innerHTML = buildTooltipHtml({
    streams: props.streams,
    activity: props.activity,
    xAxis: props.xAxis,
    idx,
    visibleStreams: props.visibleStreams as string[],
  })
  el.style.opacity = '1'
  el.style.top = '110px'
  el.style.right = '12px'
  el.style.left = 'auto'
  el.style.transform = 'none'
}

function hideMapTooltip() {
  const wrap = mapEl.value?.parentNode
  const el = wrap?.querySelector<HTMLElement>('.chart-tooltip')
  if (el) el.style.opacity = '0'
}

function showRouteCursor(lngLat) {
  if (!mapInstance) return
  if (!hoverMarker && _maplibregl) {
    const el = document.createElement('div')
    el.className = 'route-cursor'
    hoverMarker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(mapInstance)
  } else if (hoverMarker) {
    hoverMarker.setLngLat(lngLat)
    hoverMarker.getElement().style.display = ''
  }
}

function hideRouteCursor() {
  if (hoverMarker) hoverMarker.getElement().style.display = 'none'
}

// Returns the route index nearest to a map mousemove/click event if the
// cursor is within `tolPx` screen pixels of the actual route, otherwise null.
function nearestRouteIndexFromEvent(e, tolPx) {
  const data = props.streams?.latlng?.data
  if (!data || data.length === 0) return null
  const idx = latLngToIndex(e.lngLat.lng, e.lngLat.lat)
  const pt = data[idx]
  if (!pt) return null
  const routePx = mapInstance.project([pt[1], pt[0]])
  const dx = e.point.x - routePx.x
  const dy = e.point.y - routePx.y
  if (Math.hypot(dx, dy) > tolPx) return null
  return { idx, pt }
}

function installMapHoverTooltip() {
  if (!mapInstance) return
  mapInstance.on('mousemove', (e) => {
    if (isDragging) { hideMapTooltip(); hideRouteCursor(); return }
    const hit = nearestRouteIndexFromEvent(e, 40)
    if (!hit) { hideMapTooltip(); hideRouteCursor(); return }
    showMapTooltip(hit.idx)
    showRouteCursor([hit.pt[1], hit.pt[0]])
  })
  mapInstance.on('mouseout', () => { hideMapTooltip(); hideRouteCursor() })
  mapInstance.on('click', (e) => {
    if (isDragging) return
    const hit = nearestRouteIndexFromEvent(e, 25)
    if (!hit) return
    emit('select-segment', hit.idx, hit.idx)
  })
}

// ─── Grade + 3D + expand ─────────────────────────────────────────────────
function toggleGrade() {
  state.showGrade = !state.showGrade
  if (mapInstance && mapInstance.getLayer('route-line')) {
    mapInstance.setPaintProperty('route-line', 'line-color', gradePaintExpression())
  }
}

function toggleMap3D() {
  if (!mapInstance) return
  state.is3D = !state.is3D
  if (state.is3D) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    mapInstance.easeTo({ pitch: 60, bearing: -20, duration: 700 })
  } else {
    mapInstance.setTerrain(null)
    mapInstance.easeTo({ pitch: 0, bearing: 0, duration: 700 })
  }
}

async function toggleMapSize() {
  state.mapExpanded = !state.mapExpanded
  await nextTick()
  if (mapInstance) mapInstance.resize()
}

// ─── Map init ────────────────────────────────────────────────────────────
async function renderMap() {
  if (!hasRoute.value || !mapEl.value || mapInstance) return

  const maplibregl = (await import('maplibre-gl')).default
  _maplibregl = maplibregl
  await import('maplibre-gl/dist/maplibre-gl.css')

  const coords = routeCoords.value
  const bounds = coords.reduce(
    (b, c) => [
      [Math.min(b[0][0], c[0]), Math.min(b[0][1], c[1])],
      [Math.max(b[1][0], c[0]), Math.max(b[1][1], c[1])],
    ],
    [[coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]],
  )

  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(state.mapStyleId) as any,
    bounds: bounds as any,
    fitBoundsOptions: { padding: 40 },
    maxPitch: 75,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')

  mapInstance.on('load', () => {
    installRouteLayers()
    if (hasLatLngStream.value) installMapHandles(maplibregl)
    installClimbMarkers(maplibregl)
    installPhotoMarkers(maplibregl)
    installMapHoverTooltip()
  })
}

// The map is drawn as soon as we have coords — which, for an activity with a
// `summary_polyline`, happens before the detailed streams arrive. In that case
// the first draw has no grade colouring, no drag handles and no climb markers.
// Re-draw the route once `altitude`/`grade_smooth`/`latlng` land so the slope
// colouring + high-res track appear. (`installMapHoverTooltip` is not re-run —
// it binds once and reads the streams lazily at event time.)
function redrawRouteWithStreams() {
  const map = mapInstance
  if (!map || !_maplibregl) return
  const reinstall = () => {
    const layers = ['route-direction', 'route-line', 'route-border', 'selected-route-line']
    layers.forEach((id) => { if (map.getLayer(id)) map.removeLayer(id) })
    const sources = ['route', 'route-graded', 'selected-route']
    sources.forEach((id) => { if (map.getSource(id)) map.removeSource(id) })
    if (map.hasImage('route-arrow')) map.removeImage('route-arrow')
    installRouteLayers()
    if (hasLatLngStream.value && !markerA) installMapHandles(_maplibregl)
    installClimbMarkers(_maplibregl)
  }
  if (map.isStyleLoaded()) reinstall()
  else map.once('style.load', reinstall)
}

// ─── "Create route from this activity" ──────────────────────────────────
const showCreateRouteModal = ref(false)
const defaultRouteName = computed(() => (props.activity?.name || '').trim().slice(0, 80))

function openCreateRouteModal() {
  if (routeCoords.value.length) showCreateRouteModal.value = true
}

// La réparation interroge BRouter deux ou trois fois : on tient la modale ouverte pendant
// ce temps plutôt que de laisser l'utilisateur devant une page qui ne bouge pas.
const creatingRoute = ref(false)

async function confirmCreateRoute({ name, maxPoints }: { name: string; maxPoints: number }) {
  const coords = routeCoords.value
  if (!coords.length || creatingRoute.value) return
  // Simplification Ramer-Douglas-Peucker : on garde les points où la trace tourne
  // vraiment et on jette les points alignés inutiles. Résultat : peu de waypoints sur
  // les lignes droites, du détail dans les virages → re-routage BRouter fidèle. Le
  // plafond (saisi par l'utilisateur) borne le nombre de waypoints.
  // Puis nudgeIndicesOffTurns écarte les waypoints de l'apex des virages, sans quoi ils
  // atterriraient sur les carrefours et BRouter y produirait des crochets parasites.
  const track = coords.map((c) => [c[0], c[1]] as [number, number])
  let idx = nudgeIndicesOffTurns(track, simplifyIndices(track, 8, maxPoints))

  // Le sport est déduit de l'activité (et non du dernier sport utilisé) pour que le profil
  // de routage de la réparation soit exactement celui que le créateur appliquera ensuite.
  const sport = routeSportFor(props.activity as Record<string, unknown> | null)
  const profile = routeProfileForSport(sport)

  // Diagnostic + correction : purge des crochets, ré-ancrage des détours. Jamais bloquant —
  // si BRouter ne répond pas, on part avec les waypoints bruts (cf. routeRepair).
  creatingRoute.value = true
  try {
    const { indices } = await repairAgainstTrack(track, idx, profile, {
      maxPoints,
      turnDiameterM: turnAnomalyDiameterForSport(sport),
    })
    idx = indices
  } finally {
    creatingRoute.value = false
  }

  showCreateRouteModal.value = false
  sessionStorage.setItem('sportsScope.gpxImport', JSON.stringify({
    name,
    activity: sport,
    profile,
    waypoints: idx.map((i) => ({ lng: track[i][0], lat: track[i][1] })),
  }))
  window.location.href = `${props.localePrefix}/routes/new?fromGpx=1`
}

// ─── Watchers ────────────────────────────────────────────────────────────
// Render the map as soon as we know the route coords. Covers the case where
// the parent passes streams asynchronously (initial mount may happen before
// they've arrived). `flush: 'post'` is critical here — the `<div ref="mapEl">`
// is inside a `v-if="hasRoute"`, so we have to wait for Vue to commit the
// DOM update before calling `renderMap` (which reads `mapEl.value`).
watch(hasRoute, (v) => { if (v && !mapInstance) renderMap() }, { flush: 'post' })

// Streams usually arrive after the map has already been drawn from the summary
// polyline. When they do, redraw so the grade colouring / drag handles / climb
// markers show up. If the map isn't up yet, the `hasRoute` watch handles it.
watch(() => props.streams, () => {
  if (mapInstance) redrawRouteWithStreams()
})

// Selection drives both the highlighted segment on the map and the A/B
// handle positions. We listen rather than reacting at the parent so the
// parent never has to reach into our DOM.
// `effectiveSelection` couvre à la fois la sélection committée (props.selection) et la
// prévisualisation au survol d'un col — les deux redessinent tronçon bleu + poignées.
watch(effectiveSelection, () => {
  refreshSelectedRoute()
  syncMarkersFromSelection()
})

// Toute sélection committée venue d'ailleurs (clic sur un col / un pic de puissance dans
// le panneau stats, drag sur un graphique…) zoome la carte sur le tronçon, comme le clic
// sur un col de la carte. On ignore : les sélections d'un point unique (clic simple) et
// les gestes internes à la carte (flag suppressSelectionFit). Le débounce évite de faire
// vibrer la carte quand la sélection change en continu (drag des poignées de graphique).
watch(() => props.selection, (sel: any) => {
  if (suppressSelectionFit) { suppressSelectionFit = false; return }
  if (selectionFitTimer) { clearTimeout(selectionFitTimer); selectionFitTimer = null }
  if (!sel || sel.endIdx <= sel.startIdx) return
  selectionFitTimer = setTimeout(() => fitMapToSegment(sel.startIdx, sel.endIdx), 180)
})

// Photos may arrive after the map is up — re-install markers when the list
// changes.
watch(() => props.photos, () => {
  if (mapInstance && _maplibregl) installPhotoMarkers(_maplibregl)
}, { deep: true })

// Mirror the table → marker hover: parent flips `hoveredClimbStartIdx`,
// we toggle `.climb-marker-active` on the right marker element.
watch(() => props.hoveredClimbStartIdx, (curr, prev) => {
  if (prev != null) climbMarkerEls.get(prev)?.classList.remove('climb-marker-active')
  if (curr != null) climbMarkerEls.get(curr)?.classList.add('climb-marker-active')
})

watch(state, () => state.save(), { deep: true })

// Remonte l'état « couleur des tracés » au parent (initial + à chaque bascule) pour que
// ActivityCharts colore le profil d'altitude par pente en même temps que la carte.
watch(() => state.showGrade, (v) => emit('update:showGrade', v), { immediate: true })

// La hauteur du conteneur peut changer sans que la fenêtre bouge (carte collée en
// haut quand l'onglet Segments est actif, plein écran, redimensionnement d'un
// panneau) : MapLibre ne le voit pas tout seul et son canvas reste à l'ancienne
// taille. On le lui dit.
let mapResizeObserver: ResizeObserver | null = null

// Hauteur réellement occupée par la carte quand elle est collée, publiée en
// `--sticky-map-h` sur <html>. Les panneaux qui défilent sous elle (liste des
// segments) s'en servent pour ne pas amener une ligne DERRIÈRE la carte. Publier la
// mesure évite de recopier ailleurs `min(520px, 45vh)` et ses variantes, et reste
// juste quand la fenêtre change.
const cardEl = useTemplateRef('cardEl')
let cardResizeObserver: ResizeObserver | null = null

function publishStickyHeight() {
  const height = props.sticky ? (cardEl.value?.offsetHeight ?? 0) : 0
  document.documentElement.style.setProperty('--sticky-map-h', `${height}px`)
}

watch(() => props.sticky, () => nextTick().then(publishStickyHeight))

onMounted(() => {
  state.load()
  if (hasRoute.value) renderMap()
  if (mapEl.value && typeof ResizeObserver !== 'undefined') {
    mapResizeObserver = new ResizeObserver(() => mapInstance?.resize())
    mapResizeObserver.observe(mapEl.value)
  }
  if (cardEl.value && typeof ResizeObserver !== 'undefined') {
    cardResizeObserver = new ResizeObserver(publishStickyHeight)
    cardResizeObserver.observe(cardEl.value)
  }
  publishStickyHeight()
})

onBeforeUnmount(() => {
  if (mapResizeObserver) { mapResizeObserver.disconnect(); mapResizeObserver = null }
  if (cardResizeObserver) { cardResizeObserver.disconnect(); cardResizeObserver = null }
  document.documentElement.style.removeProperty('--sticky-map-h')
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  photoMarkers.forEach((m) => m.remove())
  photoMarkers.length = 0
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null }
  if (selectionFitTimer) { clearTimeout(selectionFitTimer); selectionFitTimer = null }
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <div ref="cardEl" class="card mb-3 shadow-sm border-0" :class="{ 'map-card-sticky': sticky }">
    <!-- Carte collée (onglet Segments) : pas d'en-tête. Ces chiffres (nom, durée,
         calories, TSS) ne changent pas pendant qu'on parcourt les segments et
         mangeraient la hauteur utile. `v-if` et non `display: none` : l'en-tête
         porte `d-flex`, donc `display: flex !important` — impossible à masquer en
         CSS sans surenchérir en `!important`. -->
    <div v-if="!sticky" class="card-header activity-card-header d-flex align-items-center gap-2">
      <span class="activity-type-badge" :title="sportType(activity)">
        <i :class="`fa-solid ${activityIcon(sportType(activity))}`" aria-hidden="true"></i>
      </span>
      <div class="flex-grow-1 min-width-0">
        <h2 class="h5 mb-0 text-truncate">{{ activity.name }}</h2>
        <div
          v-if="startEndDisplay || sportType(activity)"
          class="activity-times d-flex flex-wrap align-items-center gap-2 mt-1"
        >
          <span v-if="sportType(activity)" class="activity-sport-pill d-inline-flex align-items-center gap-1">
            <i class="fa-solid fa-tag" aria-hidden="true"></i>
            <span>{{ sportType(activity) }}</span>
          </span>
          <template v-if="startEndDisplay">
            <span class="d-inline-flex align-items-center gap-1">
              <i class="fa-solid fa-flag text-success" aria-hidden="true"></i>
              <span>{{ startEndDisplay.start }}</span>
            </span>
            <i v-if="startEndDisplay.end" class="fa-solid fa-arrow-right text-muted" aria-hidden="true"></i>
            <span v-if="startEndDisplay.end" class="d-inline-flex align-items-center gap-1">
              <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>
              <span>{{ startEndDisplay.end }}</span>
            </span>
          </template>
          <span
            v-if="startEndDisplay?.duration"
            class="activity-duration-pill d-inline-flex align-items-center gap-1"
          >
            <i class="fa-solid fa-stopwatch" aria-hidden="true"></i>
            <span>{{ startEndDisplay.duration }}</span>
          </span>
          <span
            v-if="activity.calories"
            class="activity-cal-pill d-inline-flex align-items-center gap-1"
          >
            <i class="fa-solid fa-fire" aria-hidden="true"></i>
            <span>{{ Math.round(activity.calories) }} kcal</span>
          </span>
          <span
            v-if="activity.tss != null"
            class="activity-tss-pill d-inline-flex align-items-center gap-1"
            :class="`activity-tss-pill--${activity.tss_source || 'estimated'}`"
            :title="tssHint(activity.tss_source)"
          >
            <i class="fa-solid fa-gauge-high" aria-hidden="true"></i>
            <span>{{ Math.round(activity.tss) }} {{ t('strava.tss_label') }}</span>
          </span>
        </div>
      </div>
      <button
        v-if="hasRoute"
        type="button"
        class="btn btn-sm btn-outline-warning d-inline-flex align-items-center gap-1 ms-auto"
        :title="t('routes.create_from_activity_title')"
        @click="openCreateRouteModal"
      >
        <i class="fa-solid fa-route" aria-hidden="true"></i>
        <span class="d-none d-md-inline">{{ t('routes.create_from_activity') }}</span>
      </button>
    </div>
    <div v-if="hasRoute" class="card-body p-0">
      <div class="map-wrap" :class="{ expanded: state.mapExpanded }">
        <div ref="mapEl" class="activity-map"></div>
        <div class="map-controls">
          <!-- Groupe 1 : style de fond -->
          <MapStyleDropdown :model-value="state.mapStyleId" @update:model-value="setMapStyle" />

          <!-- Groupe 2 : overlays et vue (toggles indépendants) -->
          <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
            <button
              type="button"
              class="btn map-ctrl-btn"
              :class="state.showClimbs ? 'btn-warning text-dark active' : 'btn-light'"
              :title="state.showClimbs ? t('strava.hide_climbs') : t('strava.show_climbs')"
              :aria-pressed="state.showClimbs"
              @click="toggleClimbs"
            >
              <i class="fa-solid fa-mountain" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="btn map-ctrl-btn"
              :class="state.showGrade ? 'btn-warning text-dark active' : 'btn-light'"
              :title="state.showGrade ? t('strava.hide_grade') : t('strava.show_grade')"
              :aria-pressed="state.showGrade"
              @click="toggleGrade"
            >
              <i class="fa-solid fa-palette" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="btn map-ctrl-btn"
              :class="state.showPhotos ? 'btn-warning text-dark active' : 'btn-light'"
              :title="state.showPhotos ? t('strava.hide_photos') : t('strava.show_photos')"
              :aria-pressed="state.showPhotos"
              :disabled="photos.length === 0"
              @click="togglePhotos"
            >
              <i class="fa-solid fa-camera" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="btn map-ctrl-btn"
              :class="state.is3D ? 'btn-warning text-dark active' : 'btn-light'"
              :title="state.is3D ? t('strava.map_2d') : t('strava.map_3d')"
              :aria-pressed="state.is3D"
              @click="toggleMap3D"
            >
              <i class="fa-solid fa-cube" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="btn map-ctrl-btn"
              :class="state.mapExpanded ? 'btn-warning text-dark active' : 'btn-light'"
              :title="state.mapExpanded ? t('strava.shrink_map') : t('strava.expand_map')"
              :aria-pressed="state.mapExpanded"
              @click="toggleMapSize"
            >
              <i :class="state.mapExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <RouteFromActivityModal
    :show="showCreateRouteModal"
    :initial-name="defaultRouteName"
    :default-max-points="ROUTE_FROM_ACTIVITY_MAX_WAYPOINTS"
    :busy="creatingRoute"
    @confirm="confirmCreateRoute"
    @close="showCreateRouteModal = false"
  />
</template>

<style scoped>
/* Carte collée sous la navbar `fixed-top` (hauteur réelle mesurée dans --navbar-h,
   elle wrappe sur deux lignes avec beaucoup de menus). Un peu moins haute que
   d'habitude, sinon il ne reste plus de place pour la liste des segments sur un
   portable. `sticky` ne crée pas de bloc conteneur pour les descendants `fixed` :
   le plein écran de la carte continue de fonctionner. */
.map-card-sticky {
  position: sticky;
  /* Collée à la navbar, sans interstice : `--navbar-h` est sa hauteur réelle
     (mesurée par trackNavbar, elle wrappe sur deux lignes avec beaucoup de menus). */
  top: var(--navbar-h, 4rem);
  z-index: 3;
  /* Sans en-tête, la carte touche le haut du bloc : on la rogne aux coins arrondis.
     Ne clippe pas le plein écran, qui est en `position: fixed` (donc cadré par la
     fenêtre, pas par cet ancêtre). */
  overflow: hidden;
}
.map-card-sticky .activity-map {
  height: min(520px, 45vh);
}
/* Téléphone : écran court ET lignes de segment plus hautes (elles passent sur trois
   étages) — on rend de la place à la liste. */
@media (max-width: 575.98px) {
  .map-card-sticky .activity-map {
    height: min(300px, 35vh);
  }
}
.map-wrap {
  position: relative;
}
.map-wrap.expanded {
  position: fixed;
  /* Sits below the fixed-top navbar (z-index 1030) and above anything else.
     left=0/right=0 spans the full viewport width. Offset = real navbar height
     (--navbar-h, mesurée par trackNavbar) : elle wrappe sur deux lignes avec
     beaucoup de menus, un offset fixe passerait dessous. Fallback 4rem. */
  top: var(--navbar-h, 4rem);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1020;
  background: #fff;
  box-shadow: 0 -2px 20px rgba(0, 0, 0, 0.2);
}
.min-width-0 { min-width: 0; }
.activity-times {
  font-size: 0.82rem;
  color: #495057;
  font-variant-numeric: tabular-nums;
}
/* Sport (sport_type Strava) — neutre, pour ne pas concurrencer les pastilles
   chiffrées (durée, calories, TSS) qui portent l'information de performance. */
.activity-sport-pill {
  background: rgba(108, 117, 125, 0.12);
  color: #495057;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
.activity-duration-pill {
  background: rgba(252, 76, 2, 0.12);
  color: #fc4c02;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
.activity-cal-pill {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
/* Charge d'entraînement (TSS) — couleur selon la source : puissance (vert,
   fiable), FC (rouge), estimation (gris, moins précis). */
.activity-tss-pill {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
  background: rgba(108, 117, 125, 0.15);
  color: #6c757d;
}
.activity-tss-pill--power {
  background: rgba(25, 135, 84, 0.14);
  color: #198754;
}
.activity-tss-pill--hr {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
}
.activity-map {
  height: 520px;
  width: 100%;
}
.map-wrap.expanded .activity-map {
  height: 100%;
  width: 100%;
}
.map-controls {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
  pointer-events: none;
}
.map-controls > * { pointer-events: auto; }
.map-ctrl-btn {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  width: 34px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
}
.map-ctrl-btn.active,
.map-ctrl-btn.active:hover,
.map-ctrl-btn.active:focus {
  background: #ffc107;
  color: #212529;
  border-color: rgba(252, 76, 2, 0.7);
}
</style>

<style>
/* DOM markers + the route hover cursor are created via document.createElement,
   so they live outside Vue's scoped CSS. Keep these rules global. */
.climb-marker {
  display: inline-flex;
  align-items: center;
  gap: 0.22rem;
  background: rgba(255, 255, 255, 0.96);
  padding: 0.1rem 0.35rem 0.1rem 0.32rem;
  border-radius: 12px;
  font-size: 0.66rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  border: 1.5px solid currentColor;
  box-shadow: 0 3px 8px -3px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transform: translateY(-4px);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
  user-select: none;
  line-height: 1.4;
}
.climb-marker:hover,
.climb-marker-active {
  transform: translateY(-6px) scale(1.06);
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.45);
}
/* `-active` is "remote-controlled" from the stats table; nudge it above
   nearby markers so it's never hidden. */
.climb-marker-active { z-index: 2; }
.climb-marker i { font-size: 0.74rem; }
.climb-marker .climb-marker-stats { color: #212529; }
.climb-marker .climb-marker-cat {
  background: currentColor;
  color: #fff !important;
  padding: 0 0.3rem;
  border-radius: 999px;
  font-size: 0.6rem;
  letter-spacing: 0.02em;
  min-width: 0.85rem;
  text-align: center;
}
.climb-marker .climb-marker-cat::first-letter { text-transform: uppercase; }

.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }

/* Hover cursor that follows the route. */
.route-cursor {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  border: 3px solid #fc4c02;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.75), 0 2px 8px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}

/* Photo markers on the map. */
.photo-marker {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2.5px solid #fff;
  background: #1f2937;
  overflow: hidden;
  box-shadow: 0 3px 8px -2px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  transform: translateY(-4px);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}
.photo-marker:hover {
  transform: translateY(-6px) scale(1.1);
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.55);
  z-index: 10;
}
.photo-marker img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.photo-marker i {
  color: #fff;
  font-size: 0.95rem;
}
</style>
