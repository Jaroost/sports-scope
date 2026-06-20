<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import MapStyleDropdown from './MapStyleDropdown.vue'
import {
  buildDistancesM, detectClimbs, detectTurns, turnsFromVoiceHints, computeGainLoss,
  formatDistanceShort, haversine, bearingBetween, nearestGeomIndex, projectOnRoute,
  lngLatAtDistanceM, progressFor, activeClimb, gradeForIndex, colorForGrade,
} from '../routeHelpers'
import type { Coord, Climb, LngLat, TurnPoint, VoiceHint, Maneuver } from '../routeHelpers'
import { unlockAudio, playManeuver, playOffRoute } from '../navAudio'
import { userPreferences, persistNavCamera } from '../userPreferences'

const props = defineProps<{ shareToken: string }>()

const SOUND_KEY = 'sportsScope.navSound'
// Tuiles MNT (terrarium) pour le relief 3D — mêmes sources que le créateur d'itinéraire.
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

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
// Set when the rider deliberately unlocks the camera with the lock button (to pan
// around and study the map). Unlike a transient drag, this suppresses the
// automatic snap-back on turn approach so the view stays where they left it.
const cameraUnlocked = ref(false)
const soundOn = ref(loadSound())
// Le fond de carte de navigation est gouverné par le profil (comme le créateur) :
// on part du réglage du compte ; le sélecteur ne sert qu'à le changer en séance.
const mapStyleId = ref(navPrefs.default_style as string)

// Réglages caméra ajustables en séance. On part des valeurs du profil ; les régler
// ici met à jour la vue immédiatement puis reporte le réglage sur le profil. La
// boucle d'animation et followOptions lisent ces refs (et non plus navPrefs) pour
// que toute modification prenne effet à la frame suivante.
const camZoom = ref(navPrefs.zoom)
const camPitch = ref(navPrefs.pitch)
const terrain3d = ref(navPrefs.terrain)
const showCamPanel = ref(false)
const CAM_PITCH_MIN = 0
const CAM_PITCH_MAX = 75
const CAM_ZOOM_MIN = 14
const CAM_ZOOM_MAX = 20

// Live navigation state (reactive, drives the UI overlays)
const remainingM = ref(0)
const remainingGainM = ref(0)
const doneRatio = ref(0)
const speedKmh = ref(0)
const offRoute = ref(false)
const offRouteRelBearing = ref(0)   // on-screen angle of the "back to route" arrow
const climbInfo = ref<{
  climb: Climb
  ratio: number
  remainingGainM: number
  segments: { d: string; color: string }[]  // graded elevation profile of the climb
  posX: number                               // cursor x (% of profile width)
  posY: number                               // cursor y (% of profile height)
  topY: number                               // summit y (% of profile height)
  grade: number                              // instantaneous grade at the rider (%)
  gradeColor: string                         // grade-bucket colour for the badge background
  gradeText: string                          // contrasting text colour (black/white)
} | null>(null)
const turnHint = ref<{ direction: 'left' | 'right'; distM: number; kind: Maneuver; angle: number } | null>(null)

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let wakeLock: any = null

// Route data (non-reactive: large arrays, only read inside callbacks)
let geometry: Coord[] = []
let alts: (number | null)[] = []
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
// True during the first-fix intro easeTo (which applies the profile zoom). While
// it's running we must NOT start the rAF loop: a jumpTo would interrupt the
// animation and freeze the zoom at the overview value, so the profile zoom would
// never take effect until the rider nudges the zoom slider.
let introPending = false
let nextTurnPtr = 0          // index of the next unpassed turn in `turns`
let announcedTurn = -1       // index of the last turn we played a cue for
let lastOffRouteAlert = 0    // timestamp of the last off-route buzz

