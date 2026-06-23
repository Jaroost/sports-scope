<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor } from '../mapStyles'
import { haversine, bearingBetween } from '../routeHelpers'
import type { LngLat } from '../routeHelpers'
import { moveLngLat } from '../navHelpers'
import { unlockAudio } from '../navAudio'
import RadarOverlay from './RadarOverlay.vue'
import NavScreenOff from './NavScreenOff.vue'
import NavControlsPanel from './NavControlsPanel.vue'
import { userPreferences, persistDefaultMapStyle, isLoggedIn } from '../userPreferences'
import { useNavPois } from '../composables/useNavPois'
import { useScreenWakeLock } from '../composables/useScreenWakeLock'
import { useNavSound } from '../composables/useNavSound'
import { useRadarAlerts } from '../composables/useRadarAlerts'
import {
  useNavCamera, CAM_PITCH_MIN, CAM_PITCH_MAX, CAM_ZOOM_MIN, CAM_ZOOM_MAX,
} from '../composables/useNavCamera'
import { useControlsHide } from '../composables/useControlsHide'
import { useRevealGesture } from '../composables/useRevealGesture'
import { MIN_MOVE_M, MIN_SPEED_MS, MAX_EXTRAP_S, BEARING_SMOOTH, BEARING_EPS } from '../navConstants'

// ─── Mode navigation libre (sans itinéraire) ──────────────────────────────────
// Frère allégé de RouteNavigation.vue : on ne garde que la carte (suivi GPS + caméra
// 3D), la vitesse, les alertes radar (Garmin Varia), la mise en veille et les commandes
// de séance (style de carte, caméra, son, POI « autour de moi »). Aucune notion
// d'itinéraire : pas de tracé, virages, cols, sortie de trajet, distance restante.

// Vue de départ avant le premier fix GPS (centre de la Suisse) — recadrée dès la
// première position reçue.
const DEFAULT_CENTER: LngLat = [8.23, 46.82]
const DEFAULT_ZOOM = 7

// Réglages caméra issus du profil (section Navigation), partagés avec la nav sur itinéraire.
const navPrefs = userPreferences().navigation

const mapEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const gpsError = ref<string | null>(null)
const hasFix = ref(false)
const following = ref(true)
// Posé quand l'utilisateur déplace/zoome la carte à la main : supprime le recentrage
// auto ; le bouton « recentrer » le réarme.
const cameraUnlocked = ref(false)
// Fond de carte gouverné par le profil (comme la nav sur itinéraire) : on part du
// réglage du compte ; le sélecteur ne sert qu'à le changer en séance.
const mapStyleId = ref(navPrefs.default_style as string)

// Son de la séance (alertes radar). Voir useNavSound.
const { soundOn, toggleSound } = useNavSound()

// Réglages caméra (inclinaison / zoom / relief 3D), ajustables en séance et reportés
// sur le profil. onZoomInput détache la caméra du suivi via onManualZoom. Voir useNavCamera.
const {
  camZoom, camPitch, terrain3d, zoomSaved,
  onPitchInput, onZoomInput, applyTerrain, toggleTerrain, persistPitchTerrain, saveZoomToProfile,
} = useNavCamera({ getMap: () => map, onManualZoom })
// Curseur zoom pris en main : on détache la caméra du suivi (état local au composant).
function onManualZoom() {
  hasInitialZoom = true
  following.value = false
  cameraUnlocked.value = true
}
// État d'ouverture du sous-panneau caméra (lié en v-model à NavControlsPanel).
const showCamPanel = ref(false)

// ─── Filtres POI (panneau de séance) ──────────────────────────────────────────
// Même sous-système que la nav sur itinéraire. Sans tracé, on lui passe une géométrie
// vide : les POI ne se chargent que via le bouton « chercher autour de moi », qui
// interroge Overpass autour de la position courante (fetchPlaces({ center })).
const pois = useNavPois({
  getMap: () => map,
  getMaplibre: () => maplibre,
  getGeometry: () => [],
  zoomWidthScale,
})
const { POI_CATS, poiVisible, loading: poiLoading } = pois
const showPoiPanel = ref(false)
// NavControlsPanel exige ces props/refs de débug même quand le panneau débug est masqué
// (debug-mode=false en mode libre) — valeurs neutres.
const showDebugPanel = ref(false)

// Garde l'écran allumé pendant la séance (Screen Wake Lock).
const screenWake = useScreenWakeLock()
const loggedIn = isLoggedIn()
const screenOff = ref(false)

