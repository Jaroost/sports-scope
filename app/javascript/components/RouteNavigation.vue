<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT, MAP_STYLES } from '../mapStyles'
import MapStyleDropdown from './MapStyleDropdown.vue'
import {
  buildDistancesM, detectClimbs, computeGainLoss, formatDistanceShort, haversine,
  generateCircle, bearingBetween, nearestGeomIndex, progressFor, activeClimb,
} from '../routeHelpers'
import type { Coord, Climb, LngLat } from '../routeHelpers'

const props = defineProps<{ routeId: string | number }>()

const STYLE_KEY = 'sportsScope.routeBuilderMapStyle'
const OFF_ROUTE_M = 50          // lateral distance beyond which we warn
const MIN_MOVE_M = 4            // movement needed to recompute a heading
const MIN_SPEED_MS = 0.8       // below this we keep the previous bearing

const mapEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const gpsError = ref<string | null>(null)
const hasFix = ref(false)
const following = ref(true)
const mapStyleId = ref(loadStyle())

// Live navigation state (reactive, drives the UI overlays)
const remainingM = ref(0)
const remainingGainM = ref(0)
const doneRatio = ref(0)
const offRoute = ref(false)
const climbInfo = ref<{ climb: Climb; ratio: number; remainingGainM: number } | null>(null)

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let wakeLock: any = null

// Route data (non-reactive: large arrays, only read inside callbacks)
let geometry: Coord[] = []
let cumDistM: number[] = []
let climbs: Climb[] = []
const routeName = ref('')

// Tracking helpers
let lastIdx = 0
let lastPos: LngLat | null = null
let currentBearing = 0

const donePercent = computed(() => Math.round(doneRatio.value * 100))

function loadStyle(): string {
  try {
    const raw = localStorage.getItem(STYLE_KEY)
    if (raw && MAP_STYLES.some((s) => s.id === raw)) return raw
  } catch { /* ignore */ }
  return 'cyclosm'
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await fetchRoute()
    await initMap()
    startTracking()
    requestWakeLock()
    document.addEventListener('visibilitychange', onVisibilityChange)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  releaseWakeLock()
  if (map) { map.remove(); map = null }
})

// ─── Data ───────────────────────────────────────────────────────────────────

