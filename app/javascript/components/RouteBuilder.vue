<script setup>
import { ref, onMounted, onBeforeUnmount, useTemplateRef, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'

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
const mapStyleId = ref('cyclosm')
const currentId = ref(props.routeId ? Number(props.routeId) : null)
const mapEl = useTemplateRef('mapEl')
const chartEl = useTemplateRef('chartEl')

let mapInstance = null
let chartInstance = null
let _maplibregl = null
const waypointMarkers = []
let hoverMarker = null
const hoverIdx = ref(null) // geometry index under cursor when over the route
let waypointGeomIndices = [] // for each waypoint, its index in geometry[]
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
// Wheel-zoom on the x axis of the elevation chart. zoomMin/zoomMax in km;
// null means "natural extent" (the whole route).
const isZoomed = ref(false)
let zoomMin = null
let zoomMax = null

// 3D terrain toggle + map expand + climbs visibility — patterns lifted from
// ActivityDetail.vue.
const is3D = ref(false)
const mapExpanded = ref(false)
const showClimbs = ref(true)
// One of 'grade' / 'surface' / 'none' — the colouring applied to the main
// route line. Both grade and surface use the same source/layer; toggling
// swaps which segmentation + paint expression is in effect.
const colorMode = ref('grade')
const showGrade = computed(() => colorMode.value === 'grade')
const showSurface = computed(() => colorMode.value === 'surface')
let routeMessages = [] // BRouter properties.messages data rows (header dropped)
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

// Surface buckets derived from OSM `surface=*` / `tracktype=*` / `highway=*`
// tags that BRouter ships in its `properties.messages` per segment.
const SURFACE_BUCKETS = [
  { color: '#22c55e' }, // 0 — asphalt / paved / concrete
  { color: '#f97316' }, // 1 — pavés / sett / cobblestone
  { color: '#eab308' }, // 2 — compacted / fine_gravel
  { color: '#a16207' }, // 3 — gravel / unpaved
  { color: '#7c2d12' }, // 4 — dirt / grass / sand
]

const hasGeometry = computed(() => geometry.value.length >= 2)

// Average gradient over the whole route: D+ / distance, expressed in %.
const avgGradePct = computed(() => {
  if (!distanceM.value) return '0.0'
  return ((elevGainM.value / distanceM.value) * 100).toFixed(1)
})

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
      let dist = 0; let up = 0; let down = 0
      for (let i = lo + 1; i <= hi; i++) {
        dist += haversine(geometry.value[i - 1], geometry.value[i])
        const a = geometry.value[i - 1][2]
        const b = geometry.value[i][2]
        if (a != null && b != null) {
          const d = b - a
          if (d > 0) up += d
          else down -= d
        }
      }
      return {
        distance: dist,
        gain: up,
        loss: down,
        avgGrade: dist > 0 ? (up / dist) * 100 : 0,
        isSelection: true,
      }
    }
  }
  const d = distanceM.value
  return {
    distance: d,
    gain: elevGainM.value,
    loss: elevLossM.value,
    avgGrade: d > 0 ? (elevGainM.value / d) * 100 : 0,
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

// ─── Map styles (duplicated from ActivityDetail.vue for MVP) ────────────────
const THUNDERFOREST_KEY = (
  document.querySelector('meta[name="thunderforest-api-key"]')?.getAttribute('content') || ''
).trim()

function mapStyleFor(id) {
  if (id === 'liberty') return 'https://tiles.openfreemap.org/styles/liberty'
  if (id === 'topo') return openTopoMapStyle()
  if (id === 'cycle' && THUNDERFOREST_KEY) return openCycleMapStyle(THUNDERFOREST_KEY)
  return cyclOsmStyle()
}

function cyclOsmStyle() {
  return {
    version: 8,
    sources: {
      'cyclosm-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution: '© <a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: 'cyclosm-base', type: 'raster', source: 'cyclosm-raster',
        paint: { 'raster-saturation': 0.1, 'raster-contrast': -0.1, 'raster-opacity': 0.85 },
      },
    ],
  }
}

