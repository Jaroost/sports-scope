<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, useTemplateRef, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'
import { computeElevGain } from '../activityHelpers'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import { RouteBuilderState } from '../pageState'
import MapStyleDropdown from './MapStyleDropdown.vue'

const props = defineProps({
  routeId: { type: [String, Number], default: null },
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

// ─── Reactive state ──────────────────────────────────────────────────────────
const name = ref('')
const waypoints = ref([])         // [{lng, lat}, ...] user-clicked points
const geometry = ref([])          // [[lng, lat, ele|null], ...] road-snapped polyline with altitude
const distanceM = ref(0)
const elevGainM = ref(0)
const elevLossM = ref(0)
const isFetchingRoute = ref(false)
const isFetchingElevation = ref(false)
const saving = ref(false)
const error = ref(null)
const state = reactive(new RouteBuilderState())
const currentId = ref(props.routeId ? Number(props.routeId) : null)
const mapEl = useTemplateRef('mapEl')
const chartEl = useTemplateRef('chartEl')

let mapInstance = null
let chartInstance = null
let _maplibregl = null
const waypointMarkers = []
let hoverMarker = null
let locationMarker = null
let lastLocationCoords: [number, number] | null = null
let lastLocationAccuracy = 0
const locationVisible = ref(false)
const locating = ref(false)
const hoverIdx = ref(null) // geometry index under cursor when over the route
let waypointGeomIndices = [] // for each waypoint, its index in geometry[]
let selectedWpIdx = -1 // index of the currently selected waypoint, -1 if none
const svCache = new Map<string, boolean>()
// Set to true right after a successful waypoint drag so the click event
// maplibre synthesizes from the mouseup doesn't add/insert a spurious point.
let suppressNextMapClick = false
// Legs where the cycling profile detours far around the foot profile — i.e.
// sections with a one-way restriction against the cyclist's direction. We
// render the foot path with a red dashed overlay + warning marker.
const divergentLegs = ref([])
const divergentMarkers = []
// Selection on the elevation chart — drag a region to highlight that
// portion of the track on the map. { startKm, endKm } or null.
const selectionRange = ref(null)
let cumDistKm = [] // cumulative distance in km per geometry index — fills during chart render
let chartDrag = null // { startPx, currentPx } while the user is dragging on the chart
// While the user is dragging one of the start/end flag handles to resize the
// selection. `fixedKm` is the km the other handle stays anchored to.
let chartHandleDrag = null // { fixedKm } | null
const HANDLE_TOL_PX = 8 // pixels from the flag pole that count as a "grab"
// Wheel-zoom on the x axis of the elevation chart. zoomMin/zoomMax in km;
// null means "natural extent" (the whole route).
const isZoomed = ref(false)
let zoomMin = null
let zoomMax = null
let chartCrossMarker = null // marker on the map synced to chart hover position
let climbHoverStartMarker = null // green flag shown on map when hovering a climb pill
let climbHoverEndMarker = null   // checkered flag shown on map when hovering a climb pill
let selectionMarkerA = null // draggable handle for one end of the selection
let selectionMarkerAKm = null
let selectionMarkerB = null // draggable handle for the other end
let selectionMarkerBKm = null
let selectionMarkerDragging = false

const climbMarkers = []
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

// Gradient color buckets for the route line — matches ActivityDetail.vue.
const GRADE_BUCKETS = [
  { max: -8,       color: '#1e3a8a' }, // very steep descent
  { max: -3,       color: '#3b82f6' }, // descent
  { max:  3,       color: '#22c55e' }, // flat / rolling
  { max:  6,       color: '#eab308' }, // easy climb
  { max: 10,       color: '#f97316' }, // medium climb
  { max: 15,       color: '#dc2626' }, // hard climb
  { max: Infinity, color: '#7f1d1d' }, // very hard climb
]

const hasGeometry = computed(() => geometry.value.length >= 2)



const detectedClimbs = computed(() => {
  const g = geometry.value
  if (g.length < 2) return []
  const altitudes = g.map((c) => c[2] ?? null)
  const distances = [0]
  for (let i = 1; i < g.length; i++) distances.push(distances[i - 1] + haversine(g[i - 1], g[i]))
  return detectClimbs(altitudes, distances).map((c) => ({
    ...c,
    startKm: distances[c.startIdx] / 1000,
    endKm: distances[c.endIdx] / 1000,
  }))
})

// Average riding speed in km/h, persisted in localStorage. Used to compute
// an estimated ride time below the map. Default 18 km/h ≈ typical cyclo
// touring pace including stops.
const SPEED_KEY = 'sportsScope.routeBuilderAvgSpeed'
function loadSpeed() {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    const v = raw != null ? parseFloat(raw) : NaN
    return Number.isFinite(v) && v >= 3 && v <= 80 ? v : 18
  } catch { return 18 }
}
const avgSpeedKmh = ref(loadSpeed())
watch(avgSpeedKmh, (v) => {
  if (!Number.isFinite(v) || v < 3 || v > 80) return
  try { localStorage.setItem(SPEED_KEY, String(v)) } catch { /* ignore */ }
})

// Estimated ride time: distance / speed. The user picks an average speed that
// already reflects how hilly the route is, so no climb penalty is layered on
// top — otherwise tweaking the speed barely moved the displayed duration.
const estimatedSeconds = computed(() => {
  const d = distanceM.value
  const v = avgSpeedKmh.value
  if (!d || !Number.isFinite(v) || v <= 0) return 0
  return Math.round(((d / 1000) / v) * 3600)
})

function formatDuration(totalSec) {
  if (!totalSec || totalSec < 0) return '–'
  const h = Math.floor(totalSec / 3600)
  const m = Math.round((totalSec - h * 3600) / 60)
  if (h === 0) return `${m} min`
  return `${h} h ${String(m).padStart(2, '0')}`
}

// Distance / D+ / D- shown in the elevation card header. Reflects the chart
// selection when there is one, otherwise the full route totals.
const chartStats = computed(() => {
  const range = selectionRange.value
  if (range && cumDistKm.length && geometry.value.length >= 2) {
    const i0 = geomIdxForKm(range.startKm)
    const i1 = geomIdxForKm(range.endKm)
    const lo = Math.min(i0, i1)
    const hi = Math.max(i0, i1)
    if (hi - lo >= 1) {
      let dist = 0
      for (let i = lo + 1; i <= hi; i++) {
        dist += haversine(geometry.value[i - 1], geometry.value[i])
      }
      const { gain: up, loss: down } = computeGainLoss(geometry.value.slice(lo, hi + 1))
      return {
        distance: dist,
        gain: up,
        loss: down,
        avgGrade: dist > 0 ? ((up - down) / dist) * 100 : 0,
        isSelection: true,
      }
    }
  }
  const d = distanceM.value
  return {
    distance: d,
    gain: elevGainM.value,
    loss: elevLossM.value,
    avgGrade: d > 0 ? ((elevGainM.value - elevLossM.value) / d) * 100 : 0,
    isSelection: false,
  }
})
const isEditMode = computed(() => currentId.value != null)

// Place search (Nominatim/OSM — free, no key required)
const searchQuery = ref('')
const searchResults = ref([])
const searchOpen = ref(false)
const searching = ref(false)
let searchTimer = null

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (trimmed.length < 3) {
    searchResults.value = []
    searchOpen.value = false
    return
  }
  searchTimer = setTimeout(() => searchPlaces(trimmed), 350)
})