async function fetchRoute() {
  const res = await fetch(`/api/routes/${props.routeId}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(t('routes.error_routing'))
  const data = await res.json()
  geometry = (data.geometry || []) as Coord[]
  if (geometry.length < 2) throw new Error(t('routes.error_min_points'))
  routeName.value = data.name || ''
  cumDistM = buildDistancesM(geometry)
  climbs = detectClimbs(geometry.map((c) => c[2]), cumDistM)
  remainingM.value = cumDistM[cumDistM.length - 1] || 0
  remainingGainM.value = computeGainLoss(geometry).gain
}

// ─── Map ──────────────────────────────────────────────────────────────────────

async function initMap() {
  maplibre = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  const coords = geometry.map(([lng, lat]) => [lng, lat] as LngLat)
  map = new maplibre.Map({
    container: mapEl.value,
    style: mapStyleFor(mapStyleId.value) as any,
    center: coords[0],
    zoom: 14,
    pitch: 55,
    attributionControl: false,
  })
  map.on('styleimagemissing', (e: any) => {
    map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  // The user took manual control of the map → stop auto-following.
  map.on('dragstart', () => { following.value = false })
  map.on('rotatestart', () => { following.value = false })

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      installRouteLayers()
      // Fit the whole route before the first GPS fix arrives.
      const b = new maplibre.LngLatBounds(coords[0], coords[0])
      coords.forEach((c) => b.extend(c))
      map.fitBounds(b, { padding: 60, duration: 0, pitch: 55 })
      resolve()
    })
  })
}

function installRouteLayers() {
  const line = geometry.map(([lng, lat]) => [lng, lat])
  map.addSource('nav-route', { type: 'geojson', data: lineFeature(line) })
  map.addSource('nav-remaining', { type: 'geojson', data: lineFeature(line) })
  map.addSource('nav-location', { type: 'geojson', data: emptyPolygon() })

  map.addLayer({ id: 'nav-route-border', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: ROUTE_BORDER_PAINT })
  map.addLayer({ id: 'nav-route-done', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#9ca3af', 'line-width': 5 } })
  map.addLayer({ id: 'nav-route-remaining', type: 'line', source: 'nav-remaining', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#7c3aed', 'line-width': 5 } })
  map.addLayer({ id: 'nav-location-fill', type: 'fill', source: 'nav-location', paint: { 'fill-color': '#4285f4', 'fill-opacity': 0.12 } })
  map.addLayer({ id: 'nav-location-stroke', type: 'line', source: 'nav-location', paint: { 'line-color': '#4285f4', 'line-width': 1.5, 'line-opacity': 0.5 } })
}

function lineFeature(coords: number[][]) {
  return { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} }
}

function emptyPolygon() {
  return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[]] }, properties: {} }
}

function setMapStyle(id: string) {
  if (!map || id === mapStyleId.value) return
  mapStyleId.value = id
  try { localStorage.setItem(STYLE_KEY, id) } catch { /* ignore */ }
  map.setStyle(mapStyleFor(id), { diff: false })
  map.once('style.load', () => {
    installRouteLayers()
    if (lastPos) updateLocationLayer(lastPos, lastAccuracy)
    refreshRemaining()
  })
}

// ─── GPS tracking ───────────────────────────────────────────────────────────

let lastAccuracy = 0

function startTracking() {
  if (!('geolocation' in navigator)) { gpsError.value = t('routes.gps_error'); return }
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    () => { gpsError.value = t('routes.gps_error') },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  )
}

function onPosition(pos: GeolocationPosition) {
  gpsError.value = null
  hasFix.value = true
  const here: LngLat = [pos.coords.longitude, pos.coords.latitude]
  lastAccuracy = pos.coords.accuracy || 0

  // Project onto the route (searching around the last known index for perf).
  const { idx, distM } = nearestGeomIndex(here, geometry, lastIdx)
  lastIdx = idx
  offRoute.value = distM > OFF_ROUTE_M
  updateProgress(idx)

  // Heading: trust the GPS heading when moving fast enough, otherwise derive it.
  updateBearing(pos, here)

  updateLocationLayer(here, lastAccuracy)
  if (locationMarker) locationMarker.setRotation(currentBearing)
  lastPos = here

  if (following.value) {
    map.easeTo({ center: here, bearing: currentBearing, pitch: 55, zoom: Math.max(map.getZoom(), 15), duration: 600 })
  }
}

function updateBearing(pos: GeolocationPosition, here: LngLat) {
  const speed = pos.coords.speed
  const heading = pos.coords.heading
  if (heading != null && !Number.isNaN(heading) && speed != null && speed > MIN_SPEED_MS) {
    currentBearing = heading
  } else if (lastPos) {
    if (haversine(lastPos, here) > MIN_MOVE_M) currentBearing = bearingBetween(lastPos, here)
  }
}

function updateProgress(idx: number) {
  const p = progressFor(idx, geometry, cumDistM)
  remainingM.value = p.remainingM
  remainingGainM.value = p.remainingGainM
  doneRatio.value = p.doneRatio
  const ac = activeClimb(idx, climbs)
  if (ac) {
    const rem = computeGainLoss(geometry.slice(idx, ac.climb.endIdx + 1)).gain
    climbInfo.value = { climb: ac.climb, ratio: ac.ratio, remainingGainM: rem }
  } else {
    climbInfo.value = null
  }
  refreshRemaining()
}

// Redraw the bright "remaining" portion of the route from the projected index.
function refreshRemaining() {
  const src = map?.getSource('nav-remaining')
  if (!src) return
  const rest = geometry.slice(lastIdx).map(([lng, lat]) => [lng, lat])
  src.setData(lineFeature(rest))
}

function updateLocationLayer(coords: LngLat, accuracy: number) {
  if (!map) return
  const src = map.getSource('nav-location')
  if (src) src.setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [generateCircle(coords, Math.max(accuracy, 8))] }, properties: {} })
  if (locationMarker) {
    locationMarker.setLngLat(coords)
  } else {
    const el = document.createElement('div')
    el.className = 'nav-position-arrow'
    el.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 2 L20 21 L12 16 L4 21 Z" fill="#4285f4" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    locationMarker = new maplibre.Marker({ element: el, rotationAlignment: 'map', anchor: 'center' }).setLngLat(coords).addTo(map)
    locationMarker.setRotation(currentBearing)
  }
}

function recenter() {
  following.value = true
  if (lastPos) map.easeTo({ center: lastPos, bearing: currentBearing, pitch: 55, zoom: 15, duration: 600 })
}

// ─── Wake lock ────────────────────────────────────────────────────────────────

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await (navigator as any).wakeLock.request('screen')
  } catch { /* unsupported or denied */ }
}

function releaseWakeLock() {
  try { wakeLock?.release() } catch { /* ignore */ }
  wakeLock = null
}

function onVisibilityChange() {
  // The screen wake lock is dropped when the page is hidden; re-acquire on return.
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock()
}
</script>

<template>
  <div class="nav-page">
    <div ref="mapEl" class="nav-map"></div>

    <div v-if="loading" class="nav-overlay-center text-muted">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.computing_route') }}
    </div>
    <div v-else-if="error" class="nav-overlay-center text-danger">
      <i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>{{ error }}
    </div>

    <!-- Top controls -->
    <div class="nav-top-left">
      <a :href="`/routes`" class="btn btn-sm btn-light shadow-sm" :title="t('routes.back')" :aria-label="t('routes.back')">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
      </a>
    </div>
    <div class="nav-top-right">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="setMapStyle" />
    </div>

    <!-- GPS / off-route banners -->
    <div v-if="gpsError" class="nav-banner nav-banner--warn">
      <i class="fa-solid fa-location-crosshairs me-2" aria-hidden="true"></i>{{ gpsError }}
    </div>
    <div v-else-if="!hasFix && !loading" class="nav-banner nav-banner--info">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.gps_waiting') }}
    </div>
    <div v-else-if="offRoute" class="nav-banner nav-banner--danger">
      <i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>{{ t('routes.off_route') }}
    </div>

    <!-- Recenter button -->
    <button
      v-if="!following && hasFix"
      type="button"
      class="btn btn-warning shadow nav-recenter"
      @click="recenter"
    >
      <i class="fa-solid fa-location-arrow me-1" aria-hidden="true"></i>{{ t('routes.recenter') }}
    </button>

    <!-- Climb card -->
    <div v-if="climbInfo" class="nav-climb shadow">
      <div class="d-flex align-items-center justify-content-between mb-1">
        <span class="fw-semibold">
          <i class="fa-solid fa-mountain text-warning me-1" aria-hidden="true"></i>{{ t('routes.climb_in_progress') }}
          <span v-if="climbInfo.climb.category" class="badge bg-dark ms-1">{{ climbInfo.climb.category }}</span>
        </span>
        <small class="text-muted">+{{ Math.round(climbInfo.remainingGainM) }} m</small>
      </div>
      <div class="progress nav-progress">
        <div class="progress-bar bg-warning" :style="{ width: `${Math.round(climbInfo.ratio * 100)}%` }"></div>
      </div>
    </div>

    <!-- Bottom stats -->
    <div class="nav-stats shadow">
      <div class="d-flex justify-content-around text-center mb-2">
        <div>
          <div class="nav-stat-value">{{ formatDistanceShort(remainingM) }}</div>
          <div class="nav-stat-label">{{ t('routes.remaining_distance') }}</div>
        </div>
        <div>
          <div class="nav-stat-value">+{{ Math.round(remainingGainM) }} m</div>
          <div class="nav-stat-label">{{ t('routes.remaining_elevation') }}</div>
        </div>
        <div>
          <div class="nav-stat-value">{{ donePercent }} %</div>
          <div class="nav-stat-label">{{ t('routes.progress') }}</div>
        </div>
      </div>
      <div class="progress nav-progress">
        <div class="progress-bar bg-primary" :style="{ width: `${donePercent}%` }"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nav-page {
  position: relative;
  width: 100%;
  height: calc(100vh - 4rem);
  height: calc(100dvh - 4rem);
  overflow: hidden;
}
.nav-map { position: absolute; inset: 0; }

.nav-overlay-center {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 5; font-weight: 500;
}

.nav-top-left { position: absolute; top: 0.75rem; left: 0.75rem; z-index: 4; }
.nav-top-right { position: absolute; top: 0.75rem; right: 0.75rem; z-index: 4; }

.nav-banner {
  position: absolute; top: 0.75rem; left: 50%; transform: translateX(-50%);
  z-index: 3; padding: 0.45rem 0.9rem; border-radius: 999px;
  font-weight: 600; font-size: 0.9rem; white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.nav-banner--danger { background: #dc3545; color: #fff; }
.nav-banner--warn { background: #fff3cd; color: #664d03; }
.nav-banner--info { background: #cfe2ff; color: #084298; }

.nav-recenter {
  position: absolute; bottom: 8.5rem; right: 0.75rem; z-index: 4;
  border-radius: 999px; font-weight: 600;
}

.nav-climb {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 6.25rem;
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.6rem 0.85rem;
}

.nav-stats {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.7rem 0.85rem;
}
.nav-stat-value { font-size: 1.25rem; font-weight: 700; line-height: 1.1; }
.nav-stat-label { font-size: 0.72rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.02em; }
.nav-progress { height: 0.5rem; border-radius: 999px; }
</style>

<style>
.nav-position-arrow {
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
  pointer-events: none;
}
</style>
