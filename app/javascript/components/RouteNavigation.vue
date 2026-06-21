<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import MapStyleDropdown from './MapStyleDropdown.vue'
import {
  buildDistancesM, detectClimbs, detectTurns, turnsFromVoiceHints, computeGainLoss,
  formatDistanceShort, formatDistancePrecise, haversine, bearingBetween, nearestGeomIndex, projectOnRoute,
  lngLatAtDistanceM, progressFor, activeClimb, gradeForIndex, colorForGrade,
} from '../routeHelpers'
import type { Coord, Climb, LngLat, TurnPoint, VoiceHint, Maneuver } from '../routeHelpers'
import { unlockAudio, playManeuver, playOffRoute } from '../navAudio'
import { userPreferences, persistNavCamera, persistDefaultMapStyle, isLoggedIn } from '../userPreferences'

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
// Largeur (px) du tracé sur la carte ; la bordure ajoute 4 px de part et d'autre.
const ROUTE_LINE_WIDTH = navPrefs.line_width ?? 8
const ROUTE_BORDER_WIDTH = ROUTE_LINE_WIDTH + 4
const TURN_ALERT_M = navPrefs.turn_alert_m
const TURN_HINT_M = navPrefs.turn_hint_m
const TURN_URGENT_M = navPrefs.turn_urgent_m
const TURN_REPEAT_MS = navPrefs.turn_repeat_ms
// Rayon (px) des pastilles orange de changement de direction.
const TURN_MARKER_SIZE = navPrefs.turn_marker_size ?? 11
const OFF_ROUTE_REALERT_MS = 12000  // re-buzz this often while still off route

const mapEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const gpsError = ref<string | null>(null)
const hasFix = ref(false)
const following = ref(true)
// Set when the rider pans/zooms/rotates the map by hand (to study it). This
// suppresses the automatic snap-back on turn approach so the view stays where
// they left it; tapping "recenter" clears it and resumes following.
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
// Confirmation éphémère affichée sur le bouton « enregistrer le zoom ».
const zoomSaved = ref(false)
// Le bouton n'a de sens que pour un compte (persistNavCamera est un no-op hors-ligne).
const loggedIn = isLoggedIn()
const screenOff = ref(false)
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
  areaD: string                              // filled area path of the whole profile (for the grey "done" overlay)
  posX: number                               // cursor x (% of profile width)
  posY: number                               // cursor y (% of profile height)
  topY: number                               // summit y (% of profile height)
  grade: number                              // instantaneous grade at the rider (%)
  gradeColor: string                         // grade-bucket colour for the badge background
  gradeText: string                          // contrasting text colour (black/white)
} | null>(null)
const turnHint = ref<{ direction: 'left' | 'right'; distM: number; kind: Maneuver; angle: number; exitNumber?: number } | null>(null)

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let wakeLock: any = null
let placeMarkers: any[] = []   // marqueurs POI (cimetières/boulangeries) issus du profil
let placePopup: any = null            // popup POI ouvert (liens Google Maps / Street View)
let activePlaceEl: HTMLElement | null = null   // marqueur dont le popup est ouvert
const svCache = new Map<string, boolean>()     // cache « Street View dispo ? » par POI

// Route data (non-reactive: large arrays, only read inside callbacks)
let geometry: Coord[] = []
let alts: (number | null)[] = []
let cumDistM: number[] = []
let climbs: Climb[] = []
let turns: TurnPoint[] = []
let turnsFromBRouter = false
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
let lastTurnReminderMs = 0   // timestamp of the last repeated turn cue
let lastOffRouteAlert = 0    // timestamp of the last off-route buzz
// Virage en cours d'annonce (dans la zone d'alerte) : la répétition du son est
// cadencée par un timer dédié (turnRepeatId) et non par les fixes GPS, sinon
// l'intervalle réel serait plafonné par la fréquence du GPS (souvent plusieurs
// secondes) au lieu de suivre la préférence turn_repeat_ms.
let activeTurn: { kind: Maneuver; direction: 'left' | 'right' } | null = null
let turnRepeatId: number | null = null

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
// Pendant un col, la carte est rétrécie (classe nav-map--climbing) pour libérer le
// bas de l'écran à la carte du col : la flèche reste donc dans la carte visible sans
// qu'on ait à décaler la caméra. On signale juste le rétrécissement à MapLibre.
const isClimbing = computed(() => climbInfo.value != null)
// Quand on entre/sort d'un col, la carte change de taille (CSS) : on attend le
// reflow puis on prévient MapLibre et on rafraîchit la hauteur mise en cache, sinon
// le canvas garde ses anciennes dimensions et la vue paraît étirée.
watch(isClimbing, () => {
  nextTick(() => {
    if (!map) return
    map.resize()
    refreshContainerH()
    if (following.value) startAnimation()  // recadre la flèche dans la carte redimensionnée
  })
})