// ─── Position extrapolation (dead-reckoning between GPS fixes) ────────────────
// GPS fixes land ~once per second; rather than jumping the marker on each fix,
// we advance the displayed position forward from the last fix using the carried
// speed and heading, recaling on every new fix. This keeps the rider gliding.
let rafId: number | null = null
let anchorPos: LngLat | null = null   // position d'ancrage affichée (snappée ou brute)
let anchorTime = 0                     // performance.now() of that fix
let anchorOnRoute = false              // true → l'ancre est snappée sur le tracé
let anchorDistM = 0                    // distance le long du tracé à l'ancre (si snappée)
let extrapSpeedMs = 0                  // speed carried forward between fixes
let extrapBearing = 0                  // travel heading (target)
let displayBearing = 0                 // smoothed bearing actually rendered
const MAX_EXTRAP_S = 2.5               // stop predicting if fixes stop arriving
const BEARING_SMOOTH = 0.18            // per-frame easing toward the target bearing
// Bottom camera padding lifts the rider's anchor up the screen so the climb card
// (which overlays the lower map) doesn't hide the position arrow. Eased per frame.
const CLIMB_LIFT_RATIO = 0.33          // extra bottom padding (× height) while climbing
const PAD_SMOOTH = 0.12                // per-frame easing toward the target padding
let displayBottomPad = 0               // smoothed bottom padding actually rendered

const donePercent = computed(() => Math.round(doneRatio.value * 100))

function loadSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}

function toggleSound() {
  soundOn.value = !soundOn.value
  try { localStorage.setItem(SOUND_KEY, soundOn.value ? 'on' : 'off') } catch { /* ignore */ }
  if (soundOn.value) unlockAudio()
}

// ─── Camera controls ──────────────────────────────────────────────────────────
// Les curseurs ajustent la vue en direct (@input) puis reportent le réglage sur le
// profil au relâchement (@change). Inclinaison et zoom sont réappliqués à chaque
// frame par la boucle (qui lit camPitch / camZoom) ; on les pousse aussi via
// setPitch/setZoom pour que le changement soit visible immédiatement hors suivi.

function onPitchInput() {
  if (map) map.setPitch(camPitch.value)
}

function onZoomInput() {
  if (!map) return
  hasInitialZoom = true  // l'utilisateur prend la main sur le zoom
  map.setZoom(camZoom.value)
}

// Active/désactive le relief 3D (terrain MNT) sous le tracé. Idempotente : aussi
// appelée après un setStyle, qui efface terrain et sources.
function applyTerrain() {
  if (!map) return
  if (terrain3d.value) {
    if (!map.getSource('terrain-dem')) {
      map.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
    }
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
  } else {
    map.setTerrain(null)
  }
}

function toggleTerrain() {
  terrain3d.value = !terrain3d.value
  applyTerrain()
  persistCamera()
}

