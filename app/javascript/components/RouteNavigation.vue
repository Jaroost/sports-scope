<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import {
  buildDistancesM, detectClimbs, detectTurns, turnsFromVoiceHints, computeGainLoss,
  haversine, bearingBetween, nearestGeomIndex, projectOnRoute,
  lngLatAtDistanceM, progressFor, activeClimb, gradeForIndex, colorForGrade,
  buildOffsetDisplayLine,
} from '../routeHelpers'
import type { Coord, Climb, LngLat, TurnPoint, VoiceHint, Maneuver } from '../routeHelpers'
import { fetchRouteToPlace, GUIDED_ROUTE_KEY } from '../navRoute'
import {
  textColorOn, moveLngLat, buildClimbProfile, profileYAt, buildDebugClimb,
} from '../navHelpers'
import type { TurnHint, ClimbInfo, ClimbProfile } from '../navHelpers'
import { unlockAudio, playManeuver, playOffRoute } from '../navAudio'
import { vibrateManeuver, vibrateApproach, vibrateOffRoute } from '../navHaptics'
import RadarOverlay from './RadarOverlay.vue'
import NavOfflineButton from './NavOfflineButton.vue'
import NavTurnBanner from './NavTurnBanner.vue'
import NavScreenOff from './NavScreenOff.vue'
import NavClimbCard from './NavClimbCard.vue'
import NavStatsBar from './NavStatsBar.vue'
import NavControlsPanel from './NavControlsPanel.vue'
import NavPlaceSearch from './NavPlaceSearch.vue'
import type { PlaceResult } from '../composables/usePlaceSearch'
import { radarStore } from '../stores/radarStore'
import { userPreferences, persistDefaultMapStyle, isLoggedIn } from '../userPreferences'
import type { Sport } from '../userPreferences'
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
import {
  offlineSupported, hasOfflineArchive, registerOfflineArchive, offlineGrauStyle, OFFLINE_DEFAULTS,
} from '../offline/offlineMaps'

// shareToken : navigation d'un itinéraire sauvegardé (lien partageable).
// sessionRoute : navigation libre vers un lieu — l'itinéraire est lu depuis
// sessionStorage (aucune route serveur), donc shareToken est absent.
const props = defineProps<{ shareToken?: string; sessionRoute?: boolean; canDebug?: boolean }>()

// Réglages caméra issus du profil (section Navigation), indépendants du créateur.
const navPrefs = userPreferences().navigation
const OFF_ROUTE_M = 20          // lateral distance beyond which we warn
const OFF_ROUTE_ACCURACY_CAP = 35  // most we widen the threshold by for a fuzzy GPS fix
// Largeur (px) du tracé sur la carte ; la bordure ajoute 4 px de part et d'autre.
const ROUTE_LINE_WIDTH = navPrefs.line_width ?? 8
const ROUTE_BORDER_WIDTH = ROUTE_LINE_WIDTH + 4
// Couleur et opacité du tracé sur la carte de navigation (réglables dans le profil).
const ROUTE_LINE_COLOR = navPrefs.line_color ?? '#7c3aed'
const ROUTE_LINE_OPACITY = navPrefs.line_opacity ?? 0.8
const TURN_ALERT_M = navPrefs.turn_alert_m
const TURN_HINT_M = navPrefs.turn_hint_m
const TURN_URGENT_M = navPrefs.turn_urgent_m
const TURN_REPEAT_MS = navPrefs.turn_repeat_ms
// Intervalle de répétition plus court une fois le virage proche (zone orange, ≤ turn_urgent_m).
const TURN_REPEAT_URGENT_MS = navPrefs.turn_repeat_urgent_ms
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
// Son de la séance (alertes virage / radar). Voir useNavSound.
const { soundOn, toggleSound } = useNavSound()
// Le fond de carte de navigation est gouverné par le profil (comme le créateur) :
// on part du réglage du compte ; le sélecteur ne sert qu'à le changer en séance.
const mapStyleId = ref(navPrefs.default_style as string)

// ─── Carte hors-ligne (PMTiles swisstopo gris) ────────────────────────────────
// Une archive du corridor a-t-elle été téléchargée pour ce trajet ? Le bouton dédié
// (NavOfflineButton) gère le téléchargement ; ici on ne fait que basculer le fond vers
// la version locale quand le réseau tombe (cf. resolveBaseStyle / refreshBaseMap).
const offlineCoords = ref<[number, number][]>([])
const offlineReady = ref(false)        // archive présente (affichage)
let offlineRegistered = false          // archive branchée sur le protocole pmtiles://
let baseIsOffline = false              // le fond actif est-il la version locale ?

// Réglages caméra (inclinaison / zoom / relief 3D), ajustables en séance et reportés
// sur le profil. La boucle d'animation et followOptions lisent ces refs (et non plus
// navPrefs) pour que toute modification prenne effet à la frame suivante. onZoomInput
// détache la caméra du suivi via onManualZoom. Voir useNavCamera.
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
const showCamPanel = ref(false)

// ─── Filtres POI (panneau de séance) ──────────────────────────────────────────
// Le sous-système POI (recherche Overpass, marqueurs, popup, Street View, mise à
// l'échelle) vit dans useNavPois — il n'a aucun lien avec l'état de navigation. Le
// composable reçoit des accès paresseux à la carte / géométrie (assignées plus bas)
// et la loi d'échelle du tracé pour caler la taille des POI sur celle des virages.
const pois = useNavPois({
  getMap: () => map,
  getMaplibre: () => maplibre,
  getGeometry: () => geometry,
  zoomWidthScale,
})
const { POI_CATS, poiVisible, loading: poiLoading } = pois
const showPoiPanel = ref(false)

// Garde l'écran allumé pendant la séance (Screen Wake Lock). Le composable gère sa
// propre reprise au retour au premier plan et sa libération au démontage.
const screenWake = useScreenWakeLock()
// Le bouton n'a de sens que pour un compte (persistNavCamera est un no-op hors-ligne).
const loggedIn = isLoggedIn()
const screenOff = ref(false)

// ─── Auto-masquage des boutons (interface épurée en séance) ────────────────────
// Les commandes (retour, style de carte, son, radar, caméra, POI) encombrent la
// vue une fois la séance lancée. On les affiche au démarrage (découvrabilité) puis
// on les estompe après quelques secondes d'inactivité ; un swipe vers le bas depuis
// le haut de l'écran les rappelle (le tap simple reste dédié à la mise en veille).
// On ne masque pas tant qu'un sous-panneau (caméra / POI / débug) est ouvert. Voir
// useControlsHide.
const { controlsVisible, armControlsHide, showControls, hideControls } = useControlsHide({
  isPanelOpen: () => showCamPanel.value || showPoiPanel.value || showDebugPanel.value,
  closePanels: () => { showCamPanel.value = false; showPoiPanel.value = false; showDebugPanel.value = false },
})

// ─── Geste de révélation (swipe vers le bas depuis le bandeau haut) ────────────
// Swipe → rappelle les boutons ; tap quasi immobile → bascule la veille. Voir useRevealGesture.
const { onRevealDown, onRevealMove, onRevealUp, cancel: cancelReveal } = useRevealGesture({
  onReveal: showControls,
  onTap: () => toggleScreenOffManual(),
  canTap: () => !screenOff.value,
})

// ─── Échelle largeur tracé / pastilles selon le zoom ───────────────────────────
// Tracé et indicateurs de virage doivent se comporter comme un ruban posé au sol :
// épais quand on zoome, fin quand on dézoome (et non l'inverse, ce que donnait une
// largeur fixe en pixels). On suit donc une loi base 2 (chaque niveau de zoom
// double l'échelle, soit une largeur au sol constante), ancrée sur le zoom par
// défaut du profil pour que l'aspect à ce zoom soit identique à l'ancien réglage.
// Les extrêmes sont clampés pour éviter un trait ridicule en zoom max / invisible
// en dézoom total.
const WIDTH_REF_ZOOM = navPrefs.zoom ?? 16.5
const WIDTH_MIN_SCALE = 0.4
const WIDTH_MAX_SCALE = 2.4
function zoomWidthScale(z: number): number {
  return Math.min(WIDTH_MAX_SCALE, Math.max(WIDTH_MIN_SCALE, 2 ** (z - WIDTH_REF_ZOOM)))
}
// Expression MapLibre `line-width` : stops à chaque niveau de zoom entier (clampés
// aux bornes du suivi), interpolés linéairement. MapLibre clampe hors plage sur le
// premier/dernier stop, ce qui borne naturellement la largeur.
// `perFeature` : si vrai, chaque palier est multiplié par la propriété `wscale` de la feature
// (largeur réduite sur les recouvrements). On garde `zoom` en entrée de l'interpolation de plus
// haut niveau — seule forme acceptée par MapLibre pour une expression zoom + data-driven.
function zoomWidthExpr(base: number, perFeature = false): any {
  const stops: any[] = []
  for (let z = CAM_ZOOM_MIN; z <= CAM_ZOOM_MAX; z++) {
    const w = Math.round(base * zoomWidthScale(z) * 100) / 100
    stops.push(z, perFeature ? ['*', w, ['get', 'wscale']] : w)
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops]
}