async function searchPlaces(q) {
  searching.value = true
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=6&addressdetails=0`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const data = await res.json()
    searchResults.value = Array.isArray(data) ? data : []
    searchOpen.value = searchResults.value.length > 0
  } catch {
    searchResults.value = []
    searchOpen.value = false
  } finally {
    searching.value = false
  }
}

function pickPlace(p) {
  searchOpen.value = false
  searchQuery.value = p.display_name.split(',')[0]
  if (!mapInstance) return
  if (p.boundingbox && p.boundingbox.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = p.boundingbox.map(parseFloat)
    mapInstance.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      { padding: 60, duration: 800, maxZoom: 14 },
    )
  } else {
    const lat = parseFloat(p.lat)
    const lng = parseFloat(p.lon)
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      mapInstance.flyTo({ center: [lng, lat], zoom: 13, duration: 800 })
    }
  }
}

function clearSearch() {
  searchQuery.value = ''
  searchResults.value = []
  searchOpen.value = false
}


// ─── Utils ───────────────────────────────────────────────────────────────────
function haversine(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr.slice()
  const step = arr.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)])
  return out
}

function formatKm(m) {
  if (!m) return '0 km'
  return `${(m / 1000).toFixed(2)} km`
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

// Initial map view: prefer the last view the user had (stored in localStorage)
// since browser geolocation on desktop is often wildly inaccurate (WiFi/IP
// triangulation pulls to ISP central nodes, can be tens of km off). Falls
// back to a sensible default (center of France) otherwise. The GeolocateControl
// button (top-right) lets the user explicitly request a geolocation centering.
function getInitialView(skip) {
  if (skip) return { center: [2.35, 48.85], zoom: 6 }
  try {
    const raw = localStorage.getItem('sportsScope.routeBuilderView')
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v.center) && v.center.length === 2 && typeof v.zoom === 'number') {
        return v
      }
    }
  } catch {
    // ignore
  }
  return { center: [2.35, 46.6], zoom: 5 } // centre of France, wide view
}

function saveMapView() {
  if (!mapInstance) return
  try {
    const c = mapInstance.getCenter()
    localStorage.setItem(
      'sportsScope.routeBuilderView',
      JSON.stringify({ center: [c.lng, c.lat], zoom: mapInstance.getZoom() }),
    )
  } catch {
    // ignore
  }
}

// ─── Map setup ───────────────────────────────────────────────────────────────
async function renderMap() {
  if (!mapEl.value) return
  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')
  _maplibregl = maplibregl

  const { center, zoom } = getInitialView(!!currentId.value)

  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(state.mapStyleId) as any,
    center,
    zoom,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')

  // Block on the 'load' event so callers that await renderMap() are
  // guaranteed that the route source/layer exist before they try to write
  // to them (otherwise updateRouteLayer() would silently no-op).
  await new Promise((resolve) => {
    mapInstance.on('load', () => {
      installRouteLayer()
      mapInstance.on('click', (e) => {
        // A waypoint drag just released — swallow the synthesized click.
        if (suppressNextMapClick) { suppressNextMapClick = false; return }
        deselectAll()
        // If the cursor is on the existing route, insert a new waypoint at
        // that exact spot (between the appropriate leg). Otherwise add a
        // new waypoint at the clicked coords.
        if (hoverIdx.value != null) {
          insertWaypointAtGeomIdx(hoverIdx.value)
        } else {
          addWaypoint(e.lngLat.lng, e.lngLat.lat)
        }
      })
      mapInstance.on('mousemove', (e) => {
        if (waypoints.value.length < 2) { hideHoverMarker(); return }
        const idx = nearestGeomIndexAt(e.point)
        if (idx == null) { hideHoverMarker(); return }
        if (isNearWaypoint(e.point)) { hideHoverMarker(); return }
        hoverIdx.value = idx
        showHoverMarker(geometry.value[idx])
      })
      mapInstance.on('mouseout', hideHoverMarker)
      // Persist view after every pan/zoom — except in edit mode where the
      // route's own bbox dictates the camera.
      mapInstance.on('moveend', () => {
        if (!currentId.value) saveMapView()
      })
      mapInstance.getCanvas().style.cursor = 'crosshair'
      resolve(undefined)
    })
  })
}

function bucketGrade(g) {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return i
  }
  return GRADE_BUCKETS.length - 1
}

function gradeForIndex(i, altitudes, distances) {
  if (!altitudes || !distances || i + 1 >= altitudes.length || i + 1 >= distances.length) return 0
  const da = altitudes[i + 1] - altitudes[i]
  const dd = distances[i + 1] - distances[i]
  return dd > 0 ? (da / dd) * 100 : 0
}


function buildGradedSegments(coords, altitudes, distances) {
  if (!coords || coords.length < 2) return []
  const features = []
  let current = [coords[0]]
  let curBucket = bucketGrade(gradeForIndex(0, altitudes, distances))
  for (let i = 1; i < coords.length; i++) {
    const g = gradeForIndex(Math.min(i, coords.length - 2), altitudes, distances)
    const b = bucketGrade(g)
    current.push(coords[i])
    if (b !== curBucket && current.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: current.slice() },
        properties: { bucket: curBucket },
      })
      current = [coords[i]]
      curBucket = b
    }
  }
  if (current.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: current },
      properties: { bucket: curBucket },
    })
  }
  return features
}

function climbCategory(lengthKm, avgGrade) {
  const score = lengthKm * Math.pow(Math.max(0, avgGrade), 2)
  if (score >= 400) return 'HC'
  if (score >= 200) return '1'
  if (score >= 100) return '2'
  if (score >= 60) return '3'
  if (score >= 25) return '4'
  return null
}

function detectClimbs(altitudes, distances) {
  if (!altitudes || !distances || altitudes.length === 0 || distances.length === 0) return []
  const MIN_GRADE = 2
  const MIN_GAIN_M = 60
  const MIN_LENGTH_M = 500
  const MERGE_GAP_M = 250
  const len = Math.min(altitudes.length, distances.length)
  const raw = []
  let startIdx = -1
  for (let i = 0; i < len; i++) {
    const g = gradeForIndex(i, altitudes, distances)
    if (g >= MIN_GRADE) {
      if (startIdx < 0) startIdx = i
    } else if (startIdx >= 0) {
      raw.push({ startIdx, endIdx: i })
      startIdx = -1
    }
  }
  if (startIdx >= 0) raw.push({ startIdx, endIdx: len - 1 })
  const merged = []
  for (const r of raw) {
    if (!merged.length) { merged.push(r); continue }
    const prev = merged[merged.length - 1]
    const gap = distances[r.startIdx] - distances[prev.endIdx]
    if (gap <= MERGE_GAP_M) prev.endIdx = r.endIdx
    else merged.push(r)
  }
  return merged
    .map((r) => {
      const gain = altitudes[r.endIdx] - altitudes[r.startIdx]
      const lengthM = distances[r.endIdx] - distances[r.startIdx]
      const avgGrade = lengthM > 0 ? (gain / lengthM) * 100 : 0
      return { ...r, gain, lengthM, avgGrade, category: climbCategory(lengthM / 1000, avgGrade) }
    })
    .filter((c) => c.gain >= MIN_GAIN_M && c.lengthM >= MIN_LENGTH_M && c.avgGrade >= MIN_GRADE)
}

function installRouteLayer() {
  if (!mapInstance) return
  if (!mapInstance.getSource('builder-route')) {
    mapInstance.addSource('builder-route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
  }
  // Gradient-coloured visible route. Each feature carries a `bucket` property
  // that the match expression resolves to a colour. When `showGrade` is off,
  // the same layer paints flat orange instead.
  if (!mapInstance.getSource('builder-route-graded')) {
    mapInstance.addSource('builder-route-graded', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    mapInstance.addLayer({
      id: 'builder-route-border',
      type: 'line',
      source: 'builder-route-graded',
      layout: ROUTE_LINE_LAYOUT,
      paint: ROUTE_BORDER_PAINT,
    })
    mapInstance.addLayer({
      id: 'builder-route-line',
      type: 'line',
      source: 'builder-route-graded',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': gradePaintExpression(), 'line-width': 5 },
    })
  }
  if (!mapInstance.getSource('builder-divergent')) {
    mapInstance.addSource('builder-divergent', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    mapInstance.addLayer({
      id: 'builder-divergent-line',
      type: 'line',
      source: 'builder-divergent',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#d62828',
        'line-width': 4,
        'line-dasharray': [1.4, 1.4],
      },
    })
  }
  // The selection layer is drawn last so it overlays both the main route and
  // any divergent overlay.
  if (!mapInstance.getSource('builder-route-selected')) {
    mapInstance.addSource('builder-route-selected', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    })
    mapInstance.addLayer({
      id: 'builder-route-selected-line',
      type: 'line',
      source: 'builder-route-selected',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#00b4d8', 'line-width': 7 },
    })
  }
}

function updateRouteLayer() {
  if (!mapInstance) return
  const baseSrc = mapInstance.getSource('builder-route')
  if (baseSrc) {
    const coords = geometry.value.map(([lng, lat]) => [lng, lat])
    baseSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } })
  }
  // The visible colored line is set by applyColorMode based on the current
  // grade / surface / none selection.
  applyColorMode()
}

function installClimbMarkers() {
  if (!_maplibregl || !mapInstance) return
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  if (!state.showClimbs || geometry.value.length < 2) return
  const altitudes = geometry.value.map((c) => c[2] ?? null)
  const distances = []
  let cum = 0
  distances.push(0)
  for (let i = 1; i < geometry.value.length; i++) {
    cum += haversine(geometry.value[i - 1], geometry.value[i])
    distances.push(cum)
  }
  const climbs = detectClimbs(altitudes, distances)
  climbs.forEach((climb) => {
    const pt = geometry.value[climb.startIdx]
    if (!pt) return
    const el = buildClimbMarkerEl(climb, distances)
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom-left' })
      .setLngLat([pt[0], pt[1]])
      .addTo(mapInstance)
    climbMarkers.push(marker)
  })
}

function buildClimbMarkerEl(climb, distances) {
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
  // Click → select the climb segment on the chart (and the map highlight).
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    const startKm = (distances[climb.startIdx] || 0) / 1000
    const endKm = (distances[climb.endIdx] || 0) / 1000
    selectionRange.value = { startKm, endKm }
    updateSelectionLayer()
    if (chartInstance) chartInstance.update('none')
    fitMapToSelection()
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return el
}

function toggleClimbs() {
  state.showClimbs = !state.showClimbs
  installClimbMarkers()
}

function gradePaintExpression() {
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

// Apply the current colorMode to the visible line: choose the right
// segmentation (grade / none) and paint expression.
// Called from updateRouteLayer + from the toggle.
function applyColorMode() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-route-graded')
  if (!src) return
  const coords = geometry.value.map(([lng, lat]) => [lng, lat])
  let features: any[] = []
  let paint: string | any[] = '#fc4c02'
  if (state.colorMode === 'grade' && coords.length >= 2) {
    const altitudes = geometry.value.map((c) => c[2] ?? null)
    const distances = [0]
    let cum = 0
    for (let i = 1; i < geometry.value.length; i++) {
      cum += haversine(geometry.value[i - 1], geometry.value[i])
      distances.push(cum)
    }
    features = buildGradedSegments(coords, altitudes, distances)
    paint = gradePaintExpression()
  } else if (coords.length >= 2) {
    features = [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
  }
  src.setData({ type: 'FeatureCollection', features })
  if (mapInstance.getLayer('builder-route-line')) {
    mapInstance.setPaintProperty('builder-route-line', 'line-color', paint)
  }
}

function toggleGrade() {
  state.colorMode = state.colorMode === 'grade' ? 'none' : 'grade'
  applyColorMode()
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
  // map-wrap toggles to position:fixed full-screen — give maplibre a chance to
  // re-measure after the layout change.
  await nextTick()
  if (mapInstance) mapInstance.resize()
}

// ─── Ma position ─────────────────────────────────────────────────────────────
function generateCircle(center: [number, number], radiusM: number, steps = 64): [number, number][] {
  const [lng, lat] = center
  const latR = lat * Math.PI / 180
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    pts.push([
      lng + (radiusM / (111320 * Math.cos(latR))) * Math.cos(a),
      lat + (radiusM / 110540) * Math.sin(a),
    ])
  }
  return pts
}

function installLocationLayers(coords: [number, number], accuracy: number) {
  if (!mapInstance) return
  const data = {
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: [generateCircle(coords, accuracy)] },
  }
  if (!mapInstance.getSource('user-location')) {
    mapInstance.addSource('user-location', { type: 'geojson', data })
    mapInstance.addLayer({
      id: 'user-location-fill',
      type: 'fill',
      source: 'user-location',
      paint: { 'fill-color': '#4285f4', 'fill-opacity': 0.12 },
    })
    mapInstance.addLayer({
      id: 'user-location-stroke',
      type: 'line',
      source: 'user-location',
      paint: { 'line-color': '#4285f4', 'line-width': 1.5, 'line-opacity': 0.5 },
    })
  } else {
    mapInstance.getSource('user-location').setData(data)
  }
}

function showLocation(coords: [number, number], accuracy: number) {
  if (!mapInstance || !_maplibregl) return
  lastLocationCoords = coords
  lastLocationAccuracy = accuracy
  installLocationLayers(coords, accuracy)
  if (locationMarker) {
    locationMarker.setLngLat(coords)
  } else {
    const el = document.createElement('div')
    el.className = 'user-location-dot'
    locationMarker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(coords)
      .addTo(mapInstance)
  }
  locationVisible.value = true
}

function hideLocation() {
  if (locationMarker) { locationMarker.remove(); locationMarker = null }
  lastLocationCoords = null
  if (mapInstance) {
    if (mapInstance.getLayer('user-location-stroke')) mapInstance.removeLayer('user-location-stroke')
    if (mapInstance.getLayer('user-location-fill')) mapInstance.removeLayer('user-location-fill')
    if (mapInstance.getSource('user-location')) mapInstance.removeSource('user-location')
  }
  locationVisible.value = false
}

async function toggleLocation() {
  if (locationVisible.value) { hideLocation(); return }
  locating.value = true
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 8000, maximumAge: 30000,
      })
    })
    const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude]
    mapInstance?.flyTo({ center: coords, zoom: 14, duration: 800 })
    showLocation(coords, pos.coords.accuracy)
  } catch { /* permission refusée ou timeout */ }
  finally { locating.value = false }
}

function updateDivergentLayer() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-divergent')
  if (!src) return
  const features = divergentLegs.value.map((leg) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: leg.coords },
    properties: { extraM: leg.extraM },
  }))
  src.setData({ type: 'FeatureCollection', features })
}

function updateSelectionLayer() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-route-selected')
  if (!src) return
  if (!selectionRange.value || !cumDistKm.length) {
    src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } })
    return
  }
  const i0 = geomIdxForKm(selectionRange.value.startKm)
  const i1 = geomIdxForKm(selectionRange.value.endKm)
  const lo = Math.min(i0, i1)
  const hi = Math.max(i0, i1)
  const coords = geometry.value.slice(lo, hi + 1).map(([lng, lat]) => [lng, lat])
  src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } })
}

function updateClimbHoverLayer(climb) {
  if (!_maplibregl || !mapInstance) return
  if (!climb) {
    if (climbHoverStartMarker) { climbHoverStartMarker.remove(); climbHoverStartMarker = null }
    if (climbHoverEndMarker)   { climbHoverEndMarker.remove();   climbHoverEndMarker = null }
    return
  }
  const ptStart = geometry.value[climb.startIdx]
  const ptEnd   = geometry.value[climb.endIdx]
  if (!ptStart || !ptEnd) return

  function makeClimbFlagMarker(kind) {
    const el = document.createElement('div')
    el.className = `climb-hover-flag climb-hover-flag--${kind}`
    el.innerHTML = kind === 'start'
      ? '<i class="fa-solid fa-flag"></i>'
      : '<i class="fa-solid fa-flag-checkered"></i>'
    return new _maplibregl.Marker({ element: el, anchor: 'bottom' })
  }

  if (climbHoverStartMarker) climbHoverStartMarker.remove()
  if (climbHoverEndMarker)   climbHoverEndMarker.remove()
  climbHoverStartMarker = makeClimbFlagMarker('start').setLngLat([ptStart[0], ptStart[1]]).addTo(mapInstance)
  climbHoverEndMarker   = makeClimbFlagMarker('end').setLngLat([ptEnd[0], ptEnd[1]]).addTo(mapInstance)
}

function selectClimb(climb) {
  selectionRange.value = { startKm: climb.startKm, endKm: climb.endKm }
  updateSelectionLayer()
  if (chartInstance) chartInstance.update('none')
  fitMapToSelection()
}

function geomIdxForKm(km) {
  if (!cumDistKm.length) return 0
  // Binary search for the first index where cumDistKm[i] >= km.
  let lo = 0
  let hi = cumDistKm.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cumDistKm[mid] < km) lo = mid + 1
    else hi = mid
  }
  return lo
}

function refreshDivergentMarkers() {
  if (!_maplibregl || !mapInstance) return
  divergentMarkers.forEach((m) => m.remove())
  divergentMarkers.length = 0
  divergentLegs.value.forEach((leg) => {
    const el = document.createElement('div')
    el.className = 'divergent-warning-marker'
    el.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>'
    el.title = `${t('routes.no_cycling_here')} · +${Math.round(leg.extraM)} m`
    const marker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(leg.midpoint)
      .addTo(mapInstance)
    divergentMarkers.push(marker)
  })
}


function setMapStyle(id) {
  if (!mapInstance || id === state.mapStyleId) return
  state.mapStyleId = id
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  mapInstance.once('style.load', () => {
    installRouteLayer()
    updateRouteLayer()
    updateDivergentLayer()
    updateSelectionLayer()
    installClimbMarkers()
    if (locationVisible.value && lastLocationCoords) {
      installLocationLayers(lastLocationCoords, lastLocationAccuracy)
    }
    // Re-apply 3D terrain (the style swap dropped both layers + terrain DEM).
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
  })
}

// ─── Street View availability (JSONP — no API key required) ──────────────────
function svCacheKey(lat: number, lng: number) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

function checkSV(lat: number, lng: number): Promise<boolean> {
  const key = svCacheKey(lat, lng)
  if (svCache.has(key)) return Promise.resolve(svCache.get(key)!)
  return new Promise<boolean>((resolve) => {
    const cb = `_sv${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    const s = document.createElement('script')
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      delete (window as any)[cb]
      s.remove()
      svCache.set(key, v)
      resolve(v)
    }
    const timer = setTimeout(() => finish(true), 4000) // fail-open on timeout
    ;(window as any)[cb] = (d: any) => finish(Array.isArray(d?.[1]) && d[1].length > 0)
    s.src = `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lng}!2d50!3m18!2m2!1sen!2sUS!9m1!1e2!11m12!1m3!1e2!2b1!3e2!1m3!1e3!2b1!3e2!1m3!1e10!2b1!3e2!4m6!1e1!1e2!1e3!1e4!1e8!1e6&callback=${cb}`
    s.onerror = () => finish(true) // fail-open on error
    document.head.appendChild(s)
  })
}