// ─── Auto-masquage des boutons (interface épurée en séance) ────────────────────
// On ne masque pas tant qu'un sous-panneau (caméra / POI) est ouvert. Voir useControlsHide.
const { controlsVisible, armControlsHide, showControls, hideControls } = useControlsHide({
  isPanelOpen: () => showCamPanel.value || showPoiPanel.value,
  closePanels: () => { showCamPanel.value = false; showPoiPanel.value = false },
})

// ─── Geste de révélation (swipe vers le bas depuis le bandeau haut) ────────────
// Swipe → rappelle les boutons ; tap quasi immobile → bascule la veille. Voir useRevealGesture.
const { onRevealDown, onRevealMove, onRevealUp, cancel: cancelReveal } = useRevealGesture({
  onReveal: showControls,
  onTap: () => toggleScreenOffManual(),
  canTap: () => !screenOff.value,
})

// ─── Échelle des POI selon le zoom ─────────────────────────────────────────────
// Même loi que la nav sur itinéraire (base 2 ancrée sur le zoom par défaut), utilisée
// par useNavPois pour mettre les marqueurs à l'échelle.
const WIDTH_REF_ZOOM = navPrefs.zoom ?? 16.5
const WIDTH_MIN_SCALE = 0.4
const WIDTH_MAX_SCALE = 2.4
function zoomWidthScale(z: number): number {
  return Math.min(WIDTH_MAX_SCALE, Math.max(WIDTH_MIN_SCALE, 2 ** (z - WIDTH_REF_ZOOM)))
}

// Vitesse instantanée (km/h), seule statistique affichée en mode libre.
const speedKmh = ref(0)

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null

// Suivi de position
let located = false
let lastPos: LngLat | null = null
let currentBearing = 0
let lastFixTime = 0
let hasInitialZoom = false
// True pendant l'easeTo d'intro (premier fix) : on ne lance pas la boucle rAF tant
// qu'elle tourne (un jumpTo l'interromprait et figerait le zoom d'aperçu).
let introPending = false

// ─── Extrapolation de position (dead-reckoning entre les fixes GPS) ────────────
let rafId: number | null = null
let anchorPos: LngLat | null = null
let anchorTime = 0
let extrapSpeedMs = 0
let extrapBearing = 0
let displayBearing = 0
const FRAME_MIN_MS = Math.round(1000 / (navPrefs.nav_fps ?? 8))
let containerH = 0
let lastTickT = 0

// ─── Radar arrière (Garmin Varia) ─────────────────────────────────────────────
// Connexion/déconnexion + alertes sonores (une par véhicule). Voir useRadarAlerts.
const { radarKnown, toggleRadar } = useRadarAlerts({ soundOn })

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await initMap()
    startTracking()
    screenWake.acquire()
    armControlsHide()
    // Le wake lock et l'AudioContext exigent un geste utilisateur fiable : on (re)tente
    // au premier toucher/clic (en phase capture, avant le canvas MapLibre).
    window.addEventListener('pointerdown', onFirstGesture, true)
    window.addEventListener('touchstart', onFirstGesture, true)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId)
  stopAnimation()
  window.removeEventListener('pointerdown', onFirstGesture, true)
  window.removeEventListener('touchstart', onFirstGesture, true)
  window.removeEventListener('resize', refreshContainerH)
  if (map) { map.remove(); map = null }
})

function onFirstGesture() {
  unlockAudio()
  if (!screenWake.isHeld()) screenWake.acquire()
}

// ─── Map ──────────────────────────────────────────────────────────────────────

function refreshContainerH() { containerH = map?.getContainer()?.clientHeight || 0 }