// Live navigation state (reactive, drives the UI overlays)
const remainingM = ref(0)
const remainingGainM = ref(0)
const doneRatio = ref(0)
const speedKmh = ref(0)
// Vitesse lissée (EMA) dédiée à l'heure d'arrivée : la vitesse instantanée saute
// trop pour une ETA stable, et tomber à 0 à chaque feu rouge la ferait exploser.
// On n'alimente la moyenne qu'en roulant (> ETA_SPEED_FLOOR) pour ignorer les arrêts.
const avgSpeedKmh = ref(0)
const ETA_SMOOTH = 0.05
const ETA_SPEED_FLOOR = 3
const offRoute = ref(false)
const offRouteRelBearing = ref(0)   // on-screen angle of the "back to route" arrow
// Reroutage manuel (bouton du bandeau hors-tracé) : appel BRouter en cours et dernier
// message d'erreur. Voir recalcRoute.
const rerouting = ref(false)
const rerouteError = ref<string | null>(null)
// ─── Navigation vers un lieu choisi sur la carte ───────────────────────────────
// Mode « cible » : on affiche une recherche (recadrage carte) + une consigne, puis un
// tap sur la carte fixe le point de destination ; « Naviguer ici » calcule un
// itinéraire depuis la position GPS et remplace le tracé courant (applyReroute).
const placeNavActive = ref(false)
// Mode recherche (cible) : tant que l'utilisateur cherche un nouveau lieu / itinéraire,
// on neutralise TOUTES les alertes — sons (virage, hors-trace, radar) ET vibrations. Il a
// la tête dans la carte et le clavier, pas sur la route : bipper ou vibrer pour un virage
// du tracé qu'il s'apprête à abandonner ne serait que du bruit parasite.
const alertsMuted = computed(() => placeNavActive.value)
const destPoint = ref<LngLat | null>(null)
const destName = ref('')
const navStarting = ref(false)
const navError = ref<string | null>(null)
let destMarker: any = null
const climbInfo = ref<ClimbInfo | null>(null)
// state : 'far' (lointain, bandeau discret) · 'near' (approche, violet/orange) ·
// 'now' (virage atteint, maintenu en vert quelques secondes comme confirmation).
const turnHint = ref<TurnHint | null>(null)

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let turnMarkers: any[] = []    // marqueurs DOM des indicateurs de virage (au-dessus des POI)

// Route data (non-reactive: large arrays, only read inside callbacks)
let geometry: Coord[] = []
// Polyligne d'AFFICHAGE alignée index-pour-index sur `geometry` : décalée latéralement
// uniquement sur les portions où l'itinéraire se superpose à lui-même, pour différencier
// les deux passages. `geometry` reste la vérité (snapping, distances) ; voir
// buildOffsetDisplayLine. C'est elle qu'on envoie aux sources MapLibre.
let displayLine: LngLat[] = []
// Facteur de largeur par sommet (∈ [0.7, 1]) : abaissé sur les recouvrements pour amincir le
// tracé dédoublé. Piloté côté MapLibre via la propriété `wscale` des features (line-width).
let displayWScale: number[] = []
let alts: (number | null)[] = []
let cumDistM: number[] = []
let climbs: Climb[] = []
let turns: TurnPoint[] = []
let turnsFromBRouter = false
// Voicehints bruts du tracé (lng/lat/cmd/angle) conservés pour reconstruire les virages
// après un reroutage : on ré-épissera ceux du tronçon restant aux hints du détour.
let rawHints: VoiceHint[] = []
// Catégorie d'activité du tracé (Route#activity) → profil BRouter du reroutage.
let routeSport: Sport = 'cycling'
const routeName = ref('')

// Tracking helpers
let lastIdx = 0
let snapPoint: LngLat | null = null   // rider position projected onto the TRUE route (geometry)
let displaySnapPoint: LngLat | null = null  // même position reportée sur la polyligne d'AFFICHAGE (décalée sur les recouvrements) — c'est elle qu'on affiche pour que la flèche colle à SA voie, pas au centre des deux
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
// Virage tout juste atteint, conservé pour le maintenir affiché en vert (confirmation
// « tournez ici » même à l'arrêt à un carrefour). On mémorise sa distance le long du
// tracé : le maintien dure tant qu'on n'a pas parcouru GREEN_HOLD_M après le virage.
let reachedTurn: { direction: 'left' | 'right'; kind: Maneuver; angle: number; exitNumber?: number; distM: number } | null = null
// Horodatage du moment où le virage courant a été atteint : sert à la limite de temps
// du maintien vert (cf. GREEN_HOLD_MS), indépendante de la distance parcourue.
let reachedAtMs = 0
// La confirmation verte (« maintenant ») disparaît au PREMIER des deux seuils atteints :
// distance parcourue après le virage (GREEN_HOLD_M) ou temps écoulé (GREEN_HOLD_MS).
// Les deux sont réglables dans le profil de navigation.
const GREEN_HOLD_M = navPrefs.turn_green_hold_m ?? 100
const GREEN_HOLD_MS = (navPrefs.turn_green_hold_s ?? 10) * 1000
// Vrai quand l'écran a été rallumé AUTOMATIQUEMENT à l'approche d'un virage : on ne
// remet en veille de soi-même que dans ce cas (un réveil manuel reste éveillé).
let autoWoken = false
// Zoom de découverte du prochain virage : quand l'écran sort de veille à l'approche
// d'un virage, on dézoome juste ce qu'il faut pour que ce virage apparaisse à l'écran,
// puis on resserre vers le zoom du profil à mesure qu'on s'en rapproche. null = pas de
// surcharge → la boucle d'animation reprend le zoom du profil (camZoom). On ne descend
// JAMAIS sous camZoom (on ne fait que dézoomer, jamais zoomer au-delà du profil). Voir
// updateRevealZoom.
let revealZoom: number | null = null
// Index (dans `turns` / `turnMarkers`) du virage mis en évidence sur la carte quand
// l'écran sort de veille à son approche, pour qu'on identifie d'un coup d'œil DE QUEL
// virage il s'agit. -1 = aucun. Voir updateTurnSelection.
let selectedTurnIdx = -1
let lastTurnReminderMs = 0   // timestamp of the last repeated turn cue
let lastOffRouteAlert = 0    // timestamp of the last off-route buzz
// Virage en cours d'annonce (dans la zone d'alerte) : la répétition du son est
// cadencée par un timer dédié (turnRepeatId) et non par les fixes GPS, sinon
// l'intervalle réel serait plafonné par la fréquence du GPS (souvent plusieurs
// secondes) au lieu de suivre la préférence turn_repeat_ms.
let activeTurn: { kind: Maneuver; direction: 'left' | 'right' } | null = null
// Vrai quand le virage armé est dans la zone orange (≤ TURN_URGENT_M) : la répétition
// du son passe alors à l'intervalle plus court TURN_REPEAT_URGENT_MS.
let activeTurnUrgent = false
// Pointeur du virage pour lequel le double buzz d'entrée en zone orange a déjà été
// émis : garantit qu'on ne vibre qu'une fois au franchissement du seuil, pas à
// chaque frame tant qu'on reste dans la zone.
let urgentBuzzedTurn = -1
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
// Pendant un col, la carte est rétrécie (classe nav-map--climbing) pour libérer le
// bas de l'écran à la carte du col : la flèche reste donc dans la carte visible sans
// qu'on ait à décaler la caméra. On signale juste le rétrécissement à MapLibre.
// À l'approche d'un virage, la carte de col est masquée (approachingTurn) : la carte
// reprend alors toute la hauteur, donc on ne la rétrécit pas dans ce cas.
// Affichage du profil des cols (carte d'altitude en bas d'écran), basculable depuis
// le tiroir de commandes. Valeur initiale issue du profil (section Navigation) ;
// masqué, la carte n'est plus rétrécie et le bas de l'écran est dégagé.
const showClimbCard = ref(navPrefs.show_climb_card ?? true)
const isClimbing = computed(() => showClimbCard.value && climbInfo.value != null && !approachingTurn.value)
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
// Intervalle minimum entre deux frames, calculé depuis la préférence nav_fps (0,5–60 fps).
const FRAME_MIN_MS = Math.round(1000 / (navPrefs.nav_fps ?? 8))
let containerH = 0                     // hauteur du conteneur carte, rafraîchie au resize
let lastTickT = 0                      // performance.now() de la dernière frame rendue

const donePercent = computed(() => Math.round(doneRatio.value * 100))

// ─── Radar arrière (Garmin Varia) ─────────────────────────────────────────────
// Connexion/déconnexion + alertes sonores (une par véhicule). Voir useRadarAlerts.
const { radarKnown, toggleRadar } = useRadarAlerts({ soundOn, muted: alertsMuted })

// Le bandeau radar (RadarOverlay) occupe le tout-haut de l'écran. Quand il est
// visible, on descend la vitesse/le virage pour ne pas passer dessous. Même
// condition d'affichage que le composant.
const radarBannerVisible = computed(
  () =>
    radarStore.isConnected.value &&
    (navPrefs.radar_always_visible || radarStore.targets.value.length > 0),
)

// Vrai à l'approche d'un virage (bandeau violet/orange « near ») et au virage atteint
// (bandeau vert « now ») : le virage prime alors sur le col, on masque la carte de col
// pour ne pas encombrer l'écran et laisser toute la place à l'indication de direction.
const approachingTurn = computed(
  () =>
    hasFix.value &&
    !offRoute.value &&
    (turnHint.value?.state === 'near' || turnHint.value?.state === 'now'),
)

// ─── Mode débug (preview des overlays) ────────────────────────────────────────
// Réservé aux comptes pouvant tout faire (can? :manage, :all → prop canDebug), ou
// forçable via `?debug=1` dans l'URL. Il révèle un bouton « flacon » dans le tiroir
// de commandes qui ouvre un panneau permettant d'injecter des données factices pour
// prévisualiser, sans GPS / col réel / radar Varia, les trois overlays clés :
//   • le radar arrière (RadarOverlay)
//   • la carte de col (climbInfo)
//   • la notification de virage (turnHint)
// Tant qu'une bascule est active, les mises à jour live (updateTurns / updateProgress)
// ne réécrivent PAS l'overlay correspondant (gardes dbgTurn / dbgClimb), pour qu'un
// vrai fix GPS ne l'efface pas pendant qu'on l'inspecte.
const debugMode = props.canDebug === true || (() => {
  try { return new URLSearchParams(window.location.search).has('debug') } catch { return false }
})()
const showDebugPanel = ref(false)
const dbgRadar = ref(false)
const dbgClimb = ref(false)
const dbgTurn = ref(false)