// Économie de batterie : la boucle d'animation s'auto-termine dès que tout est
// stabilisé (immobile / cap convergé) et se relance au prochain fix.
// On la plafonne au FPS configuré dans le profil et on met la hauteur du conteneur
// en cache pour éviter un reflow par frame.
const BEARING_EPS = 0.1                // ° — en dessous, le cap est « convergé »
// Intervalle minimum entre deux frames, calculé depuis la préférence nav_fps (0,5–60 fps).
const FRAME_MIN_MS = Math.round(1000 / (navPrefs.nav_fps ?? 8))
let containerH = 0                     // hauteur du conteneur carte, rafraîchie au resize
let lastTickT = 0                      // performance.now() de la dernière frame rendue

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
// Les curseurs ajustent la vue en direct (@input). Inclinaison et zoom sont
// réappliqués à chaque frame par la boucle (qui lit camPitch / camZoom) ; on les
// pousse aussi via setPitch/setZoom pour que le changement soit visible
// immédiatement hors suivi. L'inclinaison/le relief sont reportés sur le profil au
// relâchement (@change → persistPitchTerrain) ; le zoom, lui, ne l'est QUE
// manuellement via le bouton dédié (saveZoomToProfile), pour ne pas écraser le
// réglage par défaut par un zoom ponctuel de la séance.

function onPitchInput() {
  if (map) map.setPitch(camPitch.value)
}

function onZoomInput() {
  if (!map) return
  hasInitialZoom = true  // l'utilisateur prend la main sur le zoom
  map.setZoom(camZoom.value)
  // Comme un pinch : le curseur détache la caméra du suivi (le bouton recentrer
  // apparaît). setZoom étant programmatique, on bascule l'état ici à la main.
  following.value = false
  cameraUnlocked.value = true
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
  persistPitchTerrain()
}

// Persiste l'inclinaison et le relief sur le profil. Le zoom n'est PAS capturé ici :
// on réécrit la valeur déjà enregistrée (navPrefs.zoom) pour qu'un réglage
// d'inclinaison ou de relief n'embarque pas le zoom courant de la séance. Le zoom
// n'est reporté que manuellement, via saveZoomToProfile.
function persistPitchTerrain() {
  persistNavCamera(navPrefs.zoom, camPitch.value, terrain3d.value)
}

// Reporte le zoom courant de la navigation sur le profil (bouton dédié du panneau
// caméra). Le zoom ne s'enregistre plus automatiquement au pinch ou au curseur,
// pour ne pas écraser le zoom par défaut du compte par une vue ponctuelle.
function saveZoomToProfile() {
  persistNavCamera(camZoom.value, camPitch.value, terrain3d.value)
  zoomSaved.value = true
  window.setTimeout(() => { zoomSaved.value = false }, 1800)
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await fetchRoute()
    await initMap()
    startTracking()
    // Recherche Overpass des POI du profil (best-effort, non bloquant) : les
    // marqueurs apparaissent dès que la réponse arrive, la carte est déjà prête.
    void fetchPlaces()
    turnRepeatId = window.setInterval(tickTurnRepeat, 250)
    requestWakeLock()
    // The screen wake lock and the audio context both need a user gesture to be
    // granted reliably; the page load itself doesn't count, so (re)arm them on the
    // first touch/click anywhere on the page.
    //
    // Au lancement depuis la liste (clic sur un lien), Chrome propage la « user
    // activation » à la nouvelle page : l'AudioContext démarre « running » et le
    // son marche d'emblée. Au rafraîchissement, aucune activation n'est propagée :
    // il faut un vrai geste. Or le canvas MapLibre recouvre tout l'écran (.nav-map
    // inset:0) et avale les pointerdown avant qu'ils n'atteignent window en phase
    // bubbling — d'où un déverrouillage qui ne se déclenchait jamais au tap. On
    // écoute donc en phase CAPTURE (avant MapLibre) et on ajoute touchstart, le
    // plus fiable sur mobile.
    window.addEventListener('pointerdown', onFirstGesture, true)
    window.addEventListener('touchstart', onFirstGesture, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId)
  if (turnRepeatId != null) { clearInterval(turnRepeatId); turnRepeatId = null }
  stopAnimation()
  window.removeEventListener('pointerdown', onFirstGesture, true)
  window.removeEventListener('touchstart', onFirstGesture, true)
  window.removeEventListener('resize', refreshContainerH)
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
  turnsFromBRouter = hints.length > 0
  console.log('turns from brouter:', turnsFromBRouter)
  turns = turnsFromBRouter
    ? turnsFromVoiceHints(hints, geometry, cumDistM)
    : detectTurns(geometry, cumDistM)
  remainingM.value = cumDistM[cumDistM.length - 1] || 0
  remainingGainM.value = computeGainLoss(geometry).gain
}

// ─── Points d'intérêt (POI du profil) ─────────────────────────────────────────
// Pose autour du tracé les cimetières / boulangeries cochés dans le profil, comme
// le créateur d'itinéraire. Mêmes catégories, même rayon (points_of_interest) et
// même rendu de marqueur. Best-effort : un échec Overpass est silencieux, les POI
// ne sont qu'un complément à la navigation.
interface NavPlace { name: string; type: string; lng: number; lat: number }