async function initMap() {
  maplibre = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  map = new maplibre.Map({
    container: mapEl.value,
    style: mapStyleFor(mapStyleId.value) as any,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    pitch: camPitch.value,
    maxPitch: CAM_PITCH_MAX,
    attributionControl: false,
  })
  map.on('styleimagemissing', (e: any) => {
    map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  map.on('resize', refreshContainerH)
  map.on('load', refreshContainerH)
  window.addEventListener('resize', refreshContainerH)
  // Prise de contrôle manuelle de la carte → on arrête le suivi auto (et on le marque
  // comme déverrouillage délibéré). Garde sur originalEvent : nos propres animations de
  // suivi changent le cap par programme (sans originalEvent) et ne doivent pas désactiver.
  const onManualMove = (e: any) => { if (e.originalEvent) { following.value = false; cameraUnlocked.value = true } }
  map.on('dragstart', onManualMove)
  map.on('rotatestart', onManualMove)
  map.on('zoomstart', onManualMove)
  // Garde camZoom aligné sur un pinch manuel (sans arrondi : la boucle réapplique camZoom).
  map.on('zoom', (e: any) => { if (e.originalEvent) camZoom.value = map.getZoom() })
  // Met les marqueurs POI à l'échelle du zoom. Sur 'render' avec garde sur le delta.
  map.on('render', maybeApplyMarkerScale)
  // Tap simple sur la carte → mise en veille (ou ferme un popup POI / le tiroir ouvert).
  map.on('click', () => {
    if (pois.hasOpenPopup()) { pois.closePlacePopup(); return }
    if (controlsVisible.value) { hideControls(); return }
    if (!screenOff.value) toggleScreenOffManual()
  })

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      applyTerrain()
      resolve()
    })
  })
}

function setMapStyle(id: string) {
  if (!map || id === mapStyleId.value) return
  mapStyleId.value = id
  persistDefaultMapStyle(id as any)
  map.setStyle(mapStyleFor(id), { diff: false })
  map.once('style.load', afterStyleLoad)
}

function afterStyleLoad() {
  applyTerrain()
  if (lastPos) updateLocationMarker(lastPos)
}

// Met les POI à l'échelle du zoom (garde sur le delta : robuste quelle que soit
// l'origine du zoom, coût négligeable à zoom constant).
let lastScaleZoom = -1
function maybeApplyMarkerScale() {
  if (!map) return
  const z = map.getZoom()
  if (Math.abs(z - lastScaleZoom) < 0.01) return
  lastScaleZoom = z
  pois.applyPoiScale(z)
}

// ─── GPS tracking ───────────────────────────────────────────────────────────

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

  updateBearing(pos, here)
  updateSpeed(pos, here)

  // Sans tracé, l'ancre est toujours le GPS brut ; la boucle extrapole librement au cap.
  anchorPos = here
  anchorTime = performance.now()
  extrapSpeedMs = speedKmh.value / 3.6
  extrapBearing = currentBearing

  located = true
  lastPos = here

  if (!hasInitialZoom) {
    // Premier fix : intro fluide qui applique aussi le zoom/inclinaison du profil une
    // fois, puis la boucle rAF prend la main sur la caméra.
    updateLocationMarker(here)
    if (locationMarker) locationMarker.setRotation(currentBearing)
    displayBearing = currentBearing
    introPending = true
    map.easeTo(followOptions(here))
    map.once('moveend', () => { introPending = false; startAnimation() })
  } else {
    startAnimation()
  }
}

// Cadrage caméra du suivi : la position est ancrée au tiers inférieur de l'écran (via
// padding) pour garder une distance d'anticipation constante ; inclinaison et zoom
// viennent du profil.
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

function followPadding(h: number): { top: number; bottom: number; left: number; right: number } {
  return { top: Math.round(h * 0.45), bottom: 0, left: 0, right: 0 }
}

// Boucle de rendu : entre deux fixes GPS, on avance la position depuis le dernier fix
// le long du cap à la vitesse portée, et on lisse le cap rendu vers le cap réel. La
// caméra est « sautée » (jumpTo) chaque frame — la fluidité vient de l'extrapolation.
function startAnimation() {
  if (rafId != null || !map || introPending || screenOff.value) return
  const tick = () => {
    const now = performance.now()
    if (now - lastTickT < FRAME_MIN_MS) { rafId = requestAnimationFrame(tick); return }
    lastTickT = now
    if (!anchorPos) { rafId = requestAnimationFrame(tick); return }
    const dt = Math.min((now - anchorTime) / 1000, MAX_EXTRAP_S)
    let pos = anchorPos
    if (extrapSpeedMs > MIN_SPEED_MS) {
      pos = moveLngLat(anchorPos, extrapBearing, extrapSpeedMs * dt)
    }
    let d = extrapBearing - displayBearing
    while (d > 180) d -= 360
    while (d < -180) d += 360

    // Économie de batterie : la boucle s'arrête dès que position et cap sont stabilisés ;
    // le prochain fix GPS la relance.
    const posSettled = extrapSpeedMs <= MIN_SPEED_MS || dt >= MAX_EXTRAP_S
    const bearingSettled = Math.abs(d) < BEARING_EPS
    const h = containerH
    const idle = posSettled && bearingSettled

    displayBearing = idle ? extrapBearing : displayBearing + d * BEARING_SMOOTH
    updateLocationMarker(pos)
    if (locationMarker) locationMarker.setRotation(displayBearing)
    if (following.value) {
      map.jumpTo({ center: pos, bearing: displayBearing, zoom: camZoom.value, pitch: camPitch.value, padding: followPadding(h) })
    }

    if (idle) { rafId = null; return }
    rafId = requestAnimationFrame(tick)
  }
  lastTickT = 0
  rafId = requestAnimationFrame(tick)
}