function applySVState(markerEl: HTMLElement, available: boolean) {
  const link = markerEl.querySelector<HTMLElement>('.wp-tooltip-action--streetview')
  if (!link) return
  link.classList.toggle('wp-tooltip-action--disabled', !available)
  if (!available) link.setAttribute('aria-disabled', 'true')
  else link.removeAttribute('aria-disabled')
}

// ─── Waypoint selection & tooltip ────────────────────────────────────────────
function isInSwitzerland(lat, lng) {
  return lat >= 45.818 && lat <= 47.808 && lng >= 5.956 && lng <= 10.492
}

function selectWaypoint(idx) {
  if (selectedWpIdx >= 0 && waypointMarkers[selectedWpIdx]) {
    const el = waypointMarkers[selectedWpIdx].getElement()
    el.classList.remove('wp-marker--selected')
    if (el.parentElement) el.parentElement.style.zIndex = ''
  }
  if (selectedWpIdx === idx) {
    selectedWpIdx = -1
    return
  }
  selectedWpIdx = idx
  if (waypointMarkers[idx]) {
    const el = waypointMarkers[idx].getElement()
    el.classList.add('wp-marker--selected')
    if (el.parentElement) el.parentElement.style.zIndex = '200'
  }
  // Lazy Street View availability check — updates the tooltip once resolved.
  const wp = waypoints.value[idx]
  if (wp) {
    checkSV(wp.lat, wp.lng).then((ok) => {
      if (selectedWpIdx === idx && waypointMarkers[idx]) {
        applySVState(waypointMarkers[idx].getElement(), ok)
      }
    })
  }
}

function deselectAll() {
  if (selectedWpIdx >= 0 && waypointMarkers[selectedWpIdx]) {
    const el = waypointMarkers[selectedWpIdx].getElement()
    el.classList.remove('wp-marker--selected')
    if (el.parentElement) el.parentElement.style.zIndex = ''
  }
  selectedWpIdx = -1
}

// ─── Waypoint management ─────────────────────────────────────────────────────
function addWaypoint(lng, lat) {
  waypoints.value = [...waypoints.value, { lng, lat }]
  refreshWaypointMarkers()
  recomputeRoute()
}

function removeWaypoint(idx) {
  waypoints.value = waypoints.value.filter((_, i) => i !== idx)
  refreshWaypointMarkers()
  recomputeRoute()
}

// Append a return path ending at `idx`. The waypoint just before `idx` in the
// return sequence is skipped — `idx` itself replaces it as the final point.
// Example: [A,B,C,D] clicking A → [A,B,C,D,C,A]  (B is skipped, A is last)
function addReturnTo(idx) {
  const wps = waypoints.value
  if (wps.length < 2 || idx >= wps.length - 1) return
  const toAdd = []
  for (let i = wps.length - 2; i > idx + 1; i--) {
    toAdd.push(wps[i])
  }
  toAdd.push(wps[idx])
  waypoints.value = [...wps, ...toAdd]
  deselectAll()
  refreshWaypointMarkers()
  recomputeRoute()
}

function undoLast() {
  if (waypoints.value.length === 0) return
  waypoints.value = waypoints.value.slice(0, -1)
  refreshWaypointMarkers()
  recomputeRoute()
}

function clearAll() {
  if (!waypoints.value.length) return
  if (!window.confirm(t('routes.clear_confirm'))) return
  waypoints.value = []
  refreshWaypointMarkers()
  recomputeRoute()
}

function fitMapToSelection() {
  if (!mapInstance || !selectionRange.value || !geometry.value.length) return
  const i0 = geomIdxForKm(selectionRange.value.startKm)
  const i1 = geomIdxForKm(selectionRange.value.endKm)
  const slice = geometry.value.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)
  if (slice.length < 2) return
  const lngs = slice.map((c) => c[0])
  const lats = slice.map((c) => c[1])
  mapInstance.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 60, duration: 500 },
  )
}

function fitMapToRoute() {
  if (!mapInstance || geometry.value.length < 2) return
  const lngs = geometry.value.map((c) => c[0])
  const lats = geometry.value.map((c) => c[1])
  mapInstance.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 40, duration: 500 },
  )
}

function toggleWaypoints() {
  state.showWaypoints = !state.showWaypoints
  refreshWaypointMarkers()
  if (chartInstance) chartInstance.update('none')
}

function refreshWaypointMarkers() {
  if (!_maplibregl || !mapInstance) return
  waypointMarkers.forEach((m) => m.remove())
  waypointMarkers.length = 0
  selectedWpIdx = -1
  if (!state.showWaypoints) return
  waypoints.value.forEach((w, idx) => {
    const el = document.createElement('div')
    el.className = 'wp-marker'
    const inSwiss = isInSwitzerland(w.lat, w.lng)
    const isLast = idx === waypoints.value.length - 1
    const geoAdminHtml = inSwiss
      ? `<a class="wp-tooltip-action" href="https://map.geo.admin.ch/?zoom=14&crosshair=circle&lat=${w.lat}&lon=${w.lng}" target="_blank" rel="noopener noreferrer">
           <i class="fa-solid fa-map" aria-hidden="true"></i>
           <span>SwissTopo</span>
         </a>`
      : ''
    const returnHtml = !isLast
      ? `<button type="button" class="wp-tooltip-action wp-tooltip-action--return">
           <i class="fa-solid fa-right-left" aria-hidden="true"></i>
           <span>${t('routes.return_via_same_route')}</span>
         </button>`
      : ''
    el.innerHTML = `
      <div class="wp-tooltip">
        <button type="button" class="wp-tooltip-close" aria-label="Fermer">×</button>
        <a class="wp-tooltip-action" href="https://www.google.com/maps?q=${w.lat},${w.lng}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i>
          <span>Google Maps</span>
        </a>
        <a class="wp-tooltip-action wp-tooltip-action--streetview" href="https://www.google.com/maps?q=&layer=c&cbll=${w.lat},${w.lng}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-street-view" aria-hidden="true"></i>
          <span>${t('routes.street_view')}</span>
        </a>
        <a class="wp-tooltip-action wp-tooltip-action--komoot" href="https://www.komoot.com/plan/@${w.lat},${w.lng},14z?p[0][loc]=${w.lat},${w.lng}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
          <span>Komoot</span>
        </a>
        ${geoAdminHtml}
        ${returnHtml}
        <button type="button" class="wp-tooltip-action wp-tooltip-action--delete">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
          <span>${t('routes.remove_waypoint')}</span>
        </button>
        <div class="wp-tooltip-arrow"></div>
      </div>
      <span class="wp-marker-num">${idx + 1}</span>
    `
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([w.lng, w.lat])
      .addTo(mapInstance)

    // Manual drag — replaces maplibre's built-in draggable: behaves unreliably
    // when nested inside our Vue island + Bootstrap layout (mousedown bubbling
    // ordering issue with the map canvas).
    attachWaypointDrag(el, marker, idx)

    // Click on the marker (not the tooltip) → select/deselect
    el.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (ev.target.closest('.wp-tooltip')) return
      selectWaypoint(idx)
    })

    // Close button
    el.querySelector('.wp-tooltip-close').addEventListener('click', (ev) => {
      ev.stopPropagation()
      deselectAll()
    })

    // Tooltip external links — close tooltip after navigation
    el.querySelectorAll('.wp-tooltip-action:not(.wp-tooltip-action--delete)').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.stopPropagation()
        deselectAll()
      })
    })

    // Return via same route button
    el.querySelector('.wp-tooltip-action--return')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      addReturnTo(idx)
    })

    // Delete button
    el.querySelector('.wp-tooltip-action--delete').addEventListener('click', (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      removeWaypoint(idx)
    })

    // Right-click also deletes (quick shortcut, no confirm)
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      removeWaypoint(idx)
    })

    waypointMarkers.push(marker)
  })
}

