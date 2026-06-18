<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import MapStyleDropdown from './MapStyleDropdown.vue'
import {
  buildDistancesM, detectClimbs, detectTurns, turnsFromVoiceHints, computeGainLoss,
  formatDistanceShort, haversine, bearingBetween, nearestGeomIndex, projectOnRoute,
  progressFor, activeClimb,
} from '../routeHelpers'
import type { Coord, Climb, LngLat, TurnPoint, VoiceHint, Maneuver } from '../routeHelpers'
import { unlockAudio, playManeuver, playOffRoute } from '../navAudio'
import { userPreferences } from '../userPreferences'

const props = defineProps<{ shareToken: string }>()

const SOUND_KEY = 'sportsScope.navSound'

// Réglages caméra issus du profil (section Navigation), indépendants du créateur.
const navPrefs = userPreferences().navigation
const OFF_ROUTE_M = 20          // lateral distance beyond which we warn
const OFF_ROUTE_ACCURACY_CAP = 35  // most we widen the threshold by for a fuzzy GPS fix
const MIN_MOVE_M = 4            // movement needed to recompute a heading
const MIN_SPEED_MS = 0.8       // below this we keep the previous bearing
const TURN_ALERT_M = 60        // start announcing a turn this far ahead
const TURN_HINT_M = 200        // show the turn indicator this far ahead
const OFF_ROUTE_REALERT_MS = 12000  // re-buzz this often while still off route

const mapEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const gpsError = ref<string | null>(null)
const hasFix = ref(false)
const following = ref(true)
const soundOn = ref(loadSound())
// Le fond de carte de navigation est gouverné par le profil (comme le créateur) :
// on part du réglage du compte ; le sélecteur ne sert qu'à le changer en séance.
const mapStyleId = ref(navPrefs.default_style as string)

// Live navigation state (reactive, drives the UI overlays)
const remainingM = ref(0)
const remainingGainM = ref(0)
const doneRatio = ref(0)
const speedKmh = ref(0)
const offRoute = ref(false)
const offRouteDistM = ref(0)        // distance to the nearest point on the route
const offRouteRelBearing = ref(0)   // on-screen angle of the "back to route" arrow
const climbInfo = ref<{ climb: Climb; ratio: number; remainingGainM: number } | null>(null)
const turnHint = ref<{ direction: 'left' | 'right'; distM: number; kind: Maneuver; angle: number } | null>(null)

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let wakeLock: any = null

// Route data (non-reactive: large arrays, only read inside callbacks)
let geometry: Coord[] = []
let cumDistM: number[] = []
let climbs: Climb[] = []
let turns: TurnPoint[] = []
const routeName = ref('')

// Tracking helpers
let lastIdx = 0
let snapPoint: LngLat | null = null   // rider position projected onto the route
let snapNextIdx = 0                   // first original vertex ahead of snapPoint
let snapDistAlongM = 0                // distance covered along the route at snapPoint
let located = false
let lastPos: LngLat | null = null
let currentBearing = 0
let lastFixTime = 0
let hasInitialZoom = false
let nextTurnPtr = 0          // index of the next unpassed turn in `turns`
let announcedTurn = -1       // index of the last turn we played a cue for
let lastOffRouteAlert = 0    // timestamp of the last off-route buzz

// ─── Position extrapolation (dead-reckoning between GPS fixes) ────────────────
// GPS fixes land ~once per second; rather than jumping the marker on each fix,
// we advance the displayed position forward from the last fix using the carried
// speed and heading, recaling on every new fix. This keeps the rider gliding.
let rafId: number | null = null
let anchorPos: LngLat | null = null   // last real GPS position
let anchorTime = 0                     // performance.now() of that fix
let extrapSpeedMs = 0                  // speed carried forward between fixes
let extrapBearing = 0                  // travel heading (target)
let displayBearing = 0                 // smoothed bearing actually rendered
const MAX_EXTRAP_S = 2.5               // stop predicting if fixes stop arriving
const BEARING_SMOOTH = 0.18            // per-frame easing toward the target bearing

const donePercent = computed(() => Math.round(doneRatio.value * 100))

function loadSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}