// Scénarios de virage parcourus en boucle (un clic = scénario suivant, puis « off »).
// Couvre chaque état visuel : lointain (gris), approche (violet), urgent (orange),
// rond-point (numéro de sortie) et virage atteint (vert).
const DBG_TURNS: { label: string; state: 'far' | 'near' | 'now'; kind: Maneuver; direction: 'left' | 'right'; angle: number; distM: number; exitNumber?: number }[] = [
  { label: 'Lointain', state: 'far', kind: 'turn', direction: 'right', angle: 60, distM: 850 },
  { label: 'Approche', state: 'near', kind: 'turn', direction: 'left', angle: -70, distM: 180 },
  { label: 'Urgent', state: 'near', kind: 'sharp', direction: 'right', angle: 110, distM: Math.min(TURN_URGENT_M, 40) },
  { label: 'Rond-point', state: 'near', kind: 'roundabout', direction: 'right', angle: 90, distM: 120, exitNumber: 2 },
  { label: 'Maintenant', state: 'now', kind: 'turn', direction: 'left', angle: -70, distM: 0 },
]
const dbgTurnIdx = ref(0)
// Libellé du scénario de virage débug en cours (null quand off) — passé au tiroir.
const dbgTurnLabel = computed(() => (dbgTurn.value ? DBG_TURNS[dbgTurnIdx.value].label : null))

function cycleDebugTurn() {
  dbgTurnIdx.value = dbgTurn.value ? dbgTurnIdx.value + 1 : 0
  if (dbgTurnIdx.value >= DBG_TURNS.length) {
    dbgTurn.value = false
    turnHint.value = null
    return
  }
  dbgTurn.value = true
  hasFix.value = true
  const p = DBG_TURNS[dbgTurnIdx.value]
  turnHint.value = { direction: p.direction, distM: p.distM, kind: p.kind, angle: p.angle, exitNumber: p.exitNumber, state: p.state }
}

function toggleDebugClimb() {
  if (dbgClimb.value) { dbgClimb.value = false; climbInfo.value = null; return }
  dbgClimb.value = true
  hasFix.value = true
  climbInfo.value = buildDebugClimb()
}

// Radar factice : on passe le store en « connecté » sans Bluetooth (pas de watchdog,
// donc les cibles persistent) et on injecte deux voitures, dont une sous le seuil
// rapproché → bandeau rouge « Attention » + alertes sonores (via le watch existant).
function toggleDebugRadar() {
  if (dbgRadar.value) { dbgRadar.value = false; radarStore.reset(); return }
  dbgRadar.value = true
  radarStore.status.value = 'connected'
  radarStore.setTargets([
    { id: 1, distanceM: 18, speedMps: 9 },
    { id: 2, distanceM: 72, speedMps: 6 },
  ])
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    await fetchRoute()
    await initMap()
    startTracking()
    // Recherche Overpass des POI du profil (best-effort, non bloquant) : les
    // marqueurs apparaissent dès que la réponse arrive, la carte est déjà prête.
    void pois.fetchPlaces()
    turnRepeatId = window.setInterval(tickTurnRepeat, 250)
    screenWake.acquire()
    // Affiche les boutons quelques secondes au lancement puis les estompe.
    armControlsHide()
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
    // Bascule auto vers le fond local quand le réseau tombe (et retour au WMTS au rétablissement).
    window.addEventListener('online', refreshBaseMap)
    window.addEventListener('offline', refreshBaseMap)
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
  window.removeEventListener('online', refreshBaseMap)
  window.removeEventListener('offline', refreshBaseMap)
  window.removeEventListener('resize', refreshContainerH)
  if (map) { map.remove(); map = null }
})

function onFirstGesture() {
  unlockAudio()
  if (!screenWake.isHeld()) screenWake.acquire()
}

// ─── Data ───────────────────────────────────────────────────────────────────

async function fetchRoute() {
  // Mode session (navigation libre vers un lieu) : l'itinéraire a déjà été calculé et
  // déposé dans sessionStorage par FreeNavigation ; on le lit au lieu d'interroger le
  // serveur. Aucune sauvegarde n'est nécessaire (fonctionne pour les visiteurs anonymes).
  const route = props.sessionRoute ? readSessionRoute() : await fetchSharedRoute()
  const geom = (route.geometry || []) as Coord[]
  if (geom.length < 2) throw new Error(t('routes.error_min_points'))
  routeName.value = route.name || ''
  routeSport = (route.activity as Sport) || 'cycling'
  rebuildRouteState(geom, (route.voice_hints || []) as VoiceHint[])
}