function attachWaypointDrag(el, marker, idx) {
  el.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    if (ev.target.closest('.wp-tooltip')) return // tooltip actions — let click fire
    ev.preventDefault()
    ev.stopPropagation()

    let moved = false
    mapInstance.dragPan.disable()
    mapInstance.getCanvas().style.cursor = 'grabbing'
    el.style.cursor = 'grabbing'

    const onMove = (e) => {
      moved = true
      const rect = mapInstance.getContainer().getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const ll = mapInstance.unproject([x, y])
      marker.setLngLat([ll.lng, ll.lat])
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      mapInstance.dragPan.enable()
      mapInstance.getCanvas().style.cursor = 'crosshair'
      el.style.cursor = ''
      if (!moved) return
      suppressNextMapClick = true
      setTimeout(() => { suppressNextMapClick = false }, 50)
      const pos = marker.getLngLat()
      const next = waypoints.value.slice()
      next[idx] = { lng: pos.lng, lat: pos.lat }
      waypoints.value = next
      recomputeRoute()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

// ─── Hover-to-insert: drag the line to add waypoints ───────────────────────
function recomputeWaypointGeomIndices() {
  const wps = waypoints.value
  const geom = geometry.value
  if (!wps.length || !geom.length) {
    waypointGeomIndices = []
    return
  }
  waypointGeomIndices = wps.map((w) => {
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < geom.length; i++) {
      const dx = geom[i][0] - w.lng
      const dy = geom[i][1] - w.lat
      const d = dx * dx + dy * dy
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  })
}

function nearestGeomIndexAt(point) {
  if (!mapInstance || !geometry.value.length) return null
  // Cheap pre-filter: is the cursor over the route line pixels?
  const features = mapInstance.queryRenderedFeatures(
    [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]],
    { layers: ['builder-route-line'] },
  )
  if (!features.length) return null
  // Iterate geometry to find the nearest vertex in screen-space.
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < geometry.value.length; i++) {
    const pt = geometry.value[i]
    const px = mapInstance.project([pt[0], pt[1]])
    const dx = px.x - point.x
    const dy = px.y - point.y
    const d = dx * dx + dy * dy
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best >= 0 ? best : null
}

function isNearWaypoint(point) {
  if (!mapInstance) return false
  const TOL = 22 // pixels — roughly the radius of the marker badge
  for (const w of waypoints.value) {
    const px = mapInstance.project([w.lng, w.lat])
    const dx = px.x - point.x
    const dy = px.y - point.y
    if (dx * dx + dy * dy <= TOL * TOL) return true
  }
  return false
}

function showHoverMarker(coord) {
  if (!_maplibregl || !mapInstance || !coord) return
  const lngLat = [coord[0], coord[1]]
  if (!hoverMarker) {
    const el = document.createElement('div')
    el.className = 'route-insert-marker'
    el.innerHTML = '<i class="fa-solid fa-plus"></i>'
    hoverMarker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(mapInstance)
  } else {
    hoverMarker.setLngLat(lngLat)
    hoverMarker.getElement().style.display = ''
  }
}

function hideHoverMarker() {
  hoverIdx.value = null
  if (hoverMarker) hoverMarker.getElement().style.display = 'none'
}

function showChartCrossMarker(lng, lat) {
  if (!_maplibregl || !mapInstance) return
  if (!chartCrossMarker) {
    const el = document.createElement('div')
    el.className = 'chart-cross-marker'
    chartCrossMarker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lng, lat])
      .addTo(mapInstance)
  } else {
    chartCrossMarker.setLngLat([lng, lat])
    chartCrossMarker.getElement().style.display = ''
  }
}

function hideChartCrossMarker() {
  if (chartCrossMarker) chartCrossMarker.getElement().style.display = 'none'
}

function updateSelectionMarkers() {
  if (!_maplibregl || !mapInstance || selectionMarkerDragging) return
  if (!selectionRange.value || !cumDistKm.length || !geometry.value.length) {
    if (selectionMarkerA) { selectionMarkerA.remove(); selectionMarkerA = null }
    if (selectionMarkerB) { selectionMarkerB.remove(); selectionMarkerB = null }
    selectionMarkerAKm = null
    selectionMarkerBKm = null
    return
  }
  const { startKm, endKm } = selectionRange.value
  const ptStart = geometry.value[geomIdxForKm(startKm)]
  const ptEnd = geometry.value[geomIdxForKm(endKm)]
  if (!ptStart || !ptEnd) return
  if (!selectionMarkerA) selectionMarkerA = makeSelectionMarker('start')
  if (!selectionMarkerB) selectionMarkerB = makeSelectionMarker('end')
  selectionMarkerAKm = startKm
  selectionMarkerBKm = endKm
  selectionMarkerA.setLngLat([ptStart[0], ptStart[1]])
  selectionMarkerB.setLngLat([ptEnd[0], ptEnd[1]])
}

function makeSelectionMarker(kind) {
  const el = document.createElement('div')
  el.className = `sel-flag-marker sel-flag-marker--${kind}`
  el.innerHTML = kind === 'start'
    ? '<i class="fa-solid fa-flag"></i>'
    : '<i class="fa-solid fa-flag-checkered"></i>'
  const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true })
    .setLngLat([0, 0])
    .addTo(mapInstance)
  marker.on('dragstart', () => { selectionMarkerDragging = true })
  marker.on('drag', () => {
    const { lng: dLng, lat: dLat } = marker.getLngLat()
    let best = 0, bestDist = Infinity
    for (let i = 0; i < geometry.value.length; i++) {
      const dx = geometry.value[i][0] - dLng
      const dy = geometry.value[i][1] - dLat
      const d = dx * dx + dy * dy
      if (d < bestDist) { bestDist = d; best = i }
    }
    const km = cumDistKm[best]
    if (km == null) return
    marker.setLngLat([geometry.value[best][0], geometry.value[best][1]])
    if (marker === selectionMarkerA) selectionMarkerAKm = km
    else selectionMarkerBKm = km
    const lo = Math.min(selectionMarkerAKm ?? km, selectionMarkerBKm ?? km)
    const hi = Math.max(selectionMarkerAKm ?? km, selectionMarkerBKm ?? km)
    selectionRange.value = { startKm: lo, endKm: hi }
    updateSelectionLayer()
    if (chartInstance) chartInstance.update('none')
  })
  marker.on('dragend', () => { selectionMarkerDragging = false; fitMapToSelection() })
  return marker
}

function insertWaypointAtGeomIdx(geomIdx) {
  if (!waypointGeomIndices.length) return
  const pt = geometry.value[geomIdx]
  if (!pt) return
  // Find the leg (i, i+1) containing geomIdx — splice the new point in there
  // so the existing waypoint order is preserved.
  let insertAt = waypoints.value.length
  for (let i = 0; i < waypointGeomIndices.length - 1; i++) {
    if (geomIdx >= waypointGeomIndices[i] && geomIdx <= waypointGeomIndices[i + 1]) {
      insertAt = i + 1
      break
    }
  }
  const next = waypoints.value.slice()
  next.splice(insertAt, 0, { lng: pt[0], lat: pt[1] })
  waypoints.value = next
  hideHoverMarker()
  refreshWaypointMarkers()
  recomputeRoute()
}

// ─── BRouter road snapping ───────────────────────────────────────────────────
// We use BRouter (https://brouter.de) rather than OSRM because OSRM's public
// cycling/foot profiles have lacunar coverage on dedicated cycling
// infrastructure (national bike routes, cycleways with bicycle=yes only).
// BRouter is purpose-built for cycling and honours OSM bicycle tags properly,
// including legal contresens cyclables and route=bicycle networks. Bonus:
// BRouter embeds DEM elevation in its coordinates so we don't need a separate
// Open-Meteo round-trip in the common case.
let recomputeToken = 0
async function recomputeRoute() {
  const token = ++recomputeToken
  // Any previous chart selection / zoom is anchored to the old km range.
  selectionRange.value = null
  zoomMin = null
  zoomMax = null
  isZoomed.value = false
  if (waypoints.value.length < 2) {
    geometry.value = []
    distanceM.value = 0
    elevGainM.value = 0
    elevLossM.value = 0
    divergentLegs.value = []
    cumDistKm = []
    updateRouteLayer()
    updateDivergentLayer()
    refreshDivergentMarkers()
    updateSelectionLayer()
    installClimbMarkers()
    destroyChart()
    return
  }
  isFetchingRoute.value = true
  error.value = null
  try {
    const lonlats = waypoints.value.map((w) => `${w.lng},${w.lat}`).join('|')
    const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=trekking&alternativeidx=0&format=geojson`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`)
    const data = await res.json()
    if (token !== recomputeToken) return
    const feature = data?.features?.[0]
    const coords = feature?.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) {
      throw new Error('Routing impossible (no route)')
    }
    const trackLen = parseFloat(feature.properties?.['track-length'] || '0')
    distanceM.value = Number.isFinite(trackLen) && trackLen > 0 ? trackLen : 0
    // BRouter coords are [lng, lat, ele] (ele is SRTM/DEM, integer meters)
    geometry.value = coords.map((c) => [c[0], c[1], c.length > 2 ? c[2] : null])
    // BRouter handles bicycle-specific rules natively, no divergent legs.
    divergentLegs.value = []

    updateRouteLayer()
    updateDivergentLayer()
    refreshDivergentMarkers()
    updateSelectionLayer()
    installClimbMarkers()
    recomputeWaypointGeomIndices()

    // Prefer the elevation that came inline with the route. If absent for
    // any reason (rare), fall back to Open-Meteo.
    const hasInlineElevation = geometry.value.some((c) => c[2] != null)
    if (hasInlineElevation) {
      recomputeGain()
      renderElevationChart()
    } else {
      fetchElevation(token)
    }
  } catch (e) {
    if (token === recomputeToken) error.value = `${t('routes.error_routing')}: ${e.message}`
  } finally {
    if (token === recomputeToken) isFetchingRoute.value = false
  }
}

// ─── Open-Meteo elevation ────────────────────────────────────────────────────
async function fetchElevation(token) {
  if (!geometry.value.length) return
  isFetchingElevation.value = true
  try {
    const coords = geometry.value
    const sampled = downsample(coords, 100)
    const lats = sampled.map((c) => c[1].toFixed(5)).join(',')
    const lngs = sampled.map((c) => c[0].toFixed(5)).join(',')
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (token !== recomputeToken) return
    const elev = Array.isArray(data.elevation) ? data.elevation : []
    if (elev.length !== sampled.length) throw new Error('elevation size mismatch')
    // Interpolate elevation back onto full coords
    interpolateElevation(coords, sampled, elev)
    recomputeGain()
    renderElevationChart()
  } catch (e) {
    if (token === recomputeToken) error.value = `${t('routes.error_elevation')}: ${e.message}`
  } finally {
    if (token === recomputeToken) isFetchingElevation.value = false
  }
}

function interpolateElevation(fullCoords, sampled, sampledEle) {
  // Map each fullCoords[i] to its position between sampled indices.
  const total = fullCoords.length
  const step = total / sampled.length
  for (let i = 0; i < total; i++) {
    const s = i / step
    const lo = Math.floor(s)
    const hi = Math.min(lo + 1, sampled.length - 1)
    const f = s - lo
    const eLo = sampledEle[lo]
    const eHi = sampledEle[hi]
    if (eLo == null || eHi == null) {
      fullCoords[i][2] = eLo ?? eHi ?? null
    } else {
      fullCoords[i][2] = eLo + (eHi - eLo) * f
    }
  }
  // Reassign to trigger reactivity
  geometry.value = fullCoords.slice()
}