function stopAnimation() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
}

// Vitesse instantanée (km/h) : on fait confiance à la vitesse GPS si présente, sinon on
// la dérive du déplacement depuis le fix précédent.
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

function updateBearing(pos: GeolocationPosition, here: LngLat) {
  const speed = pos.coords.speed
  const heading = pos.coords.heading
  if (heading != null && !Number.isNaN(heading) && speed != null && speed > MIN_SPEED_MS) {
    currentBearing = heading
  } else if (lastPos) {
    if (haversine(lastPos, here) > MIN_MOVE_M) currentBearing = bearingBetween(lastPos, here)
  }
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
  // Rétablit le zoom PAR DÉFAUT du profil (et non le zoom courant de la séance).
  camZoom.value = navPrefs.zoom
  if (!lastPos) return
  stopAnimation()
  displayBearing = currentBearing
  const opts = followOptions(anchorPos ?? lastPos)
  opts.zoom = navPrefs.zoom
  map.easeTo(opts)
  map.once('moveend', startAnimation)
}

// ─── Screen-off / battery saver ───────────────────────────────────────────────
// Arrête la boucle rAF (plus de rendu WebGL/tuiles) et affiche un écran noir. Le wake
// lock reste actif ; GPS et radar continuent, les alertes sonores aussi.

function toggleScreenOff() {
  screenOff.value = !screenOff.value
  if (screenOff.value) {
    stopAnimation()
  } else {
    if (located) startAnimation()
  }
}

function toggleScreenOffManual() {
  toggleScreenOff()
}
</script>

<template>
  <div class="nav-page">
    <div ref="mapEl" class="nav-map"></div>

    <!-- Mode veille : écran noir — GPS et alertes radar restent actifs. Sans virage ni
         col, NavScreenOff n'affiche que la vitesse. -->
    <NavScreenOff
      v-if="screenOff"
      :turn-hint="null"
      :has-fix="hasFix"
      :off-route="false"
      :climb-info="null"
      :urgent-m="0"
      :speed-kmh="speedKmh"
      @resume="toggleScreenOffManual"
    />

    <div v-if="loading" class="nav-overlay-center text-muted">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.gps_waiting') }}
    </div>
    <div v-else-if="error" class="nav-overlay-center text-danger">
      <i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>{{ error }}
    </div>

    <!-- Zone de swipe (révèle les boutons masqués) -->
    <div
      v-if="!controlsVisible && !screenOff"
      class="nav-reveal-zone"
      @pointerdown="onRevealDown"
      @pointermove="onRevealMove"
      @pointerup="onRevealUp"
      @pointercancel="cancelReveal"
    >
      <span class="nav-reveal-grabber" aria-hidden="true">
        <i class="fa-solid fa-chevron-down"></i>
      </span>
    </div>

    <!-- Panneau de commandes (style de carte, son, radar, caméra, POI). Pas de bouton
         hors-ligne (corridor) ni de panneau débug : debug-mode=false. -->
    <NavControlsPanel
      :controls-visible="controlsVisible"
      :logged-in="loggedIn"
      :debug-mode="false"
      :map-style-id="mapStyleId"
      :sound-on="soundOn"
      :radar-known="radarKnown"
      v-model:cam-pitch="camPitch"
      v-model:cam-zoom="camZoom"
      :terrain3d="terrain3d"
      :zoom-saved="zoomSaved"
      :cam-pitch-min="CAM_PITCH_MIN"
      :cam-pitch-max="CAM_PITCH_MAX"
      :cam-zoom-min="CAM_ZOOM_MIN"
      :cam-zoom-max="CAM_ZOOM_MAX"
      :poi-cats="POI_CATS"
      :poi-visible="poiVisible"
      :poi-loading="poiLoading"
      :dbg-radar="false"
      :dbg-climb="false"
      :dbg-turn-label="null"
      v-model:show-cam-panel="showCamPanel"
      v-model:show-poi-panel="showPoiPanel"
      v-model:show-debug-panel="showDebugPanel"
      @arm-controls-hide="armControlsHide"
      @set-map-style="setMapStyle"
      @toggle-sound="toggleSound"
      @toggle-radar="toggleRadar"
      @pitch-input="onPitchInput"
      @persist-pitch-terrain="persistPitchTerrain"
      @zoom-input="onZoomInput"
      @save-zoom="saveZoomToProfile"
      @toggle-terrain="toggleTerrain"
      @toggle-poi="pois.togglePoi"
      @search-pois="pois.fetchPlaces({ center: lastPos ?? undefined })"
    />

    <!-- Radar arrière (Garmin Varia) — élevé au-dessus du voile de veille pour rester
         visible en mode veille (info de sécurité). En veille, on l'agrandit (expanded) :
         sans indication de virage à afficher, il occupe l'espace libre au centre. -->
    <RadarOverlay :elevated="screenOff" :expanded="screenOff" />

    <!-- GPS banners -->
    <div v-if="gpsError" class="nav-banner nav-banner--warn">
      <i class="fa-solid fa-location-crosshairs me-2" aria-hidden="true"></i>{{ gpsError }}
    </div>
    <div v-else-if="!hasFix && !loading" class="nav-banner nav-banner--info">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.gps_waiting') }}
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

    <!-- Bottom stats : vitesse seule (pas de distance / ETA / progression en mode libre) -->
    <div class="nav-stats nav-stats--free shadow">
      <div class="nav-stat-value">{{ Math.round(speedKmh) }}<span class="nav-stat-unit"> km/h</span></div>
      <div class="nav-stat-label">{{ t('routes.speed') }}</div>
    </div>
  </div>