async function fetchPlaces() {
  const poi = userPreferences().points_of_interest
  const types: string[] = []
  if (poi.show_cemeteries) types.push('cemeteries')
  if (poi.show_bakeries) types.push('bakeries')
  if (types.length === 0 || geometry.length < 2) return

  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity
  for (const [lng, lat] of geometry) {
    if (lat < south) south = lat
    if (lat > north) north = lat
    if (lng < west) west = lng
    if (lng > east) east = lng
  }
  // La bbox doit englober le rayon de détection, sinon les POI au-delà de ~2 km
  // ne seraient pas remontés par Overpass.
  const radiusM = poi.radius_m
  const BUFFER = Math.max(0.02, (radiusM + 200) / 111000)
  south -= BUFFER; north += BUFFER; west -= BUFFER; east += BUFFER

  try {
    const res = await fetch(`/api/geocode/places?south=${south}&west=${west}&north=${north}&east=${east}&types=${types.join(',')}`)
    if (!res.ok) return
    const nodes = await res.json()

    const seen = new Set<string>()
    const places: NavPlace[] = []
    for (const node of nodes) {
      if (node.type !== 'cemetery' && node.type !== 'bakery') continue
      const key = `${node.type}:${node.lat.toFixed(3)}:${node.lng.toFixed(3)}`
      if (seen.has(key)) continue
      // Filtre par le rayon configurable : distance du POI au point le plus proche du tracé.
      let minD = Infinity
      for (let i = 0; i < geometry.length; i++) {
        const d = haversine(geometry[i], [node.lng, node.lat])
        if (d < minD) minD = d
      }
      if (minD > radiusM) continue
      seen.add(key)
      places.push({ name: node.name, type: node.type, lng: node.lng, lat: node.lat })
    }
    installPlaceMarkers(places)
  } catch { /* réseau / serveur Overpass — silencieux */ }
}

// Marqueur HTML persistant par POI (même look que le créateur). Les marqueurs
// MapLibre sont des overlays DOM, ils survivent à un setStyle — pas besoin de les
// réinstaller au changement de fond de carte.
function installPlaceMarkers(places: NavPlace[]) {
  if (!map || !maplibre) return
  closePlacePopup()
  for (const m of placeMarkers) m.remove()
  placeMarkers = []
  for (const place of places) {
    const el = document.createElement('div')
    const icon = place.type === 'cemetery' ? 'fa-cross' : 'fa-bread-slice'
    el.className = `place-marker place-marker--${place.type}`
    el.title = place.name
    el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`
    // Clic = popup Google Maps / Street View. stopPropagation pour ne pas
    // déclencher la mise en veille (tap carte) ni un déplacement de carte.
    el.addEventListener('click', (ev) => { ev.stopPropagation(); showPlacePopup(place, el) })
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    const marker = new maplibre.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([place.lng, place.lat])
      .addTo(map)
    placeMarkers.push(marker)
  }
}

// Popup proposant d'ouvrir le POI sur Google Maps et en Street View — repris du
// créateur d'itinéraire (même format d'URL `maps?q=lat,lng`). Le lien Street View
// est grisé quand aucune imagerie n'est disponible à proximité.
function showPlacePopup(place: NavPlace, el: HTMLElement) {
  if (!maplibre || !map) return
  closePlacePopup()
  // Décalage de ~15 m : centrée pile sur le lieu, l'épingle rouge de Google masque
  // le POI. On vise juste à côté pour le laisser visible/cliquable.
  const OFFSET = 0.00008
  const mapsUrl = `https://www.google.com/maps?q=${place.lat + OFFSET},${place.lng + OFFSET}`
  const svUrl = `https://www.google.com/maps?q=&layer=c&cbll=${place.lat},${place.lng}`
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(place.name)}</span>
      <button type="button" class="place-popup-close" aria-label="Fermer">×</button>
    </div>
    <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.street_view'))}</span>
    </a>`
  // closeOnClick désactivé : un tap carte met l'écran en veille ; la fermeture du
  // popup sur tap carte est gérée explicitement dans le handler de clic de la carte.
  placePopup = new maplibre.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([place.lng, place.lat])
    .setDOMContent(wrap)
    .addTo(map)
  // Remplit le marqueur tant que son popup est ouvert.
  activePlaceEl = el
  el.classList.add('place-marker--active')
  wrap.querySelector('.place-popup-close')?.addEventListener('click', closePlacePopup)
  const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
  if (svLink) {
    checkSV(place.lat, place.lng).then((ok) => {
      svLink.classList.toggle('place-popup-link--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
}

// Ferme le popup de POI et retire le surlignage « actif » de son marqueur.
function closePlacePopup() {
  if (placePopup) { placePopup.remove(); placePopup = null }
  if (activePlaceEl) { activePlaceEl.classList.remove('place-marker--active'); activePlaceEl = null }
}

function escapeHtml(s: string) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

// Interroge le service d'imagerie Google : true si une vue Street View existe près
// du point. Repris du créateur (JSONP best-effort, repli optimiste sur erreur/timeout).
function svCacheKey(lat: number, lng: number) { return `${lat.toFixed(4)},${lng.toFixed(4)}` }

function checkSV(lat: number, lng: number): Promise<boolean> {
  const key = svCacheKey(lat, lng)
  if (svCache.has(key)) return Promise.resolve(svCache.get(key)!)
  return new Promise<boolean>((resolve) => {
    const cb = `_sv${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    const s = document.createElement('script')
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return; settled = true
      clearTimeout(timer); delete (window as any)[cb]; s.remove()
      svCache.set(key, v); resolve(v)
    }
    const timer = setTimeout(() => finish(true), 4000)
    ;(window as any)[cb] = (d: any) => finish(Array.isArray(d?.[1]) && d[1].length > 0)
    s.src = `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lng}!2d50!3m18!2m2!1sen!2sUS!9m1!1e2!11m12!1m3!1e2!2b1!3e2!1m3!1e3!2b1!3e2!1m3!1e10!2b1!3e2!4m6!1e1!1e2!1e3!1e4!1e8!1e6&callback=${cb}`
    s.onerror = () => finish(true)
    document.head.appendChild(s)
  })
}