function toggleSound() {
  soundOn.value = !soundOn.value
  try { localStorage.setItem(SOUND_KEY, soundOn.value ? 'on' : 'off') } catch { /* ignore */ }
  if (soundOn.value) unlockAudio()
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await fetchRoute()
    await initMap()
    startTracking()
    requestWakeLock()
    // The screen wake lock and the audio context both need a user gesture to be
    // granted reliably; the page load itself doesn't count, so (re)arm them on the
    // first touch/click anywhere on the page.
    window.addEventListener('pointerdown', onFirstGesture)
    document.addEventListener('visibilitychange', onVisibilityChange)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId)
  stopAnimation()
  window.removeEventListener('pointerdown', onFirstGesture)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  releaseWakeLock()
  if (map) { map.remove(); map = null }
})

function onFirstGesture() {
  unlockAudio()
  if (!wakeLock) requestWakeLock()
}

// ─── Data ───────────────────────────────────────────────────────────────────

async function fetchRoute() {
  const res = await fetch(`/api/routes/shared/${props.shareToken}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(t('routes.error_routing'))
  const data = await res.json()
  const route = data.route || data
  geometry = (route.geometry || []) as Coord[]
  if (geometry.length < 2) throw new Error(t('routes.error_min_points'))
  routeName.value = route.name || ''
  cumDistM = buildDistancesM(geometry)
  climbs = detectClimbs(geometry.map((c) => c[2]), cumDistM)
  // Prefer BRouter's turn-by-turn voicehints; fall back to geometric detection
  // for routes saved before voicehints were captured.
  const hints = (route.voice_hints || []) as VoiceHint[]
  turns = hints.length
    ? turnsFromVoiceHints(hints, geometry, cumDistM)
    : detectTurns(geometry, cumDistM)
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
    pitch: navPrefs.pitch,
    attributionControl: false,
  })
  map.on('styleimagemissing', (e: any) => {
    map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  // The user took manual control of the map → stop auto-following. Guard on
  // `originalEvent`: our own follow animations change the bearing and fire
  // `rotatestart` programmatically (no originalEvent), and must NOT disable it —
  // that bug forced the rider to keep tapping "recenter".
  map.on('dragstart', (e: any) => { if (e.originalEvent) following.value = false })
  map.on('rotatestart', (e: any) => { if (e.originalEvent) following.value = false })

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      installRouteLayers()
      // Fit the whole route before the first GPS fix arrives.
      const b = new maplibre.LngLatBounds(coords[0], coords[0])
      coords.forEach((c) => b.extend(c))
      map.fitBounds(b, { padding: 60, duration: 0, pitch: navPrefs.pitch })
      resolve()
    })
  })
}

function installRouteLayers() {
  const line = geometry.map(([lng, lat]) => [lng, lat])
  map.addSource('nav-route', { type: 'geojson', data: lineFeature(line) })
  map.addSource('nav-remaining', { type: 'geojson', data: lineFeature(line) })

  map.addLayer({ id: 'nav-route-border', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: ROUTE_BORDER_PAINT })
  map.addLayer({ id: 'nav-route-done', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#9ca3af', 'line-width': 5 } })
  map.addLayer({ id: 'nav-route-remaining', type: 'line', source: 'nav-remaining', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#7c3aed', 'line-width': 5 } })
}

function lineFeature(coords: number[][]) {
  return { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} }
}

function setMapStyle(id: string) {
  if (!map || id === mapStyleId.value) return
  mapStyleId.value = id
  map.setStyle(mapStyleFor(id), { diff: false })
  map.once('style.load', () => {
    installRouteLayers()
    if (lastPos) updateLocationMarker(lastPos)
    refreshRemaining()
  })
}

// ─── GPS tracking ───────────────────────────────────────────────────────────

function startTracking() {
  if (!('geolocation' in navigator)) { gpsError.value = t('routes.gps_error'); return }
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    () => { gpsError.value = t('routes.gps_error') },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  )
}

function onPosition(pos: GeolocationPosition) {
  gpsError.value = null
  hasFix.value = true
  const here: LngLat = [pos.coords.longitude, pos.coords.latitude]

  // Project onto the route: global search on the first fix (so we locate
  // correctly wherever the ride is joined, including mid-loop), then a windowed
  // search around the last index for perf and to handle self-crossing loops.
  const { idx, distM } = nearestGeomIndex(here, geometry, located ? lastIdx : -1)
  lastIdx = idx
  located = true
  // Snap the raw fix onto the polyline so the grey/purple boundary follows the
  // rider continuously along a segment instead of jumping vertex to vertex.
  const snap = projectOnRoute(here, geometry, cumDistM, idx)
  snapPoint = snap.point
  snapNextIdx = snap.nextIdx
  snapDistAlongM = snap.distAlongM
  const wasOffRoute = offRoute.value
  // Widen the threshold by the reported GPS accuracy (capped) so an imprecise fix
  // doesn't get flagged off-route while the rider is actually on the line.
  const accuracyM = Math.min(pos.coords.accuracy ?? 0, OFF_ROUTE_ACCURACY_CAP)
  offRoute.value = distM > OFF_ROUTE_M + accuracyM
  updateProgress(idx)

  // Heading: trust the GPS heading when moving fast enough, otherwise derive it.
  updateBearing(pos, here)
  updateOffRoute(here, idx, distM)

  updateSpeed(pos, here)
  lastPos = here

  // Hand the fresh fix to the extrapolation loop: it owns the marker and camera
  // from here, projecting the rider forward every frame so the view glides
  // instead of jumping once per second.
  anchorPos = here
  anchorTime = performance.now()
  extrapSpeedMs = speedKmh.value / 3.6
  extrapBearing = currentBearing

  const turnApproaching = updateTurns()
  handleOffRouteSound(wasOffRoute)

  // Snap the 3D view back over the rider as they reach an intersection.
  if (turnApproaching && !following.value) following.value = true

  if (!hasInitialZoom) {
    // First fix: a smooth intro that also applies the profile zoom & pitch once,
    // then the rAF loop takes over the camera.
    updateLocationMarker(here)
    if (locationMarker) locationMarker.setRotation(currentBearing)
    displayBearing = currentBearing
    map.easeTo(followOptions(here))
    map.once('moveend', startAnimation)
  } else {
    startAnimation()
  }
}

// Camera framing used whenever we follow the rider. The rider is anchored in the
// lower third of the screen (via padding) so the look-ahead distance stays
// constant frame to frame; the tilt comes from the profile, and the zoom (also
// from the profile) is only applied once, on the first fix, so following never
// fights a manual pinch-zoom afterwards.
function followOptions(center: LngLat): any {
  const h = map?.getContainer()?.clientHeight || 0
  const opts: any = {
    center,
    bearing: currentBearing,
    pitch: navPrefs.pitch,
    duration: 500,
    padding: { top: Math.round(h * 0.45), bottom: 0, left: 0, right: 0 },
  }
  if (!hasInitialZoom) { opts.zoom = navPrefs.zoom; hasInitialZoom = true }
  return opts
}

// Move a lng/lat by `distM` along `bearingDeg` (equirectangular — accurate to a
// few centimetres over the handful of metres we extrapolate between fixes).
function moveLngLat([lng, lat]: LngLat, bearingDeg: number, distM: number): LngLat {
  const R = 6371000
  const br = (bearingDeg * Math.PI) / 180
  const dLat = (distM * Math.cos(br)) / R
  const dLng = (distM * Math.sin(br)) / (R * Math.cos((lat * Math.PI) / 180))
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]
}

// Render loop: between GPS fixes, advance the rider from the last fix along its
// heading at its carried speed, and ease the rendered bearing toward the travel
// heading. The camera is jumped (not animated) each frame — smoothness now comes
// from the extrapolation, so a per-fix easeTo would only fight it and lag.
function startAnimation() {
  if (rafId != null || !map) return
  const tick = () => {
    rafId = requestAnimationFrame(tick)
    if (!anchorPos) return
    const dt = Math.min((performance.now() - anchorTime) / 1000, MAX_EXTRAP_S)
    const pos = extrapSpeedMs > MIN_SPEED_MS
      ? moveLngLat(anchorPos, extrapBearing, extrapSpeedMs * dt)
      : anchorPos
    let d = extrapBearing - displayBearing
    while (d > 180) d -= 360
    while (d < -180) d += 360
    displayBearing += d * BEARING_SMOOTH
    updateLocationMarker(pos)
    if (locationMarker) locationMarker.setRotation(displayBearing)
    if (following.value) {
      map.jumpTo({ center: pos, bearing: displayBearing, pitch: navPrefs.pitch })
    }
  }
  rafId = requestAnimationFrame(tick)
}

function stopAnimation() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
}

// Track the next turn ahead: announce it once within TURN_ALERT_M (and re-orient
// the view), and surface a visual hint within TURN_HINT_M. Returns true on the
// frame a turn alert fires.
function updateTurns(): boolean {
  if (!turns.length) { turnHint.value = null; return false }
  const here = snapDistAlongM
  while (nextTurnPtr < turns.length && turns[nextTurnPtr].distM < here - 5) nextTurnPtr++
  const turn = turns[nextTurnPtr]
  if (!turn) { turnHint.value = null; return false }
  const dist = turn.distM - here

  turnHint.value = dist <= TURN_HINT_M && dist > -5
    ? { direction: turn.direction, distM: dist, kind: turn.kind, angle: turn.angle }
    : null

  if (dist <= TURN_ALERT_M && dist > -5 && announcedTurn !== nextTurnPtr) {
    announcedTurn = nextTurnPtr
    if (soundOn.value) playManeuver(turn.kind, turn.direction)
    return true
  }
  return false
}

// FontAwesome icon for the visual turn indicator: plain directional arrows for
// turns, straight-up when the deviation is negligible, and distinct icons for
// roundabouts and U-turns.
function turnIcon(h: { direction: 'left' | 'right'; kind: Maneuver; angle: number }): string {
  if (h.kind === 'roundabout') return h.direction === 'left' ? 'fa-rotate-left' : 'fa-rotate-right'
  if (h.kind === 'uturn') return 'fa-arrow-down'
  if (Math.abs(h.angle) < 20) return 'fa-arrow-up'
  return h.direction === 'left' ? 'fa-arrow-left' : 'fa-arrow-right'
}

function handleOffRouteSound(wasOffRoute: boolean) {
  if (!offRoute.value) { lastOffRouteAlert = 0; return }
  const now = Date.now()
  if (!wasOffRoute || now - lastOffRouteAlert > OFF_ROUTE_REALERT_MS) {
    lastOffRouteAlert = now
    if (soundOn.value) playOffRoute()
  }
}

// Instantaneous speed in km/h: trust the GPS-reported speed when present,
// otherwise derive it from the displacement since the previous fix.
function updateSpeed(pos: GeolocationPosition, here: LngLat) {
  let ms = pos.coords.speed
  if (ms == null || Number.isNaN(ms) || ms < 0) {
    if (lastPos && lastFixTime) {
      const dt = (pos.timestamp - lastFixTime) / 1000
      ms = dt > 0 ? haversine(lastPos, here) / dt : 0
    } else {
      ms = 0
    }
  }
  lastFixTime = pos.timestamp
  speedKmh.value = Math.max(0, ms * 3.6)
}

// When off route, point an arrow back to the nearest vertex of the route. The
// map is rotated so its bearing is "up", so the on-screen angle is the absolute
// bearing-to-route minus the map's bearing.
function updateOffRoute(here: LngLat, idx: number, distM: number) {
  if (!offRoute.value) return
  offRouteDistM.value = distM
  const toRoute = bearingBetween(here, geometry[idx])
  const mapBearing = map ? map.getBearing() : currentBearing
  let rel = toRoute - mapBearing
  while (rel > 180) rel -= 360
  while (rel < -180) rel += 360
  offRouteRelBearing.value = rel
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
  const p = progressFor(idx, geometry, cumDistM, snapDistAlongM)
  remainingM.value = p.remainingM
  remainingGainM.value = p.remainingGainM
  doneRatio.value = p.doneRatio
  const ac = activeClimb(idx, climbs, cumDistM, snapDistAlongM)
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
  const rest = geometry.slice(snapPoint ? snapNextIdx : lastIdx).map(([lng, lat]) => [lng, lat])
  // Start the remaining line exactly at the rider's projected position.
  if (snapPoint) rest.unshift([snapPoint[0], snapPoint[1]])
  src.setData(lineFeature(rest))
}

function updateLocationMarker(coords: LngLat) {
  if (!map) return
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
  if (!lastPos) return
  // Pause the loop so it doesn't jump-cancel the glide back; keep the rider's
  // current zoom — only re-center, re-orient and restore the 3D tilt — then
  // hand the camera back to the loop once we're settled over the rider.
  stopAnimation()
  displayBearing = currentBearing
  map.easeTo(followOptions(lastPos))
  map.once('moveend', startAnimation)
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
    <div class="nav-top-left d-flex gap-2">
      <a :href="`/routes`" class="btn btn-sm btn-light shadow-sm" :title="t('routes.back')" :aria-label="t('routes.back')">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
      </a>
      <button
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :title="soundOn ? t('routes.sound_on') : t('routes.sound_off')"
        :aria-label="soundOn ? t('routes.sound_on') : t('routes.sound_off')"
        @click="toggleSound"
      >
        <i class="fa-solid" :class="soundOn ? 'fa-volume-high' : 'fa-volume-xmark'" aria-hidden="true"></i>
      </button>
    </div>
    <div class="nav-top-right">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="setMapStyle" />
    </div>

    <!-- Instantaneous speed -->
    <div v-if="hasFix && !offRoute" class="nav-speed shadow">
      <span class="nav-speed-value">{{ Math.round(speedKmh) }}</span>
      <span class="nav-speed-unit">km/h</span>
    </div>

    <!-- Upcoming turn indicator -->
    <div v-if="turnHint && hasFix && !offRoute" class="nav-turn shadow">
      <i class="fa-solid" :class="turnIcon(turnHint)" aria-hidden="true"></i>
      <span class="nav-turn-dist">{{ formatDistanceShort(turnHint.distM) }}</span>
      <span class="visually-hidden">{{ turnHint.direction === 'right' ? t('routes.turn_right') : t('routes.turn_left') }}</span>
    </div>

    <!-- GPS / off-route banners -->
    <div v-if="gpsError" class="nav-banner nav-banner--warn">
      <i class="fa-solid fa-location-crosshairs me-2" aria-hidden="true"></i>{{ gpsError }}
    </div>
    <div v-else-if="!hasFix && !loading" class="nav-banner nav-banner--info">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.gps_waiting') }}
    </div>
    <div v-else-if="offRoute" class="nav-banner nav-banner--danger">
      <i
        class="fa-solid fa-arrow-up nav-offroute-arrow me-2"
        :style="{ transform: `rotate(${offRouteRelBearing}deg)` }"
        aria-hidden="true"
      ></i>{{ t('routes.off_route') }} · {{ formatDistanceShort(offRouteDistM) }}
    </div>

    <!-- Big centered arrow pointing back to the route when off-route -->
    <i
      v-if="offRoute && hasFix"
      class="fa-solid fa-arrow-up nav-offroute-bigarrow"
      :style="{ transform: `translate(-50%, -50%) rotate(${offRouteRelBearing}deg)` }"
      aria-hidden="true"
    ></i>

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
  /* svh = smallest visible viewport (browser chrome expanded). The page never
     scrolls, so the chrome stays put and svh matches the visible area exactly —
     unlike dvh, which some mobile browsers mis-compute on first paint and only
     fix after a rotation, leaving the bottom stats bar clipped off-screen. */
  height: 100vh;
  height: 100svh;
  overflow: hidden;
}
.nav-map { position: absolute; inset: 0; }

/* Anchor the map-style menu to the button's right edge so it never overflows
   the screen on this full-width page. */
.nav-top-right :deep(.dropdown-menu) {
  right: 0;
  left: auto;
}

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
.nav-offroute-arrow { display: inline-block; transition: transform 0.4s ease; }
.nav-offroute-bigarrow {
  position: absolute; top: 50%; left: 50%;
  z-index: 6; pointer-events: none;
  font-size: 40vmin; color: #dc3545; opacity: 0.5;
  transition: transform 0.4s ease;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35));
}
.nav-banner--warn { background: #fff3cd; color: #664d03; }
.nav-banner--info { background: #cfe2ff; color: #084298; }

.nav-recenter {
  position: absolute; bottom: 8.5rem; right: 0.75rem; z-index: 4;
  border-radius: 999px; font-weight: 600;
}

.nav-speed {
  position: absolute; top: 0.75rem; left: 50%; transform: translateX(-50%);
  z-index: 3; display: flex; align-items: baseline; gap: 0.3rem;
  background: rgba(255, 255, 255, 0.92); border-radius: 0.75rem;
  padding: 0.3rem 0.75rem;
}
.nav-speed-value { font-size: 1.6rem; font-weight: 700; line-height: 1; }
.nav-speed-unit { font-size: 0.8rem; color: #6c757d; font-weight: 600; }

.nav-turn {
  position: absolute; top: 4.25rem; left: 50%; transform: translateX(-50%);
  z-index: 3; display: flex; align-items: center; gap: 0.5rem;
  background: #7c3aed; color: #fff; padding: 0.5rem 1rem;
  border-radius: 0.75rem; font-size: 1.6rem; line-height: 1;
}
.nav-turn-dist { font-size: 1.1rem; font-weight: 700; }

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