</template>

<style scoped>
.nav-page {
  position: relative;
  width: 100%;
  background: #e9ecef;
  height: 100vh;
  height: 100svh;
  overflow: hidden;
}
.nav-map { position: absolute; inset: 0; }

.nav-overlay-center {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 5; font-weight: 500;
}

.nav-reveal-zone {
  position: absolute; top: 0; left: 0; right: 0; height: 4.5rem;
  z-index: 6; touch-action: none;
  display: flex; justify-content: center; align-items: flex-start;
}
.nav-reveal-grabber {
  margin-top: 0.35rem;
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.4rem; height: 1.3rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.28); color: #fff; font-size: 0.7rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  animation: nav-reveal-pulse 2.4s ease-in-out infinite;
}
@keyframes nav-reveal-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.7; }
}

.nav-banner {
  position: absolute; top: 0.75rem; left: 50%; transform: translateX(-50%);
  z-index: 3; padding: 0.45rem 0.9rem; border-radius: 999px;
  font-weight: 600; font-size: 0.9rem; white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.nav-banner--warn { background: #fff3cd; color: #664d03; }
.nav-banner--info { background: #cfe2ff; color: #084298; }

.nav-recenter {
  position: absolute; bottom: 8.5rem; right: 0.75rem; z-index: 4;
  border-radius: 999px; font-weight: 600;
  font-size: 1.1rem; padding: 0.6rem 1.1rem;
}

/* Barre du bas réduite à la vitesse (reprend l'allure de NavStatsBar). */
.nav-stats {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.7rem 0.85rem;
}
.nav-stats--free { text-align: center; }
.nav-stat-value { font-size: 1.6rem; font-weight: 700; line-height: 1.1; white-space: nowrap; }
.nav-stat-unit { font-size: 0.8rem; font-weight: 600; color: #6c757d; }
.nav-stat-label { font-size: 0.72rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.02em; }
</style>

<style>
.nav-position-arrow {
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
  pointer-events: none;
  z-index: 3;
}

/* Marqueurs POI — même rendu que la nav sur itinéraire (créés en JS par useNavPois). */
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
  z-index: 1;
}
.place-marker i { font-size: 0.78rem; }
.place-marker:hover,
.place-marker--active { background: currentColor; box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.5); }
.place-marker:hover i,
.place-marker--active i { color: #fff; }
@media (max-width: 767px) {
  .place-marker { width: 32px; height: 32px; }
  .place-marker i { font-size: 0.92rem; }
}

/* Popup POI (Google Maps / Street View) — repris de la nav sur itinéraire. */
.place-popup-container { z-index: 10; }
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