// ─── Map ──────────────────────────────────────────────────────────────────────

function refreshContainerH() { containerH = map?.getContainer()?.clientHeight || 0 }

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
  // Met la hauteur du conteneur en cache : la boucle la lisait chaque frame via
  // clientHeight, ce qui force un reflow de layout synchrone. On ne la rafraîchit
  // qu'au redimensionnement (carte et fenêtre).
  map.on('resize', refreshContainerH)
  map.on('load', refreshContainerH)
  window.addEventListener('resize', refreshContainerH)
  // The user took manual control of the map → stop auto-following AND treat it as
  // a deliberate unlock (so the view won't snap back on the next turn) — moving the
  // map by hand means they want to study it. Guard on `originalEvent`: our own
  // follow animations change the bearing and fire `rotatestart` programmatically
  // (no originalEvent), and must NOT disable it — that bug forced the rider to keep
  // tapping "recenter".
  const onManualMove = (e: any) => { if (e.originalEvent) { following.value = false; cameraUnlocked.value = true } }
  map.on('dragstart', onManualMove)
  map.on('rotatestart', onManualMove)
  // Un zoom manuel (pinch / molette) détache lui aussi la caméra du suivi : le
  // bouton recentrer apparaît et rétablira le zoom du profil. Les zooms
  // programmatiques de la boucle (jumpTo) n'ont pas d'originalEvent → ignorés.
  map.on('zoomstart', onManualMove)
  // Garde camZoom (et donc le curseur du panneau caméra) aligné sur un pinch
  // manuel. Pas d'arrondi : la boucle réapplique camZoom à chaque frame, donc une
  // valeur arrondie ferait « sauter » le zoom au pas de 0,5 pendant le pinch.
  map.on('zoom', (e: any) => { if (e.originalEvent) camZoom.value = map.getZoom() })
  // Tap simple sur la carte → mode veille (la boucle rAF s'arrête, le wake lock est libéré).
  // L'overlay noir capte le tap de réveil ; pas de conflit car il est au z-index 20.
  map.on('click', () => {
    // Un popup POI ouvert : le tap carte ne fait que le fermer (pas de mise en veille).
    if (placePopup) { closePlacePopup(); return }
    if (!screenOff.value) toggleScreenOff()
  })

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

  map.addLayer({ id: 'nav-route-border', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { ...ROUTE_BORDER_PAINT, 'line-width': ROUTE_BORDER_WIDTH } })
  map.addLayer({ id: 'nav-route-done', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#9ca3af', 'line-width': ROUTE_LINE_WIDTH } })
  map.addLayer({ id: 'nav-route-remaining', type: 'line', source: 'nav-remaining', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#7c3aed', 'line-width': ROUTE_LINE_WIDTH } })

  if (turnsFromBRouter && turns.length) {
    if (!map.hasImage('nav-turn-arrow')) map.addImage('nav-turn-arrow', createArrowImage(), { pixelRatio: ARROW_SCALE })
    const features = turns.map((tp) => {
      let b = tp.idx + 1
      while (b < geometry.length - 1 && cumDistM[b] - cumDistM[tp.idx] < 18) b++
      const bearing = bearingBetween(geometry[tp.idx], geometry[b])
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [geometry[tp.idx][0], geometry[tp.idx][1]] },
        properties: { bearing, kind: tp.kind, exitNumber: tp.exitNumber ?? 0 },
      }
    })
    map.addSource('nav-turns', { type: 'geojson', data: { type: 'FeatureCollection' as const, features } })
    map.addLayer({
      id: 'nav-turns-dots',
      type: 'circle',
      source: 'nav-turns',
      paint: {
        'circle-radius': TURN_MARKER_SIZE,
        'circle-color': '#f97316',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    })
    // Flèche directionnelle pour les virages normaux
    map.addLayer({
      id: 'nav-turns-arrows',
      type: 'symbol',
      source: 'nav-turns',
      filter: ['!=', ['get', 'kind'], 'roundabout'],
      layout: {
        'icon-image': 'nav-turn-arrow',
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // Proportionnelle à la pastille, un poil plus petite pour tenir dans le cercle.
        'icon-size': TURN_MARKER_SIZE / 15,
      },
    })
    // Numéro de sortie pour les ronds-points
    map.addLayer({
      id: 'nav-turns-exit',
      type: 'symbol',
      source: 'nav-turns',
      filter: ['==', ['get', 'kind'], 'roundabout'],
      layout: {
        'text-field': ['to-string', ['get', 'exitNumber']],
        // Proportionnel à la pastille (13 px = taille par défaut, rayon 11).
        'text-size': TURN_MARKER_SIZE / 11 * 13,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#f97316',
        'text-halo-width': 1,
      },
    })
  }
}

// Suréchantillonnage de l'image de flèche : on dessine le tracé vectoriel sur un
// canvas ARROW_SCALE× plus grand et on l'enregistre avec pixelRatio = ARROW_SCALE.
// La taille logique reste 22 px (donc icon-size inchangé) mais le bitmap reste net
// quand la pastille — et donc la flèche — est agrandie.
const ARROW_SCALE = 32

function createArrowImage(): ImageData {
  const base = 22
  const size = base * ARROW_SCALE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.scale(ARROW_SCALE, ARROW_SCALE)
  ctx.fillStyle = 'white'
  ctx.beginPath()
  ctx.moveTo(base / 2, 1)        // pointe haute
  ctx.lineTo(base - 2, base - 2) // coin bas droit
  ctx.lineTo(base / 2, base - 7) // encoche basse
  ctx.lineTo(2, base - 2)        // coin bas gauche
  ctx.closePath()
  ctx.fill()
  return ctx.getImageData(0, 0, size, size)
}

function lineFeature(coords: number[][]) {
  return { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} }
}

function setMapStyle(id: string) {
  if (!map || id === mapStyleId.value) return
  mapStyleId.value = id
  persistDefaultMapStyle(id as any)
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
    // maximumAge 1 s : autorise la réutilisation d'un point récent au lieu d'imposer
    // un calcul GNSS frais à chaque rappel. Le dead-reckoning (MAX_EXTRAP_S) masque la
    // latence ; les fixes arrivent déjà à ~1 Hz, donc le débit effectif est préservé.
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
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
  const h = containerH || map?.getContainer()?.clientHeight || 0
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

// Camera padding: a fixed top inset keeps the look-ahead constant. The climb card
// no longer overlaps the map (the map is shrunk while climbing), so no bottom lift.
function followPadding(h: number): { top: number; bottom: number; left: number; right: number } {
  return { top: Math.round(h * 0.45), bottom: 0, left: 0, right: 0 }
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
  if (rafId != null || !map || introPending || screenOff.value) return
  const tick = () => {
    // Plafond FPS : une frame trop rapprochée se contente de se reprogrammer.
    // Elle ne doit JAMAIS terminer la boucle (on n'a pas calculé `idle` sans le corps).
    const now = performance.now()
    if (now - lastTickT < FRAME_MIN_MS) { rafId = requestAnimationFrame(tick); return }
    lastTickT = now
    if (!anchorPos) { rafId = requestAnimationFrame(tick); return }
    const dt = Math.min((now - anchorTime) / 1000, MAX_EXTRAP_S)
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

    // Économie de batterie : on arrête la boucle dès que ses deux sorties ont atteint
    // leur valeur finale — position (immobile ou extrapolation plafonnée) et cap convergé.
    // Le prochain fix GPS rappelle startAnimation() et relance la boucle (garde rafId != null).
    const posSettled = extrapSpeedMs <= MIN_SPEED_MS || dt >= MAX_EXTRAP_S
    const bearingSettled = Math.abs(d) < BEARING_EPS
    const h = containerH
    const idle = posSettled && bearingSettled

    // Sur la frame terminale on fige exactement sur la cible (l'easing n'y arrive jamais).
    displayBearing = idle ? extrapBearing : displayBearing + d * BEARING_SMOOTH
    updateLocationMarker(pos)
    if (locationMarker) locationMarker.setRotation(displayBearing)
    if (following.value) {
      map.jumpTo({ center: pos, bearing: displayBearing, zoom: camZoom.value, pitch: camPitch.value, padding: followPadding(h) })
    }

    if (idle) { rafId = null; return }   // arrêt ; le prochain fix relance la boucle
    rafId = requestAnimationFrame(tick)
  }
  lastTickT = 0   // la première frame après (re)lancement s'exécute sans attendre le plafond
  rafId = requestAnimationFrame(tick)
}

function stopAnimation() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
}

// Track the next turn ahead: announce it once within TURN_ALERT_M (and re-orient
// the view), and surface a visual hint within TURN_HINT_M. Returns true on the
// frame a turn alert fires.
function updateTurns(): boolean {
  if (!turns.length) { turnHint.value = null; activeTurn = null; return false }
  const here = snapDistAlongM
  while (nextTurnPtr < turns.length && turns[nextTurnPtr].distM < here - 5) nextTurnPtr++
  const turn = turns[nextTurnPtr]
  if (!turn) { turnHint.value = null; activeTurn = null; return false }
  const dist = turn.distM - here

  turnHint.value = dist <= TURN_HINT_M && dist > -5
    ? { direction: turn.direction, distM: dist, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber }
    : null

  if (dist <= TURN_ALERT_M && dist > -5) {
    // Le virage est dans la zone d'alerte : on l'arme pour la répétition cadencée
    // par le timer (tickTurnRepeat), indépendante de la fréquence des fixes GPS.
    activeTurn = { kind: turn.kind, direction: turn.direction }
    if (announcedTurn !== nextTurnPtr) {
      announcedTurn = nextTurnPtr
      lastTurnReminderMs = Date.now()
      if (soundOn.value) playManeuver(turn.kind, turn.direction)
      return true
    }
  } else {
    // Hors zone d'alerte (pas encore assez proche, ou virage franchi) : on coupe
    // la répétition jusqu'au prochain virage.
    activeTurn = null
  }
  return false
}

// Répétition du son de virage, cadencée à turn_repeat_ms et non aux fixes GPS.
// Un poll court (250 ms) suffit : la préférence est plafonnée à 500 ms mini.
function tickTurnRepeat() {
  if (!activeTurn || !soundOn.value) return
  const now = Date.now()
  if (now - lastTurnReminderMs >= TURN_REPEAT_MS) {
    lastTurnReminderMs = now
    playManeuver(activeTurn.kind, activeTurn.direction)
  }
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
      areaD: profileAreaD,
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
let profileAreaD = ''   // filled area path of the whole profile (greyed for the done section)
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
  // Filled area under the whole altitude line — reused (clipped) for the grey done overlay.
  profileAreaD = `M${profilePts[0].x},100`
  for (const p of profilePts) profileAreaD += ` L${p.x},${p.y}`
  profileAreaD += ` L${profilePts[profilePts.length - 1].x},100 Z`
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

function recenter() {
  following.value = true
  cameraUnlocked.value = false
  // Rétablit le zoom PAR DÉFAUT du profil (et non le zoom courant de la séance) :
  // la boucle réapplique camZoom à chaque frame, donc le remettre ici suffit à
  // figer la vue au zoom du compte.
  camZoom.value = navPrefs.zoom
  if (!lastPos) return
  // Pause the loop so it doesn't jump-cancel the glide back; re-center, re-orient,
  // restore the 3D tilt AND the profile zoom, then hand the camera back to the loop
  // once we're settled over the rider.
  stopAnimation()
  displayBearing = currentBearing
  // Recentrer sur l'ancre affichée (snappée sur le tracé si on est dessus) pour que
  // caméra et flèche coïncident — la boucle recentre déjà sur la position affichée.
  const opts = followOptions(anchorPos ?? lastPos)
  opts.zoom = navPrefs.zoom   // followOptions n'ajoute le zoom qu'au tout premier cadrage
  map.easeTo(opts)
  map.once('moveend', startAnimation)
}

// ─── Screen-off / battery saver ───────────────────────────────────────────────
// Stops the rAF loop (no more WebGL/tile rendering) and shows a black screen.
// The wake lock stays active so l'écran reste allumé et les indicateurs de virage restent visibles.
// GPS and turn detection keep running via onPosition() — sounds still fire.
// Tapping the black overlay (or pressing the button again) resumes everything.

function toggleScreenOff() {
  screenOff.value = !screenOff.value
  if (screenOff.value) {
    stopAnimation()
  } else {
    if (located) startAnimation()
  }
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
    <div ref="mapEl" class="nav-map" :class="{ 'nav-map--climbing': isClimbing }"></div>

    <!-- Battery saver: black screen — GPS and turn sounds still active -->
    <div v-if="screenOff" class="nav-screen-off" @click="toggleScreenOff">
      <div v-if="hasFix" class="nav-speed shadow">
        <span class="nav-speed-value">{{ speedKmh.toFixed(1) }}</span>
        <span class="nav-speed-unit">km/h</span>
      </div>
      <div v-if="turnHint && hasFix && !offRoute" class="nav-turn-sleep shadow" :class="{ 'nav-turn-sleep--urgent': turnHint.distM <= TURN_URGENT_M, 'nav-turn-sleep--climb': climbInfo }">
        <div class="nav-turn-sleep-icons">
          <i v-if="turnHint.distM <= TURN_URGENT_M" class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <i class="fa-solid" :class="turnIcon(turnHint)" aria-hidden="true"></i>
          <span v-if="turnHint.kind === 'roundabout' && turnHint.exitNumber" class="nav-turn-sleep-exit">{{ turnHint.exitNumber }}</span>
        </div>
        <span class="nav-turn-sleep-dist">{{ formatDistanceShort(turnHint.distM) }}</span>
        <span class="visually-hidden">{{ turnHint.direction === 'right' ? t('routes.turn_right') : t('routes.turn_left') }}</span>
      </div>
      <div class="nav-screen-off-hint">
        <i class="fa-solid fa-eye me-2" aria-hidden="true"></i>{{ t('routes.tap_to_resume') }}
      </div>
    </div>

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
    </div>
    <div class="nav-top-right">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="setMapStyle" />
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
              @change="persistPitchTerrain"
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
            />
            <span class="nav-cam-val">{{ camZoom.toFixed(1) }}</span>
          </label>
          <button
            v-if="loggedIn"
            type="button"
            class="nav-cam-savezoom"
            :class="{ 'nav-cam-savezoom--done': zoomSaved }"
            @click="saveZoomToProfile"
          >
            <i class="fa-solid" :class="zoomSaved ? 'fa-check' : 'fa-floppy-disk'" aria-hidden="true"></i>
            {{ zoomSaved ? t('routes.camera_zoom_saved') : t('routes.camera_save_zoom') }}
          </button>
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

    <!-- Instantaneous speed -->
    <div v-if="hasFix" class="nav-speed shadow">
      <span class="nav-speed-value">{{ speedKmh.toFixed(1) }}</span>
      <span class="nav-speed-unit">km/h</span>
    </div>

    <!-- Upcoming turn indicator -->
    <div v-if="turnHint && hasFix && !offRoute" class="nav-turn shadow" :class="{ 'nav-turn--urgent': turnHint.distM <= TURN_URGENT_M }">
      <i v-if="turnHint.distM <= TURN_URGENT_M" class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>
      <i class="fa-solid" :class="turnIcon(turnHint)" aria-hidden="true"></i>
      <span v-if="turnHint.kind === 'roundabout' && turnHint.exitNumber" class="nav-turn-exit">{{ turnHint.exitNumber }}</span>
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

    <!-- Climb card: full graded elevation profile with a position cursor.
         Reste visible (au-dessus du voile noir) en mode veille ; un tap réveille. -->
    <div
      v-if="climbInfo"
      class="nav-climb shadow"
      :class="{ 'nav-climb--sleep': screenOff }"
      @click="screenOff && toggleScreenOff()"
    >
      <div class="d-flex align-items-center justify-content-between mb-1">
        <span class="fw-semibold">
          <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
        </span>
        <span class="d-flex align-items-center gap-2">
          <!-- Distance restante du col, mise en avant. -->
          <span class="nav-climb-remaining-dist">{{ formatDistancePrecise(climbInfo.climb.lengthM * (1 - climbInfo.ratio)) }}</span>
          <span class="nav-climb-grade" :style="{ background: climbInfo.gradeColor, color: climbInfo.gradeText }">{{ Math.round(climbInfo.grade) }} %</span>
        </span>
      </div>
      <div class="nav-climb-graph">
        <svg class="nav-climb-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id="nav-climb-done-clip">
              <rect x="0" y="0" :width="climbInfo.posX" height="100" />
            </clipPath>
          </defs>
          <path v-for="(seg, i) in climbInfo.segments" :key="i" :d="seg.d" :fill="seg.color" />
          <!-- Done section: the profile redrawn in a flat grey, clipped up to the rider. -->
          <path :d="climbInfo.areaD" fill="#9ca3af" clip-path="url(#nav-climb-done-clip)" />
        </svg>
        <div class="nav-climb-cursor" :style="{ left: `${climbInfo.posX}%` }">
          <!-- Remaining vertical gain: from the rider's altitude up to the summit. -->
          <span
            class="nav-climb-remain"
            :style="{ top: `${climbInfo.topY}%`, height: `${Math.max(0, climbInfo.posY - climbInfo.topY)}%` }"
          ></span>
          <span
            class="nav-climb-remain-label"
            :class="{ 'nav-climb-remain-label--left': climbInfo.posX > 50 }"
            :style="{ top: `${(climbInfo.topY + climbInfo.posY) / 2}%` }"
          >
            <span class="nav-climb-remain-gain">+{{ Math.round(climbInfo.remainingGainM) }} m</span>
            <span class="nav-climb-remain-pct">{{ Math.round(climbInfo.ratio * 100) }} %</span>
          </span>
          <span class="nav-climb-dot" :style="{ top: `${climbInfo.posY}%` }"></span>
        </div>
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
  /* Fond visible sous la carte rétrécie pendant un col (autour des panneaux). */
  background: #e9ecef;
  /* svh = smallest visible viewport (browser chrome expanded). The page never
     scrolls, so the chrome stays put and svh matches the visible area exactly —
     unlike dvh, which some mobile browsers mis-compute on first paint and only
     fix after a rotation, leaving the bottom stats bar clipped off-screen. */
  height: 100vh;
  height: 100svh;
  overflow: hidden;
}
.nav-map { position: absolute; inset: 0; }
/* Pendant un col, la carte se rétrécit pour laisser le bas de l'écran à la carte du
   col (bottom: 6.25rem, hauteur ≈ 12rem) : la flèche reste dans la carte visible. */
.nav-map--climbing { bottom: 18.75rem; }

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
  display: flex; flex-direction: column; align-items: flex-end; gap: 0.6rem;
}

/* Larger touch targets: these controls are tapped one-handed on a phone while
   riding. Min dimensions keep the icon-only buttons a comfortable ~3.25rem
   square while the map-style dropdown (which carries a text label on desktop)
   can still grow past it. */
.nav-top-left :deep(.btn),
.nav-top-right :deep(.btn) {
  min-width: 3.25rem; min-height: 3.25rem; padding: 0.5rem 0.75rem;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 1.35rem; border-radius: 0.7rem;
}

/* Small camera-settings popover anchored under its toggle button. The toggle now
   lives in the top-right column, so anchor the panel to the button's right edge to
   keep it from overflowing off the right side of the screen. */
.nav-cam-panel {
  position: absolute; top: calc(100% + 0.4rem); right: 0; left: auto;
  z-index: 5; width: 18rem;
  background: #fff; border-radius: 0.7rem; padding: 0.9rem 1rem;
}
.nav-cam-row {
  display: flex; align-items: center; gap: 0.65rem; margin: 0;
}
.nav-cam-row + .nav-cam-row { margin-top: 0.85rem; }
.nav-cam-label { font-size: 0.95rem; font-weight: 600; color: #495057; width: 5.5rem; }
.nav-cam-row .form-range { flex: 1; margin: 0; height: 1.6rem; }
.nav-cam-val { font-size: 0.95rem; font-weight: 700; width: 3rem; text-align: right; }
/* Bigger thumb so the sliders are easy to drag with a thumb on the road. */
.nav-cam-row .form-range::-webkit-slider-thumb { width: 1.5rem; height: 1.5rem; }
.nav-cam-row .form-range::-moz-range-thumb { width: 1.5rem; height: 1.5rem; }
.nav-cam-row--switch .form-check-input { width: 3rem; height: 1.5rem; }
.nav-cam-savezoom {
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  width: 100%; margin-top: 0.85rem; padding: 0.5rem 0.75rem;
  border: 1px solid #7c3aed; border-radius: 0.5rem;
  background: #fff; color: #7c3aed; font-size: 0.9rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s ease, color 0.12s ease;
}
.nav-cam-savezoom:hover { background: #f3effd; }
.nav-cam-savezoom--done { background: #198754; border-color: #198754; color: #fff; }

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
  font-size: 1.1rem; padding: 0.6rem 1.1rem;
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
.nav-turn-exit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  background: rgba(255,255,255,0.25); font-size: 0.95rem; font-weight: 700;
}
.nav-turn.nav-turn--urgent { background: #f97316; }

.nav-climb {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 6.25rem;
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.6rem 0.85rem;
}
/* Mode veille : la carte du col passe au-dessus du voile noir (z 20). On garde sa
   position par défaut pour laisser l'indice « tap pour reprendre » visible dessous. */
.nav-climb--sleep { z-index: 21; }
.nav-climb-grade {
  font-weight: 700; font-size: 1.1rem; line-height: 1;
  padding: 0.15rem 0.45rem; border-radius: 0.4rem;
}
/* Distance restante du col, mise en avant dans l'en-tête. */
.nav-climb-remaining-dist {
  font-weight: 800; font-size: 1.5rem; line-height: 1; color: #111827;
}
.nav-climb-graph {
  position: relative; height: 145px; width: 100%;
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
  position: absolute; left: 8px; transform: translateY(-50%);
  display: flex; flex-direction: column; align-items: flex-start;
  white-space: nowrap; line-height: 1.1;
  background: rgba(255, 255, 255, 0.9); padding: 0.1rem 0.35rem; border-radius: 0.3rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.nav-climb-remain-gain { font-size: 1.05rem; font-weight: 800; color: #c2410c; }
.nav-climb-remain-pct { font-size: 0.8rem; font-weight: 700; color: #6c757d; }
/* Passé la moitié du graphique, on bascule le label à gauche de la ligne pour
   qu'il ne soit pas coupé par le bord droit. */
.nav-climb-remain-label--left { left: auto; right: 8px; align-items: flex-end; }

.nav-stats {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.7rem 0.85rem;
}
.nav-stat-value { font-size: 1.25rem; font-weight: 700; line-height: 1.1; }
.nav-stat-label { font-size: 0.72rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.02em; }
.nav-progress { height: 0.5rem; border-radius: 999px; }

.nav-screen-off {
  position: absolute; inset: 0; z-index: 20;
  background: #000;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 3rem;
  cursor: pointer;
}
.nav-screen-off-hint {
  position: absolute; bottom: 2.5rem;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.85rem;
}
.nav-turn-sleep {
  display: flex; flex-direction: column; align-items: center; gap: 1rem;
  background: #7c3aed; color: #fff;
  padding: 2.5rem 4rem; border-radius: 1.5rem;
  width: calc(100% - 1.5rem); box-sizing: border-box;
}
.nav-turn-sleep-icons {
  display: flex; align-items: center; gap: 0.75rem;
  font-size: 3.5rem; line-height: 1;
}
.nav-turn-sleep-dist { font-size: 2.25rem; font-weight: 700; line-height: 1; }
.nav-turn-sleep-exit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.5rem; height: 2.5rem; border-radius: 50%;
  background: rgba(255,255,255,0.25); font-size: 1.6rem; font-weight: 700;
}
.nav-turn-sleep.nav-turn-sleep--urgent { background: #f97316; }
/* Pendant un col en veille, la carte du col occupe le bas : on remonte l'indicateur
   de virage en haut (sous le badge de vitesse) pour qu'il ne soit pas masqué. */
.nav-turn-sleep--climb { position: absolute; top: 3.75rem; left: 50%; transform: translateX(-50%); }
</style>

<style>
.nav-position-arrow {
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
  pointer-events: none;
}

/* Marqueurs POI (cimetières / boulangeries) — même rendu que le créateur d'itinéraire.
   Créés en JS (maplibre.Marker), donc placés dans le bloc de style non-scoped. */
.place-marker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid currentColor;
  box-shadow: 0 3px 8px -2px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  user-select: none;
  transform-origin: bottom center;
  transition: box-shadow 0.1s ease;
}
.place-marker i { font-size: 0.78rem; }
.place-marker:hover { box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.5); }
/* Popup ouvert : le marqueur se remplit de sa couleur, icône en blanc. */
.place-marker--active { background: currentColor; box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.5); }
.place-marker--active i { color: #fff; }
.place-marker--cemetery { color: #6b7280; }
.place-marker--bakery   { color: #b45309; }
@media (max-width: 767px) {
  .place-marker { width: 32px; height: 32px; }
  .place-marker i { font-size: 0.92rem; }
}

/* Popup POI (Google Maps / Street View) — repris du créateur d'itinéraire. */
.place-popup-container .maplibregl-popup-content {
  padding: 4px;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.10);
}
.place-popup { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
.place-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.2rem 0.65rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.07);
  margin-bottom: 2px;
}
.place-popup-name {
  font-size: 0.78rem;
  font-weight: 600;
  color: #6b7280;
  max-width: 14rem;
}
.place-popup-close {
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
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.place-popup-close:hover { background: rgba(0, 0, 0, 0.14); color: #111827; }
.place-popup-link {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.45rem 0.65rem;
  border-radius: 7px;
  font-size: 0.8rem;
  font-weight: 500;
  color: #212529;
  text-decoration: none;
}
.place-popup-link i { width: 14px; text-align: center; flex-shrink: 0; }
.place-popup-link:hover { background: rgba(0, 0, 0, 0.06); color: #212529; text-decoration: none; }
.place-popup-link--disabled { opacity: 0.38; pointer-events: none; cursor: default; }
</style>