function computeGainLoss(coords) {
  return computeElevGain(coords.map((c) => c[2]))
}

function recomputeGain() {
  const { gain, loss } = computeGainLoss(geometry.value)
  elevGainM.value = gain
  elevLossM.value = loss
}

// ─── Elevation chart ─────────────────────────────────────────────────────────
// Per-segment bucket color + per-segment grade (parallel to geometry segments).
// Same GRADE_BUCKETS palette as the map line — read by gradeFillPlugin (fill),
// the dataset's segment.borderColor (line stroke), and the tooltip callback.
let segmentColors = []
let segmentGrades = []

function colorForGrade(g) {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return GRADE_BUCKETS[i].color
  }
  return GRADE_BUCKETS[GRADE_BUCKETS.length - 1].color
}

function recomputeSegmentColors() {
  const g = geometry.value
  const cols = []
  const grades = []
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1]
    const b = g[i]
    const ea = a[2]
    const eb = b[2]
    if (ea == null || eb == null) { cols.push('#9ca3af'); grades.push(null); continue }
    const d = haversine(a, b)
    const grade = d > 0 ? ((eb - ea) / d) * 100 : 0
    grades.push(grade)
    cols.push(colorForGrade(grade))
  }
  segmentColors = cols
  segmentGrades = grades
}

// Bucket ranges → { color, label } for the chart legend below the canvas.
// Lower bound is the previous bucket's `max` (the bucket-as-half-open-interval
// model we use everywhere else); first/last edges become "< x%" / "> x%".
const gradeLegend = computed(() => {
  const out = []
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    const upper = GRADE_BUCKETS[i].max
    const lower = i === 0 ? -Infinity : GRADE_BUCKETS[i - 1].max
    let label
    if (!Number.isFinite(lower)) label = `< ${upper}%`
    else if (!Number.isFinite(upper)) label = `> ${lower}%`
    else label = `${lower} → ${upper}%`
    out.push({ color: GRADE_BUCKETS[i].color, label })
  }
  return out
})

// Paints a colored trapezoid below each line segment, bucketed by gradient.
// Runs before the dataset so the line itself sits on top of the fill.
const gradeFillPlugin = {
  id: 'routeGradeFill',
  beforeDatasetsDraw(chart) {
    if (!segmentColors.length) return
    const ds = chart.data.datasets[0]?.data
    if (!ds || ds.length < 2) return
    const { ctx, chartArea } = chart
    const xScale = chart.scales.x
    const yScale = chart.scales.y
    const baseY = chartArea.bottom
    ctx.save()
    ctx.beginPath()
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
    ctx.clip()
    for (let i = 1; i < ds.length; i++) {
      const c = segmentColors[i - 1]
      if (!c) continue
      const x0 = xScale.getPixelForValue(ds[i - 1].x)
      const x1 = xScale.getPixelForValue(ds[i].x)
      // Skip segments fully outside the visible x range (zoomed-in case).
      if (x1 < chartArea.left || x0 > chartArea.right) continue
      const y0 = yScale.getPixelForValue(ds[i - 1].y)
      const y1 = yScale.getPixelForValue(ds[i].y)
      ctx.fillStyle = c + '66' // ~40% alpha — readable but lets grid show through
      ctx.beginPath()
      ctx.moveTo(x0, baseY)
      ctx.lineTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.lineTo(x1, baseY)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  },
}

async function renderElevationChart() {
  if (!hasGeometry.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)
  // The canvas lives in the v-else branch of the chart card body. On the
  // very first recompute after arriving with a pending route (e.g.
  // ?fromGpx=1 from RoutesList / ActivityDetail), Vue hasn't flushed the
  // hasGeometry: false→true DOM update yet, so chartEl is still null.
  // Waiting one tick lets the canvas mount before we bind to it.
  if (!chartEl.value) await nextTick()
  if (!chartEl.value) return
  destroyChart()
  recomputeSegmentColors()
  let cumDist = 0
  const points = [{ x: 0, y: geometry.value[0][2] ?? 0 }]
  cumDistKm = [0]
  for (let i = 1; i < geometry.value.length; i++) {
    cumDist += haversine(geometry.value[i - 1], geometry.value[i])
    const km = cumDist / 1000
    cumDistKm.push(km)
    points.push({ x: km, y: geometry.value[i][2] ?? points[points.length - 1].y })
  }
  chartInstance = new Chart(chartEl.value.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        label: t('routes.altitude'),
        data: points,
        // Per-segment color via Chart.js's segment scriptable — bucketed by
        // gradient so the line itself matches the colored fill beneath it.
        // The dataset-level borderColor is just a fallback before segment
        // fires (and for the legend swatch, which we hide).
        borderColor: '#198754',
        segment: {
          borderColor: (ctx) => segmentColors[ctx.p0DataIndex] || '#198754',
        },
        fill: false,
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 1.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { intersect: false, mode: 'index', axis: 'x' },
      scales: {
        x: { type: 'linear', min: 0, max: cumDistKm[cumDistKm.length - 1], title: { display: true, text: t('routes.x_km') }, ticks: { maxTicksLimit: 8 } },
        y: { title: { display: true, text: t('routes.y_m') }, ticks: { maxTicksLimit: 6 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items.length) return ''
              return `${items[0].parsed.x.toFixed(2)} km`
            },
            label: (item) => {
              const alt = Math.round(item.parsed.y)
              // Prefer the segment starting at this index (looking forward);
              // fall back to the segment ending here for the last point.
              const i = item.dataIndex
              const grade = segmentGrades[i] != null
                ? segmentGrades[i]
                : segmentGrades[Math.max(0, i - 1)]
              const out = [`${t('routes.altitude')}: ${alt} m`]
              if (grade != null) {
                const sign = grade > 0 ? '+' : ''
                out.push(`${t('routes.grade')}: ${sign}${grade.toFixed(1)}%`)
              }
              return out
            },
          },
        },
      },
    },
    // gradeFillPlugin must come before selectionRectPlugin so the selection
    // rectangle (also drawn in beforeDatasetsDraw) sits on top of the colored
    // fill.
    plugins: [gradeFillPlugin, selectionRectPlugin, waypointDotsPlugin, hoverSyncPlugin],
  })
  attachChartSelectionOnce(chartEl.value)
}

// Numbered dots on the elevation profile matching the route waypoints.
// X = cumulative distance at the waypoint, Y = elevation at the waypoint.
const waypointDotsPlugin = {
  id: 'routeWaypointDots',
  afterDatasetsDraw(chart) {
    const wps = waypointGeomIndices
    if (!state.showWaypoints || !wps.length || !cumDistKm.length || !geometry.value.length) return
    const { ctx, chartArea } = chart
    const xScale = chart.scales.x
    const yScale = chart.scales.y
    ctx.save()
    for (let i = 0; i < wps.length; i++) {
      const gi = wps[i]
      if (gi == null || gi < 0 || gi >= cumDistKm.length) continue
      const km = cumDistKm[gi]
      const pt = geometry.value[gi]
      const ele = pt?.[2]
      if (ele == null) continue
      const px = xScale.getPixelForValue(km)
      const py = yScale.getPixelForValue(ele)
      if (px < chartArea.left - 2 || px > chartArea.right + 2) continue
      ctx.beginPath()
      ctx.arc(px, py, 9, 0, Math.PI * 2)
      ctx.fillStyle = '#fc4c02'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#fff'
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 11px system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), px, py + 0.5)
    }
    ctx.restore()
  },
}

// Draws a crosshair on the elevation chart synced to the map hover position.
const hoverSyncPlugin = {
  id: 'hoverSync',
  afterDatasetsDraw(chart) {
    const idx = hoverIdx.value
    if (idx == null || !cumDistKm.length || idx >= cumDistKm.length) return
    const ele = geometry.value[idx]?.[2]
    if (ele == null) return
    const km = cumDistKm[idx]
    const { ctx, chartArea } = chart
    const xScale = chart.scales.x
    const yScale = chart.scales.y
    const px = xScale.getPixelForValue(km)
    const py = yScale.getPixelForValue(ele)
    if (px < chartArea.left || px > chartArea.right) return
    ctx.save()
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(252, 76, 2, 0.65)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.moveTo(px, chartArea.top)
    ctx.lineTo(px, chartArea.bottom)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(px, py, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#fc4c02'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.restore()
  },
}

// Paints a vertical pole with either a green flag (start) or a red/white
// checkered flag (end) at the top. Lifted from ActivityDetail.vue.
function drawChartFlag(ctx, area, x, kind) {
  const fw = 12
  const fh = 9
  const headTop = Math.max(0, area.top - fh)
  ctx.save()
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x, area.top)
  ctx.lineTo(x, area.bottom)
  ctx.stroke()
  if (kind === 'start') {
    ctx.fillStyle = '#22c55e'
    ctx.fillRect(x, headTop, fw, fh)
    ctx.strokeStyle = '#15803d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  } else {
    const cell = 3
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ef4444' : '#ffffff'
        ctx.fillRect(x + c * cell, headTop + r * cell, cell, cell)
      }
    }
    ctx.strokeStyle = '#7f1d1d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  }
  ctx.fillStyle = '#1f2937'
  ctx.beginPath()
  ctx.arc(x, area.top, 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// Returns 'start' | 'end' | null depending on which flag pole the pixel x is
// closest to (within HANDLE_TOL_PX). Used by both mousedown (grab) and
// mousemove (cursor feedback) handlers.
function detectChartHandle(px) {
  if (!chartInstance || !selectionRange.value) return null
  const area = chartInstance.chartArea
  const xScale = chartInstance.scales.x
  const lo = Math.min(selectionRange.value.startKm, selectionRange.value.endKm)
  const hi = Math.max(selectionRange.value.startKm, selectionRange.value.endKm)
  const pxStart = Math.max(area.left, Math.min(area.right, xScale.getPixelForValue(lo)))
  const pxEnd = Math.max(area.left, Math.min(area.right, xScale.getPixelForValue(hi)))
  const dStart = Math.abs(px - pxStart)
  const dEnd = Math.abs(px - pxEnd)
  if (dStart <= HANDLE_TOL_PX && dStart <= dEnd) return 'start'
  if (dEnd <= HANDLE_TOL_PX) return 'end'
  return null
}

// Chart.js plugin that paints a translucent rectangle under the line for
// either the in-progress drag (chartDrag) or the committed selectionRange,
// and overlays the start/end flag handles on top of the line.
const selectionRectPlugin = {
  id: 'routeSelectionRect',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea } = chart
    let x1, x2
    if (chartDrag) {
      x1 = chartDrag.startPx
      x2 = chartDrag.currentPx
    } else if (selectionRange.value) {
      const xScale = chart.scales.x
      x1 = xScale.getPixelForValue(selectionRange.value.startKm)
      x2 = xScale.getPixelForValue(selectionRange.value.endKm)
    } else {
      return
    }
    const xMin = Math.max(chartArea.left, Math.min(x1, x2))
    const xMax = Math.min(chartArea.right, Math.max(x1, x2))
    if (xMax <= xMin) return
    ctx.save()
    ctx.fillStyle = 'rgba(0, 180, 216, 0.22)'
    ctx.fillRect(xMin, chartArea.top, xMax - xMin, chartArea.bottom - chartArea.top)
    ctx.strokeStyle = '#00b4d8'
    ctx.lineWidth = 1
    ctx.strokeRect(xMin + 0.5, chartArea.top + 0.5, xMax - xMin - 1, chartArea.bottom - chartArea.top - 1)
    ctx.restore()
  },
  afterDatasetsDraw(chart) {
    if (!selectionRange.value) return
    const { ctx, chartArea } = chart
    const xScale = chart.scales.x
    const lo = Math.min(selectionRange.value.startKm, selectionRange.value.endKm)
    const hi = Math.max(selectionRange.value.startKm, selectionRange.value.endKm)
    const pxLo = Math.max(chartArea.left, Math.min(chartArea.right, xScale.getPixelForValue(lo)))
    const pxHi = Math.max(chartArea.left, Math.min(chartArea.right, xScale.getPixelForValue(hi)))
    drawChartFlag(ctx, chartArea, pxLo, 'start')
    drawChartFlag(ctx, chartArea, pxHi, 'end')
  },
}