function persistCamera() {
  persistNavCamera(camZoom.value, camPitch.value, terrain3d.value)
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
  alts = geometry.map((c) => c[2] ?? null)
  cumDistM = buildDistancesM(geometry)
  climbs = detectClimbs(alts, cumDistM)
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
    pitch: camPitch.value,
    maxPitch: CAM_PITCH_MAX,
    attributionControl: false,
  })
  map.on('styleimagemissing', (e: any) => {
    map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  // The user took manual control of the map → stop auto-following AND treat it as
  // a deliberate unlock (so the view won't snap back on the next turn) — moving the
  // map by hand means they want to study it. Guard on `originalEvent`: our own
  // follow animations change the bearing and fire `rotatestart` programmatically
  // (no originalEvent), and must NOT disable it — that bug forced the rider to keep
  // tapping "recenter".
  const onManualMove = (e: any) => { if (e.originalEvent) { following.value = false; cameraUnlocked.value = true } }
  map.on('dragstart', onManualMove)
  map.on('rotatestart', onManualMove)
  // Garde camZoom (et donc le curseur du panneau caméra) aligné sur un pinch
  // manuel. Pas d'arrondi : la boucle réapplique camZoom à chaque frame, donc une
  // valeur arrondie ferait « sauter » le zoom au pas de 0,5 pendant le pinch.
  map.on('zoom', (e: any) => { if (e.originalEvent) camZoom.value = map.getZoom() })

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      installRouteLayers()
      applyTerrain()
      // Fit the whole route before the first GPS fix arrives.
      const b = new maplibre.LngLatBounds(coords[0], coords[0])
      coords.forEach((c) => b.extend(c))
      map.fitBounds(b, { padding: 60, duration: 0, pitch: camPitch.value })
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
    applyTerrain()
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
  updateOffRoute(here, idx)

  updateSpeed(pos, here)
  lastPos = here

  // Hand the fresh fix to the extrapolation loop: it owns the marker and camera
  // from here, projecting the rider forward every frame so the view glides
  // instead of jumping once per second. Tant qu'on est sur le tracé, on ancre la
  // flèche sur la position projetée (snapPoint) et on extrapolera LE LONG du tracé,
  // pour qu'elle reste collée à la ligne au lieu de suivre un GPS qui dérive. Hors
  // trajet, on retombe sur le GPS brut pour montrer qu'on a quitté l'itinéraire.
  anchorOnRoute = !offRoute.value && snapPoint != null
  anchorPos = anchorOnRoute ? snapPoint : here
  anchorDistM = snapDistAlongM
  anchorTime = performance.now()
  extrapSpeedMs = speedKmh.value / 3.6
  extrapBearing = currentBearing

  const turnApproaching = updateTurns()
  handleOffRouteSound(wasOffRoute)

  // Snap the 3D view back over the rider as they reach an intersection — unless
  // they've deliberately unlocked the camera to study the map.
  if (turnApproaching && !following.value && !cameraUnlocked.value) following.value = true

  if (!hasInitialZoom) {
    // First fix: a smooth intro that also applies the profile zoom & pitch once,
    // then the rAF loop takes over the camera. On affiche directement l'ancre
    // (snappée sur le tracé si on est dessus) plutôt que le GPS brut.
    updateLocationMarker(anchorPos ?? here)
    if (locationMarker) locationMarker.setRotation(currentBearing)
    displayBearing = currentBearing
    introPending = true
    map.easeTo(followOptions(anchorPos ?? here))
    map.once('moveend', () => { introPending = false; startAnimation() })
  } else {
    startAnimation()
  }
}

// Camera framing used whenever we follow the rider. The rider is anchored in the
// lower third of the screen (via padding) so the look-ahead distance stays
// constant frame to frame; the tilt and zoom come from the profile. The render
// loop re-applies camZoom every frame, and a manual pinch writes its result back
// into camZoom, so following tracks the pinch instead of fighting it.
function followOptions(center: LngLat): any {
  const h = map?.getContainer()?.clientHeight || 0
  const opts: any = {
    center,
    bearing: currentBearing,
    pitch: camPitch.value,
    duration: 500,
    padding: followPadding(h),
  }
  if (!hasInitialZoom) { opts.zoom = camZoom.value; hasInitialZoom = true }
  return opts
}

// Extra bottom padding so the rider sits above the climb card when it's shown.
function bottomPadTarget(h: number): number {
  return climbInfo.value ? Math.round(h * CLIMB_LIFT_RATIO) : 0
}

// Camera padding: a fixed top inset keeps the look-ahead constant; the bottom
// inset (smoothed) lifts the rider clear of the climb card overlay.
function followPadding(h: number): { top: number; bottom: number; left: number; right: number } {
  return { top: Math.round(h * 0.45), bottom: Math.round(displayBottomPad), left: 0, right: 0 }
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
  if (rafId != null || !map || introPending) return
  const tick = () => {
    rafId = requestAnimationFrame(tick)
    if (!anchorPos) return
    const dt = Math.min((performance.now() - anchorTime) / 1000, MAX_EXTRAP_S)
    let pos = anchorPos
    if (extrapSpeedMs > MIN_SPEED_MS) {
      // Sur le tracé : avancer la distance le long de la polyligne (la flèche reste
      // collée à la ligne, virages compris). Hors trajet : extrapolation libre au cap.
      pos = anchorOnRoute
        ? lngLatAtDistanceM(geometry, cumDistM, anchorDistM + extrapSpeedMs * dt)
        : moveLngLat(anchorPos, extrapBearing, extrapSpeedMs * dt)
    }
    let d = extrapBearing - displayBearing
    while (d > 180) d -= 360
    while (d < -180) d += 360
    displayBearing += d * BEARING_SMOOTH
    updateLocationMarker(pos)
    if (locationMarker) locationMarker.setRotation(displayBearing)
    if (following.value) {
      const h = map.getContainer()?.clientHeight || 0
      displayBottomPad += (bottomPadTarget(h) - displayBottomPad) * PAD_SMOOTH
      map.jumpTo({ center: pos, bearing: displayBearing, zoom: camZoom.value, pitch: camPitch.value, padding: followPadding(h) })
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
function updateOffRoute(here: LngLat, idx: number) {
  if (!offRoute.value) return
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
    buildClimbProfile(ac.climb)
    const posX = ac.ratio * 100
    const grade = gradeForIndex(idx, alts, cumDistM)
    const gradeColor = colorForGrade(grade)
    climbInfo.value = {
      climb: ac.climb,
      ratio: ac.ratio,
      remainingGainM: rem,
      segments: profileSegments,
      posX,
      posY: profileYAt(posX),
      topY: profileTopY,
      grade,
      gradeColor,
      gradeText: textColorOn(gradeColor),
    }
  } else {
    climbInfo.value = null
  }
  refreshRemaining()
}

// Build the graded elevation profile of a climb once (geometry is static), cached
// by its start index. Each segment is a filled polygon from the altitude line down
// to the baseline, coloured by its grade. Coordinates are in a 0–100 viewBox:
// x spans the climb's distance, y is the altitude normalised to the climb's range.
let profileForStart = -1
let profileSegments: { d: string; color: string }[] = []
let profilePts: { x: number; y: number }[] = []
let profileTopY = 4   // y of the highest point of the climb (summit)

function buildClimbProfile(climb: Climb) {
  if (profileForStart === climb.startIdx) return
  profileForStart = climb.startIdx
  const { startIdx: s, endIdx: e } = climb
  const startM = cumDistM[s]
  const span = (cumDistM[e] - startM) || 1
  let minA = Infinity
  let maxA = -Infinity
  for (let i = s; i <= e; i++) { const a = alts[i] ?? 0; if (a < minA) minA = a; if (a > maxA) maxA = a }
  const range = (maxA - minA) || 1
  const xOf = (i: number) => ((cumDistM[i] - startM) / span) * 100
  const yOf = (i: number) => 96 - (((alts[i] ?? 0) - minA) / range) * 88  // 4–96, peak near the top
  profilePts = []
  for (let i = s; i <= e; i++) profilePts.push({ x: xOf(i), y: yOf(i) })
  profileTopY = Math.min(...profilePts.map((p) => p.y))
  profileSegments = []
  for (let i = s; i < e; i++) {
    const x1 = xOf(i)
    const x2 = xOf(i + 1)
    profileSegments.push({
      d: `M${x1},${yOf(i)} L${x2},${yOf(i + 1)} L${x2},100 L${x1},100 Z`,
      color: colorForGrade(gradeForIndex(i, alts, cumDistM)),
    })
  }
}

// Black or white, whichever reads best on `hex` (perceived luminance, BT.601).
function textColorOn(hex: string): string {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111827' : '#ffffff'
}

// Altitude-line y at a given x (% of width), interpolated between profile points.
function profileYAt(x: number): number {
  if (!profilePts.length) return 100
  for (let i = 1; i < profilePts.length; i++) {
    if (profilePts[i].x >= x) {
      const a = profilePts[i - 1]
      const b = profilePts[i]
      const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0
      return a.y + t * (b.y - a.y)
    }
  }
  return profilePts[profilePts.length - 1].y
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

// Lock button: unlock the camera for free panning/zooming/rotating, or re-lock
// (and recenter) if already unlocked. An explicit unlock keeps the view fixed
// even through turns, so the rider can study the map ahead at their own pace.
function toggleFollow() {
  if (following.value) {
    following.value = false
    cameraUnlocked.value = true
  } else {
    recenter()
  }
}

function recenter() {
  following.value = true
  cameraUnlocked.value = false
  if (!lastPos) return
  // Pause the loop so it doesn't jump-cancel the glide back; keep the rider's
  // current zoom — only re-center, re-orient and restore the 3D tilt — then
  // hand the camera back to the loop once we're settled over the rider.
  stopAnimation()
  displayBearing = currentBearing
  // Recentrer sur l'ancre affichée (snappée sur le tracé si on est dessus) pour que
  // caméra et flèche coïncident — la boucle recentre déjà sur la position affichée.
  map.easeTo(followOptions(anchorPos ?? lastPos))
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
      <div class="position-relative">
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :class="{ active: showCamPanel }"
          :title="t('routes.camera_settings')"
          :aria-label="t('routes.camera_settings')"
          @click="showCamPanel = !showCamPanel"
        >
          <i class="fa-solid fa-video" aria-hidden="true"></i>
        </button>
        <div v-if="showCamPanel" class="nav-cam-panel shadow">
          <label class="nav-cam-row">
            <span class="nav-cam-label">{{ t('routes.camera_pitch') }}</span>
            <input
              type="range"
              class="form-range"
              :min="CAM_PITCH_MIN" :max="CAM_PITCH_MAX" step="1"
              v-model.number="camPitch"
              @input="onPitchInput"
              @change="persistCamera"
            />
            <span class="nav-cam-val">{{ Math.round(camPitch) }}°</span>
          </label>
          <label class="nav-cam-row">
            <span class="nav-cam-label">{{ t('routes.camera_zoom') }}</span>
            <input
              type="range"
              class="form-range"
              :min="CAM_ZOOM_MIN" :max="CAM_ZOOM_MAX" step="0.5"
              v-model.number="camZoom"
              @input="onZoomInput"
              @change="persistCamera"
            />
            <span class="nav-cam-val">{{ camZoom.toFixed(1) }}</span>
          </label>
          <label class="nav-cam-row nav-cam-row--switch">
            <span class="nav-cam-label">{{ t('routes.camera_3d') }}</span>
            <span class="form-check form-switch m-0">
              <input
                class="form-check-input"
                type="checkbox"
                role="switch"
                :checked="terrain3d"
                @change="toggleTerrain"
              />
            </span>
          </label>
        </div>
      </div>
    </div>
    <div class="nav-top-right">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="setMapStyle" />
      <button
        v-if="hasFix"
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :class="{ active: cameraUnlocked }"
        :title="following ? t('routes.camera_unlock') : t('routes.camera_lock')"
        :aria-label="following ? t('routes.camera_unlock') : t('routes.camera_lock')"
        @click="toggleFollow"
      >
        <i class="fa-solid" :class="following ? 'fa-lock' : 'fa-lock-open'" aria-hidden="true"></i>
      </button>
    </div>

    <!-- Instantaneous speed -->
    <div v-if="hasFix" class="nav-speed shadow">
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

    <!-- Climb card: full graded elevation profile with a position cursor -->
    <div v-if="climbInfo" class="nav-climb shadow">
      <div class="d-flex align-items-center justify-content-between mb-1">
        <span class="fw-semibold">
          <i class="fa-solid fa-mountain text-warning me-1" aria-hidden="true"></i>{{ t('routes.climb_in_progress') }}
          <span v-if="climbInfo.climb.category" class="badge bg-dark ms-1">{{ climbInfo.climb.category }}</span>
        </span>
        <span class="nav-climb-grade" :style="{ background: climbInfo.gradeColor, color: climbInfo.gradeText }">{{ Math.round(climbInfo.grade) }} %</span>
      </div>
      <div class="nav-climb-graph">
        <svg class="nav-climb-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path v-for="(seg, i) in climbInfo.segments" :key="i" :d="seg.d" :fill="seg.color" />
        </svg>
        <div class="nav-climb-cursor" :style="{ left: `${climbInfo.posX}%` }">
          <!-- Remaining vertical gain: from the rider's altitude up to the summit. -->
          <span
            class="nav-climb-remain"
            :style="{ top: `${climbInfo.topY}%`, height: `${Math.max(0, climbInfo.posY - climbInfo.topY)}%` }"
          ></span>
          <span class="nav-climb-remain-label" :style="{ top: `${(climbInfo.topY + climbInfo.posY) / 2}%` }">
            +{{ Math.round(climbInfo.remainingGainM) }} m
          </span>
          <span class="nav-climb-dot" :style="{ top: `${climbInfo.posY}%` }"></span>
        </div>
      </div>
      <div class="d-flex justify-content-between mt-1">
        <small class="text-muted">{{ formatDistanceShort(climbInfo.climb.lengthM) }}</small>
        <small class="text-muted">{{ formatDistanceShort(climbInfo.climb.lengthM * (1 - climbInfo.ratio)) }}</small>
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
.nav-top-right {
  position: absolute; top: 0.75rem; right: 0.75rem; z-index: 4;
  display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;
}

/* Small camera-settings popover anchored under its toggle button. */
.nav-cam-panel {
  position: absolute; top: calc(100% + 0.4rem); left: 0;
  z-index: 5; width: 14rem;
  background: #fff; border-radius: 0.6rem; padding: 0.6rem 0.75rem;
}
.nav-cam-row {
  display: flex; align-items: center; gap: 0.5rem; margin: 0;
}
.nav-cam-row + .nav-cam-row { margin-top: 0.45rem; }
.nav-cam-label { font-size: 0.78rem; font-weight: 600; color: #495057; width: 4.5rem; }
.nav-cam-row .form-range { flex: 1; margin: 0; }
.nav-cam-val { font-size: 0.78rem; font-weight: 700; width: 2.6rem; text-align: right; }

.nav-banner {
  position: absolute; top: 0.75rem; left: 50%; transform: translateX(-50%);
  z-index: 3; padding: 0.45rem 0.9rem; border-radius: 999px;
  font-weight: 600; font-size: 0.9rem; white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
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
.nav-climb-grade {
  font-weight: 700; font-size: 1.1rem; line-height: 1;
  padding: 0.15rem 0.45rem; border-radius: 0.4rem;
}
.nav-climb-graph {
  position: relative; height: 64px; width: 100%;
}
.nav-climb-svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  border-radius: 0.4rem; background: #f8f9fa;
}
/* Vertical "you are here" cursor over the profile; the dot rides the altitude line. */
.nav-climb-cursor {
  position: absolute; top: 0; bottom: 0; width: 2px;
  background: rgba(17, 24, 39, 0.55); transform: translateX(-1px);
}
.nav-climb-dot {
  position: absolute; left: 50%; width: 12px; height: 12px;
  background: #111827; border: 2px solid #fff; border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
/* Remaining vertical gain: dashed segment from the rider up to the summit. */
.nav-climb-remain {
  position: absolute; left: 50%; width: 0;
  border-left: 2px dashed #f97316; transform: translateX(-1px);
}
.nav-climb-remain-label {
  position: absolute; left: 6px; transform: translateY(-50%);
  font-size: 0.7rem; font-weight: 700; color: #c2410c; white-space: nowrap;
  background: rgba(255, 255, 255, 0.85); padding: 0 0.2rem; border-radius: 0.25rem;
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