async function fetchSharedRoute(): Promise<any> {
  const res = await fetch(`/api/routes/shared/${props.shareToken}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(t('routes.error_routing'))
  const data = await res.json()
  return data.route || data
}

function readSessionRoute(): any {
  try {
    const raw = sessionStorage.getItem(GUIDED_ROUTE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* sessionStorage indisponible / JSON invalide */ }
  throw new Error(t('routes.error_routing'))
}

// Recompute everything derived from `geometry` + raw voicehints: altitudes, distances,
// display line, climbs, turns, totals. Partagé par le chargement initial (fetchRoute) et
// le reroutage (applyReroute), qui remplacent tous deux la géométrie entière.
function rebuildRouteState(newGeometry: Coord[], hints: VoiceHint[]) {
  geometry = newGeometry
  rawHints = hints
  offlineCoords.value = geometry.map(([lng, lat]) => [lng, lat])
  alts = geometry.map((c) => c[2] ?? null)
  cumDistM = buildDistancesM(geometry)
  ;({ line: displayLine, wscale: displayWScale } = buildOffsetDisplayLine(geometry, cumDistM))
  climbs = detectClimbs(alts, cumDistM)
  // Prefer BRouter's turn-by-turn voicehints; fall back to geometric detection
  // for routes saved before voicehints were captured.
  turnsFromBRouter = hints.length > 0
  turns = turnsFromBRouter
    ? turnsFromVoiceHints(hints, geometry, cumDistM)
    : detectTurns(geometry, cumDistM)
  remainingM.value = cumDistM[cumDistM.length - 1] || 0
  remainingGainM.value = computeGainLoss(geometry).gain
}

// ─── Reroutage manuel ───────────────────────────────────────────────────────────
// Hors-tracé, un bouton « Recalculer » appelle BRouter pour tracer un chemin depuis la
// position GPS jusqu'au point du tracé original le plus proche EN AVANT (le raccord),
// puis on épisse ce détour devant la suite inchangée de l'itinéraire planifié. On
// préserve ainsi l'itinéraire choisi à la main (cols, routes) au lieu de le remplacer.

// Raccord visé un peu en avant du sommet retenu, pour ne pas viser un point qu'on
// s'apprête déjà à dépasser.
const REJOIN_LOOKAHEAD_M = 30
// Demi-angle (deg) autour du cap dans lequel un point du tracé est considéré « devant »
// le coureur. Au-delà, le rejoindre imposerait de faire demi-tour.
const REJOIN_FORWARD_ARC = 85
// Distance minimale (m) au point de raccord : on ne raccorde pas juste à côté de soi.
const REJOIN_MIN_AHEAD_M = 40
let rerouteToken = 0

// Sommet du tracé restant où raccorder. On privilégie le sommet le plus proche situé
// DEVANT le coureur (dans l'arc autour de son cap) : BRouter en tire alors un détour qui
// repart vers l'avant, donc continuer tout droit raccroche le tracé plus loin — au lieu
// de raccorder derrière soi (point le plus proche après un virage manqué) et de ressortir
// aussitôt. À défaut de point exploitable devant (cap peu fiable à l'arrêt, ou tracé
// entièrement derrière), on retombe sur le sommet le plus proche depuis la progression.
function rejoinIndexAhead(pos: LngLat, heading: number, fromIdx: number): number {
  let best = -1
  let bestD = Infinity
  for (let i = fromIdx; i < geometry.length; i++) {
    const d = haversine(pos, [geometry[i][0], geometry[i][1]])
    if (d < REJOIN_MIN_AHEAD_M) continue
    let rel = bearingBetween(pos, [geometry[i][0], geometry[i][1]]) - heading
    while (rel > 180) rel -= 360
    while (rel < -180) rel += 360
    if (Math.abs(rel) > REJOIN_FORWARD_ARC) continue
    if (d < bestD) { bestD = d; best = i }
  }
  if (best < 0) {
    best = fromIdx
    bestD = Infinity
    for (let i = fromIdx; i < geometry.length; i++) {
      const d = haversine(pos, [geometry[i][0], geometry[i][1]])
      if (d < bestD) { bestD = d; best = i }
    }
  }
  let j = best
  while (j < geometry.length - 1 && cumDistM[j] - cumDistM[best] < REJOIN_LOOKAHEAD_M) j++
  return j
}

async function recalcRoute() {
  if (rerouting.value || !offRoute.value || !lastPos || geometry.length < 2) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    rerouteError.value = t('routes.reroute_offline')
    return
  }
  rerouting.value = true
  rerouteError.value = null
  const token = ++rerouteToken
  const from = lastPos
  try {
    const fromIdx = Math.max(0, Math.min(lastIdx, geometry.length - 1))
    const rejoinIdx = rejoinIndexAhead(from, currentBearing, fromIdx)
    const target = geometry[rejoinIdx]
    const { geometry: detour, hints: detourHints } = await fetchRouteToPlace(from, [target[0], target[1]], routeSport)
    // Réponse périmée (clic plus récent) ou composant démonté : on n'écrase rien.
    if (token !== rerouteToken) return

    // Épissage : détour (position → raccord) + suite inchangée du tracé original.
    const tail = geometry.slice(rejoinIdx)
    const newGeometry = detour.concat(tail)
    // On ne garde des hints originaux que ceux du tronçon restant : leurs coordonnées
    // (ancrées à l'identique sur les sommets du tracé sauvegardé) existent encore dans
    // `tail`. turnsFromVoiceHints les ré-attache au bon passage du nouveau tracé.
    const tailKeys = new Set(tail.map((c) => `${c[0]},${c[1]}`))
    const tailHints = rawHints.filter((h) => tailKeys.has(`${h.lng},${h.lat}`))
    applyReroute(newGeometry, detourHints.concat(tailHints))
  } catch {
    if (token === rerouteToken) rerouteError.value = t('routes.reroute_failed')
  } finally {
    if (token === rerouteToken) rerouting.value = false
  }
}

// Remplace la géométrie de navigation par l'itinéraire rerouté et réinitialise le suivi.
function applyReroute(newGeometry: Coord[], hints: VoiceHint[]) {
  rebuildRouteState(newGeometry, hints)
  // Force une re-localisation globale au prochain fix (nouvelle géométrie) et repart des
  // premiers virages — les pointeurs de l'ancien tracé n'ont plus de sens.
  located = false
  lastIdx = 0
  snapPoint = null
  displaySnapPoint = null
  snapNextIdx = 0
  snapDistAlongM = 0
  nextTurnPtr = 0
  announcedTurn = -1
  urgentBuzzedTurn = -1
  reachedTurn = null
  activeTurn = null
  turnHint.value = null
  // Recalculé au prochain fix ; remis à faux pour que le bandeau hors-tracé disparaisse.
  offRoute.value = false
  // La progression mémorisée pointe un passage de l'ancien tracé : on l'efface.
  try { localStorage.removeItem(PROGRESS_KEY) } catch { /* quota / private mode */ }
  // Re-render carte : nouvelle polyligne complète + marqueurs de virage.
  const src = map?.getSource('nav-route')
  if (src) src.setData(widthRunsCollection(displayLine, displayWScale))
  refreshRemaining()
  renderTurnMarkers()
}

// ─── Navigation vers un lieu choisi sur la carte ───────────────────────────────

function startPlaceNav() {
  placeNavActive.value = true
  navError.value = null
  // Le tiroir de commandes et la recherche se disputent le haut de l'écran : on
  // referme le tiroir pour laisser la barre de recherche seule en tête.
  hideControls()
}

function cancelPlaceNav() {
  placeNavActive.value = false
  navError.value = null
  destPoint.value = null
  destName.value = ''
  if (destMarker) { destMarker.remove(); destMarker = null }
}

// Recadre la carte sur le lieu recherché (sans fixer de destination) : l'utilisateur
// ajuste ensuite la vue et touche le point exact. Repris de RouteBuilderMap.pickPlace.
function onLocate(p: PlaceResult) {
  destName.value = p.display_name.split(',')[0]
  if (!map) return
  if (p.boundingbox?.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = p.boundingbox.map(parseFloat)
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 800, maxZoom: 14 })
  } else {
    const lat = parseFloat(p.lat), lng = parseFloat(p.lon)
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) map.flyTo({ center: [lng, lat], zoom: 13, duration: 800 })
  }
}

// Pose (ou déplace) le marqueur de destination au point cliqué.
function setDestPoint(lngLat: LngLat) {
  destPoint.value = lngLat
  navError.value = null
  if (!map || !maplibre) return
  if (destMarker) {
    destMarker.setLngLat(lngLat)
  } else {
    const el = document.createElement('div')
    el.className = 'nav-dest-marker'
    el.innerHTML = '<i class="fa-solid fa-location-dot"></i>'
    destMarker = new maplibre.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map)
  }
}

// « Naviguer ici » : itinéraire BRouter depuis la position GPS jusqu'au point choisi,
// qui remplace le tracé courant (applyReroute réinitialise tout le suivi).
async function confirmPlaceNav() {
  if (navStarting.value || !destPoint.value || !lastPos) return
  navStarting.value = true
  navError.value = null
  try {
    const { geometry: geom, hints } = await fetchRouteToPlace(lastPos, destPoint.value, routeSport)
    routeName.value = destName.value || t('routes.destination')
    applyReroute(geom, hints)
    cancelPlaceNav()
    following.value = true
    cameraUnlocked.value = false
  } catch {
    navError.value = t('routes.error_routing')
  } finally {
    navStarting.value = false
  }
}

// ─── Map ──────────────────────────────────────────────────────────────────────

function refreshContainerH() { containerH = map?.getContainer()?.clientHeight || 0 }

async function initMap() {
  maplibre = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  // Branche l'archive hors-ligne du trajet (si déjà téléchargée) AVANT de construire le
  // style, pour pouvoir démarrer directement sur le fond local en cas de lancement
  // sans réseau.
  // Hors-ligne indisponible en mode session (pas de token de trajet à archiver).
  if (props.shareToken && offlineSupported() && await hasOfflineArchive(props.shareToken)) {
    offlineReady.value = true
    try { await registerOfflineArchive(props.shareToken, maplibre); offlineRegistered = true } catch { /* archive illisible : on reste en ligne */ }
  }
  baseIsOffline = wantOffline()

  const coords = geometry.map(([lng, lat]) => [lng, lat] as LngLat)
  map = new maplibre.Map({
    container: mapEl.value,
    style: resolveBaseStyle(mapStyleId.value) as any,
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
  // Met les marqueurs (pastilles de virage + POI) à l'échelle du zoom, comme le tracé.
  // Sur 'render' (et non 'zoom') avec garde sur le delta : fiable pour toute origine
  // de zoom, sans coût notable à zoom constant.
  map.on('render', maybeApplyMarkerScale)
  // Tap simple sur la carte → mode veille (la boucle rAF s'arrête, le wake lock est libéré).
  // L'overlay noir capte le tap de réveil ; pas de conflit car il est au z-index 20.
  map.on('click', (e: any) => {
    // Mode « cible » : le tap fixe (ou déplace) le point de destination au lieu de
    // mettre en veille.
    if (placeNavActive.value) { setDestPoint([e.lngLat.lng, e.lngLat.lat]); return }
    // Un popup POI ouvert : le tap carte ne fait que le fermer (pas de mise en veille).
    if (pois.hasOpenPopup()) { pois.closePlacePopup(); return }
    // Tiroir de commandes ouvert : un tap hors du tiroir le referme (et ses
    // sous-panneaux) au lieu de mettre en veille.
    if (controlsVisible.value) { hideControls(); return }
    if (!screenOff.value) toggleScreenOffManual()
  })

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      installRouteLayers()
      renderTurnMarkers()
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
  // displayLine porte déjà le décalage des portions superposées (baked dans la géométrie),
  // donc plus de `line-offset` paint : il s'appliquerait uniformément à tout le tracé.
  // La largeur, elle, varie via la propriété `wscale` des features (tracé aminci sur les
  // recouvrements) → sources en FeatureCollection découpée par paliers de largeur.
  map.addSource('nav-route', { type: 'geojson', data: widthRunsCollection(displayLine, displayWScale) })
  map.addSource('nav-remaining', { type: 'geojson', data: widthRunsCollection(displayLine, displayWScale) })

  map.addLayer({ id: 'nav-route-border', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { ...ROUTE_BORDER_PAINT, 'line-width': zoomWidthExpr(ROUTE_BORDER_WIDTH, true) } })
  map.addLayer({ id: 'nav-route-done', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#9ca3af', 'line-width': zoomWidthExpr(ROUTE_LINE_WIDTH, true), 'line-opacity': ROUTE_LINE_OPACITY } })
  map.addLayer({ id: 'nav-route-remaining', type: 'line', source: 'nav-remaining', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': ROUTE_LINE_COLOR, 'line-width': zoomWidthExpr(ROUTE_LINE_WIDTH, true), 'line-opacity': ROUTE_LINE_OPACITY } })
}

// Indicateurs de virage en marqueurs DOM (et non en couches canvas) : les
// marqueurs MapLibre sont des overlays HTML, toujours rendus AU-DESSUS du canvas
// — donc au-dessus des POI (eux aussi des marqueurs, mais au z-index inférieur).
// C'est ce qui garantit qu'un POI ne masque jamais un indicateur de virage.
// Posés une seule fois (les marqueurs survivent à un setStyle).
function renderTurnMarkers() {
  if (!map || !maplibre) return
  for (const m of turnMarkers) m.remove()
  turnMarkers = []
  if (!turnsFromBRouter || !turns.length) return
  const dot = TURN_MARKER_SIZE * 2          // diamètre de la pastille (rayon → diamètre)
  for (const tp of turns) {
    let b = tp.idx + 1
    while (b < geometry.length - 1 && cumDistM[b] - cumDistM[tp.idx] < 18) b++
    const bearing = bearingBetween(geometry[tp.idx], geometry[b])
    const el = document.createElement('div')
    el.className = 'nav-turn-marker'
    // La racine garde la taille de base (pour le centrage MapLibre via translate -50%) ;
    // le corps interne porte le visuel et est mis à l'échelle via --ts.
    el.style.width = `${dot}px`
    el.style.height = `${dot}px`
    const body = document.createElement('div')
    body.className = 'nav-turn-marker-body'
    // Couleurs configurables (profil → navigation) : pastille et icône intérieure.
    body.style.background = navPrefs.turn_marker_color
    if (tp.kind === 'roundabout') {
      // Rond-point : numéro de sortie, texte maintenu droit (pas d'alignement carte).
      const exitFont = TURN_MARKER_SIZE / 11 * 13   // 13 px à la taille par défaut (rayon 11)
      body.innerHTML = `<span class="nav-turn-marker-exit" style="font-size:${exitFont}px;color:${navPrefs.turn_marker_icon_color}">${tp.exitNumber ?? 0}</span>`
      el.appendChild(body)
      const marker = new maplibre.Marker({ element: el, anchor: 'center' })
        .setLngLat([geometry[tp.idx][0], geometry[tp.idx][1]])
        .addTo(map)
      turnMarkers.push(marker)
    } else {
      // Virage normal : flèche directionnelle couchée sur le plan de la carte
      // (rotationAlignment + pitchAlignment 'map') et orientée selon le cap.
      body.innerHTML = '<svg class="nav-turn-marker-arrow" viewBox="0 0 22 22" aria-hidden="true">'
        + `<path d="M11 1 L20 20 L11 15 L2 20 Z" fill="${navPrefs.turn_marker_icon_color}"/></svg>`
      el.appendChild(body)
      const marker = new maplibre.Marker({ element: el, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat([geometry[tp.idx][0], geometry[tp.idx][1]])
        .addTo(map)
      marker.setRotation(bearing)
      turnMarkers.push(marker)
    }
  }
  applyMarkerScale()
}

// Met les pastilles de virage à l'échelle du zoom, selon la même loi que le tracé
// (zoomWidthScale) : grosses en zoom, fines en dézoom — comme un ruban posé au sol.
// Les marqueurs MapLibre portent leur propre transform (position + rotation), donc on
// ne touche PAS à `transform` de la racine ; on scale le corps interne (premier enfant),
// ce qui contourne le plancher de taille du conteneur flex et scale d'un bloc le cercle,
// le liseré, la flèche et le numéro. Les POI suivent leur propre échelle (useNavPois).
function applyMarkerScale() {
  if (!map) return
  const s = zoomWidthScale(map.getZoom())
  for (const m of turnMarkers) {
    const body = (m.getElement() as HTMLElement).firstElementChild as HTMLElement | null
    if (body) body.style.transform = `scale(${s})`
  }
}

// Déclenché à chaque frame rendue, mais ne fait le travail DOM que si le zoom a
// réellement changé (garde sur le delta) : robuste quelle que soit l'origine du zoom
// (pinch, curseur, recadrage automatique), là où un simple écouteur 'zoom' pouvait
// passer à côté. Le coût d'une frame à zoom constant se limite à un getZoom + compare.
let lastScaleZoom = -1
function maybeApplyMarkerScale() {
  if (!map) return
  const z = map.getZoom()
  if (Math.abs(z - lastScaleZoom) < 0.01) return
  lastScaleZoom = z
  applyMarkerScale()
  pois.applyPoiScale(z)
}

// Une LineString a une largeur uniforme : pour faire varier `wscale` le long du tracé, on le
// découpe en tronçons de wscale ~constant (quantifié par paliers) et on porte la valeur en
// propriété de feature, lue par line-width. Les tronçons partagent leur sommet frontière pour
// rester jointifs. `scales` est aligné index-pour-index sur `coords`.
function widthRunsCollection(coords: number[][], scales: number[]) {
  const q = (w: number) => Math.round(w / 0.05) * 0.05   // paliers de 0.05 → peu de features
  const seg = (c: number[][], wscale: number) =>
    ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: c }, properties: { wscale } })
  const features: ReturnType<typeof seg>[] = []
  if (coords.length < 2) return { type: 'FeatureCollection' as const, features }
  let start = 0
  let cur = q(scales[0] ?? 1)
  for (let i = 1; i < coords.length; i++) {
    const w = q(scales[i] ?? 1)
    if (w !== cur) {
      features.push(seg(coords.slice(start, i + 1), cur))   // inclut le sommet frontière i
      start = i
      cur = w
    }
  }
  features.push(seg(coords.slice(start), cur))
  return { type: 'FeatureCollection' as const, features }
}

function setMapStyle(id: string) {
  if (!map || id === mapStyleId.value) return
  mapStyleId.value = id
  persistDefaultMapStyle(id as any)
  baseIsOffline = wantOffline()
  map.setStyle(resolveBaseStyle(id), { diff: false })
  map.once('style.load', afterStyleLoad)
}

function afterStyleLoad() {
  installRouteLayers()
  applyTerrain()
  // Replace le marqueur sur la position AFFICHÉE (snappée et décalée sur sa voie si on est
  // sur le tracé), pas sur le GPS brut, pour rester cohérent avec la boucle d'animation.
  const restore = anchorPos ?? lastPos
  if (restore) updateLocationMarker(restore)
  refreshRemaining()
}

// ─── Bascule en ligne / hors-ligne ────────────────────────────────────────────
// On n'utilise le fond local QUE lorsque le réseau est absent : en ligne, le WMTS reste
// préféré (tuiles fraîches, couverture au-delà du corridor). Limité à swisstopo gris,
// seul fond dont les CGU autorisent le hors-ligne.
function wantOffline(): boolean {
  return offlineRegistered && mapStyleId.value === 'swissgrau' && typeof navigator !== 'undefined' && navigator.onLine === false
}

function resolveBaseStyle(id: string): string | object {
  if (id === 'swissgrau' && wantOffline()) return offlineGrauStyle(props.shareToken!, OFFLINE_DEFAULTS.maxZoom)
  return mapStyleFor(id)
}

// Recharge le fond seulement si la décision en-ligne/hors-ligne a changé (évite un
// rechargement à chaque scintillement de connectivité).
function refreshBaseMap() {
  if (!map) return
  const want = wantOffline()
  if (want === baseIsOffline) return
  baseIsOffline = want
  map.setStyle(resolveBaseStyle(mapStyleId.value), { diff: false })
  map.once('style.load', afterStyleLoad)
}

// Appelé par NavOfflineButton quand une archive vient d'être téléchargée.
async function onOfflineAvailable() {
  offlineReady.value = true
  if (!offlineRegistered && maplibre) {
    try { await registerOfflineArchive(props.shareToken, maplibre); offlineRegistered = true } catch { /* ignore */ }
  }
  refreshBaseMap()
}

function onOfflineRemoved() {
  offlineReady.value = false
  offlineRegistered = false
  refreshBaseMap()
}

// ─── Reprise après rechargement (tracés auto-recoupants) ──────────────────────
// La position GPS seule ne distingue pas les passages d'un tracé qui se recoupe :
// au même endroit, lng/lat peut appartenir à 2–3 passages. On mémorise donc la
// progression (le sommet courant le long du tracé) dans localStorage et on s'en
// sert comme indice au premier fix après un rechargement, pour repartir sur le bon
// passage au lieu d'une recherche globale ambiguë. L'entrée expire afin de ne pas
// « téléporter » un rider qui relance la même route un autre jour ; la validité est
// en plus confirmée par la proximité réelle au fix GPS (sinon repli global).
const PROGRESS_KEY = `sportsScope.navProgress.${props.shareToken ?? 'session'}`
const RESUME_MAX_AGE_MS = 30 * 60 * 1000
let lastProgressSaveMs = 0

// Indice de reprise (sommet) si une progression récente est mémorisée, sinon -1.
function resumeHintIdx(): number {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    if (!raw) return -1
    const saved = JSON.parse(raw) as { idx: number; t: number }
    if (!saved || typeof saved.idx !== 'number' || typeof saved.t !== 'number') return -1
    if (Date.now() - saved.t > RESUME_MAX_AGE_MS) { localStorage.removeItem(PROGRESS_KEY); return -1 }
    return saved.idx >= 0 && saved.idx < geometry.length ? saved.idx : -1
  } catch { return -1 }
}

// Sauvegarde throttlée de la progression (≤ 1 écriture / 3 s). Best-effort : un
// localStorage indisponible (mode privé, quota) ne doit pas casser la séance.
function persistProgress() {
  const now = Date.now()
  if (now - lastProgressSaveMs < 3000) return
  lastProgressSaveMs = now
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ idx: lastIdx, t: now })) } catch { /* indisponible : best-effort */ }
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

  // Project onto the route. On the first fix we normally do a global search so we
  // locate wherever the ride is joined (including mid-loop); after that a windowed
  // search around the last index keeps perf up and handles self-crossing loops.
  // Exception : sur un tracé auto-recoupant, une progression récente mémorisée
  // (rechargement en pleine course) lève l'ambiguïté du passage — on repart de cet
  // indice. On ne s'y fie que si le rider est effectivement proche de ce passage ;
  // sinon (entrée périmée ou rider ailleurs) on retombe sur la recherche globale.
  const hint = located ? lastIdx : resumeHintIdx()
  let { idx, distM } = nearestGeomIndex(here, geometry, hint)
  if (!located && hint >= 0 && distM > OFF_ROUTE_M + OFF_ROUTE_ACCURACY_CAP) {
    ;({ idx, distM } = nearestGeomIndex(here, geometry, -1))
  }
  lastIdx = idx
  located = true
  // Snap the raw fix onto the polyline so the grey/purple boundary follows the
  // rider continuously along a segment instead of jumping vertex to vertex.
  const snap = projectOnRoute(here, geometry, cumDistM, idx)
  snapPoint = snap.point
  snapNextIdx = snap.nextIdx
  snapDistAlongM = snap.distAlongM
  // Position reportée sur la polyligne d'affichage (décalée sur les recouvrements) : la
  // flèche et le tracé restant sont rendus dessus pour coller à LA voie parcourue, pas au
  // centre des deux passages superposés. `displayLine` est indexée comme `geometry` et
  // partage `cumDistM`, donc l'interpolation par distance le long donne le point décalé.
  displaySnapPoint = lngLatAtDistanceM(displayLine, cumDistM, snapDistAlongM)
  const wasOffRoute = offRoute.value
  // Widen the threshold by the reported GPS accuracy (capped) so an imprecise fix
  // doesn't get flagged off-route while the rider is actually on the line.
  const accuracyM = Math.min(pos.coords.accuracy ?? 0, OFF_ROUTE_ACCURACY_CAP)
  offRoute.value = distM > OFF_ROUTE_M + accuracyM
  updateProgress(idx)
  // Mémorise la progression pour reprendre sur le bon passage après un éventuel
  // rechargement. On ne sauvegarde que sur le tracé : un point hors-tracé pourrait
  // figer un mauvais passage. nextTurnPtr et snapDistAlongM se recalent d'eux-mêmes
  // au premier fix de reprise (pilotés par l'indice restauré), rien d'autre à stocker.
  if (!offRoute.value) persistProgress()

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
  anchorOnRoute = !offRoute.value && displaySnapPoint != null
  anchorPos = anchorOnRoute ? displaySnapPoint : here
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

// Zoom effectivement appliqué par la boucle : le zoom de découverte du virage s'il est
// actif (sortie de veille à l'approche), sinon le zoom du profil.
function effectiveZoom(): number {
  return revealZoom != null ? revealZoom : camZoom.value
}

// Position (lng/lat) du virage à révéler quand on vient de sortir de veille pour lui.
// On ne révèle que dans ce cas précis : réveil automatique (autoWoken) ET virage en
// approche (état « near »), caméra en suivi. Sinon null → pas de surcharge de zoom.
function revealTurnLngLat(): LngLat | null {
  if (!autoWoken || !following.value) return null
  if (turnHint.value?.state !== 'near') return null
  const tp = turns[nextTurnPtr]
  if (!tp) return null
  return [geometry[tp.idx][0], geometry[tp.idx][1]]
}

// Ajuste le zoom de découverte pour garder le prochain virage visible à l'écran, sans
// jamais zoomer au-delà du zoom du profil. On projette le virage dans la vue courante
// (ce qui tient compte de l'inclinaison 3D, contrairement à un calcul analytique) : s'il
// est trop haut (proche du bord supérieur, voire hors champ), on dézoome d'un cran ; s'il
// laisse trop d'espace vide devant, on resserre vers le profil. Une bande morte large
// entre les deux seuils évite toute oscillation. Appelé à chaque frame de suivi, juste
// avant le jumpTo : le pas par frame se cumule en un dézoom progressif et fluide.
function updateRevealZoom() {
  const target = revealTurnLngLat()
  if (!target) { revealZoom = null; return }
  const h = containerH || map?.getContainer()?.clientHeight || 0
  if (!h) { revealZoom = null; return }
  const y = map.project(target).y
  const topSafe = h * 0.18    // au-dessus → virage trop haut / hors champ : dézoomer
  const comfyMax = h * 0.30   // en dessous → trop d'espace devant : resserrer vers le profil
  const base = revealZoom ?? camZoom.value
  let z = base
  if (y < topSafe) z = base - 0.2
  else if (y > comfyMax) z = base + 0.2
  // Borné : on ne dépasse jamais le zoom du profil (dézoom seulement) ni le plancher caméra.
  revealZoom = Math.min(camZoom.value, Math.max(CAM_ZOOM_MIN, z))
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
        ? lngLatAtDistanceM(displayLine, cumDistM, anchorDistM + extrapSpeedMs * dt)
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
      // Dézoom de découverte du prochain virage (sortie de veille) : ajusté avant le
      // jumpTo, borné au zoom du profil. Hors de ce cas, effectiveZoom() == camZoom.
      updateRevealZoom()
      map.jumpTo({ center: pos, bearing: displayBearing, zoom: effectiveZoom(), pitch: camPitch.value, padding: followPadding(h) })
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
  // Débug : un virage factice est épinglé, on ne le réécrit pas depuis le GPS.
  if (dbgTurn.value) return false
  if (!turns.length) { turnHint.value = null; activeTurn = null; reachedTurn = null; return false }
  const here = snapDistAlongM
  // Avance le pointeur sur les virages dépassés (>5 m derrière), en mémorisant chacun
  // pour le maintien vert. Le décompte ne démarre donc qu'une fois le virage vraiment
  // laissé derrière soi.
  while (nextTurnPtr < turns.length && turns[nextTurnPtr].distM < here - 5) {
    rememberReached(turns[nextTurnPtr])
    nextTurnPtr++
  }
  const turn = turns[nextTurnPtr] as TurnPoint | undefined
  const dist = turn ? turn.distM - here : Infinity

  // Son / répétition : armé tant que le prochain virage est dans la zone d'alerte.
  let fired = false
  if (turn && dist <= TURN_ALERT_M && dist > -5) {
    // Le virage est dans la zone d'alerte : on l'arme pour la répétition cadencée
    // par le timer (tickTurnRepeat), indépendante de la fréquence des fixes GPS.
    activeTurn = { kind: turn.kind, direction: turn.direction }
    activeTurnUrgent = dist <= TURN_URGENT_M
    // Entrée dans la zone orange : double buzz distinct, une seule fois par virage.
    if (activeTurnUrgent && urgentBuzzedTurn !== nextTurnPtr) {
      urgentBuzzedTurn = nextTurnPtr
      if (!alertsMuted.value) vibrateApproach()
    }
    if (announcedTurn !== nextTurnPtr) {
      announcedTurn = nextTurnPtr
      lastTurnReminderMs = Date.now()
      if (soundOn.value && !alertsMuted.value) playManeuver(turn.kind, turn.direction)
      // Vibration indépendante du son (perceptible téléphone en poche, vent fort).
      if (!alertsMuted.value) vibrateManeuver(turn.kind)
      fired = true
    }
  } else {
    // Hors zone d'alerte (pas encore assez proche, ou virage franchi) : on coupe
    // la répétition jusqu'au prochain virage.
    activeTurn = null
    activeTurnUrgent = false
  }

  // Virage courant atteint (dist ≤ 0) mais pointeur pas encore avancé (on est dessus,
  // potentiellement à l'arrêt à un carrefour) : on rafraîchit le maintien vert pour
  // qu'il ne disparaisse pas tant qu'on n'est pas reparti.
  if (turn && dist <= 0) rememberReached(turn)

  // Choix de l'affichage. Priorité au prochain virage s'il est proche (« sauf s'il y a
  // une autre instruction plus proche »). Sinon, on maintient le virage tout juste
  // franchi en vert pendant GREEN_HOLD_M après lui. Sinon, le prochain virage en mode lointain.
  const greenActive = reachedTurn != null
    && here - reachedTurn.distM < GREEN_HOLD_M
    && Date.now() - reachedAtMs < GREEN_HOLD_MS
  if (turn && dist > 0 && dist <= TURN_HINT_M) {
    turnHint.value = { direction: turn.direction, distM: dist, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber, state: 'near' }
  } else if (greenActive && reachedTurn) {
    turnHint.value = { direction: reachedTurn.direction, distM: 0, kind: reachedTurn.kind, angle: reachedTurn.angle, exitNumber: reachedTurn.exitNumber, state: 'now' }
  } else if (turn && dist > 0) {
    turnHint.value = { direction: turn.direction, distM: dist, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber, state: 'far' }
  } else {
    turnHint.value = null
  }

  autoWakeForTurns(turnHint.value?.state ?? null)
  updateTurnSelection()
  return fired
}

// Met en évidence sur la carte la pastille du prochain virage quand l'écran vient de
// sortir de veille pour lui (autoWoken) et qu'on est en approche (état « near ») — même
// fenêtre que le dézoom de découverte. `turnMarkers` est aligné index-pour-index sur
// `turns` (renderTurnMarkers en pose un par virage, dans l'ordre), donc le marqueur du
// prochain virage est turnMarkers[nextTurnPtr]. No-op si la détection géométrique n'a
// posé aucun marqueur (turnMarkers vide).
function updateTurnSelection() {
  const sel = autoWoken && turnHint.value?.state === 'near' ? nextTurnPtr : -1
  if (sel === selectedTurnIdx) return
  selectedTurnIdx = sel
  turnMarkers.forEach((m, i) => {
    (m.getElement() as HTMLElement).classList.toggle('nav-turn-marker--selected', i === sel)
  })
}

// Veille automatique pilotée par les virages :
//   • à l'approche d'un virage (état « near », violet/orange), si on est en veille,
//     on rallume l'écran pour montrer l'instruction ;
//   • à la fin du maintien vert (« now »), si c'est nous qui avions rallumé, on se
//     rendort — SAUF si un autre virage est déjà proche (état « near »), auquel cas
//     on reste éveillé.
function autoWakeForTurns(state: 'far' | 'near' | 'now' | null) {
  // Mode recherche : on ne réveille pas l'écran ni ne dézoome pour un virage du tracé que
  // l'utilisateur s'apprête à changer. Si on s'était réveillé automatiquement, on se rendort.
  if (alertsMuted.value) {
    if (autoWoken && !screenOff.value) {
      autoWoken = false
      toggleScreenOff()
    }
    return
  }
  // Hors-tracé : il n'y a plus de virage à anticiper, et la flèche de retour reste
  // visible au-dessus du voile de veille. Si on s'était réveillé tout seul pour un
  // virage, on se rendort (un virage encore « proche » géométriquement ne doit pas
  // garder l'écran allumé une fois qu'on a quitté le tracé). Un réveil manuel reste
  // éveillé.
  if (offRoute.value) {
    if (autoWoken && !screenOff.value) {
      autoWoken = false
      toggleScreenOff()     // remet en veille (on a quitté le tracé)
    }
    return
  }
  if (state === 'near' && screenOff.value) {
    autoWoken = true
    toggleScreenOff()       // sort de veille (et relance la boucle d'animation)
  } else if (autoWoken && !screenOff.value && state !== 'near' && state !== 'now') {
    autoWoken = false
    toggleScreenOff()       // remet en veille (plus de virage proche)
  }
}

// Mémorise un virage franchi (avec sa distance le long du tracé) pour le maintien vert.
// Le chrono (reachedAtMs) ne démarre qu'au premier passage sur ce virage, et non à
// chaque rafraîchissement tant qu'on est dessus (sinon la limite de temps ne
// s'écoulerait jamais à l'arrêt à un carrefour).
function rememberReached(turn: TurnPoint) {
  if (!reachedTurn || reachedTurn.distM !== turn.distM) reachedAtMs = Date.now()
  reachedTurn = { direction: turn.direction, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber, distM: turn.distM }
}

// Répétition du son de virage, cadencée à turn_repeat_ms et non aux fixes GPS.
// Un poll court (250 ms) suffit : la préférence est plafonnée à 500 ms mini.
function tickTurnRepeat() {
  if (!activeTurn || !soundOn.value || alertsMuted.value) return
  const now = Date.now()
  const interval = activeTurnUrgent ? TURN_REPEAT_URGENT_MS : TURN_REPEAT_MS
  if (now - lastTurnReminderMs >= interval) {
    lastTurnReminderMs = now
    playManeuver(activeTurn.kind, activeTurn.direction)
  }
}

function handleOffRouteSound(wasOffRoute: boolean) {
  if (!offRoute.value) { lastOffRouteAlert = 0; return }
  const now = Date.now()
  if (alertsMuted.value) return
  if (!wasOffRoute || now - lastOffRouteAlert > OFF_ROUTE_REALERT_MS) {
    lastOffRouteAlert = now
    if (soundOn.value) playOffRoute()
    vibrateOffRoute()
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
  const kmh = Math.max(0, ms * 3.6)
  speedKmh.value = kmh
  // Moyenne lissée pour l'ETA : seulement en roulant, pour qu'un arrêt n'effondre
  // pas l'estimation. Amorcée sur la première vitesse exploitable.
  if (kmh > ETA_SPEED_FLOOR) {
    avgSpeedKmh.value = avgSpeedKmh.value > 0
      ? avgSpeedKmh.value + (kmh - avgSpeedKmh.value) * ETA_SMOOTH
      : kmh
  }
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
  // Débug : une carte de col factice est épinglée, on ne la réécrit pas depuis le GPS.
  if (dbgClimb.value) { refreshRemaining(); return }
  const ac = activeClimb(idx, climbs, cumDistM, snapDistAlongM)
  if (ac) {
    const rem = computeGainLoss(geometry.slice(idx, ac.climb.endIdx + 1)).gain
    const prof = climbProfileFor(ac.climb)
    const posX = ac.ratio * 100
    const grade = gradeForIndex(idx, alts, cumDistM)
    const gradeColor = colorForGrade(grade)
    climbInfo.value = {
      climb: ac.climb,
      ratio: ac.ratio,
      remainingGainM: rem,
      segments: prof.segments,
      areaD: prof.areaD,
      posX,
      posY: profileYAt(prof.pts, posX),
      topY: prof.topY,
      grade,
      gradeColor,
      gradeText: textColorOn(gradeColor),
    }
  } else {
    climbInfo.value = null
  }
  refreshRemaining()
}

// Cache du profil d'altitude gradué du col, par index de départ : la géométrie est
// statique, on ne reconstruit le profil (buildClimbProfile, dans navHelpers) que
// lorsqu'on entre dans un nouveau col.
let profileForStart = -1
let profileCache: ClimbProfile | null = null

function climbProfileFor(climb: Climb): ClimbProfile {
  if (profileForStart !== climb.startIdx || !profileCache) {
    profileForStart = climb.startIdx
    profileCache = buildClimbProfile(climb, alts, cumDistM)
  }
  return profileCache
}

// Redraw the bright "remaining" portion of the route from the projected index.
function refreshRemaining() {
  const src = map?.getSource('nav-remaining')
  if (!src) return
  // displayLine / displayWScale sont indexés comme geometry : on tranche au même index pour
  // garder le décalage ET l'amincissement des portions superposées sur la partie restante.
  const from = snapPoint ? snapNextIdx : lastIdx
  const rest = displayLine.slice(from).map(([lng, lat]) => [lng, lat])
  const restW = displayWScale.slice(from)
  // Start the remaining line exactly at the rider's projected position — sur la voie
  // d'AFFICHAGE (décalée), pour qu'elle se raccorde sans cassure au tracé restant décalé.
  if (displaySnapPoint) { rest.unshift([displaySnapPoint[0], displaySnapPoint[1]]); restW.unshift(restW[0] ?? 1) }
  src.setData(widthRunsCollection(rest, restW))
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

// Bascule manuelle (tap utilisateur) : on annule l'état « réveil automatique » pour
// ne pas re-endormir de soi-même un écran que l'utilisateur a lui-même rallumé (ni
// re-réveiller un écran qu'il vient d'éteindre).
function toggleScreenOffManual() {
  autoWoken = false
  toggleScreenOff()
}
</script>

<template>
  <div class="nav-page">
    <div ref="mapEl" class="nav-map" :class="{ 'nav-map--climbing': isClimbing }"></div>

    <!-- Battery saver: black screen — GPS and turn sounds still active -->
    <NavScreenOff
      v-if="screenOff"
      :turn-hint="turnHint"
      :has-fix="hasFix"
      :off-route="offRoute"
      :climb-info="showClimbCard ? climbInfo : null"
      :urgent-m="TURN_URGENT_M"
      :speed-kmh="speedKmh"
      @resume="toggleScreenOffManual"
    />

    <div v-if="loading" class="nav-overlay-center text-muted">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.computing_route') }}
    </div>
    <div v-else-if="error" class="nav-overlay-center text-danger">
      <i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>{{ error }}
    </div>

    <!-- Zone de swipe (révèle les boutons masqués) : fine bande transparente en
         haut, active seulement boutons masqués et écran allumé. -->
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

    <!-- Panneau de commandes : glisse depuis le haut au swipe vers le bas. Regroupe
         TOUS les boutons (retour, profil, style de carte, son, radar, caméra, POI)
         pour libérer le haut de l'écran aux notifications pleine largeur (virage /
         radar). Masqué hors séance, rappelé par la zone de swipe. -->
    <NavControlsPanel
      :controls-visible="controlsVisible"
      :logged-in="loggedIn"
      :debug-mode="debugMode"
      :map-style-id="mapStyleId"
      :sound-on="soundOn"
      :climb-card-visible="showClimbCard"
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
      :dbg-radar="dbgRadar"
      :dbg-climb="dbgClimb"
      :dbg-turn-label="dbgTurnLabel"
      v-model:show-cam-panel="showCamPanel"
      v-model:show-poi-panel="showPoiPanel"
      v-model:show-debug-panel="showDebugPanel"
      @arm-controls-hide="armControlsHide"
      @start-place-nav="startPlaceNav"
      @set-map-style="setMapStyle"
      @toggle-sound="toggleSound"
      @toggle-climb-card="showClimbCard = !showClimbCard"
      @toggle-radar="toggleRadar"
      @pitch-input="onPitchInput"
      @persist-pitch-terrain="persistPitchTerrain"
      @zoom-input="onZoomInput"
      @save-zoom="saveZoomToProfile"
      @toggle-terrain="toggleTerrain"
      @toggle-poi="pois.togglePoi"
      @search-pois="pois.fetchPlaces({ center: lastPos ?? undefined })"
      @toggle-debug-radar="toggleDebugRadar"
      @toggle-debug-climb="toggleDebugClimb"
      @cycle-debug-turn="cycleDebugTurn"
    >
      <template #map-extra>
        <!-- Pas de carte hors-ligne en mode session (aucun token de trajet à archiver). -->
        <NavOfflineButton
          v-if="shareToken"
          :share-token="shareToken"
          :coords="offlineCoords"
          @available="onOfflineAvailable"
          @removed="onOfflineRemoved"
        />
      </template>
    </NavControlsPanel>

    <!-- Mode « cible » : recherche d'un lieu (recadrage carte) + consigne, puis un tap
         sur la carte fixe la destination ; « Naviguer ici » lance le guidage. -->
    <div v-if="placeNavActive" class="nav-place-picker">
      <div class="nav-place-bar">
        <NavPlaceSearch @locate="onLocate" />
        <button type="button" class="btn btn-light nav-place-cancel shadow" :title="t('routes.cancel')" :aria-label="t('routes.cancel')" @click="cancelPlaceNav">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <div class="nav-place-hint">
        <i class="fa-solid fa-circle-info me-2" aria-hidden="true"></i>{{ t('routes.navigate_pick_hint') }}
      </div>
    </div>

    <!-- Confirmation : itinéraire depuis la position GPS vers le point choisi. -->
    <div v-if="placeNavActive && destPoint" class="nav-place-confirm-wrap">
      <button
        type="button"
        class="btn btn-primary shadow nav-place-confirm"
        :disabled="navStarting || !hasFix"
        @click="confirmPlaceNav"
      >
        <i v-if="navStarting" class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>
        <i v-else class="fa-solid fa-diamond-turn-right me-1" aria-hidden="true"></i>
        {{ navStarting ? t('routes.computing_route') : (hasFix ? t('routes.navigate_here') : t('routes.gps_waiting')) }}
      </button>
      <div v-if="navError" class="nav-place-error">{{ navError }}</div>
    </div>

    <!-- Radar arrière (Garmin Varia) — élevé au-dessus du voile de veille pour rester
         visible en mode veille (info de sécurité). -->
    <RadarOverlay :elevated="screenOff" />

    <!-- Upcoming turn indicator -->
    <NavTurnBanner
      v-if="turnHint && hasFix && !offRoute"
      :turn-hint="turnHint"
      :urgent-m="TURN_URGENT_M"
      :radar-banner-visible="radarBannerVisible"
      :speed-kmh="speedKmh"
    />

    <!-- GPS / off-route banners -->
    <div v-if="gpsError" class="nav-banner nav-banner--warn">
      <i class="fa-solid fa-location-crosshairs me-2" aria-hidden="true"></i>{{ gpsError }}
    </div>
    <div v-else-if="!hasFix && !loading" class="nav-banner nav-banner--info">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.gps_waiting') }}
    </div>

    <!-- Big centered arrow pointing back to the route when off-route.
         Reste visible (au-dessus du voile noir) en mode veille : quitter le tracé
         est une info de sécurité qui doit réveiller l'attention même écran éteint. -->
    <i
      v-if="offRoute && hasFix"
      class="fa-solid fa-arrow-up nav-offroute-bigarrow"
      :class="{ 'nav-offroute-bigarrow--sleep': screenOff }"
      :style="{ transform: `translate(-50%, -50%) rotate(${offRouteRelBearing}deg)` }"
      aria-hidden="true"
    ></i>

    <!-- Reroutage manuel : recalcule un chemin BRouter de la position vers le tracé.
         Reste visible en veille (au-dessus du voile noir) : quitter le tracé est une
         info de sécurité ; l'erreur éventuelle s'affiche sous le bouton. -->
    <div v-if="offRoute && hasFix" class="nav-reroute" :class="{ 'nav-reroute--sleep': screenOff }">
      <button
        type="button"
        class="btn btn-warning shadow nav-reroute-btn"
        :disabled="rerouting"
        @click="recalcRoute"
      >
        <i v-if="rerouting" class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>
        <i v-else class="fa-solid fa-route me-1" aria-hidden="true"></i>
        {{ rerouting ? t('routes.rerouting') : t('routes.reroute') }}
      </button>
      <div v-if="rerouteError" class="nav-reroute-error">{{ rerouteError }}</div>
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

    <!-- Climb card: full graded elevation profile with a position cursor.
         Reste visible (au-dessus du voile noir) en mode veille ; un tap réveille. -->
    <NavClimbCard
      v-if="showClimbCard && climbInfo && !offRoute && !approachingTurn"
      :climb-info="climbInfo"
      :screen-off="screenOff"
      @resume="toggleScreenOffManual"
    />

    <!-- Bottom stats -->
    <NavStatsBar
      :remaining-m="remainingM"
      :remaining-gain-m="remainingGainM"
      :done-percent="donePercent"
      :speed-kmh="speedKmh"
      :eta-speed-kmh="avgSpeedKmh"
    />
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
   col (bottom: 6.25rem, hauteur ≈ 16rem) : la flèche reste dans la carte visible. */
.nav-map--climbing { bottom: 22.75rem; }

.nav-overlay-center {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 5; font-weight: 500;
}

/* Zone de geste « swipe vers le bas » : bande transparente en haut de l'écran.
   touch-action:none pour que le glissement vertical déclenche bien pointermove au
   lieu d'un scroll. Au-dessus de la carte mais sous le voile de veille (z-index 20). */
.nav-reveal-zone {
  position: absolute; top: 0; left: 0; right: 0; height: 4.5rem;
  z-index: 6; touch-action: none;
  display: flex; justify-content: center; align-items: flex-start;
}
/* Petit chevron discret indiquant qu'on peut faire glisser vers le bas pour déployer
   le tiroir de commandes. Centré sur le bord supérieur. */
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
.nav-offroute-bigarrow {
  position: absolute; top: 50%; left: 50%;
  z-index: 6; pointer-events: none;
  font-size: 40vmin; color: #dc3545; opacity: 0.5;
  transition: transform 0.4s ease;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35));
}
/* Mode veille : au-dessus du voile noir (z 20), pleinement opaque pour rester
   bien lisible sur fond sombre. */
.nav-offroute-bigarrow--sleep { z-index: 21; opacity: 1; }
.nav-banner--warn { background: #fff3cd; color: #664d03; }
.nav-banner--info { background: #cfe2ff; color: #084298; }

.nav-recenter {
  position: absolute; bottom: 8.5rem; right: 0.75rem; z-index: 4;
  border-radius: 999px; font-weight: 600;
  font-size: 1.1rem; padding: 0.6rem 1.1rem;
}

/* Bouton de reroutage : centré sous la grande flèche hors-tracé, au-dessus du
   bandeau de stats. z-index 7 pour rester cliquable au-dessus de la flèche (z 6). */
.nav-reroute {
  position: absolute; bottom: 12rem; left: 50%; transform: translateX(-50%);
  z-index: 7; display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
}
/* Mode veille : au-dessus du voile noir (z 20) pour rester cliquable écran éteint,
   comme la grande flèche hors-tracé. */
.nav-reroute--sleep { z-index: 21; }
.nav-reroute-btn {
  border-radius: 999px; font-weight: 600;
  font-size: 1.1rem; padding: 0.6rem 1.4rem;
}
.nav-reroute-error {
  background: #fff3cd; color: #664d03; border-radius: 999px;
  padding: 0.3rem 0.8rem; font-size: 0.85rem; font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* Mode « cible » : barre de recherche centrée en haut + consigne ; au-dessus du
   tiroir de commandes (z 8) car il est replié pendant ce mode. */
.nav-place-picker {
  position: absolute; top: 0.75rem; left: 50%; transform: translateX(-50%);
  z-index: 9; width: min(440px, calc(100% - 1.5rem));
  display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem;
}
.nav-place-bar { display: flex; align-items: flex-start; gap: 0.5rem; }
.nav-place-bar :deep(.nav-search) { flex: 1; }
.nav-place-cancel {
  flex-shrink: 0; width: 2.6rem; height: 2.6rem; border-radius: 0.5rem;
  display: inline-flex; align-items: center; justify-content: center; font-size: 1.1rem;
}
.nav-place-hint {
  align-self: center; max-width: 100%;
  background: rgba(8, 66, 152, 0.95); color: #fff;
  padding: 0.45rem 0.9rem; border-radius: 0.6rem;
  font-size: 0.85rem; font-weight: 500; text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.nav-place-confirm-wrap {
  position: absolute; bottom: 8rem; left: 50%; transform: translateX(-50%);
  z-index: 9; display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
}
.nav-place-confirm {
  border-radius: 999px; font-weight: 600; font-size: 1.1rem; padding: 0.6rem 1.4rem;
}
.nav-place-error {
  background: #fff3cd; color: #664d03; border-radius: 999px;
  padding: 0.3rem 0.8rem; font-size: 0.85rem; font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
</style>

<style>
.nav-position-arrow {
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
  pointer-events: none;
  /* Position de l'utilisateur : au-dessus des indicateurs de virage et des POI. */
  z-index: 3;
}

/* Marqueur de destination posé au tap en mode « cible » (créé en JS, donc style
   global, hors scope). */
.nav-dest-marker {
  color: #dc2626;
  font-size: 2rem;
  line-height: 1;
  pointer-events: none;
  z-index: 4;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45));
}

/* Indicateurs de virage (pastille orange + flèche / numéro de sortie). Marqueurs
   DOM placés au-dessus des POI (z-index 2 > 1) pour ne jamais être masqués par eux.
   La racine ne sert qu'au positionnement (MapLibre y pose son transform : position +
   rotation pour les flèches) ; le visuel est porté par .nav-turn-marker-body, qu'on met
   à l'échelle du zoom via `transform: scale()`. On scale le corps plutôt que de
   redimensionner la boîte parce que la largeur CSS d'un conteneur flex est plancher-
   née par la taille intrinsèque de son contenu (la flèche SVG) : la pastille refusait
   de descendre sous sa taille de base en dézoom. `transform` ignore cette contrainte
   et scale d'un bloc le cercle, le liseré, la flèche et le numéro. */
.nav-turn-marker {
  pointer-events: none;
  z-index: 2;
}
.nav-turn-marker-body {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #f97316;
  border: 2px solid #fff;
  /* content-box : le liseré blanc s'ajoute autour de la pastille (comme circle-stroke),
     pour reproduire le rendu de l'ancienne couche canvas malgré le reset Bootstrap. */
  box-sizing: content-box;
  /* Échelle posée en JS (applyMarkerScale) ; défaut neutre avant le premier calcul. */
  transform: scale(1);
  transform-origin: center;
}
.nav-turn-marker-arrow { width: 73%; height: 73%; display: block; }
.nav-turn-marker-exit { color: #fff; font-weight: 700; line-height: 1; }

/* Virage « sélectionné » : mis en évidence quand l'écran sort de veille à son approche,
   pour repérer d'un coup d'œil le virage concerné sur la carte. Halo pulsé porté par le
   corps (qui subit déjà le scale du zoom), donc il grossit/rétrécit avec la pastille. Le
   halo combine un liseré blanc et un liseré sombre pour rester visible sur fond clair
   comme sombre, indépendamment de la couleur configurée de la pastille. */
.nav-turn-marker--selected .nav-turn-marker-body {
  animation: nav-turn-pulse 1.2s ease-in-out infinite;
}
@keyframes nav-turn-pulse {
  0%, 100% {
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.95), 0 0 0 5px rgba(0, 0, 0, 0.25), 0 0 10px 3px rgba(255, 255, 255, 0.55);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 1), 0 0 0 7px rgba(0, 0, 0, 0.3), 0 0 22px 9px rgba(255, 255, 255, 0.85);
  }
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
  /* Sous les indicateurs de virage (z-index 2) : un POI ne doit jamais les masquer. */
  z-index: 1;
}
.place-marker i { font-size: 0.78rem; }
/* Survol souris ou popup ouvert : le marqueur s'inverse — le fond se remplit de sa
   couleur, l'icône passe en blanc. */
.place-marker:hover,
.place-marker--active { background: currentColor; box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.5); }
.place-marker:hover i,
.place-marker--active i { color: #fff; }
/* La couleur de chaque marqueur est posée en inline depuis le registre POI
   (poiCategories.ts) ; currentColor pilote la bordure et le remplissage. */
@media (max-width: 767px) {
  .place-marker { width: 32px; height: 32px; }
  .place-marker i { font-size: 0.92rem; }
}

/* Popup POI (Google Maps / Street View) — repris du créateur d'itinéraire. */
/* Toujours au-dessus des autres marqueurs (POI z-index 1, virages 2, position 3) :
   sans z-index explicite, le popup maplibre (auto = 0) passe sous les marqueurs. */
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