function applyZoom() {
  if (!chartInstance) return
  const naturalMax = cumDistKm.length ? cumDistKm[cumDistKm.length - 1] : null
  chartInstance.options.scales.x.min = zoomMin ?? 0
  chartInstance.options.scales.x.max = zoomMax ?? naturalMax
  chartInstance.update('none')
  isZoomed.value = zoomMin != null || zoomMax != null
}

function resetZoom() {
  zoomMin = null
  zoomMax = null
  applyZoom()
}

function zoomToSelection() {
  if (!selectionRange.value) return
  const { startKm, endKm } = selectionRange.value
  zoomMin = Math.min(startKm, endKm)
  zoomMax = Math.max(startKm, endKm)
  applyZoom()
}

let wheelRafPending = false
let pendingWheel = null
function onChartWheel(e) {
  if (!chartInstance || !cumDistKm.length) return
  e.preventDefault()
  const rect = chartEl.value.getBoundingClientRect()
  pendingWheel = { px: e.clientX - rect.left, deltaY: e.deltaY }
  if (wheelRafPending) return
  wheelRafPending = true
  requestAnimationFrame(() => {
    wheelRafPending = false
    if (!pendingWheel || !chartInstance) return
    const { px, deltaY } = pendingWheel
    pendingWheel = null
    applyZoomStep(px, deltaY)
  })
}

function applyZoomStep(px, deltaY) {
  const chart = chartInstance
  if (!chart) return
  const xScale = chart.scales.x
  const cursorVal = xScale.getValueForPixel(px)
  const naturalMin = cumDistKm[0]
  const naturalMax = cumDistKm[cumDistKm.length - 1]
  if (cursorVal == null || Number.isNaN(cursorVal)) return
  const curMin = zoomMin ?? naturalMin
  const curMax = zoomMax ?? naturalMax
  const range = curMax - curMin
  if (range <= 0) return
  const naturalRange = naturalMax - naturalMin
  const factor = deltaY > 0 ? 1.25 : 0.8
  const newRange = range * factor
  if (newRange >= naturalRange) { resetZoom(); return }
  const leftFrac = (cursorVal - curMin) / range
  let newMin = cursorVal - leftFrac * newRange
  let newMax = newMin + newRange
  if (newMin < naturalMin) { newMax += naturalMin - newMin; newMin = naturalMin }
  if (newMax > naturalMax) { newMin -= newMax - naturalMax; newMax = naturalMax }
  zoomMin = newMin
  zoomMax = newMax
  applyZoom()
}