function openTopoMapStyle() {
  return {
    version: 8,
    sources: {
      'topo-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256, maxzoom: 17,
        attribution: 'Map: © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM',
      },
    },
    layers: [{ id: 'topo-base', type: 'raster', source: 'topo-raster' }],
  }
}

function openCycleMapStyle(apiKey) {
  return {
    version: 8,
    sources: {
      'thunderforest-cycle': {
        type: 'raster',
        tiles: [
          `https://a.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
          `https://b.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
          `https://c.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
        ],
        tileSize: 256, maxzoom: 22,
        attribution: 'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [{ id: 'cycle-base', type: 'raster', source: 'thunderforest-cycle' }],
  }
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
    style: mapStyleFor(mapStyleId.value),
    center,
    zoom,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
  // "Locate me" button — explicit user action. Uses the same browser
  // geolocation API but at least the user knows they asked for it.
  mapInstance.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      trackUserLocation: false,
      showUserLocation: true,
      fitBoundsOptions: { maxZoom: 14 },
    }),
    'top-right',
  )

  // Block on the 'load' event so callers that await renderMap() are
  // guaranteed that the route source/layer exist before they try to write
  // to them (otherwise updateRouteLayer() would silently no-op).
  await new Promise((resolve) => {
    mapInstance.on('load', () => {
      installRouteLayer()
      mapInstance.on('click', (e) => {
        // A waypoint drag just released — swallow the synthesized click.
        if (suppressNextMapClick) { suppressNextMapClick = false; return }
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
      resolve()
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

function parseWayTags(s) {
  const out = {}
  if (!s) return out
  for (const pair of s.split('&')) {
    const i = pair.indexOf('=')
    if (i > 0) out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1))
  }
  return out
}

function bucketSurface(tags) {
  const surface = (tags.surface || tags['cycleway:surface'] || '').toLowerCase()
  const tracktype = (tags.tracktype || '').toLowerCase()
  const highway = (tags.highway || '').toLowerCase()
  if (['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'chipseal'].includes(surface)) return 0
  if (['paving_stones', 'cobblestone', 'cobblestone:flattened', 'sett', 'bricks', 'unhewn_cobblestone'].includes(surface)) return 1
  if (['compacted', 'fine_gravel'].includes(surface) || tracktype === 'grade1') return 2
  if (['gravel', 'pebblestone', 'unpaved', 'metal', 'wood'].includes(surface) || tracktype === 'grade2') return 3
  if (['ground', 'dirt', 'earth', 'mud', 'grass', 'sand', 'snow', 'ice', 'woodchips'].includes(surface)) return 4
  if (['grade3', 'grade4', 'grade5'].includes(tracktype)) return 4
  // Heuristic fallback by highway type when surface= is missing.
  if (highway === 'track') return 3
  if (highway === 'path' || highway === 'bridleway') return 4
  return 0 // most highways without an explicit surface tag are paved
}

function buildSurfaceSegments(coords, messageRows) {
  if (!coords || coords.length < 2) return []
  // BRouter's messages contain one row per routing segment between consecutive
  // coords. The `WayTags` column is at index 11 (current schema). We treat the
  // row for segment i as describing the edge ending at coords[i+1].
  const features = []
  const bucketAt = (i) => {
    const row = messageRows[Math.min(i, messageRows.length - 1)]
    const tagsStr = row && row[11] != null ? String(row[11]) : ''
    return bucketSurface(parseWayTags(tagsStr))
  }
  let current = [coords[0]]
  let curBucket = bucketAt(0)
  for (let i = 1; i < coords.length; i++) {
    const b = bucketAt(Math.min(i, coords.length - 2))
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
      id: 'builder-route-line',
      type: 'line',
      source: 'builder-route-graded',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': gradePaintExpression(),
        'line-width': 5,
      },
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
  if (!showClimbs.value || geometry.value.length < 2) return
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
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return el
}

function toggleClimbs() {
  showClimbs.value = !showClimbs.value
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

function surfacePaintExpression() {
  return [
    'match', ['get', 'bucket'],
    0, SURFACE_BUCKETS[0].color,
    1, SURFACE_BUCKETS[1].color,
    2, SURFACE_BUCKETS[2].color,
    3, SURFACE_BUCKETS[3].color,
    4, SURFACE_BUCKETS[4].color,
    '#fc4c02',
  ]
}

// Apply the current colorMode to the visible line: choose the right
// segmentation (grade / surface / single feature) and the right paint
// expression. Called from updateRouteLayer + from the toggles.
function applyColorMode() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-route-graded')
  if (!src) return
  const coords = geometry.value.map(([lng, lat]) => [lng, lat])
  let features = []
  let paint = '#fc4c02'
  if (colorMode.value === 'grade' && coords.length >= 2) {
    const altitudes = geometry.value.map((c) => c[2] ?? null)
    const distances = [0]
    let cum = 0
    for (let i = 1; i < geometry.value.length; i++) {
      cum += haversine(geometry.value[i - 1], geometry.value[i])
      distances.push(cum)
    }
    features = buildGradedSegments(coords, altitudes, distances)
    paint = gradePaintExpression()
  } else if (colorMode.value === 'surface' && coords.length >= 2) {
    features = buildSurfaceSegments(coords, routeMessages)
    paint = surfacePaintExpression()
    // No BRouter messages → fall back to a single segment so the line stays
    // visible (paint expression's default colour kicks in).
    if (features.length === 0) {
      features = [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { bucket: 0 } }]
    }
  } else if (coords.length >= 2) {
    features = [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
  }
  src.setData({ type: 'FeatureCollection', features })
  if (mapInstance.getLayer('builder-route-line')) {
    mapInstance.setPaintProperty('builder-route-line', 'line-color', paint)
  }
}

function setColorMode(mode) {
  // Click the active mode → off; click another → switch to it.
  colorMode.value = (colorMode.value === mode) ? 'none' : mode
  applyColorMode()
}

function toggleGrade() { setColorMode('grade') }
function toggleSurface() { setColorMode('surface') }

function toggleMap3D() {
  if (!mapInstance) return
  is3D.value = !is3D.value
  if (is3D.value) {
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
  mapExpanded.value = !mapExpanded.value
  // map-wrap toggles to position:fixed full-screen — give maplibre a chance to
  // re-measure after the layout change.
  await nextTick()
  if (mapInstance) mapInstance.resize()
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
  if (!mapInstance || id === mapStyleId.value) return
  mapStyleId.value = id
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  mapInstance.once('style.load', () => {
    installRouteLayer()
    updateRouteLayer()
    updateDivergentLayer()
    updateSelectionLayer()
    installClimbMarkers()
    // Re-apply 3D terrain (the style swap dropped both layers + terrain DEM).
    if (is3D.value) {
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

function refreshWaypointMarkers() {
  if (!_maplibregl || !mapInstance) return
  waypointMarkers.forEach((m) => m.remove())
  waypointMarkers.length = 0
  waypoints.value.forEach((w, idx) => {
    const el = document.createElement('div')
    el.className = 'wp-marker'
    el.innerHTML = `<span class="wp-marker-num">${idx + 1}</span><button type="button" class="wp-marker-del" aria-label="remove">×</button>`
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([w.lng, w.lat])
      .addTo(mapInstance)

    // Manual drag — replaces maplibre's built-in draggable: behaves unreliably
    // when nested inside our Vue island + Bootstrap layout (mousedown bubbling
    // ordering issue with the map canvas).
    attachWaypointDrag(el, marker, idx)

    // "×" delete button (visible on hover)
    el.querySelector('.wp-marker-del').addEventListener('click', (ev) => {
      ev.stopPropagation()
      ev.preventDefault()
      removeWaypoint(idx)
    })
    // Right-click on a marker also deletes it (no confirm — the user can
    // re-click the map to re-add a point).
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      removeWaypoint(idx)
    })
    el.addEventListener('click', (ev) => ev.stopPropagation())

    waypointMarkers.push(marker)
  })
}

function attachWaypointDrag(el, marker, idx) {
  el.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    if (ev.target.closest('.wp-marker-del')) return // delete button — let click fire
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
      // The click event that maplibre will synthesize from this mouseup
      // would otherwise hit the map handler and insert/add a spurious point.
      suppressNextMapClick = true
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
    routeMessages = []
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
    // `&messages=1` asks BRouter to embed per-segment OSM tag rows
    // (highway/surface/tracktype/…) into properties.messages — used by the
    // surface colour mode.
    const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=trekking&alternativeidx=0&format=geojson&messages=1`
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
    // Per-segment OSM tag rows for surface colour mode. The first row is a
    // header — skip it. Empty / missing → surface mode degrades to flat.
    const rawMsgs = feature.properties?.messages
    routeMessages = Array.isArray(rawMsgs) && rawMsgs.length > 1 ? rawMsgs.slice(1) : []
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

function recomputeGain() {
  let up = 0
  let down = 0
  for (let i = 1; i < geometry.value.length; i++) {
    const a = geometry.value[i - 1][2]
    const b = geometry.value[i][2]
    if (a == null || b == null) continue
    const d = b - a
    if (d > 0) up += d
    else down -= d
  }
  elevGainM.value = up
  elevLossM.value = down
}

// ─── Elevation chart ─────────────────────────────────────────────────────────
async function renderElevationChart() {
  if (!chartEl.value || !hasGeometry.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)
  destroyChart()
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
        borderColor: '#198754',
        backgroundColor: '#19875433',
        fill: true,
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
        x: { type: 'linear', title: { display: true, text: t('routes.x_km') }, ticks: { maxTicksLimit: 8 } },
        y: { title: { display: true, text: t('routes.y_m') }, ticks: { maxTicksLimit: 6 } },
      },
      plugins: { legend: { display: false } },
    },
    plugins: [selectionRectPlugin, waypointDotsPlugin],
  })
  attachChartSelectionOnce(chartEl.value)
}

// Numbered dots on the elevation profile matching the route waypoints.
// X = cumulative distance at the waypoint, Y = elevation at the waypoint.
const waypointDotsPlugin = {
  id: 'routeWaypointDots',
  afterDatasetsDraw(chart) {
    const wps = waypointGeomIndices
    if (!wps.length || !cumDistKm.length || !geometry.value.length) return
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

// Chart.js plugin that paints a translucent rectangle under the line for
// either the in-progress drag (chartDrag) or the committed selectionRange.
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
}

function applyZoom() {
  if (!chartInstance) return
  chartInstance.options.scales.x.min = zoomMin
  chartInstance.options.scales.x.max = zoomMax
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
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    const chart = chartInstance
    if (!chart) return
    const rect = canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const area = chart.chartArea
    if (x < area.left || x > area.right) return
    ev.preventDefault()
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

// ─── Lifecycle ───────────────────────────────────────────────────────────────
onMounted(async () => {
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
})

onBeforeUnmount(() => {
  destroyChart()
  waypointMarkers.forEach((m) => m.remove())
  waypointMarkers.length = 0
  divergentMarkers.forEach((m) => m.remove())
  divergentMarkers.length = 0
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null }
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

    <!-- Map card -->
    <div class="card shadow-sm border-0 mb-3">
      <div class="card-body p-0">
        <div class="map-wrap" :class="{ expanded: mapExpanded }">
          <div ref="mapEl" class="route-builder-map"></div>
          <div class="map-controls">
            <div class="btn-group btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn map-ctrl-btn"
                :class="mapStyleId === 'cyclosm' ? 'btn-warning text-dark active' : 'btn-light'"
                @click="setMapStyle('cyclosm')"
                :title="t('strava.map_style_cyclo')">
                <i class="fa-solid fa-bicycle" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_cyclo') }}</span>
              </button>
              <button v-if="THUNDERFOREST_KEY" type="button" class="btn map-ctrl-btn"
                :class="mapStyleId === 'cycle' ? 'btn-warning text-dark active' : 'btn-light'"
                @click="setMapStyle('cycle')"
                :title="t('strava.map_style_opencycle')">
                <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_opencycle') }}</span>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="mapStyleId === 'topo' ? 'btn-warning text-dark active' : 'btn-light'"
                @click="setMapStyle('topo')"
                :title="t('strava.map_style_topo')">
                <i class="fa-solid fa-mountain-sun" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_topo') }}</span>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="mapStyleId === 'liberty' ? 'btn-warning text-dark active' : 'btn-light'"
                @click="setMapStyle('liberty')"
                :title="t('strava.map_style_standard')">
                <i class="fa-solid fa-map" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_standard') }}</span>
              </button>
            </div>
            <div class="btn-group btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn map-ctrl-btn"
                :class="showClimbs ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleClimbs"
                :title="showClimbs ? t('strava.hide_climbs') : t('strava.show_climbs')"
                :aria-pressed="showClimbs">
                <i class="fa-solid fa-mountain" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.climbs_label') }}</span>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="showGrade ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleGrade"
                :title="showGrade ? t('strava.hide_grade') : t('strava.show_grade')"
                :aria-pressed="showGrade">
                <i class="fa-solid fa-palette" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.grade_label') }}</span>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="showSurface ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleSurface"
                :title="showSurface ? t('strava.hide_surface') : t('strava.show_surface')"
                :aria-pressed="showSurface">
                <i class="fa-solid fa-road" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('strava.surface_label') }}</span>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="is3D ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleMap3D"
                :title="is3D ? t('strava.map_2d') : t('strava.map_3d')"
                :aria-pressed="is3D">
                <i class="fa-solid fa-cube" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">3D</span>
              </button>
              <button type="button" class="btn map-ctrl-btn"
                :class="mapExpanded ? 'btn-warning text-dark active' : 'btn-light'"
                @click="toggleMapSize"
                :title="mapExpanded ? t('strava.shrink_map') : t('strava.expand_map')"
                :aria-pressed="mapExpanded">
                <i :class="mapExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ mapExpanded ? t('strava.shrink_map') : t('strava.expand_map') }}</span>
              </button>
            </div>
            <div class="btn-group btn-group-sm shadow-sm" role="group">
              <button type="button" class="btn btn-light"
                :disabled="waypoints.length === 0"
                @click="undoLast"
                :title="t('routes.undo')">
                <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('routes.undo') }}</span>
              </button>
              <button type="button" class="btn btn-light"
                :disabled="waypoints.length === 0"
                @click="clearAll"
                :title="t('routes.clear')">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                <span class="d-none d-md-inline ms-1">{{ t('routes.clear') }}</span>
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
    </div>

    <!-- Stats + actions bar -->
    <div class="card shadow-sm border-0 mb-3">
      <div class="card-body d-flex flex-wrap align-items-center gap-3">
        <div class="d-flex align-items-center gap-3 flex-grow-1 flex-wrap">
          <span class="stat-pill stat-pill-distance">
            <i class="fa-solid fa-route" aria-hidden="true"></i>
            <strong>{{ formatKm(distanceM) }}</strong>
          </span>
          <span class="stat-pill stat-pill-up">
            <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
            <strong>+{{ Math.round(elevGainM) }} m</strong>
          </span>
          <span class="stat-pill stat-pill-down">
            <i class="fa-solid fa-arrow-trend-down" aria-hidden="true"></i>
            <strong>-{{ Math.round(elevLossM) }} m</strong>
          </span>
          <span class="stat-pill stat-pill-grade">
            <span class="grade-icon" aria-hidden="true">\</span>
            <strong>{{ avgGradePct }} %</strong>
          </span>
        </div>
        <div class="d-flex gap-2">
          <button v-if="isEditMode" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            @click="exportGpx" :title="t('routes.export_gpx')">
            <i class="fa-solid fa-download" aria-hidden="true"></i>
            <span class="d-none d-md-inline">GPX</span>
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
        <div v-else class="elevation-canvas-wrap">
          <canvas ref="chartEl"></canvas>
        </div>
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
.map-ctrl-btn {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  font-weight: 500;
}
/* Active state — has to win over .map-ctrl-btn's white background. */
.map-ctrl-btn.active,
.map-ctrl-btn.active:hover,
.map-ctrl-btn.active:focus {
  background: #ffc107;
  color: #212529;
  border-color: rgba(252, 76, 2, 0.7);
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
  cursor: grab;
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
}
.wp-marker-del {
  position: absolute;
  top: -6px;
  right: -8px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #212529;
  color: #fff;
  border: 2px solid #fff;
  font-size: 0.7rem;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity 0.1s;
}
.wp-marker:hover .wp-marker-del {
  opacity: 1;
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
</style>