// Attached once on the canvas DOM element; each handler reads chartInstance
// at event time so it works across re-renders of the chart.
let chartSelectionWired = false
function attachChartSelectionOnce(canvas) {
  if (chartSelectionWired || !canvas) return
  chartSelectionWired = true
  canvas.addEventListener('wheel', onChartWheel, { passive: false })

  // Hover cursor feedback — `ew-resize` over a flag pole, `crosshair` over
  // the plotting area. Also syncs a marker on the map to the hovered position.
  canvas.addEventListener('mousemove', (ev) => {
    if (chartHandleDrag || chartDrag) return
    if (!chartInstance) return
    const r = canvas.getBoundingClientRect()
    const x = ev.clientX - r.left
    const area = chartInstance.chartArea
    if (x < area.left - HANDLE_TOL_PX || x > area.right + HANDLE_TOL_PX) {
      canvas.style.cursor = ''
      hideChartCrossMarker()
      return
    }
    canvas.style.cursor = detectChartHandle(x) ? 'ew-resize' : 'crosshair'
    if (x >= area.left && x <= area.right && cumDistKm.length) {
      const km = chartInstance.scales.x.getValueForPixel(x)
      if (km != null && !Number.isNaN(km)) {
        const pt = geometry.value[geomIdxForKm(km)]
        if (pt) showChartCrossMarker(pt[0], pt[1])
      }
    }
  })
  canvas.addEventListener('mouseleave', () => { hideChartCrossMarker() })

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    const chart = chartInstance
    if (!chart) return
    const rect = canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const area = chart.chartArea
    if (x < area.left - HANDLE_TOL_PX || x > area.right + HANDLE_TOL_PX) return
    ev.preventDefault()

    // Priority 1: did the user grab a flag pole? Resize the existing selection
    // by keeping the other handle fixed.
    const handle = detectChartHandle(x)
    if (handle) {
      const fixedKm = handle === 'start' ? selectionRange.value.endKm : selectionRange.value.startKm
      chartHandleDrag = { fixedKm }
      canvas.style.cursor = 'ew-resize'

      const onMove = (e) => {
        const c = chartInstance
        if (!c || !chartHandleDrag) return
        const r2 = canvas.getBoundingClientRect()
        const xx = Math.max(c.chartArea.left, Math.min(c.chartArea.right, e.clientX - r2.left))
        const km = c.scales.x.getValueForPixel(xx)
        if (km == null || Number.isNaN(km)) return
        // Auto-normalize via min/max so dragging past the fixed handle simply
        // swaps which end is start/end — no flip glitch.
        const lo = Math.min(chartHandleDrag.fixedKm, km)
        const hi = Math.max(chartHandleDrag.fixedKm, km)
        selectionRange.value = { startKm: lo, endKm: hi }
        updateSelectionLayer()
        c.update('none')
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        chartHandleDrag = null
        canvas.style.cursor = ''
        fitMapToSelection()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }

    // Priority 2: regular drag-to-select on the plot area.
    if (x < area.left || x > area.right) return
    const startPx = x
    chartDrag = { startPx, currentPx: x }
    chart.update('none')

    const onMove = (e) => {
      const c = chartInstance
      if (!c) return
      const r = canvas.getBoundingClientRect()
      const xx = Math.max(c.chartArea.left, Math.min(c.chartArea.right, e.clientX - r.left))
      chartDrag.currentPx = xx
      c.update('none')
    }
    const onUp = (e) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const c = chartInstance
      if (!chartDrag || !c) { chartDrag = null; return }
      const r = canvas.getBoundingClientRect()
      const finalX = Math.max(c.chartArea.left, Math.min(c.chartArea.right, e.clientX - r.left))
      const dragged = Math.abs(finalX - startPx) > 4
      const xScale = c.scales.x
      const km1 = xScale.getValueForPixel(Math.min(startPx, finalX))
      const km2 = xScale.getValueForPixel(Math.max(startPx, finalX))
      chartDrag = null
      selectionRange.value = dragged ? { startKm: km1, endKm: km2 } : null
      updateSelectionLayer()
      c.update('none')
      if (dragged) fitMapToSelection()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

function destroyChart() {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null }
}

// ─── Persistence ─────────────────────────────────────────────────────────────
async function fetchRoute(id) {
  try {
    const res = await fetch(`/api/routes/${id}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const r = payload.route
    name.value = r.name || ''
    waypoints.value = Array.isArray(r.waypoints) ? r.waypoints : []
    geometry.value = Array.isArray(r.geometry) ? r.geometry : []
    distanceM.value = r.distance_m || 0
    elevGainM.value = r.elevation_gain_m || 0
    elevLossM.value = r.elevation_loss_m || 0
    // Fit map to route bounds
    if (mapInstance && geometry.value.length >= 2) {
      const lngs = geometry.value.map((c) => c[0])
      const lats = geometry.value.map((c) => c[1])
      mapInstance.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 40, duration: 0 },
      )
    }
    refreshWaypointMarkers()
    updateRouteLayer()
    recomputeWaypointGeomIndices()
    renderElevationChart()
    // Re-snap the saved waypoints with the current routing profile (foot +
    // cycling-divergence detection). The stored geometry may have been
    // produced by an older profile and not actually pass through some
    // waypoints — recomputing realigns it and shows divergent-leg warnings.
    // DB stays unchanged until the user clicks Save.
    if (waypoints.value.length >= 2) recomputeRoute()
  } catch (e) {
    error.value = e.message
  }
}

async function save() {
  if (!name.value.trim()) {
    error.value = t('routes.error_name_required')
    return
  }
  if (waypoints.value.length < 2) {
    error.value = t('routes.error_min_points')
    return
  }
  saving.value = true
  error.value = null
  try {
    const body = JSON.stringify({
      name: name.value.trim(),
      waypoints: waypoints.value,
      geometry: geometry.value,
      distance_m: distanceM.value,
      elevation_gain_m: elevGainM.value,
      elevation_loss_m: elevLossM.value,
      profile: 'cycling',
    })
    const url = isEditMode.value ? `/api/routes/${currentId.value}` : '/api/routes'
    const method = isEditMode.value ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const r = payload.route
    if (!isEditMode.value && r?.id) {
      currentId.value = r.id
      // Replace URL so reload edits this route
      window.history.replaceState({}, '', `${localePrefix}/routes/${r.id}/edit`)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

function exportGpx() {
  if (!isEditMode.value) return
  window.location.href = `/api/routes/${currentId.value}/gpx`
}

function openInKomoot() {
  const wps = waypoints.value
  if (wps.length < 2) return
  // Komoot accepts at most 20 waypoints via URL params — downsample while
  // always keeping first and last.
  const MAX = 20
  let pts = wps
  if (pts.length > MAX) {
    if (!window.confirm(t('routes.komoot_waypoint_limit', { count: pts.length }))) return
    const middle = pts.slice(1, -1)
    const step = middle.length / (MAX - 2)
    const sampled = Array.from({ length: MAX - 2 }, (_, i) => middle[Math.floor(i * step)])
    pts = [pts[0], ...sampled, pts[pts.length - 1]]
  }
  const lats = pts.map((w) => w.lat)
  const lngs = pts.map((w) => w.lng)
  const centerLat = ((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5)
  const centerLng = ((Math.min(...lngs) + Math.max(...lngs)) / 2).toFixed(5)
  const points = pts.map((w, i) => `p[${i}][loc]=${w.lat},${w.lng}`).join('&')
  window.open(
    `https://www.komoot.com/plan/@${centerLat},${centerLng},12z?sport=touringbicycle&${points}`,
    '_blank',
    'noopener,noreferrer',
  )
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
watch(state, () => state.save(), { deep: true })
watch(hoverIdx, () => { if (chartInstance) chartInstance.update('none') })
watch(selectionRange, () => { updateSelectionMarkers() })

onMounted(async () => {
  state.load()
  // When coming from the "Nouvel itinéraire" prompt, the URL carries
  // ?name=… — pre-fill the name input and scrub the param so a reload
  // doesn't re-apply the prefill on top of what the user has typed since.
  if (!currentId.value) {
    try {
      const u = new URL(window.location.href)
      const presetName = u.searchParams.get('name')
      if (presetName) {
        name.value = presetName.slice(0, 80)
        u.searchParams.delete('name')
        window.history.replaceState({}, '', u.toString())
      }
    } catch { /* ignore malformed URL */ }
  }
  await renderMap()
  if (currentId.value) await fetchRoute(currentId.value)
  else applyPendingGpxImport()
})

// Handover from the routes list page: the user picked a .gpx there, we
// downsampled the track into waypoints and stashed them in sessionStorage.
// Read them once on mount of the empty builder and feed them through the
// normal recompute path so BRouter snaps + adds elevation.
function applyPendingGpxImport() {
  try {
    const u = new URL(window.location.href)
    if (u.searchParams.get('fromGpx') !== '1') return
    u.searchParams.delete('fromGpx')
    window.history.replaceState({}, '', u.toString())
    const raw = sessionStorage.getItem('sportsScope.gpxImport')
    sessionStorage.removeItem('sportsScope.gpxImport')
    if (!raw) return
    const payload = JSON.parse(raw)
    const wps = Array.isArray(payload?.waypoints) ? payload.waypoints : []
    if (wps.length < 2) return
    if (payload.name && !name.value.trim()) name.value = String(payload.name).slice(0, 80)
    waypoints.value = wps
    refreshWaypointMarkers()
    if (mapInstance) {
      const lngs = wps.map((w) => w.lng)
      const lats = wps.map((w) => w.lat)
      mapInstance.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 60, duration: 600, maxZoom: 14 },
      )
    }
    recomputeRoute()
  } catch {
    // bad/stale payload — drop it silently and let the user start over
  }
}

onBeforeUnmount(() => {
  destroyChart()
  waypointMarkers.forEach((m) => m.remove())
  waypointMarkers.length = 0
  divergentMarkers.forEach((m) => m.remove())
  divergentMarkers.length = 0
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null }
  if (locationMarker) { locationMarker.remove(); locationMarker = null }
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <div>
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <a :href="`${localePrefix}/routes`" class="btn btn-sm btn-link p-0 me-2 d-inline-flex align-items-center gap-1">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
        <span>{{ t('routes.back') }}</span>
      </a>
      <input
        v-model="name"
        type="text"
        class="form-control form-control-lg route-name-input"
        :placeholder="t('routes.name_placeholder')"
        :maxlength="80"
      />
    </div>

    <div v-if="error" class="alert alert-warning d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="flex-grow-1">{{ error }}</span>
      <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
    </div>

    <!-- Map + Stats layout -->
    <div class="d-flex gap-3 mb-3 align-items-stretch">

    <!-- Stats sidebar -->
    <div class="card shadow-sm border-0 route-stats-sidebar">
      <div class="card-body d-flex flex-column gap-2 p-3">
        <span class="stat-pill stat-pill-distance">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
          <strong>{{ formatKm(distanceM) }}</strong>
        </span>
        <span class="stat-pill stat-pill-up">
          <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
          <strong>+{{ Math.round(elevGainM) }} m</strong>
        </span>
        <template v-if="detectedClimbs.length">
          <button
            v-for="(climb, idx) in detectedClimbs"
            :key="idx"
            type="button"
            class="climb-pill"
            @click="selectClimb(climb)"
            @mouseenter="updateClimbHoverLayer(climb)"
            @mouseleave="updateClimbHoverLayer(null)"
          >
            <span class="climb-pill-cat" :class="climb.category ? `climb-cat-${climb.category}` : 'climb-cat-uncat'">
              {{ climb.category || 'HC' }}
            </span>
            <span class="climb-pill-stats">
              <span>{{ climb.lengthM >= 1000 ? (climb.lengthM / 1000).toFixed(1) + ' km' : Math.round(climb.lengthM) + ' m' }} · +{{ Math.round(climb.gain) }} m</span>
              <span class="climb-pill-grade">{{ climb.avgGrade.toFixed(1) }}%</span>
            </span>
          </button>
        </template>
        <span class="stat-pill stat-pill-time" :title="t('routes.estimated_time_hint')">
          <span class="d-flex align-items-center gap-2">
            <i class="fa-solid fa-clock" aria-hidden="true"></i>
            <strong>{{ formatDuration(estimatedSeconds) }}</strong>
          </span>
          <span class="speed-input-wrap">
            <input
              v-model.number="avgSpeedKmh"
              type="number"
              min="3"
              max="80"
              step="1"
              class="speed-input"
              :title="t('routes.avg_speed_hint')"
              :aria-label="t('routes.avg_speed_hint')"
            />
            <small>km/h</small>
          </span>
        </span>
      </div>
    </div>

    <!-- Right column: map + elevation profile -->
    <div class="d-flex flex-column gap-3 flex-grow-1" style="min-width:0">

    <!-- Map card -->
    <div class="card shadow-sm border-0">
      <div class="card-body p-0">
        <div class="map-wrap" :class="{ expanded: state.mapExpanded }">
          <div ref="mapEl" class="route-builder-map"></div>
          <div class="map-controls">
            <!-- Fond de carte -->
            <MapStyleDropdown :model-value="state.mapStyleId" @update:model-value="setMapStyle" />
            <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn map-ctrl-btn"
                :class="state.showWaypoints ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleWaypoints"
                :title="state.showWaypoints ? t('routes.hide_waypoints') : t('routes.show_waypoints')"
                :aria-pressed="state.showWaypoints">
                <i class="fa-solid fa-map-pin" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="state.showClimbs ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleClimbs"
                :title="state.showClimbs ? t('strava.hide_climbs') : t('strava.show_climbs')"
                :aria-pressed="state.showClimbs">
                <i class="fa-solid fa-mountain" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="state.showGrade ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleGrade"
                :title="state.showGrade ? t('strava.hide_grade') : t('strava.show_grade')"
                :aria-pressed="state.showGrade">
                <i class="fa-solid fa-palette" aria-hidden="true"></i>
              </button>
            </div>
            <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn btn-light map-ctrl-btn"
                :disabled="!hasGeometry"
                @click="fitMapToRoute"
                title="Recentrer sur le trajet">
                <i class="fa-solid fa-crosshairs" aria-hidden="true"></i>
              </button>
            </div>
            <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn btn-light map-ctrl-btn"
                :disabled="waypoints.length === 0"
                @click="undoLast"
                :title="t('routes.undo')">
                <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn btn-light map-ctrl-btn"
                :disabled="waypoints.length === 0"
                @click="clearAll"
                :title="t('routes.clear')">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div class="map-controls-right">
            <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn map-ctrl-btn"
                :class="state.is3D ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleMap3D"
                :title="state.is3D ? t('strava.map_2d') : t('strava.map_3d')"
                :aria-pressed="state.is3D">
                <i class="fa-solid fa-cube" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="locationVisible ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleLocation"
                :disabled="locating"
                :title="locationVisible ? 'Masquer ma position' : 'Ma position'"
                :aria-pressed="locationVisible">
                <span v-if="locating" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                <i v-else class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="state.mapExpanded ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleMapSize"
                :title="state.mapExpanded ? t('strava.shrink_map') : t('strava.expand_map')"
                :aria-pressed="state.mapExpanded">
                <i :class="state.mapExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div class="map-search">
            <div class="input-group input-group-sm shadow-sm">
              <span class="input-group-text bg-white">
                <i v-if="searching" class="fa-solid fa-circle-notch fa-spin"></i>
                <i v-else class="fa-solid fa-magnifying-glass"></i>
              </span>
              <input
                v-model="searchQuery"
                type="search"
                class="form-control"
                :placeholder="t('routes.search_placeholder')"
                @focus="searchOpen = searchResults.length > 0"
                @keydown.escape="clearSearch"
                @keydown.enter.prevent="searchResults[0] && pickPlace(searchResults[0])"
              />
              <button v-if="searchQuery" type="button" class="btn btn-light" @click="clearSearch" :title="t('routes.clear')">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <ul v-if="searchOpen" class="map-search-results shadow">
              <li
                v-for="p in searchResults"
                :key="p.place_id"
                @click="pickPlace(p)"
                class="map-search-result"
              >
                <i class="fa-solid fa-location-dot text-muted me-2"></i>
                <span>{{ p.display_name }}</span>
              </li>
            </ul>
          </div>
          <div v-if="waypoints.length === 0" class="map-overlay-hint">
            <i class="fa-solid fa-hand-pointer" aria-hidden="true"></i>
            <span>{{ t('routes.click_hint') }}</span>
          </div>
          <div v-if="isFetchingRoute || isFetchingElevation" class="map-overlay-loading">
            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
            <span v-if="isFetchingRoute">{{ t('routes.computing_route') }}</span>
            <span v-else>{{ t('routes.computing_elevation') }}</span>
          </div>
        </div>
      </div>
      <!-- CyclOSM legend — shown only when the CyclOSM base map is active -->
      <div v-if="state.mapStyleId === 'cyclosm'" class="card-footer cyclosm-legend py-2 px-3" :aria-label="t('routes.cyclosm_legend')">
        <div class="cyclosm-legend-row">
          <span class="cyclosm-legend-group-label">{{ t('routes.cyclosm_paths') }}</span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-line-swatch" style="background:#0000CC"></span>
            {{ t('routes.cyclosm_cycleway') }}
          </span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-dashed-swatch" style="--dash-color:#6B96FF"></span>
            {{ t('routes.cyclosm_lane') }}
          </span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-line-swatch" style="background:#4B9B4B"></span>
            {{ t('routes.cyclosm_greenway') }}
          </span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-line-swatch" style="background:#C4A870"></span>
            {{ t('routes.cyclosm_unpaved') }}
          </span>
        </div>
        <div class="cyclosm-legend-row">
          <span class="cyclosm-legend-group-label">{{ t('routes.cyclosm_routes') }}</span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-route-dot" style="background:#F2D200"></span>
            {{ t('routes.cyclosm_lcn') }}
          </span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-route-dot" style="background:#F08000"></span>
            {{ t('routes.cyclosm_rcn') }}
          </span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-route-dot" style="background:#CC0000"></span>
            {{ t('routes.cyclosm_ncn') }}
          </span>
          <span class="cyclosm-legend-item">
            <span class="cyclosm-route-dot" style="background:#7B00B4"></span>
            {{ t('routes.cyclosm_icn') }}
          </span>
        </div>
      </div>
    </div>

    <!-- Elevation chart card -->
    <div class="card shadow-sm border-0">
      <div class="card-header activity-card-header d-flex align-items-center gap-2 flex-wrap">
        <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
        <h3 class="h6 mb-0">{{ t('routes.elevation_profile') }}</h3>
        <button
          v-if="selectionRange"
          type="button"
          class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
          :title="t('routes.zoom_to_selection')"
          @click="zoomToSelection"
        >
          <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
          <span class="d-none d-md-inline">{{ t('routes.zoom_to_selection') }}</span>
        </button>
        <button
          v-if="isZoomed"
          type="button"
          class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
          :title="t('routes.reset_zoom')"
          @click="resetZoom"
        >
          <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
          <span class="d-none d-md-inline">{{ t('routes.reset_zoom') }}</span>
        </button>
        <div v-if="hasGeometry" class="ms-auto d-flex flex-wrap gap-2">
          <span class="stat-pill stat-pill-distance">
            <i class="fa-solid fa-route me-1" aria-hidden="true"></i><strong>{{ formatKm(chartStats.distance) }}</strong>
          </span>
          <span class="stat-pill stat-pill-up">
            <i class="fa-solid fa-arrow-trend-up me-1" aria-hidden="true"></i><strong>+{{ Math.round(chartStats.gain) }} m</strong>
          </span>
          <span class="stat-pill stat-pill-down">
            <i class="fa-solid fa-arrow-trend-down me-1" aria-hidden="true"></i><strong>−{{ Math.round(chartStats.loss) }} m</strong>
          </span>
          <span class="stat-pill stat-pill-grade">
            <span class="grade-icon me-1" aria-hidden="true">\</span><strong>{{ chartStats.avgGrade.toFixed(1) }} %</strong>
          </span>
        </div>
      </div>
      <div class="card-body">
        <div v-if="!hasGeometry" class="text-muted small d-flex align-items-center gap-2">
          <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
          <span>{{ t('routes.no_elevation_yet') }}</span>
        </div>
        <template v-else>
          <div class="grade-legend mb-2" :aria-label="t('routes.grade_legend')">
            <span v-for="b in gradeLegend" :key="b.label" class="grade-legend-item">
              <span class="grade-legend-swatch" :style="{ backgroundColor: b.color }"></span>
              <span class="grade-legend-label">{{ b.label }}</span>
            </span>
          </div>
          <div class="elevation-canvas-wrap">
            <canvas ref="chartEl"></canvas>
          </div>
        </template>
      </div>
    </div>

    </div> <!-- end right column -->

    </div> <!-- end map + stats flex wrapper -->

    <!-- Actions bar -->
    <div class="card shadow-sm border-0 mb-3">
      <div class="card-body d-flex justify-content-end gap-2">
        <button v-if="isEditMode" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          @click="exportGpx" :title="t('routes.export_gpx')">
          <i class="fa-solid fa-download" aria-hidden="true"></i>
          <span class="d-none d-md-inline">GPX</span>
        </button>
        <button v-if="waypoints.length >= 2" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          @click="openInKomoot" :title="t('routes.open_in_komoot')">
          <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
          <span class="d-none d-md-inline">Komoot</span>
        </button>
        <button type="button" class="btn btn-warning d-flex align-items-center gap-1"
          @click="save" :disabled="saving || waypoints.length < 2 || !name.trim()">
          <span v-if="saving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
          <span>{{ t('routes.save') }}</span>
        </button>
      </div>
    </div>

  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
}
.map-wrap.expanded {
  position: fixed;
  top: 4rem;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1020;
  background: #fff;
  box-shadow: 0 -2px 20px rgba(0, 0, 0, 0.2);
}
.route-builder-map {
  height: 75vh;
  min-height: 560px;
  width: 100%;
}
.map-wrap.expanded .route-builder-map {
  height: 100%;
  min-height: 0;
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
.map-controls-right {
  position: absolute;
  top: 115px;
  right: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-end;
  pointer-events: none;
}
.map-controls-right > * { pointer-events: auto; }
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
.user-location-dot {
  width: 16px;
  height: 16px;
  background: #4285f4;
  border: 2.5px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(66, 133, 244, 0.35);
}
.map-search {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  width: min(420px, calc(100% - 220px));
  z-index: 5;
}
.map-search-results {
  list-style: none;
  margin: 6px 0 0;
  padding: 0.25rem 0;
  background: #fff;
  border-radius: 0.4rem;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.85rem;
}
.map-search-result {
  padding: 0.4rem 0.7rem;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 0.3rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
.map-search-result:last-child { border-bottom: 0; }
.map-search-result:hover {
  background: rgba(252, 76, 2, 0.08);
}
.map-overlay-hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(33, 37, 41, 0.88);
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  pointer-events: none;
  z-index: 4;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
.map-overlay-loading {
  position: absolute;
  top: 12px;
  right: 60px;
  background: rgba(255, 255, 255, 0.95);
  padding: 0.4rem 0.8rem;
  border-radius: 999px;
  font-size: 0.8rem;
  z-index: 5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
}

.route-name-input {
  max-width: 480px;
  font-weight: 600;
}

.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}
.stat-pill-distance { background: rgba(252, 76, 2, 0.12); color: #fc4c02; }
.stat-pill-up       { background: rgba(25, 135, 84, 0.12); color: #15803d; }
.stat-pill-down     { background: rgba(220, 53, 69, 0.12); color: #b02a37; }
.stat-pill-grade    { background: rgba(108, 117, 125, 0.12); color: #495057; }
.stat-pill-time     { background: rgba(13, 110, 253, 0.10); color: #0d6efd; }
.stat-pill-time .speed-input-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 0.15rem;
  margin-left: 0.4rem;
  padding-left: 0.45rem;
  border-left: 1px solid rgba(13, 110, 253, 0.25);
}
.stat-pill-time .speed-input-wrap small { font-size: 0.7rem; opacity: 0.75; }
.stat-pill-time .speed-input {
  width: 2.6rem;
  border: 1px solid rgba(13, 110, 253, 0.25);
  background: rgba(255, 255, 255, 0.6);
  color: inherit;
  border-radius: 4px;
  padding: 0 0.25rem;
  font-size: 0.78rem;
  font-weight: 600;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}
.stat-pill-time .speed-input::-webkit-outer-spin-button,
.stat-pill-time .speed-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.stat-pill-time .speed-input:focus {
  outline: none;
  border-color: #0d6efd;
}

.grade-icon {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700;
  font-size: 0.95em;
  line-height: 1;
  display: inline-block;
}

.elevation-canvas-wrap {
  position: relative;
  height: 220px;
  width: 100%;
}
.elevation-canvas-wrap canvas {
  cursor: crosshair;
}

.grade-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.75rem;
  font-size: 0.75rem;
  color: #4b5563;
}
.grade-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
}
.grade-legend-swatch {
  display: inline-block;
  width: 14px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.grade-legend-label {
  font-variant-numeric: tabular-nums;
}

.cyclosm-legend {
  background: #f8f9fa;
  font-size: 0.75rem;
  color: #4b5563;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.cyclosm-legend-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.7rem;
}
.cyclosm-legend-group-label {
  font-weight: 600;
  color: #1f2937;
  white-space: nowrap;
}
.cyclosm-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
}
.cyclosm-line-swatch {
  display: inline-block;
  width: 20px;
  height: 3px;
  border-radius: 2px;
  flex-shrink: 0;
}
.cyclosm-dashed-swatch {
  display: inline-block;
  width: 20px;
  height: 3px;
  border-radius: 2px;
  flex-shrink: 0;
  background: repeating-linear-gradient(
    90deg,
    var(--dash-color, #6B96FF) 0 5px,
    transparent 5px 9px
  );
}
.cyclosm-route-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.18);
  flex-shrink: 0;
}
</style>

<style>
/* Waypoint markers (created via document.createElement, so global) */
.wp-marker {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 36px;
  cursor: pointer;
}
.wp-marker-num {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fc4c02;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  transition: background 0.15s, box-shadow 0.15s;
}
.wp-marker--selected .wp-marker-num {
  background: #1d4ed8;
  box-shadow: 0 0 0 3px rgba(29, 78, 216, 0.32), 0 2px 6px rgba(0, 0, 0, 0.35);
}

/* Tooltip card — shown when the marker is selected */
.wp-tooltip {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.10);
  padding: 26px 4px 4px;
  display: none;
  flex-direction: column;
  gap: 2px;
  min-width: 190px;
  z-index: 20;
  white-space: nowrap;
  pointer-events: auto;
}
.wp-marker--selected .wp-tooltip {
  display: flex;
}
.wp-tooltip-close {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.07);
  color: #6b7280;
  font-size: 0.85rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s, color 0.1s;
}
.wp-tooltip-close:hover {
  background: rgba(0, 0, 0, 0.14);
  color: #111827;
}
.wp-tooltip-arrow {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-top: 7px solid #fff;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.10));
}
.wp-tooltip-action {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.65rem;
  border-radius: 7px;
  font-size: 0.8rem;
  font-weight: 500;
  text-decoration: none;
  color: #212529;
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  line-height: 1;
  transition: background 0.1s;
}
.wp-tooltip-action i {
  width: 14px;
  text-align: center;
  font-size: 0.78rem;
  flex-shrink: 0;
}
.wp-tooltip-action:hover {
  background: rgba(0, 0, 0, 0.06);
  color: #212529;
}
.wp-tooltip-action--komoot i { color: #6aaf23; }
.wp-tooltip-action--delete { color: #dc2626; }
.wp-tooltip-action--delete:hover {
  background: rgba(220, 38, 38, 0.08);
  color: #dc2626;
}
.wp-tooltip-action--disabled {
  opacity: 0.38;
  pointer-events: none;
  cursor: default;
}

/* Warning marker placed at the midpoint of a leg where cycling routing
   would take a long detour — i.e. one-way streets the cyclist can't enter.
   The red dashed line on the map covers the same leg. */
.divergent-warning-marker {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #d62828;
  color: #fff;
  border: 2px solid #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  font-size: 0.78rem;
  cursor: help;
}

/* Climb marker — small pill anchored at the foot of the climb with stats and
   optional category badge. Click sends a selection to the chart. */
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
.climb-marker:hover {
  transform: translateY(-6px) scale(1.06);
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.45);
}
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
.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }

.climb-pill {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 0.5rem;
  background: #f9fafb;
  cursor: pointer;
  text-align: left;
  font-size: 0.8rem;
  transition: background 0.1s, border-color 0.1s;
}
.climb-pill:hover {
  background: #f0fdf4;
  border-color: #16a34a;
}
.climb-pill-cat {
  font-weight: 700;
  font-size: 0.72rem;
  min-width: 1.5rem;
  text-align: center;
  flex-shrink: 0;
}
.climb-pill-stats {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  color: #374151;
}
.climb-pill-grade {
  color: #6b7280;
  font-size: 0.73rem;
}

.climb-hover-flag {
  font-size: 1.2rem;
  line-height: 1;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.35));
  pointer-events: none;
}
.climb-hover-flag--start { color: #16a34a; }
.climb-hover-flag--end   { color: #1f2937; }

/* Ghost marker shown when hovering the existing route line. Click on the
   line inserts a new waypoint at this position. Pointer-events: none so the
   click reaches the map's click handler (which reads hoverIdx). */
.route-insert-marker {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(252, 76, 2, 0.95);
  border: 2px solid #fff;
  color: #fff;
  font-size: 0.7rem;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  transform: translateY(-1px);
}

.chart-cross-marker {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fc4c02;
  border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.sel-flag-marker {
  font-size: 1.2rem;
  line-height: 1;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.35));
  cursor: grab;
}
.sel-flag-marker:active { cursor: grabbing; }
.sel-flag-marker--start { color: #16a34a; }
.sel-flag-marker--end   { color: #1f2937; }

.route-stats-sidebar {
  flex-shrink: 0;
  width: 175px;
}
.route-stats-sidebar .stat-pill {
  display: flex;
  width: 100%;
  border-radius: 0.6rem;
}
.route-stats-sidebar .stat-pill-time {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.3rem;
}
.route-stats-sidebar .stat-pill-time .speed-input-wrap {
  margin-left: 0;
  padding-left: 0;
  border-left: none;
}
</style>
