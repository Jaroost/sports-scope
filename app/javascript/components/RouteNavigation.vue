<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import { useNavLineWidth, widthRunsCollection } from '../navLineWidth'
import {
  buildDistancesM, detectClimbs, detectTurns, turnsFromVoiceHints, computeGainLoss,
  haversine, bearingBetween, bearingDelta, nearestGeomIndex, nearestGeomIndexPreferring, projectOnRoute,
  lngLatAtDistanceM, sliceLineBetween, maneuverEndIdx, progressFor, activeClimb, gradeForIndex, colorForGrade,
  buildOffsetDisplayLine, formatDistancePrecise, attachClimbNames,
} from '../routeHelpers'
import type { Coord, Climb, LngLat, TurnPoint, VoiceHint, Maneuver, ClimbName } from '../routeHelpers'
import { fetchRouteToPlace, fetchRouteVia, waypointInsertIndex } from '../navRoute'
import { rejoinIndexAhead, viasAhead, detourAnchors, spliceDetour } from '../navReroute'
import type { Waypoint } from '../navRoute'
import {
  textColorOn, moveLngLat, buildClimbProfile, buildCompanionClimbProfile, buildCompanionRouteClimbs,
  profileYAt, buildTurnChain,
  smoothEtaSpeed, arrivalStep, INITIAL_ARRIVAL_STATE, turnBanner, turnAlertStep,
  INITIAL_TURN_ALERT_STATE, TURN_PASSED_M, revealZoomStep, navStateFor,
  resyncOnTurn, turnLabel, turnsNearTap, turnIcon,
} from '../navHelpers'
import type {
  TurnHint, ClimbInfo, ClimbProfile, ArrivalState, ReachedTurn, TurnAlertState,
} from '../navHelpers'
import { unlockAudio, playManeuverBurst, playOffRoute, playPoi, playArrival } from '../navAudio'
import { vibrateManeuver, vibrateApproach, vibrateOffRoute, vibratePoi, vibrateArrival } from '../navHaptics'
import { categoryForType } from '../poiCategories'
import CompanionSensors from './CompanionSensors.vue'
import NavTurnBanner from './NavTurnBanner.vue'
import NavPoiBanner from './NavPoiBanner.vue'
import NavPoiBrowser from './NavPoiBrowser.vue'
import NavScreenOff from './NavScreenOff.vue'
import NavSleepHold from './NavSleepHold.vue'
import NavClimbCard from './NavClimbCard.vue'
import NavStatsBar from './NavStatsBar.vue'
import NavControlsPanel from './NavControlsPanel.vue'
import NavPlaceSearch from './NavPlaceSearch.vue'
import NavRoutePicker from './NavRoutePicker.vue'
import {
  companionScreen, companionNav, companionClimbProfile, companionRouteClimbs, inCompanionApp,
  registerOfflineMapsHandlers, pushOfflineMapsState, registerSleepHandlers,
} from '../companionBridge'
import { companionStore } from '../stores/companionStore'
import { userPreferences, persistNavigationStyle, sportPreferences, setActiveSport, isLoggedIn, routeProfileForSport } from '../userPreferences'
import type { Sport } from '../userPreferences'
import { catalogDefaultForSport, isProfileValidForSport } from '../brouter'
import NavRoutingPicker from './NavRoutingPicker.vue'
import { useNavPois } from '../composables/useNavPois'
import type { NavPlace } from '../composables/useNavPois'
import type { RouteMarker } from '../routeMarkers'
import { useScreenWakeLock } from '../composables/useScreenWakeLock'
import { useNavSound } from '../composables/useNavSound'
import {
  useNavCamera, CAM_ZOOM_MIN, CAM_ZOOM_MAX,
} from '../composables/useNavCamera'
import { useControlsHide } from '../composables/useControlsHide'
import { useRevealGesture } from '../composables/useRevealGesture'
import { useTrackOpacityDrag } from '../composables/useTrackOpacityDrag'
import { useSleepHold } from '../composables/useSleepHold'
import { MIN_MOVE_M, MIN_SPEED_MS, MAX_EXTRAP_S, BEARING_SMOOTH, BEARING_EPS, TURN_CHAIN_GAP_M, TURN_CHAIN_MAX } from '../navConstants'
import { useOfflineMaps } from '../composables/useOfflineMaps'
import { usePoiBrowse } from '../composables/usePoiBrowse'
import { useNavToast } from '../composables/useNavToast'
import { useNavDebug } from '../composables/useNavDebug'
import { useRouteEditing } from '../composables/useRouteEditing'
import { useDestinationNav } from '../composables/useDestinationNav'
import { buildCoordPopupContent, attachTwoFingerTap } from '../mapCoordPopup'
import { popupHeaderHtml, popupActionHtml, escapeHtml } from '../placePopup'
import { saveNavSession, loadNavSession, clearNavSession } from '../navSession'
import { loadProgress, saveProgress, clearProgress, clearAllProgress } from '../navProgress'

// Page de navigation unifiée : démarre en mode libre (carte + GPS + vitesse, sans
// tracé) et peut charger/décharger un itinéraire à chaud. shareToken : si présent
// (lien partageable /routes/:token/navigate), l'itinéraire est chargé automatiquement
// au montage. Absent → on démarre en navigation libre.
//
// fresh : navigation libre demandée explicitement depuis un menu (`/navigate?fresh=1`).
// On repart alors vraiment de zéro — la session mémorisée est effacée au lieu d'être
// restaurée, sinon l'itinéraire de la séance précédente réapparaissait.
const props = defineProps<{ shareToken?: string; canDebug?: boolean; fresh?: boolean }>()

// Vrai dès qu'un itinéraire est chargé (≥ 2 points) : bascule entre la navigation
// libre (suivi GPS brut, vitesse seule) et la navigation sur itinéraire (tracé,
// virages, cols, hors-trajet, progression).
const hasRoute = ref(false)
// Token du trajet actif (lien partagé ou itinéraire sauvegardé chargé depuis la
// dialogue), null en mode libre. Pilote la clé de reprise de progression et la carte
// hors-ligne, autrefois figés sur props.shareToken.
const routeToken = ref<string | null>(props.shareToken ?? null)
// Dialogue de chargement d'un itinéraire (liste des itinéraires sauvegardés + bouton
// « naviguer vers un lieu »).
const showRoutePicker = ref(false)

// Vue de départ avant le premier fix GPS en mode libre (centre de la Suisse) —
// recadrée dès la première position reçue. En mode itinéraire, on cadre sur le tracé.
const DEFAULT_CENTER: LngLat = [8.23, 46.82]
const DEFAULT_ZOOM = 7

// Réglages caméra issus du profil (section Navigation), indépendants du créateur.
const navPrefs = userPreferences().navigation
const OFF_ROUTE_M = 30          // lateral distance beyond which we warn
const OFF_ROUTE_ACCURACY_CAP = 45  // most we widen the threshold by for a fuzzy GPS fix (élargi pour le drift GPS sous couvert boisé)
const OFF_ROUTE_REALERT_MS = 12000  // re-buzz this often while still off route
// Tolérance de désambiguïsation des passages lors d'une recherche globale (voir
// nearestGeomIndexPreferring) : deux passages du tracé distants de moins de ça sont
// jugés également plausibles, et c'est le plus proche de la progression connue qui
// l'emporte. Volontairement large : sur une boucle, se garer quelques dizaines de
// mètres en amont sur la branche de retour ne doit pas démarrer la séance à 99 % du
// parcours. Le pire cas — un coureur qui rejoint vraiment le tracé là où deux passages
// se frôlent — se corrige seul dès qu'il avance.
const LOOP_AMBIGUITY_TOL_M = 60
// Recalcul automatique hors-course (profil navigation.auto_reroute) : délai entre deux
// recalculs auto tant qu'on reste hors-course (profil navigation.auto_reroute_cooldown_s,
// 10 s par défaut). Évite qu'un flottement GPS hors-tracé/sur-tracé déclenche une rafale
// d'appels BRouter ; le décompte restant s'affiche sur le bouton « Recalculer ».
const AUTO_REROUTE_COOLDOWN_MS = (navPrefs.auto_reroute_cooldown_s ?? 10) * 1000
// Secondes restantes avant la prochaine tentative de recalcul auto (0 = éligible ou
// inactif). Affiché sur le bouton « Recalculer ». Mis à jour par tickTurnRepeat.
const autoRerouteLeftS = ref(0)

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
// Son de la séance (alertes de virage). Voir useNavSound.
const { soundOn, toggleSound, soundVolume, setVolume } = useNavSound()
const activePanel = ref<string | null>(null)
// Le fond de carte de navigation est gouverné par le profil (comme le créateur) :
// on part du réglage du compte ; le sélecteur ne sert qu'à le changer en séance.
const mapStyleId = ref(navPrefs.default_style as string)

// ─── Carte hors-ligne (PMTiles swisstopo gris) ────────────────────────────────
// Une archive du corridor a-t-elle été téléchargée pour ce trajet ? Le bouton dédié
// (NavOfflineButton) gère le téléchargement ; ici on ne fait que basculer le fond vers
// la version locale quand le réseau tombe (cf. resolveBaseStyle / refreshBaseMap).
const offlineCoords = ref<[number, number][]>([])
// POI du tracé actif (issues de routes.pois) : passés à NavOfflineButton pour être
// sauvegardés dans le localStorage au moment du téléchargement hors-ligne.
const offlinePois = ref<Array<{ name: string; type: string; lat: number; lng: number }>>([])
// Repères du tracé actif (routes.markers) tels que reçus : useNavPois les convertit en
// NavPlace pour l'affichage, on garde ici la forme brute pour la session persistée.
const routeMarkersRaw = ref<RouteMarker[]>([])
// Sous-système cartes hors-ligne (téléchargement du corridor, bascule du fond en/hors
// réseau) : cf. useOfflineMaps. `offlineCoords`/`offlinePois` (état du tracé actif, aussi
// consommés par la session persistée) lui sont passés en entrée.
const {
  offlineIsSup, offlineDownloading, offlineErrored,
  offlineReady, offlineStale, offlinePct, offlineEst, offlineLayerRows, selectedLayers,
  toggleOfflineLayer,
  resolveBaseStyle, refreshBaseMap, noteBaseReloaded, syncOfflineState,
  startOfflineDownload, cancelOfflineDownload, removeOfflineMap,
} = useOfflineMaps({
  getMap: () => map,
  getMaplibre: () => maplibre,
  mapStyleId,
  routeToken,
  coords: offlineCoords,
  pois: offlinePois,
  onBaseStyleReload: () => afterStyleLoad(),
})

// Le panneau qui pilote normalement le téléchargement (NavOfflineButton, dans
// NavControlsPanel) est masqué dans l'appli mobile — voir companionBridge.ts pour
// le pourquoi. On s'enregistre tant que cette page est montée : l'appli obtient
// les mêmes trois gestes que le panneau web (démarrer, annuler, supprimer) sans
// qu'on réécrive le téléchargement côté Dart, et l'état poussé lui permet
// d'afficher une entrée de menu à jour (prêt, en cours, périmé, en échec).
registerOfflineMapsHandlers({
  start: () => { void startOfflineDownload() },
  cancel: cancelOfflineDownload,
  remove: () => { void removeOfflineMap() },
})
onBeforeUnmount(() => registerOfflineMapsHandlers(null))

// L'appli demande la veille depuis un bouton natif, sur une page de données
// qui n'a pas cette carte sous les yeux (voir SleepBlock côté Dart). On
// réutilise le chemin exact de l'appui long — toggleScreenOffManual, plus bas
// — pour que l'appli n'ait rien de plus à apprendre : même remise à zéro
// d'autoWoken, même message `screen` renvoyé en confirmation. Le garde
// `!screenOff.value` évite qu'un second appui (bouton retapé, page rechargée)
// ne rendorme ce qui vient de se réveiller.
registerSleepHandlers({
  enter: () => { if (!screenOff.value) toggleScreenOffManual() },
})
onBeforeUnmount(() => registerSleepHandlers(null))

watch(
  () => ({
    supported: offlineIsSup && !!routeToken.value,
    ready: offlineReady.value,
    stale: offlineStale.value,
    downloading: offlineDownloading.value,
    pct: offlinePct.value,
    mb: offlineEst.value.mb,
    tiles: offlineEst.value.tiles,
    errored: offlineErrored.value,
  }),
  (state) => pushOfflineMapsState(state),
  { immediate: true, deep: true },
)

// Réglages caméra (zoom), ajustables en séance et reportés sur le profil.
// La caméra reste toujours à plat (pitch 0) pour économiser la batterie. La boucle
// d'animation et followOptions lisent ces refs (et non plus navPrefs) pour que toute
// modification prenne effet à la frame suivante. onZoomInput détache la caméra du suivi
// via onManualZoom. Voir useNavCamera.
const {
  camZoom, zoomSaved, hasUnsavedZoom, savedZoom,
  onZoomInput, saveZoomToProfile,
} = useNavCamera({ getMap: () => map, onManualZoom })
// Curseur zoom pris en main : on détache la caméra du suivi (état local au composant).
function onManualZoom() {
  hasInitialZoom = true
  following.value = false
  cameraUnlocked.value = true
}

// ─── Largeur du tracé selon le zoom ────────────────────────────────────────────
// Loi base 2 ancrée sur le zoom de référence du profil, clampée (cf. navLineWidth). Défini
// AVANT useNavPois, qui reçoit zoomWidthScale pour caler la taille des POI sur celle des virages.
const { zoomWidthScale, zoomWidthExpr } = useNavLineWidth({
  refZoom: navPrefs.zoom ?? 16.5,
  minScale: 0.4,
  maxScale: 2.4,
  zoomMin: CAM_ZOOM_MIN,
  zoomMax: CAM_ZOOM_MAX,
})

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
  // « Naviguer ici » depuis le popup d'un POI : recalcule le tracé vers lui (remplace
  // l'itinéraire courant, comme une destination posée sur la carte).
  onNavigateTo: (place) => navigateTo(place.name, [place.lng, place.lat]),
  // « Ajouter à l'itinéraire » : insère le POI dans le tracé courant (au plus proche),
  // sans le remplacer. N'apparaît que lorsqu'un itinéraire est chargé.
  onInsertVia: (place) => insertViaIntoRoute(place.lng, place.lat),
  hasRoute: () => hasRoute.value,
})
const { POI_CATS, poiVisible, poiCounts, loading: poiLoading } = pois
// Toast transitoire (résultat de recherche POI, reroutage, reset, sauvegarde d'édition…),
// auto-effacé au bout de 3 s. Cf. useNavToast (gère aussi son nettoyage au démontage).
const { poiToast, showPoiToast } = useNavToast()

// Lance une recherche POI depuis le panneau de séance et affiche un toast de résultat.
// Les recherches automatiques (montage, chargement de tracé) restent silencieuses.
async function searchPois(opts: { center?: [number, number] } = {}) {
  const res = await pois.fetchPlaces(opts)
  if (!res.ok) { showPoiToast(false, t('routes.poi_search_error')); return }
  if (res.count === 0) { showPoiToast(true, t('routes.poi_search_none')); return }
  const key = res.count === 1 ? 'routes.poi_search_found_one' : 'routes.poi_search_found_other'
  showPoiToast(true, t(key, { count: res.count }))
}

// ─── Parcours des POI ──────────────────────────────────────────────────────────
// Enchaîne les POI visibles en volant de l'un à l'autre (cf. usePoiBrowse) : consomme les
// POI de useNavPois (`pois`) et débraye le suivi caméra le temps du parcours. `bumpPosTick`
// est appelé à chaque fix GPS pour rafraîchir la distance live du POI courant.
const {
  poiBrowseActive, poiBrowseIndex, poiBrowseFilter,
  poiBrowseCount, poiBrowseList, poiBrowseCats, poiBrowseDistM, poiBrowseHint,
  startPoiBrowse, setPoiBrowseFilter, browseNext, browsePrev, stopPoiBrowse,
  bumpPosTick,
} = usePoiBrowse({
  getMap: () => map,
  getVisiblePlaces: () => pois.visiblePlaces.value,
  poiCats: POI_CATS,
  openPlacePopup: pois.openPlacePopup,
  closePlacePopup: pois.closePlacePopup,
  following,
  cameraUnlocked,
  getContainerH: () => containerH,
  getLastPos: () => lastPos,
  hideControls: () => hideControls(),
})

// Garde l'écran allumé pendant la séance (Screen Wake Lock). Le composable gère sa
// propre reprise au retour au premier plan et sa libération au démontage.
const screenWake = useScreenWakeLock()
// Le bouton n'a de sens que pour un compte (persistNavCamera est un no-op hors-ligne).
const loggedIn = isLoggedIn()
const screenOff = ref(false)

// ─── Chrome cédé à l'application mobile ────────────────────────────────────────
// Dans l'appli, la coquille native possède le bas de l'écran (bandeau de valeurs,
// pages de données) et le bord droit (poignée de sortie de carte) — exactement où la
// page pose ses deux zones de révélation. Deux poignées superposées au même endroit,
// c'est un geste sur deux qui part au mauvais destinataire.
//
// La page rend donc les deux : le tiroir de commandes ne s'ouvre plus, et le geste de
// masquage disparaît. Elle rend aussi ce que ce geste servait à dégager et que l'appli
// affiche désormais elle-même — la barre d'avancement (distance, D+, ETA, progression)
// et le profil du col. Restent à la page le bandeau de virage, celui des POI et le voile
// de veille, dont l'appli ne sait rien.
//
// Constante et non réactive : le canal est injecté avant le premier rendu et ne
// disparaît jamais en cours de route.
const appOwnsChrome = inCompanionApp()

// ─── Auto-masquage des boutons (interface épurée en séance) ────────────────────
// Les commandes (retour, style de carte, son, caméra, POI) encombrent la
// vue une fois la séance lancée. On les affiche au démarrage (découvrabilité) puis
// on les estompe après quelques secondes d'inactivité ; un swipe vers le haut depuis
// le bas de l'écran les rappelle. On ne masque pas tant qu'un sous-panneau (caméra /
// POI / débug) est ouvert. Voir useControlsHide.
const { controlsVisible, armControlsHide, showControls, hideControls } = useControlsHide({
  isPanelOpen: () => activePanel.value !== null,
  closePanels: () => { activePanel.value = null },
  enabled: !appOwnsChrome,
})

// Ouverture du tiroir par un geste sur la zone de révélation. Sur mobile, le tap y
// produit un `click` de compatibilité juste après le pointerup : à cet instant le tiroir
// vient d'être démasqué mais glisse encore depuis le bas (transition 0,28 s), il n'est
// donc pas sous le doigt — le clic atterrissait sur la carte, dont le gestionnaire
// « clic hors du menu » le refermait aussitôt. D'où l'impression qu'il fallait presser
// deux fois. On horodate l'ouverture et la carte ignore le clic qui la suit de près.
const REVEAL_CLICK_GUARD_MS = 500
let controlsShownAt = 0
function revealControls() {
  controlsShownAt = performance.now()
  showControls()
}

// ─── Mise en veille par appui long ────────────────────────────────────────────
// Endormir demande de maintenir le doigt (anneau qui se remplit) ; réveiller reste un tap.
// Voir useSleepHold pour le pourquoi de l'asymétrie. Les modes qui donnent déjà un rôle au
// doigt sur la carte gardent la main : édition (pose d'ancrage), cible (point d'étape),
// tiroir ouvert (le tap le referme) — et la veille elle-même, où seul le réveil existe.
const {
  press: sleepPress,
  hint: sleepHint,
  onHoldDown: onSleepDown,
  onHoldMove: onSleepMove,
  onHoldUp: onSleepUp,
  cancelHold: cancelSleepHold,
  showHint: showSleepHint,
  attach: attachSleepHold,
} = useSleepHold({
  canHold: () => !screenOff.value && !editMode.value && !placeNavActive.value
    && !poiBrowseActive.value && !controlsVisible.value,
  onComplete: () => {
    // Le doigt est encore posé : le clic de compatibilité qui suivra le relâchement
    // tomberait sur la carte (bulle, point d'étape, rappel du geste). Même garde que
    // l'appui long de la bulle coordonnées.
    suppressNextMapClick = true
    setTimeout(() => { suppressNextMapClick = false }, 500)
    toggleScreenOffManual()
  },
})

// Tap là où, avant, l'écran s'endormait : on rappelle le geste plutôt que de ne rien
// faire. C'est le seul instant où l'on sait que quelqu'un cherchait la veille.
function onSleepZoneTap() {
  if (screenOff.value) { toggleScreenOffManual(); return }
  showSleepHint()
}

// ─── Zone de veille (bandeau haut) ────────────────────────────────────────────
// Le tiroir de commandes vit maintenant en bas : la bande haute n'est plus qu'une zone
// de tap dédiée à la veille — elle réveille d'un tap, et endort à l'appui long comme la
// carte (les mêmes gestionnaires y sont branchés). Aucun swipe à y écouter. Voir
// useRevealGesture.
const { onRevealDown, onRevealMove, onRevealUp, cancel: cancelReveal } = useRevealGesture({
  onTap: () => onSleepZoneTap(),
  canTap: () => true,
})

// La bande haute écoute les deux gestes sur les mêmes pointeurs. Le relâchement d'un appui
// qui a abouti n'y est pas un tap : sans ce filtre, il réveillerait aussitôt l'écran que
// l'appui vient d'éteindre (voir useSleepHold.onHoldUp).
function onSleepZoneDown(e: PointerEvent) { onRevealDown(e); onSleepDown(e) }
function onSleepZoneMove(e: PointerEvent) { onRevealMove(e); onSleepMove(e) }
function onSleepZoneUp(e: PointerEvent) {
  if (onSleepUp(e)) { cancelReveal(); return }
  onRevealUp(e)
}
function onSleepZoneCancel() { cancelReveal(); cancelSleepHold() }

// ─── Geste de révélation du tiroir (swipe vers le haut depuis le bord bas) ─────
// Swipe vers le haut → rappelle le tiroir de commandes, y compris en veille, par-dessus
// le voile noir. La zone couvre toute la barre du bas ; en veille, elle recouvre donc
// l'indice « tap pour reprendre » du voile : le tap y garde la sémantique du voile
// (réveil) et seul le swipe ouvre le tiroir. Voir useRevealGesture.
const {
  onRevealDown: onMenuDown,
  onRevealMove: onMenuMove,
  onRevealUp: onMenuUp,
  cancel: cancelMenuReveal,
} = useRevealGesture({
  onReveal: revealControls,
  onTap: () => { if (screenOff.value) toggleScreenOffManual(); else revealControls() },
  canTap: () => true,
  direction: 'up',
})

// ─── Masquage groupé des overlays du bas (cols / POI / avancement) ─────────────
// Un swipe de droite à gauche depuis le bord droit (ou un tap sur la poignée) bascule la
// visibilité de TOUS les overlays du bas d'un coup, pour dégager la carte. Geste
// horizontal : le vertical est pris par le tiroir de commandes, juste en dessous.
const bottomOverlaysVisible = ref(true)
const {
  onRevealDown: onBottomDown,
  onRevealMove: onBottomMove,
  onRevealUp: onBottomUp,
  cancel: cancelBottomReveal,
} = useRevealGesture({
  onReveal: () => { bottomOverlaysVisible.value = !bottomOverlaysVisible.value },
  onTap: () => { bottomOverlaysVisible.value = !bottomOverlaysVisible.value },
  canTap: () => true,
  direction: 'left',
})


// Live navigation state (reactive, drives the UI overlays)
const remainingM = ref(0)
const remainingGainM = ref(0)
const doneRatio = ref(0)
const speedKmh = ref(0)
// Arrivée à destination : bascule à vrai (une seule fois par tracé) quand la distance
// restante le long du tracé passe sous le seuil, avec les garde-fous anti-faux-positif
// d'arrivalStep. Son état (déjà été en route, restant du fix précédent) est porté d'un fix
// au suivant et remis à zéro avec le suivi.
const arrived = ref(false)
let arrivalState: ArrivalState = INITIAL_ARRIVAL_STATE
// Vitesse lissée dédiée à l'heure d'arrivée : voir smoothEtaSpeed.
const avgSpeedKmh = ref(0)
const offRoute = ref(false)
const offRouteRelBearing = ref(0)   // on-screen angle of the "back to route" arrow
// Reroutage manuel (bouton du bandeau hors-tracé) : appel BRouter en cours et dernier
// message d'erreur. Voir recalcRoute.
const rerouting = ref(false)
const rerouteError = ref<string | null>(null)
// Mode recherche (cible) / édition : l'utilisateur cherche un nouveau lieu / itinéraire ou
// retouche le tracé — la tête dans la carte et le clavier, pas sur la route. Bipper ou
// vibrer pour un virage du tracé qu'il s'apprête à abandonner ne serait que du bruit
// parasite. Base commune aux différentes sourdines ci-dessous.
const searchOrEditMuted = computed(() => placeNavActive.value || editMode.value)
// Sourdine des alertes du TRACÉ (virage, hors-trace, POI) — sons ET vibrations. On y
// ajoute le parcours des POI : pendant qu'il enchaîne ses POI à la main, on ne le
// dérange pas avec les indications du tracé.
const alertsMuted = computed(() => searchOrEditMuted.value || poiBrowseActive.value)
// Sourdine AUDIO des alertes du tracé = sourdine alertes OU tiroir de commandes affiché.
// Tant que le panneau de boutons est visible (l'utilisateur le consulte / ajuste un
// réglage), on coupe les sons (virage, hors-trace, POI) — un bip par-dessus le menu serait
// du bruit parasite. Les vibrations, elles, restent pilotées par alertsMuted.
const audioMuted = computed(() => alertsMuted.value || controlsVisible.value)

// Adopte le sport et le profil de routage d'un tracé chargé (liste ou lien partagé). Un
// tracé sauvegardé avant l'introduction des profils, ou avec un profil incohérent avec son
// sport, retombe sur le défaut catalogue du sport plutôt que d'être envoyé tel quel à
// BRouter (qui répondrait 500 sur un profil inconnu).
function adoptRouteRouting(route: any) {
  const sport = (route.activity as Sport) || 'cycling'
  routeSport.value = sport
  routeProfile.value = isProfileValidForSport(route.profile, sport) ? route.profile : catalogDefaultForSport(sport)
}

// Réglage de la séance, depuis le menu Itinéraire du tiroir. Le tracé suivi est aussitôt
// recalculé avec le nouveau profil quand on en a encore la source ; sinon le réglage
// s'appliquera au prochain calcul (reroutage, insertion de via, édition, destination).
function applyRouteRouting({ sport, profile }: { sport: Sport; profile: string }) {
  routeSport.value = sport
  routeProfile.value = profile
  void recomputeForRoutingChange()
}

// Bandeau d'erreur des calculs BRouter de la séance (destination, insertion de via).
const navError = ref<string | null>(null)
// Insertion d'un point intermédiaire dans le tracé en cours (POI / clic droit) : appel
// BRouter du détour en cours. Évite un double déclenchement et neutralise le bouton.
const viaInserting = ref(false)
const climbInfo = ref<ClimbInfo | null>(null)
// state : 'far' (lointain, bandeau discret) · 'near' (approche, violet/orange) ·
// 'now' (virage atteint, maintenu en vert quelques secondes comme confirmation).
const turnHint = ref<TurnHint | null>(null)
// Virages secondaires enchaînés au prochain (rafale gauche-droite) : affichés en petit
// sous le bandeau principal, éveillé comme en veille. Vide hors approche (état « near »).
const followTurns = ref<TurnHint[]>([])

// ─── Notification de proximité d'un point d'intérêt ────────────────────────────
// Quand le coureur passe à portée (≤ points_of_interest.alert_m, 100 m par défaut)
// d'un POI affiché, on montre un bandeau en bas (NavPoiBanner, au-dessus de la barre
// de progression) — le pendant « POI » de la notification de virage. `poiHint` pilote
// le bandeau (POI le plus proche dans le rayon, ou null). `announcedPoiKey` retient le
// dernier POI signalé (son + vibration) pour ne le faire qu'une fois par approche ;
// remis à zéro dès qu'on s'éloigne (poiHint repasse à null), pour réalerter en cas de
// repassage. Le rayon de notification est relu à chaque fix (réglable au profil).
const poiHint = ref<{ name: string; icon: string; color: string; distM: number } | null>(null)
let announcedPoiKey: string | null = null
// POI effectivement signalé par le bandeau (le bandeau n'en porte que l'affichage) :
// gardé pour le tap sur la notification, qui recadre la carte sur le coureur ET le POI
// (cf. focusPoiHint). Null quand le bandeau vient du mode débug (POI factice, sans
// coordonnées) — le tap retombe alors sur la bascule de veille.
let poiHintPlace: NavPlace | null = null

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let turnMarkers: any[] = []    // marqueurs DOM des indicateurs de virage (au-dessus des POI)
// ─── Flux animé du surlignage de virage ───────────────────────────────────────
// Le bout de tracé coloré autour du prochain virage porte un traitillé blanc qui défile
// vers l'avant : le sens du virage se lit sur la CARTE, à l'endroit où il faut tourner,
// sans avoir à décoder la flèche du bandeau. Même technique que le sens de parcours du
// créateur (RouteBuilderMap) : `line-dasharray` n'étant pas interpolable, on cycle sur une
// séquence de motifs dont la partie pleine avance d'un cran (période de 7 unités de
// largeur de trait). Déclaré ici, avec l'état de la carte : applyRouteLinePaint tourne dès
// le setup (watch immédiat) et lit ces constantes — plus bas, elles seraient en zone morte.
const TURN_FLOW_LAYER = 'nav-turn-flow'
const TURN_FLOW_DASHES: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
]
const TURN_FLOW_STEP_MS = 55
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
// Déplacement de la carte à deux doigts, au doigt seulement (pointeur grossier). En
// roulant, on vise ses boutons d'un pouce qui bouge : un appui qui dérive de quelques
// pixels partait en déplacement de carte, ce qui décrochait le suivi (onManualMove) et
// faisait apparaître « recentrer » — la carte s'en allait au moment précis où on essayait
// d'appuyer ailleurs. Deux doigts, c'est un geste qu'on ne fait pas par accident.
// `cooperativeGestures` de MapLibre fait exactement ça (touchPan passe à minTouches=2) ;
// il exige AUSSI Ctrl/⌘ pour zoomer à la molette, d'où la condition : à la souris le
// problème n'existe pas, et un zoom molette qui ne répond plus serait une régression.
// Le pinch (deux doigts) et le glissement d'un marqueur en mode édition (gestionnaires
// propres au marqueur) ne sont pas concernés.
const TWO_FINGER_PAN = window.matchMedia?.('(pointer: coarse)').matches ?? false
let turnFlowRaf: number | null = null
let turnFlowStep = -1
// Clé d'idempotence du surlignage du virage courant (cf. refreshTurnHighlight). Déclarée
// ici, avec l'état de la carte : applyRouteLinePaint tourne dès le setup (watch immédiat)
// et la lit — une déclaration plus bas dans le script la mettrait en zone morte.
let hiKey = ''
// Tooltip d'un point quelconque de la carte (clic droit / tap à deux doigts) : coordonnées
// copiables, Google Maps, Street View. Voir mapCoordPopup. L'appui long, qui l'ouvrait au
// doigt, sert désormais à la veille — d'où le tap à deux doigts, dans la même famille de
// gestes que le déplacement et le zoom (cf. TWO_FINGER_PAN). suppressNextMapClick
// neutralise le clic synthétique que laisse un geste abouti (appui long ou tap à deux
// doigts) : sans lui, il irait rappeler le geste de veille ou poser un point.
let coordPopup: any = null
let detachCoordTap: (() => void) | null = null
let detachSleepHold: (() => void) | null = null
let suppressNextMapClick = false

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
// Noms donnés à la main aux cols de CE tracé (routes.climb_names), réappariés à
// chaque recalcul par attachClimbNames — voir rebuildRouteState. Vide pour une
// destination ad hoc ou un reroutage hors-trace : attachClimbNames n'y change alors
// rien.
let routeClimbNames: ClimbName[] = []
let turns: TurnPoint[] = []
let turnsFromBRouter = false
// Voicehints bruts du tracé (lng/lat/cmd/angle) conservés pour reconstruire les virages
// après un reroutage : on ré-épissera ceux du tronçon restant aux hints du détour.
let rawHints: VoiceHint[] = []
// Sport et profil de routage BRouter DE LA SÉANCE. Ils pilotent tout ce qui appelle
// BRouter en navigation : reroutage hors-trace, insertion d'un point intermédiaire,
// édition des points d'ancrage, et le trajet d'une navigation vers un lieu (qui les reprend
// comme valeurs de départ). Réglables à tout moment via NavRoutingPicker, dans le menu
// Itinéraire du tiroir, sans jamais toucher au tracé sauvegardé ni aux préférences.
//
// Amorcés sur les préférences du compte, puis écrasés par le sport et le profil d'un tracé
// chargé (adoptRouteRouting) — un tracé se reroute comme il a été créé.
const routeSport = ref<Sport>(userPreferences().display.default_sport)
const routeProfile = ref<string>(routeProfileForSport(routeSport.value))
const routeName = ref('')

// ─── Navigation vers un lieu choisi sur la carte ───────────────────────────────
// Mode « cible » : on affiche une recherche (recadrage carte) + une consigne, puis chaque
// tap sur la carte pose un point d'étape ; « Naviguer ici » calcule un itinéraire depuis la
// position GPS à travers ces points et remplace le tracé courant (applyReroute). Tout le
// sous-système (points, aperçu BRouter, marqueurs) vit dans useDestinationNav — il ne
// partage avec la navigation que le tracé qu'il installe à la fin.
const {
  placeNavActive, destPoints, navSport, navProfile, navStarting,
  previewLoading, previewDistM, confirmLabel,
  startPlaceNav, cancelPlaceNav, confirmPlaceNav, applyNavRouting, onLocate,
  removeLastDestPoint, handleMapTap: handlePlaceNavTap, applyPreviewLinePaint, navigateTo,
} = useDestinationNav({
  getMap: () => map,
  getMaplibre: () => maplibre,
  getLastPos: () => lastPos,
  navError,
  routeSport, routeProfile, routeName, routeToken, following, cameraUnlocked,
  lineWidthExpr: () => zoomWidthExpr(routeLineWidth.value),
  applyReroute: (geom, hints) => applyReroute(geom, hints),
  setRouteVias: (vias) => { routeVias = vias },
  persistSession: () => persistSession(),
  hideControls: () => hideControls(),
})

// Réglages de navigation du sport de la séance : aspect du tracé, indicateurs de direction,
// distances et cadences des annonces de virage. Réglés PAR SPORT dans le profil — un virage
// annoncé 100 m à l'avance arrive dans 20 s à vélo et dans 80 s à pied, et on ne lit pas une
// carte au guidon comme un sentier à pied. Relus dès que le sport de la séance change (tracé
// chargé, choix manuel dans NavRoutingPicker).
const sportNav = computed(() => sportPreferences(routeSport.value).navigation)

// Largeur (px) du tracé ; la bordure ajoute 4 px de part et d'autre.
const routeLineWidth = computed(() => sportNav.value.line_width)
const routeBorderWidth = computed(() => routeLineWidth.value + 4)
// Flux animé du surlignage de virage : plus fin que le ruban coloré, pour que la couleur
// du virage reste visible de part et d'autre du traitillé blanc (dont la longueur suit,
// `line-dasharray` étant exprimé en multiples de la largeur du trait).
const turnFlowWidth = computed(() => Math.max(1.2, routeLineWidth.value * 0.45))
// Rayon (px) des pastilles de changement de direction.
const turnMarkerSize = computed(() => sportNav.value.turn_marker_size)

// ─── Opacité du tracé, ajustable en séance (glissé vertical, bord gauche) ──────
// Amorcée sur le réglage du profil, mais jamais écrite dedans : voir useTrackOpacityDrag.
// Un changement de sport écrase l'ajustement du geste — pas de raison de garder celui
// d'un autre sport, aux couleurs et à la largeur différentes.
const trackOpacity = ref(sportNav.value.line_opacity)
watch(sportNav, (nav) => { trackOpacity.value = nav.line_opacity })
const {
  dragging: opacityDragging,
  onDown: onOpacityDragDown,
  onMove: onOpacityDragMove,
  onUp: onOpacityDragUp,
  cancel: cancelOpacityDrag,
} = useTrackOpacityDrag({
  getOpacity: () => trackOpacity.value,
  setOpacity: (v) => { trackOpacity.value = v; applyTrackOpacity() },
})

// Changer de sport en séance rejoue tout ce qui a été peint avec ses réglages : le tracé
// (largeur, couleur, opacité) et les pastilles de virage, reconstruites en marqueurs DOM.
// Au passage, les modules hors composant qui lisent les préférences par sport (seuils de
// détection de cols dans routeHelpers) suivent le sport de la séance.
watch(routeSport, (sport) => {
  setActiveSport(sport)
  applyRouteLinePaint()
  renderTurnMarkers()
}, { immediate: true })

// Repeint les couches du tracé aux réglages du sport courant. Sans effet avant la pose des
// couches (navigation libre, style en cours de chargement) : installRouteLayers les crée
// déjà aux bonnes valeurs.
function applyRouteLinePaint() {
  if (!map) return
  const { line_color: color } = sportNav.value
  const opacity = trackOpacity.value
  if (map.getLayer('nav-route-border')) map.setPaintProperty('nav-route-border', 'line-width', zoomWidthExpr(routeBorderWidth.value, true))
  if (map.getLayer('nav-route-done')) {
    map.setPaintProperty('nav-route-done', 'line-width', zoomWidthExpr(routeLineWidth.value, true))
    map.setPaintProperty('nav-route-done', 'line-opacity', opacity)
  }
  if (map.getLayer('nav-route-remaining')) {
    map.setPaintProperty('nav-route-remaining', 'line-color', color)
    map.setPaintProperty('nav-route-remaining', 'line-width', zoomWidthExpr(routeLineWidth.value, true))
    map.setPaintProperty('nav-route-remaining', 'line-opacity', opacity)
  }
  if (map.getLayer('nav-turn-highlight')) {
    // La couleur, elle, suit le virage montré (orange/vert) : c'est refreshTurnHighlight
    // qui la pose — d'où le hiKey remis à zéro pour qu'un changement de sport la rejoue.
    map.setPaintProperty('nav-turn-highlight', 'line-width', zoomWidthExpr(routeLineWidth.value, true))
    map.setPaintProperty('nav-turn-highlight', 'line-opacity', opacity)
    hiKey = ''
    refreshTurnHighlight()
  }
  if (map.getLayer(TURN_FLOW_LAYER)) {
    map.setPaintProperty(TURN_FLOW_LAYER, 'line-width', zoomWidthExpr(turnFlowWidth.value, true))
    map.setPaintProperty(TURN_FLOW_LAYER, 'line-opacity', opacity)
  }
  applyPreviewLinePaint()
}

// Repeint uniquement l'opacité des couches du tracé, sans toucher largeur/couleur ni
// rejouer le surlignage de virage (hiKey) : c'est la version bon marché d'
// applyRouteLinePaint, appelée à chaque pointermove du geste d'opacité.
function applyTrackOpacity() {
  if (!map) return
  const opacity = trackOpacity.value
  if (map.getLayer('nav-route-done')) map.setPaintProperty('nav-route-done', 'line-opacity', opacity)
  if (map.getLayer('nav-route-remaining')) map.setPaintProperty('nav-route-remaining', 'line-opacity', opacity)
  if (map.getLayer('nav-turn-highlight')) map.setPaintProperty('nav-turn-highlight', 'line-opacity', opacity)
  if (map.getLayer(TURN_FLOW_LAYER)) map.setPaintProperty(TURN_FLOW_LAYER, 'line-opacity', opacity)
}

// ─── Trajet réellement parcouru (application companion) ────────────────────────
// La carte ne le calcule pas elle-même — elle ne sait pas où le cycliste est
// réellement passé, seulement où le tracé prévu l'emmène. C'est l'appli qui pousse
// les positions acceptées par son enregistreur (voir CLAUDE.md, TraveledPathTracker),
// en delta à chaque tic, avec un renvoi complet marqué `reset` après un rechargement
// de page. Style par défaut ci-dessous tant que `configureTraveledPath` n'est pas
// encore arrivé (premier rendu, avant que l'appli ait eu le temps de répondre).
const traveledPathColor = computed(() => companionStore.traveledPathStyle.value?.color ?? '#2196f3')
const traveledPathWidth = computed(() => companionStore.traveledPathStyle.value?.width ?? 4)
const traveledPathOpacity = computed(() => companionStore.traveledPathStyle.value?.opacity ?? 0.85)

function emptyLineStringFeature() {
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [] as number[][] } }
}

// Pose (ou replace) la couche du trajet parcouru — appelée au premier chargement de la
// carte, après chaque changement de style, ET à la fin d'installRouteLayers.
//
// INDÉPENDANTE du tracé prévu à dessein : contrairement à installRouteLayers, elle
// tourne aussi **en mode libre** (aucun itinéraire choisi), où `hasRoute` reste faux et
// installRouteLayers n'est jamais appelée — le trajet réellement parcouru n'a aucune
// raison de dépendre de l'existence d'un tracé à suivre.
//
// Idempotente (elle vérifie avant de créer) pour deux raisons : elle peut être rappelée
// sans qu'un style ait été rechargé entre-temps (un itinéraire choisi en pleine
// navigation libre), et parce qu'il faut alors REPOSITIONNER la couche déjà là — sinon
// elle resterait sous le tracé qu'on vient d'ajouter, ou pire, entièrement recouverte.
function installOrReorderTraveledPath() {
  if (!map) return
  const beforeId = map.getLayer('nav-turn-highlight') ? 'nav-turn-highlight' : undefined

  if (!map.getSource('nav-traveled')) {
    map.addSource('nav-traveled', { type: 'geojson', data: emptyLineStringFeature() })
  }
  if (!map.getLayer('nav-traveled-path')) {
    map.addLayer({
      id: 'nav-traveled-path',
      type: 'line',
      source: 'nav-traveled',
      layout: ROUTE_LINE_LAYOUT,
      paint: {
        'line-color': traveledPathColor.value,
        'line-width': zoomWidthExpr(traveledPathWidth.value, true),
        'line-opacity': traveledPathOpacity.value,
      },
    }, beforeId)
  } else if (beforeId) {
    map.moveLayer('nav-traveled-path', beforeId)
  }
  applyTraveledPathData()
}

// Repeint la ligne du trajet parcouru à son style courant, sans effet avant la pose de
// la couche (voir installOrReorderTraveledPath, qui la crée déjà aux bonnes valeurs).
function applyTraveledPathPaint() {
  if (!map || !map.getLayer('nav-traveled-path')) return
  map.setPaintProperty('nav-traveled-path', 'line-color', traveledPathColor.value)
  map.setPaintProperty('nav-traveled-path', 'line-width', zoomWidthExpr(traveledPathWidth.value, true))
  map.setPaintProperty('nav-traveled-path', 'line-opacity', traveledPathOpacity.value)
}
watch(companionStore.traveledPathStyle, applyTraveledPathPaint)

// Remplace la géométrie de la ligne par ce que le store a accumulé. `setData` seul,
// jamais `addLayer` : la couche existe déjà, poser une géométrie qui grandit ne coûte
// pas de rechargement de style — même idiome que `nav-route`/`nav-remaining`.
//
// Conversion `{lat, lng}` → `[lng, lat]` À CET ENDROIT SEULEMENT : c'est l'ordre GeoJSON,
// l'inverse de la lecture GPS habituelle, et c'est le seul point du fichier qui la fait —
// une inversion ici se verrait comme une diagonale à travers la carte plutôt que par une
// erreur de compilation.
function applyTraveledPathData() {
  if (!map) return
  const src = map.getSource('nav-traveled')
  if (!src) return
  const coordinates = companionStore.traveledPathPoints.value.map((p) => [ p.lng, p.lat ])
  src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })
}
watch(companionStore.traveledPathPoints, applyTraveledPathData)

// ─── Édition de l'itinéraire en séance ─────────────────────────────────────────
// Points d'ancrage (waypoints) de l'itinéraire chargé : source de vérité de l'édition.
// Présents pour un itinéraire chargé depuis la liste / un lien partagé ; vides pour une
// destination ad hoc (« naviguer ici ») ou après un reroutage hors-trace, où l'édition
// est désactivée (le tracé ne correspond plus à des points sauvegardés).
let routeWaypoints: Waypoint[] = []
// Identifiant de l'itinéraire sauvegardé (pour l'enregistrement des modifications via
// PATCH /api/routes/:id). null pour un lien partagé d'autrui ou une destination ad hoc.
let routeId: number | null = null

// ─── Sources de recalcul du tracé suivi ────────────────────────────────────────
// De quoi rejouer le calcul BRouter du tracé quand le profil de la séance change
// (recomputeForRoutingChange). Chaque forme de tracé garde une source différente :
//
//   itinéraire chargé   → routeWaypoints (ci-dessus), qui le reconstruit entièrement
//   destination ad hoc  → routeVias, les étapes traversées depuis la position
//   après un reroutage  → detourEndIdx, le sommet où le détour rejoint le tracé
//
// Étapes d'une destination ad hoc (« naviguer ici »), dans l'ordre, la dernière étant la
// destination. Conservées après un reroutage — c'est encore la meilleure source pour ce
// tracé-là. Vidées dès qu'on charge un itinéraire ou qu'on quitte le tracé.
let routeVias: LngLat[] = []
// Indice, dans `geometry`, du sommet où le détour issu du dernier reroutage rejoint le
// tracé d'origine ; -1 quand la tête du tracé n'est pas un détour. Devient caduc dès que
// le coureur a dépassé ce sommet (lastIdx >= detourEndIdx) : au-delà, il n'y a plus de
// détour à refaire, et le tracé d'origine n'a plus de source (ses points d'ancrage ont
// été jetés par applyReroute).
let detourEndIdx = -1

// ─── Édition de l'itinéraire en séance ─────────────────────────────────────────
// Points d'ancrage déplaçables, recalcul BRouter à chaque modification, enregistrement à
// la sortie du mode. Voir useRouteEditing : le tracé et ses sources restent la propriété
// du composant (tableaux non réactifs), le composable y accède par accesseurs.
const {
  editMode, editHintVisible, editBusy, editDirty, editError, editSaving, canEditRoute,
  syncEditable, installRecomputedRoute, recomputeFromWaypoints,
  enterEditMode, cancelEditMode, finishEditMode, closeEditMode, destroyEditOverlays,
  addEditWaypoint, closeEditPopup, hasEditPopup,
} = useRouteEditing({
  getMap: () => map,
  getMaplibre: () => maplibre,
  getGeometry: () => geometry,
  getRawHints: () => rawHints,
  getCumDistM: () => cumDistM,
  getWaypoints: () => routeWaypoints,
  setWaypoints: (w) => { routeWaypoints = w },
  getRouteId: () => routeId,
  loggedIn,
  routeProfile, hasRoute, following, cameraUnlocked,
  rebuildRouteState: (geom, hints) => rebuildRouteState(geom, hints),
  resetRouteTracking: (atStart) => resetRouteTracking(atStart),
  ensureRouteInstalled: () => ensureRouteInstalled(),
  refreshRemaining: () => refreshRemaining(),
  persistSession: () => persistSession(),
  clearDetour: () => { detourEndIdx = -1 },
  closeCoordPopup: () => closeCoordPopup(),
  hideControls: () => hideControls(),
  recenter: () => recenter(),
  showToast: (ok, message) => showPoiToast(ok, message),
})

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
// Annonces déjà jouées pour le virage courant (première détection, entrée en zone
// proche) : voir turnAlertStep.
let turnAlertState: TurnAlertState = INITIAL_TURN_ALERT_STATE
// Virage tout juste atteint, conservé pour le maintenir affiché en vert (confirmation
// « tournez ici » même à l'arrêt à un carrefour). On mémorise sa distance le long du
// tracé : le maintien dure tant qu'on n'a pas parcouru turn_green_hold_m après le virage.
let reachedTurn: ReachedTurn | null = null
// Index (dans `turns`) du virage tout juste atteint : sert à colorer en vert SA pastille
// sur la carte pendant le maintien « now ». -1 quand aucun virage n'est en maintien vert.
let reachedTurnIdx = -1
// Horodatage du moment où le virage courant a été atteint : sert à la limite de temps
// du maintien vert (cf. greenHoldMs), indépendante de la distance parcourue.
let reachedAtMs = 0
// La confirmation verte (« maintenant ») disparaît au PREMIER des deux seuils atteints :
// distance parcourue après le virage (turn_green_hold_m) ou temps écoulé (turn_green_hold_s).
// Les deux sont réglables par sport dans le profil.
const greenHoldM = computed(() => sportNav.value.turn_green_hold_m)
const greenHoldMs = computed(() => sportNav.value.turn_green_hold_s * 1000)
// Distance AVANT le virage à partir de laquelle on bascule en confirmation verte
// (« maintenant ») : la pastille passe au vert dès qu'on est à turn_now_m, sans
// attendre de l'avoir franchi.
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
let lastTurnReminderMs = 0   // timestamp of the last repeated turn cue
let lastOffRouteAlert = 0    // timestamp of the last off-route buzz
let lastAutoReroute = 0      // timestamp of the last automatic off-route recalculation
// Virage en cours d'annonce (dans la zone d'alerte) : la répétition du son est
// cadencée par un timer dédié (turnRepeatId) et non par les fixes GPS, sinon
// l'intervalle réel serait plafonné par la fréquence du GPS (souvent plusieurs
// secondes) au lieu de suivre la préférence turn_repeat_ms.
let activeTurn: { kind: Maneuver; direction: 'left' | 'right' } | null = null
// Vrai quand le virage armé est dans la zone orange (≤ turn_urgent_m) : la répétition
// du son passe alors à l'intervalle plus court turn_repeat_urgent_ms.
let activeTurnUrgent = false
let turnRepeatId: number | null = null
// Sourdine du virage courant : l'utilisateur a demandé à ne plus être alerté
// (son + vibration) pour le virage actuellement en approche. Remis à false
// automatiquement dès que nextTurnPtr avance (nouveau virage).
const turnAlertMuted = ref(false)
let mutedTurnPtr = -1

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
// reprend alors toute la hauteur, donc on ne la rétrécit pas dans ce cas. Idem
// hors-tracé (offRoute) et en édition (editMode), où la carte de col n'est pas rendue.
// Affichage du profil des cols (carte d'altitude en bas d'écran), basculable depuis
// le tiroir de commandes. Valeur initiale issue du profil (section Navigation) ;
// masqué, la carte n'est plus rétrécie et le bas de l'écran est dégagé.
//
// Toujours masqué dans l'appli, qui dessine le profil du col elle-même : c'est le point
// d'extinction unique du col (isClimbing en découle, donc le rétrécissement de la carte
// et le redimensionnement MapLibre suivent sans qu'on ait à les traiter à part). Rien ne
// peut le rallumer, la bascule vivant dans le tiroir de commandes, lui aussi rendu.
const showClimbCard = ref(appOwnsChrome ? false : (navPrefs.show_climb_card ?? true))
// La carte n'est rétrécie que quand la carte de col est EFFECTIVEMENT affichée : cette
// condition doit donc rester alignée sur le v-if de NavClimbCard (showClimbCard +
// overlays du bas visibles + col en cours + ni approche de virage, ni hors-tracé, ni
// édition, ni parcours POI). Sinon la carte se rétrécit pour un panneau absent, laissant
// un vide en bas.
const isClimbing = computed(() =>
  showClimbCard.value && bottomOverlaysVisible.value && climbInfo.value != null
  && !approachingTurn.value && !offRoute.value && !editMode.value && !poiBrowseActive.value)
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
// Interpolation GPS (dead-reckoning + lissage du cap) entre deux fixes. Désactivée en
// dur : le marqueur et la caméra se posent directement sur chaque fix (position snappée
// sur le tracé si on y est, sinon GPS brut), et la flèche prend le cap du fix sans
// transition — la position ne « glisse » plus entre les fixes. Le snapping sur le tracé
// reste actif (il ne relève pas de l'interpolation). Repasser à true rétablit le glissé.
const GPS_INTERPOLATION = false
let containerH = 0                     // hauteur du conteneur carte, rafraîchie au resize
let lastTickT = 0                      // performance.now() de la dernière frame rendue

const donePercent = computed(() => Math.round(doneRatio.value * 100))

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
// Panneau d'injection de données factices (virage, col, POI) pour prévisualiser
// les overlays sans GPS. Voir useNavDebug : les gardes dbgTurn / dbgClimb /
// dbgPoi ci-dessous empêchent les mises à jour live d'écraser l'overlay inspecté.
const {
  debugMode, dbgClimb, dbgTurn, dbgPoi, dbgTurnLabel,
  cycleDebugTurn, toggleDebugClimb, toggleDebugPoi,
} = useNavDebug({
  canDebug: props.canDebug,
  getTurnUrgentM: () => sportNav.value.turn_urgent_m,
  hasFix, turnHint, followTurns, climbInfo, poiHint, soundOn,
})

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    // Lien partagé : on charge l'itinéraire AVANT la carte pour qu'initMap cadre
    // directement sur le tracé. Sans token, on démarre en navigation libre.
    if (props.shareToken) {
      try { await loadSharedRouteData(props.shareToken) } catch { /* tracé introuvable : on reste en libre */ }
    } else if (props.fresh) {
      // « Navigation libre » choisie dans un menu : on veut la carte nue, pas l'itinéraire
      // de tout à l'heure. On efface la session et on retire `fresh` de l'URL pour qu'un
      // rechargement ultérieur (séance en cours) reprenne bien ce qu'on suit alors.
      clearNavSession()
      stripFreshParam()
    } else {
      // Rechargement de page en pleine séance : on reprend le tracé mémorisé (itinéraire
      // chargé ou destination ad hoc) au lieu de repartir en navigation libre.
      restoreSession()
    }
    await initMap()
    startTracking()
    // POI sauvegardés de l'utilisateur (table `pois`) : rendus en permanence dès que la
    // carte est prête, indépendamment de toute recherche Overpass.
    void pois.loadSavedPois()
    // Recherche Overpass des POI du profil (best-effort, non bloquant) : les
    // marqueurs apparaissent dès que la réponse arrive, la carte est déjà prête.
    // Sans tracé (mode libre), les POI ne se chargent qu'à la demande (« autour de moi »).
    if (hasRoute.value) void pois.fetchPlaces()
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
  stopTurnFlow()
  window.removeEventListener('pointerdown', onFirstGesture, true)
  window.removeEventListener('touchstart', onFirstGesture, true)
  window.removeEventListener('online', refreshBaseMap)
  window.removeEventListener('offline', refreshBaseMap)
  window.removeEventListener('resize', refreshContainerH)
  if (detachCoordTap) { detachCoordTap(); detachCoordTap = null }
  if (detachSleepHold) { detachSleepHold(); detachSleepHold = null }
  closeCoordPopup()
  closeTurnPopup()
  destroyEditOverlays()
  // Quitter la navigation en veille ne doit pas laisser le téléphone à 1 % de
  // luminosité sur l'écran suivant. L'appli reprend le même réflexe de son côté,
  // pour le cas où c'est la page entière qui disparaît.
  companionScreen('normal')
  if (map) { map.remove(); map = null }
})

function onFirstGesture() {
  unlockAudio()
  if (!screenWake.isHeld()) screenWake.acquire()
}

// ─── Data ───────────────────────────────────────────────────────────────────

// Charge un itinéraire partagé par token AVANT que la carte ne soit prête (montage
// d'un lien partagé) : on ne fait qu'alimenter l'état (rebuildRouteState) ; initMap
// installera les couches et cadrera sur le tracé. Lève si le tracé est introuvable
// ou trop court → l'appelant retombe sur le mode libre.
async function loadSharedRouteData(token: string) {
  const res = await fetch(`/api/routes/shared/${token}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(t('routes.error_routing'))
  const data = await res.json()
  const route = data.route || data
  const geom = (route.geometry || []) as Coord[]
  if (geom.length < 2) throw new Error(t('routes.error_min_points'))
  routeToken.value = token
  routeName.value = route.name || ''
  adoptRouteRouting(route)
  routeId = typeof route.id === 'number' ? route.id : null
  routeWaypoints = Array.isArray(route.waypoints) ? route.waypoints : []
  routeVias = []
  routeClimbNames = Array.isArray(route.climb_names) ? route.climb_names : []
  rebuildRouteState(geom, (route.voice_hints || []) as VoiceHint[])
  const savedPois = (route.pois || []) as Array<{ name: string; type: string; lat: number; lng: number }>
  offlinePois.value = savedPois
  if (savedPois.length > 0) pois.setRoutePlaces(savedPois)
  routeMarkersRaw.value = (route.markers || []) as RouteMarker[]
  pois.setRouteMarkers(routeMarkersRaw.value)
  hasRoute.value = true
  syncEditable()
  persistSession()
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
  climbs = attachClimbNames(detectClimbs(alts, cumDistM), geometry, routeClimbNames)
  companionRouteClimbs(buildCompanionRouteClimbs(climbs, cumDistM))
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
// On passe le cap courant à BRouter (heading) : le moteur interdit alors un demi-tour
// collé au départ et repart vers l'avant — voir fetchRouteToPlace / headingParam.
//
// Le choix du point de raccord, les étapes restantes et l'épissage lui-même sont de la
// géométrie pure : ils vivent dans navReroute (rejoinIndexAhead, viasAhead, spliceDetour).
// Ne reste ici que l'orchestration : garde anti-concurrence, appels BRouter, état.

let rerouteToken = 0

// Refait le trajet d'une destination ad hoc depuis la position, par les étapes restantes.
async function recomputeVias(): Promise<boolean> {
  const ahead = viasAhead(routeVias, geometry, lastIdx)
  if (!lastPos || ahead.length === 0) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  rerouting.value = true
  const token = ++rerouteToken
  const from = lastPos
  try {
    const { geometry: geom, hints } = await fetchRouteVia([from, ...ahead], routeProfile.value)
    if (token !== rerouteToken) return false
    applyReroute(geom, hints)
    routeVias = ahead   // les étapes franchies sortent définitivement de la source
    return true
  } catch {
    return false
  } finally {
    if (token === rerouteToken) rerouting.value = false
  }
}

// Rejoue le calcul BRouter du tracé suivi avec le profil de la séance qu'on vient de
// changer, en se servant de la meilleure source encore disponible (cf. « Sources de
// recalcul »). Un tracé sauvegardé déjà rerouté et dont on a franchi le raccord n'a plus
// de source : il conserve le profil avec lequel il a été calculé.
//
// Un recalcul déjà en vol porterait l'ancien profil. On libère donc la garde `rerouting`
// avant d'en lancer un nouveau : les fonctions appelées incrémentent leur jeton, ce qui
// périme la réponse en vol — son `finally` ne détiendra plus le jeton courant et ne
// touchera plus à la garde, c'est à nous de le faire.
async function recomputeForRoutingChange() {
  if (!hasRoute.value) return
  rerouting.value = false
  rerouteError.value = null

  // Hors-trace, le détour part de la position : il prime sur toute autre source.
  if (offRoute.value) { void recalcRoute(); return }

  let done: boolean
  if (routeWaypoints.length >= 2) {
    // Itinéraire chargé : reconstruit de bout en bout depuis ses points d'ancrage.
    done = await recomputeFromWaypoints({ markDirty: editMode.value })
  } else if (routeVias.length > 0) {
    done = await recomputeVias()
  } else if (detourEndIdx > 0 && lastIdx < detourEndIdx) {
    // Détour d'un reroutage, pas encore parcouru : on le refait jusqu'au même raccord.
    done = await rerouteToward(detourEndIdx)
  } else {
    return
  }
  // Le tracé recalculé est visible sur la carte ; seul l'échec mérite d'être signalé.
  if (!done) showPoiToast(false, t('routes.reroute_failed'))
}

async function recalcRoute() {
  if (rerouting.value || !offRoute.value || !lastPos || geometry.length < 2) return
  // Arme le cooldown du recalcul auto pour TOUTE tentative (auto ou manuelle, en ligne
  // comme hors-ligne) : un appui manuel décale d'autant la prochaine relance auto, et un
  // échec hors-ligne n'enchaîne pas une rafale de tentatives.
  lastAutoReroute = performance.now()
  const fromIdx = Math.max(0, Math.min(lastIdx, geometry.length - 1))
  await rerouteToward(rejoinIndexAhead(geometry, cumDistM, lastPos, currentBearing, fromIdx))
}

// Calcule un détour de la position courante jusqu'au sommet `rejoinIdx` du tracé, puis
// l'épisse devant la suite inchangée. Cœur commun au reroutage hors-trace (recalcRoute,
// manuel ou auto) et à la reprise du détour après un changement de profil, qui vise le
// même point de raccord (recomputeForRoutingChange).
async function rerouteToward(rejoinIdx: number): Promise<boolean> {
  if (rerouting.value || !lastPos || geometry.length < 2) return false
  if (rejoinIdx <= 0 || rejoinIdx >= geometry.length) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    rerouteError.value = t('routes.reroute_offline')
    return false
  }
  rerouting.value = true
  rerouteError.value = null
  const token = ++rerouteToken
  const from = lastPos
  try {
    const target = geometry[rejoinIdx]
    // Cap de départ passé à BRouter pour interdire un demi-tour collé au départ, mais
    // seulement en mouvement : à l'arrêt currentBearing est figé sur le dernier
    // déplacement et orienterait le routage au hasard, donc on l'omet (undefined).
    const heading = speedKmh.value / 3.6 > MIN_SPEED_MS ? currentBearing : undefined
    const { geometry: detour, hints: detourHints } = await fetchRouteToPlace(from, [target[0], target[1]], routeProfile.value, heading)
    // Réponse périmée (clic plus récent) ou composant démonté : on n'écrase rien.
    if (token !== rerouteToken) return false

    // Épissage : détour (départ → raccord) + suite inchangée du tracé original, dont on
    // conserve les voicehints. Voir spliceDetour.
    const spliced = spliceDetour(geometry, rawHints, detour, detourHints, 0, rejoinIdx)
    applyReroute(spliced.geometry, spliced.hints)
    // Le détour occupe désormais la tête du tracé : on retient où il se raccorde, pour
    // pouvoir le refaire au même endroit si le profil change avant qu'on l'ait parcouru.
    // applyReroute a remis lastIdx à 0, donc le raccord est bien devant nous.
    detourEndIdx = detour.length
    return true
  } catch {
    if (token === rerouteToken) rerouteError.value = t('routes.reroute_failed')
    return false
  } finally {
    if (token === rerouteToken) rerouting.value = false
  }
}

// Réinitialise tout l'état de suivi d'un nouveau tracé (pointeurs de virage, snapping,
// hors-trajet, sourdines). `atStart` : vrai quand le tracé part de la position du
// coureur (reroutage, « naviguer ici ») → on l'ancre à l'index 0 et on reste « localisé »
// pour des recherches fenêtrées vers l'avant. Faux pour un itinéraire chargé tel quel
// (lien partagé, dialogue) → `located = false` force une recherche globale du point le
// plus proche au prochain fix, le coureur pouvant être n'importe où sur le tracé.
function resetRouteTracking(atStart: boolean) {
  located = atStart
  lastIdx = 0
  snapPoint = null
  displaySnapPoint = null
  snapNextIdx = 0
  snapDistAlongM = 0
  nextTurnPtr = 0
  turnAlertState = INITIAL_TURN_ALERT_STATE
  reachedTurn = null
  reachedTurnIdx = -1
  activeTurn = null
  turnHint.value = null
  followTurns.value = []
  turnAlertMuted.value = false
  mutedTurnPtr = -1
  // Nouveau tracé (ou reroutage) : on réarme la détection d'arrivée.
  arrived.value = false
  arrivalState = INITIAL_ARRIVAL_STATE
  // Recalculé au prochain fix ; remis à faux pour que le bandeau hors-tracé disparaisse.
  offRoute.value = false
  // La progression mémorisée pointe un passage de l'ancien tracé : on l'efface.
  clearProgress(routeToken.value)
}

// Réinitialisation manuelle depuis Réglages : repart d'une ardoise propre côté
// progressions mémorisées (cf. clearAllProgress) et relance le suivi en cours — recherche
// globale du point le plus proche au prochain fix.
//
// On RECONSTRUIT aussi tout ce qui est dérivé du tracé (virages, cols, distances) : sans
// ça, le bouton ne remettait à zéro que les pointeurs de suivi, et une chaîne de virages
// abîmée — ce pour quoi on l'actionne — survivait intacte. « Rien ne se passe » : il
// fallait sortir de la navigation et y revenir.
function resetNavigationState() {
  clearAllProgress()
  if (hasRoute.value) {
    rebuildRouteState(geometry, rawHints)
    resetRouteTracking(false)
    ensureRouteInstalled()
    refreshRemaining()
  }
  activePanel.value = null
  showPoiToast(true, t('routes.nav_reset_done'))
}

// Installe (ou met à jour) les couches du tracé sur la carte. En mode libre, aucune
// source n'existe encore : on les crée. Si elles existent déjà (reroutage en séance),
// on se contente de remplacer les données. Puis on (re)pose les marqueurs de virage.
function ensureRouteInstalled() {
  if (!map) return
  const src = map.getSource('nav-route')
  if (src) src.setData(widthRunsCollection(displayLine, displayWScale))
  else installRouteLayers()
  renderTurnMarkers()
}

// Remplace la géométrie de navigation par l'itinéraire rerouté et réinitialise le suivi.
// Le tracé part TOUJOURS de la position du coureur (détour calculé depuis lastPos).
function applyReroute(newGeometry: Coord[], hints: VoiceHint[]) {
  rebuildRouteState(newGeometry, hints)
  resetRouteTracking(true)
  hasRoute.value = true
  // Le tracé ne correspond plus à des points d'ancrage sauvegardés (détour depuis la
  // position GPS, ou destination ad hoc) : on désactive l'édition.
  routeWaypoints = []
  routeId = null
  // Les indices de `geometry` viennent de changer : tout détour retenu est caduc.
  // rerouteToward, seul à en produire un, le réarme juste après cet appel.
  detourEndIdx = -1
  syncEditable()
  ensureRouteInstalled()
  refreshRemaining()
  persistSession()
}

// ─── Session persistée (reprise après rechargement) ────────────────────────────
// Ce qu'on suit — itinéraire chargé ou destination ad hoc — survit à un rechargement de
// page : on réécrit la session à chaque changement de tracé (chargement, reroutage,
// insertion d'étape, édition) et on la restaure au montage en l'absence de lien partagé.
// Voir navSession.ts pour le format et la péremption.
function persistSession() {
  if (!hasRoute.value) { clearNavSession(); return }
  saveNavSession({
    name: routeName.value,
    token: routeToken.value,
    routeId,
    sport: routeSport.value,
    profile: routeProfile.value,
    geometry,
    hints: rawHints,
    waypoints: routeWaypoints,
    vias: routeVias,
    pois: offlinePois.value,
    markers: routeMarkersRaw.value,
    climbNames: routeClimbNames,
  })
}

// Restaure le tracé mémorisé AVANT la carte (comme un lien partagé) : initMap cadre
// alors directement dessus. On ne réinitialise PAS le suivi (resetRouteTracking effacerait
// la progression mémorisée) : le premier fix se recale via l'indice de reprise, exactement
// comme au chargement d'un lien partagé. Renvoie faux s'il n'y a rien à restaurer.
function restoreSession(): boolean {
  const s = loadNavSession()
  if (!s) return false
  routeToken.value = s.token
  routeName.value = s.name
  routeSport.value = s.sport
  routeProfile.value = isProfileValidForSport(s.profile, s.sport) ? s.profile : catalogDefaultForSport(s.sport)
  routeId = s.routeId
  routeWaypoints = s.waypoints
  routeVias = s.vias
  // `Array.isArray` : une session écrite avant l'ajout de ce champ n'en a pas —
  // sans ce filet, attachClimbNames planterait sur un `undefined.length`.
  routeClimbNames = Array.isArray(s.climbNames) ? s.climbNames : []
  rebuildRouteState(s.geometry, s.hints)
  offlinePois.value = s.pois
  if (s.pois.length > 0) pois.setRoutePlaces(s.pois)
  routeMarkersRaw.value = s.markers
  pois.setRouteMarkers(s.markers)
  hasRoute.value = true
  syncEditable()
  return true
}

// Retire `?fresh=1` de l'URL sans recharger : le paramètre n'est qu'une intention de
// départ. S'il restait, charger un itinéraire puis recharger la page (batterie, crash)
// effacerait la session au lieu de la reprendre.
function stripFreshParam(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('fresh')) return
    url.searchParams.delete('fresh')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch { /* URL exotique : sans importance */ }
}

// ─── Chargement / déchargement d'un itinéraire (page unifiée) ──────────────────
// Charge un itinéraire complet (lien partagé ou itinéraire sauvegardé choisi dans la
// dialogue) et passe en navigation sur itinéraire. Le coureur peut être n'importe où
// sur le tracé → recherche globale au prochain fix (resetRouteTracking(false)). On
// cadre la vue sur l'ensemble du tracé, puis le suivi reprend dès le premier fix.
function loadRoute(route: any) {
  const geom = (route.geometry || []) as Coord[]
  if (geom.length < 2) { navError.value = t('routes.error_min_points'); return }
  routeToken.value = (route.share_token as string) || null
  routeName.value = route.name || t('routes.destination')
  adoptRouteRouting(route)
  routeId = typeof route.id === 'number' ? route.id : null
  routeWaypoints = Array.isArray(route.waypoints) ? route.waypoints : []
  routeVias = []
  routeClimbNames = Array.isArray(route.climb_names) ? route.climb_names : []
  rebuildRouteState(geom, (route.voice_hints || []) as VoiceHint[])
  const savedPois = (route.pois || []) as Array<{ name: string; type: string; lat: number; lng: number }>
  offlinePois.value = savedPois
  void syncOfflineState()
  if (savedPois.length > 0) pois.setRoutePlaces(savedPois)
  routeMarkersRaw.value = (route.markers || []) as RouteMarker[]
  pois.setRouteMarkers(routeMarkersRaw.value)
  resetRouteTracking(false)
  hasRoute.value = true
  syncEditable()
  persistSession()
  showRoutePicker.value = false
  ensureRouteInstalled()
  refreshRemaining()
  // Cadre sur l'ensemble du tracé puis rend la caméra au suivi.
  if (map && maplibre) {
    const coords = geom.map(([lng, lat]) => [lng, lat] as LngLat)
    const b = new maplibre.LngLatBounds(coords[0], coords[0])
    coords.forEach((c) => b.extend(c))
    map.fitBounds(b, { padding: 60, duration: 600, pitch: 0 })
  }
  following.value = true
  cameraUnlocked.value = false
  void pois.fetchPlaces()
}

// Décharge l'itinéraire courant et revient à la navigation libre : on retire les
// couches du tracé, les marqueurs de virage, et on remet à zéro l'état d'itinéraire.
// Le suivi GPS continue (le prochain fix s'ancre sur la position brute).
function unloadRoute() {
  // Sort proprement du mode édition (retire marqueurs / popup) avant de tout effacer.
  if (editMode.value) closeEditMode()
  // Le geste de masquage groupé n'existe qu'en navigation sur itinéraire : on réaffiche.
  bottomOverlaysVisible.value = true
  routeWaypoints = []
  routeVias = []
  detourEndIdx = -1
  routeId = null
  syncEditable()
  hasRoute.value = false
  routeToken.value = null
  routeName.value = ''
  offlinePois.value = []
  routeMarkersRaw.value = []
  clearNavSession()
  void syncOfflineState()
  geometry = []
  displayLine = []
  displayWScale = []
  alts = []
  cumDistM = []
  climbs = []
  routeClimbNames = []
  companionRouteClimbs(buildCompanionRouteClimbs([], []))
  // Un `startIdx` est un indice dans CE tracé : le prochain trajet chargé peut,
  // par pure coïncidence, ouvrir un col au même indice numérique. Sans ce reset,
  // le cache le prendrait pour « déjà affiché » et ne republierait jamais son
  // climb_profile vers l'appli.
  profileForStart = -1
  profileCache = null
  turns = []
  rawHints = []
  turnHint.value = null
  followTurns.value = []
  // État de suivi des virages : sans ça, `activeTurn` reste pointé sur le dernier
  // virage et le timer de répétition (tickTurnRepeat) continue de jouer l'alerte sonore
  // indéfiniment après l'effacement du tracé (typiquement quand on efface à un carrefour,
  // alerte en cours). On remet aussi à zéro les pointeurs/anti-rejeu pour repartir propre.
  nextTurnPtr = 0
  turnAlertState = INITIAL_TURN_ALERT_STATE
  reachedTurn = null
  reachedTurnIdx = -1
  activeTurn = null
  activeTurnUrgent = false
  turnAlertMuted.value = false
  mutedTurnPtr = -1
  climbInfo.value = null
  offRoute.value = false
  arrived.value = false
  arrivalState = INITIAL_ARRIVAL_STATE
  remainingM.value = 0
  remainingGainM.value = 0
  doneRatio.value = 0
  for (const m of turnMarkers) m.remove()
  turnMarkers = []
  if (map) {
    stopTurnFlow()
    // 'nav-traveled-path'/'nav-traveled' n'y sont PAS : retirer l'itinéraire ne doit
    // pas effacer où on est réellement passé, et installOrReorderTraveledPath est de
    // toute façon idempotente — rien ne la force à être recréée ici.
    for (const id of ['nav-route-border', 'nav-route-done', 'nav-route-remaining', 'nav-turn-highlight', TURN_FLOW_LAYER]) {
      if (map.getLayer(id)) map.removeLayer(id)
    }
    for (const id of ['nav-route', 'nav-remaining', 'nav-turn-hi']) {
      if (map.getSource(id)) map.removeSource(id)
    }
  }
  // L'ancre repart sur le GPS brut ; on relance la boucle pour figer la flèche.
  anchorOnRoute = false
  if (lastPos) { anchorPos = lastPos; anchorTime = performance.now() }
}

// ─── Insertion d'un point intermédiaire dans le tracé ──────────────────────────
// Contrairement à « Naviguer ici » (qui remplace tout par un trajet depuis la position
// GPS), on insère le point dans l'itinéraire courant au plus proche : on repère le
// sommet du tracé le plus proche, on route un détour [ancrage amont → point → ancrage
// aval] via BRouter, et on l'épisse entre les portions inchangées (tête + queue). Les
// voicehints des portions conservées sont réutilisés, ceux du détour insérés au milieu.
const VIA_ANCHOR_GAP_M = 40

async function insertViaIntoRoute(lng: number, lat: number) {
  if (!hasRoute.value || geometry.length < 2 || viaInserting.value) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    navError.value = t('routes.reroute_offline')
    return
  }
  viaInserting.value = true
  navError.value = null
  try {
    // Sommet du tracé le plus proche du point à insérer.
    const nearIdx = nearestGeomIndex([lng, lat], geometry).idx
    // Ancrages du détour, ~40 m de part et d'autre du sommet le plus proche, pour
    // laisser BRouter raccorder proprement le passage par le nouveau point.
    const { a, b } = detourAnchors(geometry, cumDistM, nearIdx, VIA_ANCHOR_GAP_M)
    const { geometry: detour, hints: detourHints } = await fetchRouteVia(
      [[geometry[a][0], geometry[a][1]], [lng, lat], [geometry[b][0], geometry[b][1]]],
      routeProfile.value,
    )
    // Le détour remplace la portion a…b ; les voicehints des portions conservées (tête et
    // queue) sont réutilisés. Voir spliceDetour.
    const spliced = spliceDetour(geometry, rawHints, detour, detourHints, a, b + 1)
    // Garde les points d'ancrage en phase avec la géométrie : le point inséré devient un
    // vrai ancrage (au bon rang), pour que l'édition ultérieure ne le perde pas. Calculé
    // sur l'ancienne géométrie (nearIdx), avant qu'elle ne soit remplacée ci-dessous.
    if (routeWaypoints.length >= 2) routeWaypoints.splice(waypointInsertIndex(geometry, routeWaypoints, lng, lat, nearIdx), 0, { lng, lat })
    rebuildRouteState(spliced.geometry, spliced.hints)
    // Le tracé a changé : on relocalise au prochain fix (le coureur peut être n'importe
    // où dessus) plutôt que de repartir du début.
    resetRouteTracking(false)
    ensureRouteInstalled()
    refreshRemaining()
    persistSession()
  } catch {
    navError.value = t('routes.error_routing')
  } finally {
    viaInserting.value = false
  }
}

// ─── Map ──────────────────────────────────────────────────────────────────────

function refreshContainerH() { containerH = map?.getContainer()?.clientHeight || 0 }

function closeCoordPopup() {
  if (coordPopup) { coordPopup.remove(); coordPopup = null }
}

// Tooltip d'un point quelconque de la carte (clic droit / appui long n'importe où) :
// coordonnées copiables, Google Maps, Street View. Sans effet sur la navigation.
function showCoordPopup(lng: number, lat: number) {
  if (!maplibre || !map) return
  closeCoordPopup()
  // Avec un tracé chargé, le popup propose d'y insérer ce point (au plus proche). En
  // navigation libre (sans tracé), pas d'insertion possible : tooltip informative seule.
  const onAdd = hasRoute.value
    ? (plng: number, plat: number) => { closeCoordPopup(); void insertViaIntoRoute(plng, plat) }
    : undefined
  coordPopup = new maplibre.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([lng, lat])
    .setDOMContent(buildCoordPopupContent(lng, lat, closeCoordPopup, onAdd))
    .addTo(map)
}

async function initMap() {
  maplibre = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  // Branche l'archive hors-ligne du trajet (si déjà téléchargée) AVANT de construire le
  // style, pour pouvoir démarrer directement sur le fond local en cas de lancement
  // sans réseau.
  // Hors-ligne indisponible en mode libre (aucun token de trajet à archiver).
  await syncOfflineState()
  noteBaseReloaded()

  const coords = geometry.map(([lng, lat]) => [lng, lat] as LngLat)
  map = new maplibre.Map({
    container: mapEl.value,
    style: resolveBaseStyle(mapStyleId.value) as any,
    // Mode itinéraire : on part du départ du tracé (recadré sur l'ensemble au load).
    // Mode libre : vue d'ensemble de la Suisse jusqu'au premier fix GPS.
    center: hasRoute.value ? coords[0] : DEFAULT_CENTER,
    zoom: hasRoute.value ? 14 : DEFAULT_ZOOM,
    // Caméra toujours à plat (économie de batterie) : maxPitch 0 verrouille aussi
    // l'inclinaison au geste tactile.
    pitch: 0,
    maxPitch: 0,
    attributionControl: false,
    // Tap plus tolérant : on conduit d'un pouce, en mouvement, et un appui « simple »
    // dérive souvent de quelques pixels. Au seuil par défaut (3 px), MapLibre prend ce
    // micro-déplacement pour un déplacement de carte et n'émet PAS l'événement `click` —
    // d'où le tiroir de commandes qui ne se ferme qu'après plusieurs essais. On élargit
    // la tolérance pour fiabiliser tous les taps (fermeture du tiroir, veille, pose de
    // points en édition / cible).
    clickTolerance: 10,
    // Carte déplaçable à deux doigts seulement au tactile (cf. TWO_FINGER_PAN). Le
    // message affiché quand un doigt seul essaie de la déplacer est celui de MapLibre,
    // traduit ici (il n'a pas de version française) et restylé en pastille discrète
    // (cf. <style>) : en pleine sortie, le voile sombre par défaut cacherait la carte.
    cooperativeGestures: TWO_FINGER_PAN,
    locale: {
      'CooperativeGesturesHandler.MobileHelpText': t('routes.nav_two_finger_pan'),
      'CooperativeGesturesHandler.WindowsHelpText': t('routes.nav_ctrl_scroll_zoom'),
      'CooperativeGesturesHandler.MacHelpText': t('routes.nav_cmd_scroll_zoom'),
    },
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
  // Tiroir de commandes ouvert : le premier clic sur la carte ne fait que le refermer,
  // comme un clic hors d'un menu déroulant — sans poser de point d'étape, ouvrir un POI
  // ni mettre en veille. Posé en CAPTURE sur le conteneur : il passe avant les
  // gestionnaires de MapLibre ET avant ceux des marqueurs / popups (marqueur POI, point
  // d'ancrage…), qui vivent dans le conteneur mais ne déclenchent pas map.on('click').
  // Un simple déplacement de carte ne produit pas de clic : le tiroir y survit.
  mapEl.value?.addEventListener('click', (e: MouseEvent) => {
    if (!controlsVisible.value) return
    e.stopPropagation()
    // …sauf le clic de compatibilité du tap qui vient d'ouvrir le tiroir (cf.
    // revealControls) : il refermerait aussitôt ce qu'on vient d'ouvrir. On avale quand
    // même l'événement (stopPropagation ci-dessus) pour qu'il n'aille pas endormir l'écran.
    if (performance.now() - controlsShownAt < REVEAL_CLICK_GUARD_MS) return
    hideControls()
  }, true)

  // Tap simple sur la carte : il n'endort plus rien (c'est l'appui long, cf. useSleepHold).
  // Il reste le geste qui referme ce qui est ouvert et qui sert aux modes édition / cible ;
  // quand il ne tombe sur rien, on rappelle le geste de veille — sinon la page paraîtrait
  // ne plus répondre à qui pressait la carte par habitude.
  map.on('click', (e: any) => {
    // Clic synthétique de relâchement d'un geste déjà traité (veille, tap à deux doigts).
    if (suppressNextMapClick) { suppressNextMapClick = false; return }
    // Tooltip « point quelconque » ouverte : un tap ne fait que la refermer.
    if (coordPopup) { closeCoordPopup(); return }
    // Le tiroir de commandes ouvert absorbe le tap en amont (cf. le gestionnaire en
    // capture sur le conteneur de carte, plus bas) : on n'arrive jamais ici tiroir ouvert.
    // Mode édition : un tap pose un nouveau point d'ancrage (ou referme la tooltip d'un
    // point ouverte).
    if (editMode.value) {
      if (hasEditPopup()) { closeEditPopup(); return }
      addEditWaypoint(e.lngLat.lng, e.lngLat.lat)
      return
    }
    // Mode « cible » : le tap pose un point d'étape (voir useDestinationNav.handleMapTap,
    // qui dit s'il l'a consommé).
    if (handlePlaceNavTap(e.point, [e.lngLat.lng, e.lngLat.lat])) return
    // Un popup POI ouvert : le tap carte ne fait que le fermer.
    if (pois.hasOpenPopup()) { pois.closePlacePopup(); return }
    // Idem pour la tooltip d'un virage.
    if (turnPopup) { closeTurnPopup(); return }
    // Tap sur une pastille de virage : tooltip « franchi / pas encore ».
    if (handleTurnTap(e.point)) return
    // Le tap n'a rien trouvé à faire : c'est là que l'écran s'endormait. On dit comment.
    onSleepZoneTap()
  })
  // Clic droit (ordinateur) n'importe où : tooltip coordonnées / Google Maps / Street View.
  map.on('contextmenu', (e: any) => {
    e.preventDefault?.()
    showCoordPopup(e.lngLat.lng, e.lngLat.lat)
  })
  // Tap à deux doigts (mobile) : même tooltip, l'appui long étant passé à la veille. On
  // neutralise le clic synthétique de relâchement (suppressNextMapClick). Voir
  // attachTwoFingerTap.
  detachCoordTap = attachTwoFingerTap(map.getCanvas(), (clientX, clientY) => {
    const rect = map.getContainer().getBoundingClientRect()
    const ll = map.unproject([clientX - rect.left, clientY - rect.top])
    showCoordPopup(ll.lng, ll.lat)
    suppressNextMapClick = true
    setTimeout(() => { suppressNextMapClick = false }, 500)
  })
  // Appui long (un doigt) sur la carte : mise en veille, avec l'anneau de progression.
  // Branché sur le canvas et non sur le conteneur : les bulles et les marqueurs vivent dans
  // le conteneur, or un appui sur une bulle qu'on est en train de lire n'est pas une veille.
  detachSleepHold = attachSleepHold(map.getCanvas())
  // Tap à deux doigts de MapLibre = dézoom (TapZoomHandler, cf. attachTwoFingerTap) : il
  // ferait fuir la carte au moment où l'on renseigne un point. On le désactive au doigt
  // seulement — au clic, le double-clic pour zoomer reste normal, et rien ne le concurrence.
  if (TWO_FINGER_PAN) map.doubleClickZoom.disable()

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      // Mode itinéraire (lien partagé chargé avant la carte) : installe le tracé et
      // cadre dessus avant le premier fix GPS. Mode libre : rien à installer.
      if (hasRoute.value && coords.length) {
        installRouteLayers()
        renderTurnMarkers()
        const b = new maplibre.LngLatBounds(coords[0], coords[0])
        coords.forEach((c) => b.extend(c))
        map.fitBounds(b, { padding: 60, duration: 0, pitch: 0 })
      }
      // Indépendant du tracé : installRouteLayers l'a déjà posé ci-dessus si un
      // itinéraire est chargé, mais le mode libre (rien à installer, cf. commentaire
      // au-dessus) n'a personne d'autre pour le faire.
      installOrReorderTraveledPath()
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

  map.addLayer({ id: 'nav-route-border', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { ...ROUTE_BORDER_PAINT, 'line-width': zoomWidthExpr(routeBorderWidth.value, true) } })
  map.addLayer({ id: 'nav-route-done', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#9ca3af', 'line-width': zoomWidthExpr(routeLineWidth.value, true), 'line-opacity': trackOpacity.value } })
  map.addLayer({ id: 'nav-route-remaining', type: 'line', source: 'nav-remaining', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': sportNav.value.line_color, 'line-width': zoomWidthExpr(routeLineWidth.value, true), 'line-opacity': trackOpacity.value } })
  // Surlignage du prochain virage : même ruban (largeur, opacité, amincissement des
  // recouvrements) mais à la couleur de la pastille, posé PAR-DESSUS le tracé restant.
  map.addSource('nav-turn-hi', { type: 'geojson', data: widthRunsCollection([], []) })
  map.addLayer({ id: 'nav-turn-highlight', type: 'line', source: 'nav-turn-hi', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': sportNav.value.turn_marker_color, 'line-width': zoomWidthExpr(routeLineWidth.value, true), 'line-opacity': trackOpacity.value } })
  // Flux animé PAR-DESSUS le surlignage : traitillé blanc qui défile vers le virage, donc
  // dans le sens où il faut tourner (le tracé est orienté dans le sens de parcours).
  turnFlowStep = -1
  map.addLayer({
    id: TURN_FLOW_LAYER,
    type: 'line',
    source: 'nav-turn-hi',
    layout: { 'line-join': 'round', 'line-cap': 'butt', visibility: REDUCED_MOTION ? 'none' : 'visible' },
    paint: {
      'line-color': '#ffffff',
      'line-width': zoomWidthExpr(turnFlowWidth.value, true),
      'line-opacity': trackOpacity.value,
      'line-dasharray': TURN_FLOW_DASHES[0],
    },
  })
  hiKey = ''
  refreshTurnHighlight()
  // Repositionne le trajet parcouru juste sous la mise en avant du virage qu'on vient
  // de recréer — sans ça il resterait sous le tracé prévu qu'on venait d'ajouter, ou
  // pire, disparaîtrait sous elle. Voir installOrReorderTraveledPath : la ligne du
  // trajet n'est PAS installée ici, elle vit indépendamment du tracé (mode libre compris).
  installOrReorderTraveledPath()
}

// Longueur (m) de tracé colorée de part et d'autre du virage mis en avant. Assez court
// pour rester lisible en zoom de navigation sans manger le virage suivant d'une rafale.
const TURN_HIGHLIGHT_M = 40

// Boucle d'animation du flux (cf. la déclaration de TURN_FLOW_LAYER plus haut).
// requestAnimationFrame se met en pause tout seul quand l'onglet passe en arrière-plan ;
// on ne repeint la carte que lorsque le motif change vraiment (≈18 fois par seconde, pas à
// chaque frame), et jamais en veille — l'écran noir masque la carte, la repeindre ne
// ferait que consommer la batterie.
function startTurnFlow() {
  if (turnFlowRaf !== null || REDUCED_MOTION || !map) return
  const tick = (ts: number) => {
    turnFlowRaf = requestAnimationFrame(tick)
    if (screenOff.value || !map?.getLayer(TURN_FLOW_LAYER)) return
    const step = Math.floor(ts / TURN_FLOW_STEP_MS) % TURN_FLOW_DASHES.length
    if (step === turnFlowStep) return
    turnFlowStep = step
    map.setPaintProperty(TURN_FLOW_LAYER, 'line-dasharray', TURN_FLOW_DASHES[step])
  }
  turnFlowRaf = requestAnimationFrame(tick)
}

function stopTurnFlow() {
  if (turnFlowRaf === null) return
  cancelAnimationFrame(turnFlowRaf)
  turnFlowRaf = null
}

// Indicateurs de virage en marqueurs DOM (et non en couches canvas) : les
// marqueurs MapLibre sont des overlays HTML, toujours rendus AU-DESSUS du canvas
// — donc au-dessus des POI (eux aussi des marqueurs, mais au z-index inférieur).
// C'est ce qui garantit qu'un POI ne masque jamais un indicateur de virage.
// Posés une seule fois (les marqueurs survivent à un setStyle).
function renderTurnMarkers() {
  if (!map || !maplibre) return
  // Les pastilles vont être détruites : la tooltip pointerait un virage d'un autre tracé.
  closeTurnPopup()
  for (const m of turnMarkers) m.remove()
  turnMarkers = []
  // Nouveau jeu de virages (reroutage, changement de sport) : le surlignage est recalculé
  // depuis la nouvelle géométrie — y compris pour l'effacer s'il n'y a plus de pastilles.
  hiKey = ''
  refreshTurnHighlight()
  if (!turnsFromBRouter || !turns.length) return
  const dot = turnMarkerSize.value * 2      // diamètre de la pastille (rayon → diamètre)
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
    body.style.background = sportNav.value.turn_marker_color
    // Couleur de la pulsation du prochain virage (halo) = couleur de fond de la pastille.
    body.style.setProperty('--turn-pulse-color', sportNav.value.turn_marker_color)
    if (tp.kind === 'roundabout') {
      // Rond-point : numéro de sortie, texte maintenu droit (pas d'alignement carte).
      const exitFont = turnMarkerSize.value / 11 * 13   // 13 px à la taille par défaut (rayon 11)
      body.innerHTML = `<span class="nav-turn-marker-exit" style="font-size:${exitFont}px;color:${sportNav.value.turn_marker_icon_color}">${tp.exitNumber ?? 0}</span>`
      el.appendChild(body)
      const marker = new maplibre.Marker({ element: el, anchor: 'center' })
        .setLngLat([geometry[tp.idx][0], geometry[tp.idx][1]])
        .addTo(map)
      turnMarkers.push(marker)
    } else {
      // Virage normal : flèche directionnelle couchée sur le plan de la carte
      // (rotationAlignment + pitchAlignment 'map') et orientée selon le cap.
      body.innerHTML = '<svg class="nav-turn-marker-arrow" viewBox="0 0 22 22" aria-hidden="true">'
        + `<path d="M11 1 L20 20 L11 15 L2 20 Z" fill="${sportNav.value.turn_marker_icon_color}"/></svg>`
      el.appendChild(body)
      const marker = new maplibre.Marker({ element: el, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat([geometry[tp.idx][0], geometry[tp.idx][1]])
        .addTo(map)
      marker.setRotation(bearing)
      turnMarkers.push(marker)
    }
  }
  applyMarkerScale()
  visibleTurnIdx = -1   // force le recalcul : les marqueurs neufs sont visibles par défaut
  greenTurnIdx = -1     // marqueurs recréés : aucune pastille verte en cours
  updateTurnVisibility()
}

// En suivi d'itinéraire, toutes les pastilles restent visibles sur le tracé, mais seul
// le PROCHAIN virage est en couleur et pulse (halo « selected ») pour attirer l'œil ;
// les virages déjà franchis comme ceux encore loin devant sont grisés (« inactive »),
// comme désactivés, pour rester discrets sans disparaître. `turnMarkers` est aligné
// index-pour-index sur `turns`, donc le marqueur du prochain virage est
// turnMarkers[nextTurnPtr]. Idempotent via le garde sur visibleTurnIdx.
let visibleTurnIdx = -1
function updateTurnVisibility() {
  if (visibleTurnIdx === nextTurnPtr) return
  visibleTurnIdx = nextTurnPtr
  turnMarkers.forEach((m, i) => {
    const el = m.getElement() as HTMLElement
    el.classList.toggle('nav-turn-marker--inactive', i !== nextTurnPtr)
    el.classList.toggle('nav-turn-marker--selected', i === nextTurnPtr)
  })
  refreshTurnHighlight()
}

// Couleur verte du virage atteint, alignée sur le bandeau « now » (NavTurnBanner).
const TURN_NOW_COLOR = '#16a34a'

// Colore en vert la pastille du virage atteint pendant le maintien « now » (et la
// restaure ensuite). On force la couleur en inline (la couleur de base est posée en
// inline, donc une classe ne suffirait pas) ; la classe `--now` gère le halo, l'échelle
// et la priorité d'empilement. Idempotent via le garde sur greenTurnIdx.
let greenTurnIdx = -1
function setGreenTurn(idx: number) {
  if (greenTurnIdx === idx) return
  const paint = (i: number, green: boolean) => {
    const m = turnMarkers[i]
    if (!m) return
    const el = m.getElement() as HTMLElement
    // Par classe et non par rang : la racine porte aussi la zone tactile.
    const body = el.querySelector<HTMLElement>('.nav-turn-marker-body')
    const color = green ? TURN_NOW_COLOR : sportNav.value.turn_marker_color
    if (body) {
      body.style.background = color
      body.style.setProperty('--turn-pulse-color', color)
    }
    el.classList.toggle('nav-turn-marker--now', green)
  }
  if (greenTurnIdx >= 0) paint(greenTurnIdx, false)
  greenTurnIdx = idx
  if (idx >= 0) paint(idx, true)
  refreshTurnHighlight()
}

// ─── Tooltip d'un virage : fait / pas encore fait ──────────────────────────────

let turnPopup: any = null

function closeTurnPopup() {
  if (turnPopup) { turnPopup.remove(); turnPopup = null }
}

// Tap sur la carte : y avait-il des virages sous le doigt ? Le test est fait ICI, dans le
// gestionnaire de clic de MapLibre, et non sur la pastille elle-même. Deux raisons, toutes
// deux liées au pouce en roulant :
//   • la tolérance. MapLibre n'émet ce clic qu'au-delà de son clickTolerance (10 px, élargi
//     exprès pour les taps qui dérivent en mouvement) ; un écouteur DOM sur la pastille,
//     lui, dépendrait de la tolérance du navigateur, et un tap qui glisse de quelques
//     pixels tomberait à côté — donc sur la carte, qui met l'écran en veille. Le geste le
//     plus difficile à réussir déclencherait exactement ce qu'on ne veut pas.
//   • la cible. Une pastille fait 22 px au zoom par défaut et rétrécit en dézoom ; en
//     pixels d'écran on vise ce qu'on veut, indépendamment du zoom.
// Renvoie vrai si le tap a été consommé — l'appelant ne met alors pas l'écran en veille.
function handleTurnTap(point: { x: number; y: number }): boolean {
  if (!map || !turnsFromBRouter || !turns.length) return false
  const projected = turns.map((tp, ptr) => {
    const p = map.project([geometry[tp.idx][0], geometry[tp.idx][1]])
    return { ptr, x: p.x, y: p.y }
  })
  const hits = turnsNearTap(projected, point)
  if (!hits.length) return false
  showTurnPopup(hits)
  return true
}

// Tooltip des virages sous le doigt : ce que dit la navigation de chacun (franchi ou non),
// et de quoi la contredire. Le coureur est le seul à savoir : la projection, elle, peut
// être coincée sur le mauvais passage d'un aller-retour (cf. resyncOnTurn) et annoncer
// indéfiniment un virage déjà pris.
//
// Plusieurs virages quand le tracé repasse au même endroit : on les liste tous plutôt que
// d'en choisir un. Chacun est nommé par son point kilométrique, seul repère qui distingue
// deux passages superposés — « le virage du km 42 » et non « celui du dessus ».
function showTurnPopup(ptrs: number[]) {
  if (!maplibre || !map) return
  const shown = ptrs.map((ptr) => ({ ptr, tp: turns[ptr] })).filter((c) => c.tp)
  if (!shown.length) return
  closeTurnPopup()
  const many = shown.length > 1
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  const rows = shown.map(({ ptr, tp }) => {
    const done = ptr < nextTurnPtr
    const label = turnLabel(tp)
    // Combien de virages ce seul geste ferait basculer : celui-ci plus tous ceux qui le
    // séparent du pointeur courant. C'est LA réponse à « il faudra en marquer cinquante ? » —
    // non, un seul tap sur le virage où l'on est règle tous les précédents d'un coup.
    const span = done ? nextTurnPtr - ptr : ptr - nextTurnPtr + 1
    const state = done ? t('routes.turn_marked_done') : t('routes.turn_marked_todo')
    return `
      <div class="nav-turn-popup-row">
        <div class="nav-turn-popup-state">
          <i class="fa-solid ${turnIcon(tp)}" aria-hidden="true"></i>
          <span>${escapeHtml(many ? `${t(label.key, label.params)} · ${formatDistancePrecise(tp.distM)}` : state)}</span>
        </div>
        ${many ? `<div class="nav-turn-popup-state">${escapeHtml(state)}</div>` : ''}
        ${span > 1 ? `<div class="nav-turn-popup-span">${escapeHtml(t('routes.turn_mark_span', { count: span }))}</div>` : ''}
        ${popupActionHtml({
          className: `place-popup-link--turn-mark-${ptr}`,
          icon: done ? 'fa-solid fa-rotate-left' : 'fa-solid fa-check',
          label: done ? t('routes.turn_mark_todo') : t('routes.turn_mark_done'),
        })}
      </div>`
  })
  const first = shown[0]
  const title = many
    ? t('routes.turns_here', { count: shown.length })
    : t(turnLabel(first.tp).key, turnLabel(first.tp).params)
  wrap.innerHTML = popupHeaderHtml(title) + rows.join('')
  turnPopup = new maplibre.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([geometry[first.tp.idx][0], geometry[first.tp.idx][1]])
    .setDOMContent(wrap)
    .addTo(map)
  wrap.querySelector('.place-popup-close')?.addEventListener('click', closeTurnPopup)
  for (const { ptr } of shown) {
    wrap.querySelector(`.place-popup-link--turn-mark-${ptr}`)?.addEventListener('click', () => {
      closeTurnPopup()
      markTurn(ptr, ptr >= nextTurnPtr)
    })
  }
}

// Applique la déclaration du coureur : le virage `ptr` est fait (ou ne l'est pas). Tout
// le raisonnement est dans resyncOnTurn (pur, testé) ; ici on ne fait que reposer l'état
// de suivi sur l'ancre qu'il rend, comme le ferait un fix GPS arrivant à cet endroit.
function markTurn(ptr: number, done: boolean) {
  const target = resyncOnTurn(turns, cumDistM, ptr, done)
  if (!target) return
  lastIdx = target.idx
  located = true
  nextTurnPtr = target.nextTurnPtr
  snapPoint = [geometry[target.idx][0], geometry[target.idx][1]]
  snapNextIdx = Math.min(target.idx + 1, geometry.length - 1)
  snapDistAlongM = target.distAlongM
  displaySnapPoint = lngLatAtDistanceM(displayLine, cumDistM, snapDistAlongM)
  // Annonces et maintien vert portaient sur le passage qu'on vient de quitter.
  turnAlertState = INITIAL_TURN_ALERT_STATE
  reachedTurn = null
  reachedTurnIdx = -1
  turnAlertMuted.value = false
  mutedTurnPtr = -1
  setGreenTurn(-1)
  // Écriture immédiate (lastSaveMs = 0 court-circuite le throttle) : la progression
  // mémorisée pointait le mauvais passage, et c'est elle qui servirait de reprise si la
  // page était rechargée dans la minute.
  lastProgressSaveMs = saveProgress(routeToken.value, lastIdx, 0)
  // La flèche doit sauter tout de suite : la boucle d'extrapolation part de l'ancre, et
  // le prochain fix GPS peut être à une seconde. Sans ça, le recalage semblerait sans effet.
  anchorOnRoute = displaySnapPoint != null
  anchorPos = displaySnapPoint ?? snapPoint
  anchorDistM = snapDistAlongM
  anchorTime = performance.now()
  updateProgress(target.idx)
  updateTurnVisibility()
  updateTurns()
}

// Colore un bout de tracé (TURN_HIGHLIGHT_M avant ET après) autour du virage mis en
// avant, en plus du halo de sa pastille : de loin, on lit d'un coup d'œil PAR OÙ ça
// passe, pas seulement où est le virage. Le virage montré et sa couleur suivent la
// pastille — orange sur le prochain virage, vert sur le virage tout juste franchi
// pendant le maintien « now ». Idempotent via `hiKey` (appelé à chaque fix GPS).
function refreshTurnHighlight() {
  const src = map?.getSource('nav-turn-hi')
  if (!src) return
  const green = greenTurnIdx >= 0
  const idx = green ? greenTurnIdx : nextTurnPtr
  const tp = turns[idx] as TurnPoint | undefined
  // Pas de virage à montrer (fin de tracé, virages géométriques sans pastille) : on vide.
  if (!tp || !turnsFromBRouter || displayLine.length < 2) {
    // Rien de coloré : plus rien à animer non plus (on ne repeint pas la carte pour rien).
    stopTurnFlow()
    if (hiKey === '') return
    hiKey = ''
    src.setData(widthRunsCollection([], []))
    return
  }
  const color = green ? TURN_NOW_COLOR : sportNav.value.turn_marker_color
  const key = `${idx}|${tp.distM.toFixed(1)}|${displayLine.length}|${color}`
  if (key === hiKey) return
  hiKey = key
  // displayLine est indexée comme geometry : cumDistM s'y applique tel quel (c'est déjà
  // l'hypothèse de lngLatAtDistanceM ailleurs), décalage des recouvrements compris.
  // En aval, la couleur va au moins jusqu'à la FIN de la manœuvre : sur un grand
  // rond-point, 40 m s'arrêtent dans l'anneau et on ne voit pas par où ressortir. Le
  // TURN_HIGHLIGHT_M s'ajoute après la sortie, pour montrer la branche prise.
  // Garde-fou plus large pour l'anneau (jusqu'à ~300 m sur un très grand rond-point) que
  // pour un virage ordinaire, où une route sinueuse pourrait sinon tout colorer.
  const maxM = tp.kind === 'roundabout' ? 400 : 120
  const endM = cumDistM[maneuverEndIdx(geometry, cumDistM, tp.idx, { maxM })] ?? tp.distM
  const afterM = Math.max(tp.distM, endM) + TURN_HIGHLIGHT_M
  const cut = sliceLineBetween(displayLine, cumDistM, displayWScale, tp.distM - TURN_HIGHLIGHT_M, afterM)
  map.setPaintProperty('nav-turn-highlight', 'line-color', color)
  src.setData(widthRunsCollection(cut.line, cut.wscale))
  if (cut.line.length >= 2) startTurnFlow()
  else stopTurnFlow()
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
    const body = (m.getElement() as HTMLElement).querySelector<HTMLElement>('.nav-turn-marker-body')
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

function setMapStyle(id: string) {
  if (!map || id === mapStyleId.value) return
  mapStyleId.value = id
  // Le fond de carte de la navigation guidée a sa propre préférence, distincte de celle
  // du créateur (elle-même désormais propre à chaque sport).
  persistNavigationStyle(id as any)
  noteBaseReloaded()
  map.setStyle(resolveBaseStyle(id), { diff: false })
  map.once('style.load', afterStyleLoad)
}

function afterStyleLoad() {
  // Pas de couches de tracé à réinstaller en mode libre.
  if (hasRoute.value) installRouteLayers()
  // Le trajet parcouru, lui, n'a jamais dépendu du tracé : un changement de fond de
  // carte efface TOUTES les sources/couches (setStyle), y compris en mode libre.
  else installOrReorderTraveledPath()
  // Replace le marqueur sur la position AFFICHÉE (snappée et décalée sur sa voie si on est
  // sur le tracé), pas sur le GPS brut, pour rester cohérent avec la boucle d'animation.
  const restore = anchorPos ?? lastPos
  if (restore) updateLocationMarker(restore)
  refreshRemaining()
}

// ─── Reprise après rechargement (tracés auto-recoupants) ──────────────────────
// La progression le long du tracé est mémorisée dans le localStorage pour repartir sur le
// BON passage d'un tracé qui se recoupe après un rechargement — voir navProgress. Ici on ne
// garde que l'état du throttle d'écriture.
let lastProgressSaveMs = 0

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

// Navigation sur itinéraire : projection sur le tracé, hors-trajet, virages, cols,
// progression. L'ancre suit la position projetée (snappée) le long du tracé.
function onPositionRoute(pos: GeolocationPosition, here: LngLat) {
  // Project onto the route. On the first fix we normally do a global search so we
  // locate wherever the ride is joined (including mid-loop); after that a windowed
  // search around the last index keeps perf up and handles self-crossing loops.
  // Exception : sur un tracé auto-recoupant, une progression récente mémorisée
  // (rechargement en pleine course) lève l'ambiguïté du passage — on repart de cet
  // indice. On ne s'y fie que si le rider est effectivement proche de ce passage ;
  // sinon (entrée périmée ou rider ailleurs) on retombe sur la recherche globale.
  // Cette recherche globale est ambiguë sur une boucle (l'arrivée passe à quelques
  // mètres du départ) : on privilégie donc le passage le plus proche du DÉPART, sinon
  // un simple fix bruité au point de départ nous place sur les derniers mètres du tracé
  // — parcours affiché comme terminé, arrivée annoncée aussitôt.
  const hint = located ? lastIdx : loadProgress(routeToken.value, geometry.length)
  let { idx, distM } = hint >= 0
    ? nearestGeomIndex(here, geometry, hint)
    : nearestGeomIndexPreferring(here, geometry, cumDistM, 0, LOOP_AMBIGUITY_TOL_M)
  // Recherche globale de secours quand la projection fenêtrée nous place hors-tracé :
  //  • au premier fix d'un tracé chargé (!located), le coureur peut être n'importe où ;
  //  • en séance (located), s'il a quitté la ligne suivie — typiquement un reroutage auto
  //    ignoré, qui a remplacé la géométrie par un détour+queue — puis rejoint le tracé plus
  //    loin, la fenêtre ±60 autour du dernier indice ne le retrouve pas. On rebalaie tout et
  //    on adopte le point vraiment le plus proche. `relocated` : vrai quand cela fait sauter
  //    la position sur un tout autre passage, ce qui invalide les pointeurs de virage.
  // La progression connue (snapDistAlongM en séance, l'indice repris sinon) sert
  // d'arbitre entre passages également proches : on ne saute pas sur la fin du tracé
  // alors qu'on est au début d'une boucle.
  // EN SÉANCE, on n'adopte un autre passage que si le coureur est franchement DESSUS
  // (au sens du seuil hors-trajet). Sinon, s'écarter du tracé près du départ d'une
  // boucle — où la dernière branche passe à quelques dizaines de mètres — ferait
  // basculer la progression à ~100 % : parcours affiché comme fini, reroutage vers
  // l'arrivée. Hors séance (reprise via localStorage), on garde le repli large :
  // l'indice mémorisé peut être périmé et le coureur être n'importe où.
  // Widen the threshold by the reported GPS accuracy (capped) so an imprecise fix
  // doesn't get flagged off-route while the rider is actually on the line.
  const accuracyM = Math.min(pos.coords.accuracy ?? 0, OFF_ROUTE_ACCURACY_CAP)
  let relocated = false
  if (hint >= 0 && distM > OFF_ROUTE_M + OFF_ROUTE_ACCURACY_CAP) {
    const prefer = located ? snapDistAlongM : (cumDistM[hint] ?? 0)
    const global = nearestGeomIndexPreferring(here, geometry, cumDistM, prefer, LOOP_AMBIGUITY_TOL_M)
    if (global.distM < distM && (!located || global.distM <= OFF_ROUTE_M + accuracyM)) {
      relocated = located && Math.abs(global.idx - idx) > 1
      ;({ idx, distM } = global)
    }
  }
  lastIdx = idx
  located = true
  // Re-localisation réelle : `nextTurnPtr` est monotone (updateTurns ne fait qu'avancer),
  // donc un saut en arrière le laisserait bloqué sur un virage déjà « dépassé » — au pire
  // le dernier du trajet. On repart de zéro : la boucle forward d'updateTurns re-dérivera le
  // bon prochain virage depuis la position réelle. On purge aussi l'état d'annonce / de
  // maintien vert, qui pointe l'ancien passage.
  if (relocated) {
    nextTurnPtr = 0
    turnAlertState = INITIAL_TURN_ALERT_STATE
    reachedTurn = null
    reachedTurnIdx = -1
  }
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
  offRoute.value = distM > OFF_ROUTE_M + accuracyM
  updateProgress(idx)
  // Mémorise la progression pour reprendre sur le bon passage après un éventuel
  // rechargement. On ne sauvegarde que sur le tracé : un point hors-tracé pourrait
  // figer un mauvais passage. nextTurnPtr et snapDistAlongM se recalent d'eux-mêmes
  // au premier fix de reprise (pilotés par l'indice restauré), rien d'autre à stocker.
  if (!offRoute.value) lastProgressSaveMs = saveProgress(routeToken.value, lastIdx, lastProgressSaveMs)

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
  maybeAutoReroute()

  // Snap the 3D view back over the rider as they reach an intersection — unless
  // they've deliberately unlocked the camera to study the map.
  if (turnApproaching && !following.value && !cameraUnlocked.value) following.value = true
}

// Navigation libre (sans tracé) : aucun snapping ni virage. L'ancre est le GPS brut ;
// la boucle d'animation extrapole librement au cap. On ne tient que la vitesse et le cap.
function onPositionFree(pos: GeolocationPosition, here: LngLat) {
  updateBearing(pos, here)
  updateSpeed(pos, here)
  anchorPos = here
  anchorOnRoute = false
  anchorDistM = 0
  anchorTime = performance.now()
  extrapSpeedMs = speedKmh.value / 3.6
  extrapBearing = currentBearing
  located = true
  lastPos = here
}

// Publie l'état de la navigation vers l'application mobile, une fois par fix.
//
// Appelé ici plutôt que dans updateTurns : la charge utile mélange le virage, le
// hors-trace, l'arrivée, la vitesse et le col, qui sont posés par plusieurs
// fonctions du même fix. Même esprit que autoWakeForTurns — un appel impératif au
// point où l'état est complet, pas un `watch` qui redéclencherait à contretemps.
//
// La coordonnée publiée est celle du PROCHAIN virage du tracé, pas forcément celle
// que le bandeau affiche : quand on est déjà sur un virage, le bandeau montre le
// suivant de la rafale. C'est le prochain virage qui intéresse l'appli, puisqu'elle
// s'en sert pour juger l'approche avec son propre GPS.
function publishNavState() {
  const turn = hasRoute.value ? turns[nextTurnPtr] : undefined
  const coord = turn && geometry[turn.idx]
    ? ([geometry[turn.idx][0], geometry[turn.idx][1]] as LngLat)
    : null

  companionNav(navStateFor({
    hasRoute: hasRoute.value,
    hint: turnHint.value,
    turnCoord: coord,
    offRoute: offRoute.value,
    arrived: arrived.value,
    speedKmh: speedKmh.value,
    remainingM: remainingM.value,
    remainingGainM: remainingGainM.value,
    climb: climbInfo.value,
  }))
}

function onPosition(pos: GeolocationPosition) {
  gpsError.value = null
  hasFix.value = true
  bumpPosTick()
  const here: LngLat = [pos.coords.longitude, pos.coords.latitude]

  if (hasRoute.value) {
    onPositionRoute(pos, here)
  } else {
    onPositionFree(pos, here)
  }

  // Notification de proximité d'un POI (bandeau du bas), en mode itinéraire comme libre.
  updatePoiProximity(here)

  publishNavState()

  if (!hasInitialZoom) {
    // First fix: a smooth intro that also applies the profile zoom once,
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
// constant frame to frame; the camera stays flat (pitch 0) and the zoom comes
// from the profile. The render
// loop re-applies camZoom every frame, and a manual pinch writes its result back
// into camZoom, so following tracks the pinch instead of fighting it.
function followOptions(center: LngLat): any {
  const h = containerH || map?.getContainer()?.clientHeight || 0
  const opts: any = {
    center,
    bearing: currentBearing,
    pitch: 0,
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

// Ajuste le zoom de découverte pour garder le prochain virage visible à l'écran. On projette
// le virage dans la vue courante (ce qui tient compte de l'inclinaison 3D, contrairement à
// un calcul analytique) et on laisse revealZoomStep décider du pas. Appelé à chaque frame de
// suivi, juste avant le jumpTo : le pas par frame se cumule en un dézoom fluide.
function updateRevealZoom() {
  const target = revealTurnLngLat()
  if (!target) { revealZoom = null; return }
  const h = containerH || map?.getContainer()?.clientHeight || 0
  if (!h) { revealZoom = null; return }
  revealZoom = revealZoomStep({
    y: map.project(target).y,
    h,
    base: revealZoom ?? camZoom.value,
    camZoom: camZoom.value,
    minZoom: CAM_ZOOM_MIN,
  })
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
    if (GPS_INTERPOLATION && extrapSpeedMs > MIN_SPEED_MS) {
      // Sur le tracé : avancer la distance le long de la polyligne (la flèche reste
      // collée à la ligne, virages compris). Hors trajet : extrapolation libre au cap.
      pos = anchorOnRoute
        ? lngLatAtDistanceM(displayLine, cumDistM, anchorDistM + extrapSpeedMs * dt)
        : moveLngLat(anchorPos, extrapBearing, extrapSpeedMs * dt)
    }
    const d = bearingDelta(displayBearing, extrapBearing)

    // Économie de batterie : on arrête la boucle dès que ses deux sorties ont atteint
    // leur valeur finale — position (immobile ou extrapolation plafonnée) et cap convergé.
    // Le prochain fix GPS rappelle startAnimation() et relance la boucle (garde rafId != null).
    // Interpolation désactivée : rien n'évolue entre deux fixes, la frame est terminale.
    const posSettled = extrapSpeedMs <= MIN_SPEED_MS || dt >= MAX_EXTRAP_S
    const bearingSettled = Math.abs(d) < BEARING_EPS
    const h = containerH
    const idle = !GPS_INTERPOLATION || (posSettled && bearingSettled)

    // Sur la frame terminale on fige exactement sur la cible (l'easing n'y arrive jamais).
    displayBearing = idle ? extrapBearing : displayBearing + d * BEARING_SMOOTH
    updateLocationMarker(pos)
    if (locationMarker) locationMarker.setRotation(displayBearing)
    if (following.value) {
      // Dézoom de découverte du prochain virage (sortie de veille) : ajusté avant le
      // jumpTo, borné au zoom du profil. Hors de ce cas, effectiveZoom() == camZoom.
      updateRevealZoom()
      map.jumpTo({ center: pos, bearing: displayBearing, zoom: effectiveZoom(), pitch: 0, padding: followPadding(h) })
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

// Track the next turn ahead: announce it once within turn_alert_m (and re-orient
// the view), and surface a visual hint within turn_hint_m. Returns true on the
// frame a turn alert fires.
function updateTurns(): boolean {
  // Débug : un virage factice est épinglé, on ne le réécrit pas depuis le GPS.
  if (dbgTurn.value) return false
  // Hors-tracé : plus aucun virage du tracé à annoncer. On désarme l'alerte sonore et sa
  // répétition (tickTurnRepeat) — sinon un virage encore proche de la position projetée
  // resterait « bloqué » à sonner en boucle alors qu'on a quitté l'itinéraire ; l'alerte
  // hors-tracé prend le relais. autoWakeForTurns gère déjà la mise en veille hors-tracé.
  if (offRoute.value) {
    turnHint.value = null
    followTurns.value = []
    activeTurn = null
    activeTurnUrgent = false
    autoWakeForTurns(null)
    return false
  }
  if (!turns.length) { turnHint.value = null; followTurns.value = []; activeTurn = null; reachedTurn = null; return false }
  const here = snapDistAlongM
  // Avance le pointeur sur les virages dépassés (>5 m derrière), en mémorisant chacun
  // pour le maintien vert. Le décompte ne démarre donc qu'une fois le virage vraiment
  // laissé derrière soi.
  while (nextTurnPtr < turns.length && turns[nextTurnPtr].distM < here - TURN_PASSED_M) {
    rememberReached(turns[nextTurnPtr], nextTurnPtr)
    nextTurnPtr++
  }
  // Virage franchi → la pastille suivante devient la seule visible sur la carte.
  updateTurnVisibility()
  // Nouveau virage : on lève automatiquement la sourdine posée sur le précédent.
  if (turnAlertMuted.value && mutedTurnPtr !== nextTurnPtr) {
    turnAlertMuted.value = false
  }
  const turn = turns[nextTurnPtr] as TurnPoint | undefined
  const dist = turn ? turn.distM - here : Infinity

  // Son / vibration : ce qu'il faut annoncer est décidé par turnAlertStep (pur) ; ici on
  // applique les sourdines et on émet. `activeTurn` reste armé tant que le virage est dans
  // la zone d'alerte, pour la répétition cadencée par le timer (tickTurnRepeat),
  // indépendante de la fréquence des fixes GPS.
  const alert = turnAlertStep(turnAlertState, {
    ptr: nextTurnPtr,
    distM: dist,
    alertM: sportNav.value.turn_alert_m,
    urgentM: sportNav.value.turn_urgent_m,
  })
  turnAlertState = alert.state
  activeTurn = alert.active && turn ? { kind: turn.kind, direction: turn.direction } : null
  activeTurnUrgent = alert.active?.urgent ?? false
  const alertAudible = soundOn.value && !audioMuted.value && !turnAlertMuted.value
  const alertHaptic = !alertsMuted.value && !turnAlertMuted.value
  if (alert.buzzApproach && alertHaptic) vibrateApproach()
  if (alert.announce && turn) {
    lastTurnReminderMs = Date.now()
    const burst = alert.urgentBurst ? sportNav.value.turn_repeat_urgent_count : sportNav.value.turn_repeat_count
    if (alertAudible) playManeuverBurst(turn.kind, turn.direction, burst)
    if (alert.buzzManeuver && alertHaptic) vibrateManeuver(turn.kind)
  }
  const fired = alert.announce && turn != null

  // Virage atteint dès qu'on est à turn_now_m (15 m par défaut) devant — et tant que le pointeur
  // n'a pas avancé (on est dessus, potentiellement à l'arrêt à un carrefour) : on
  // rafraîchit le maintien vert pour qu'il ne disparaisse pas tant qu'on n'est pas reparti.
  if (turn && dist <= sportNav.value.turn_now_m) rememberReached(turn, nextTurnPtr)

  // Choix de l'affichage : cf. turnBanner. Le maintien vert court sur une distance ET une
  // durée (turn_green_hold_m / _s) — un coureur à l'arrêt au carrefour garde sa
  // confirmation, mais elle ne s'éternise pas.
  const greenActive = reachedTurn != null
    && here - reachedTurn.distM < greenHoldM.value
    && Date.now() - reachedAtMs < greenHoldMs.value
  const banner = turnBanner({
    turn,
    distM: dist,
    // Rafale des virages qui suivent le prochain de près (≤ TURN_CHAIN_GAP_M entre chacun).
    chain: buildTurnChain(turns, nextTurnPtr, here, TURN_CHAIN_GAP_M, TURN_CHAIN_MAX),
    reached: reachedTurn,
    greenActive,
    nowM: sportNav.value.turn_now_m,
    hintM: sportNav.value.turn_hint_m,
  })
  turnHint.value = banner.hint
  followTurns.value = banner.follow

  // Confirmation verte (« now ») : on colore en vert SA pastille sur la carte, en
  // cohérence avec le bandeau. Sinon, aucune pastille n'est verte.
  setGreenTurn(turnHint.value?.state === 'now' ? reachedTurnIdx : -1)

  autoWakeForTurns(turnHint.value?.state ?? null)
  return fired
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
function rememberReached(turn: TurnPoint, idx: number) {
  if (!reachedTurn || reachedTurn.distM !== turn.distM) reachedAtMs = Date.now()
  reachedTurn = { direction: turn.direction, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber, distM: turn.distM }
  reachedTurnIdx = idx
}

function muteTurnAlert() {
  turnAlertMuted.value = !turnAlertMuted.value
  mutedTurnPtr = turnAlertMuted.value ? nextTurnPtr : -1
}

// Répétition du son de virage, cadencée à turn_repeat_ms et non aux fixes GPS.
// Un poll court (250 ms) suffit : la préférence est plafonnée à 500 ms mini.
// Le paquet d'annonces (turn_repeat_count lectures à la suite) n'est rejoué que si la
// répétition périodique est activée pour la zone courante (turn_repeat / turn_repeat_urgent) ;
// sinon le virage n'est annoncé qu'une fois (au passage dans la zone d'alerte).
function tickTurnRepeat() {
  updateAutoRerouteCountdown()
  if (!activeTurn || !soundOn.value || audioMuted.value || turnAlertMuted.value) return
  const nav = sportNav.value
  const enabled = activeTurnUrgent ? nav.turn_repeat_urgent : nav.turn_repeat
  if (!enabled) return
  const now = Date.now()
  const interval = activeTurnUrgent ? nav.turn_repeat_urgent_ms : nav.turn_repeat_ms
  if (now - lastTurnReminderMs >= interval) {
    lastTurnReminderMs = now
    const burst = activeTurnUrgent ? nav.turn_repeat_urgent_count : nav.turn_repeat_count
    playManeuverBurst(activeTurn.kind, activeTurn.direction, burst)
  }
}

function handleOffRouteSound(wasOffRoute: boolean) {
  if (!offRoute.value) { lastOffRouteAlert = 0; return }
  const now = Date.now()
  if (alertsMuted.value) return
  if (!wasOffRoute || now - lastOffRouteAlert > OFF_ROUTE_REALERT_MS) {
    lastOffRouteAlert = now
    // audioMuted (et non alertsMuted, déjà filtré plus haut) : coupe le son si le menu
    // déroulant est ouvert, tout en laissant la vibration prévenir le coureur.
    if (soundOn.value && !audioMuted.value) playOffRoute()
    vibrateOffRoute()
  }
}

// Recalcul automatique hors-course (profil navigation.auto_reroute, true par défaut). On
// relance recalcRoute() tant qu'on reste hors-tracé, espacé d'AUTO_REROUTE_COOLDOWN_MS :
// si la première tentative échoue (réseau) ou si le coureur n'a pas encore rejoint le
// nouveau tracé, on réessaie au lieu de s'arrêter à une seule tentative. Un recalcul
// réussi remet le coureur sur le tracé (offRoute repasse à faux) et stoppe les relances.
// Mêmes gardes que le bouton manuel (recherche de lieu, édition, parcours de POI) ; le
// cooldown protège aussi d'un clignotement GPS hors-tracé/sur-tracé.
//
// Le tiroir ouvert suspend aussi les relances : c'est là qu'on choisit le profil de
// routage du détour, et un recalcul parti au milieu de la sélection l'aurait calculé avec
// l'ancien profil. À la fermeture, le cooldown est déjà écoulé, donc le détour part
// aussitôt — avec le profil retenu. Même raisonnement que audioMuted, qui tient
// déjà « tiroir ouvert » pour « l'utilisateur est en train de régler ».
function maybeAutoReroute() {
  if (!navPrefs.auto_reroute) return
  if (!offRoute.value) return
  if (rerouting.value || placeNavActive.value || editMode.value || poiBrowseActive.value) return
  if (controlsVisible.value) return
  // recalcRoute arme lui-même lastAutoReroute, donc on ne gère ici que la temporisation.
  if (performance.now() - lastAutoReroute < AUTO_REROUTE_COOLDOWN_MS) return
  void recalcRoute()
}

// Décompte (s) avant la prochaine tentative de recalcul auto, pour le bouton « Recalculer ».
// 0 quand le recalcul auto est inactif, qu'on n'est pas hors-course, ou qu'une tentative
// est en cours. Appelé par tickTurnRepeat (toutes les 250 ms) pour un affichage fluide.
function updateAutoRerouteCountdown() {
  if (!navPrefs.auto_reroute || !offRoute.value || rerouting.value) {
    autoRerouteLeftS.value = 0
    return
  }
  const leftMs = AUTO_REROUTE_COOLDOWN_MS - (performance.now() - lastAutoReroute)
  autoRerouteLeftS.value = leftMs > 0 ? Math.ceil(leftMs / 1000) : 0
}

// Notification de proximité d'un point d'intérêt : repère le POI affiché le plus
// proche dans le rayon configuré (points_of_interest.alert_m) et pilote le bandeau du
// bas. Émet une alerte discrète (son + vibration) une seule fois à l'entrée dans le
// rayon de chaque POI. Masquée — comme les notifications du tracé — en mode recherche,
// en édition ou hors-trajet ; le silence des alertes suit alertsMuted / audioMuted.
function updatePoiProximity(here: LngLat) {
  // Débug : une notification POI factice est épinglée, on ne la réécrit pas depuis le GPS.
  if (dbgPoi.value) return
  if (placeNavActive.value || editMode.value || offRoute.value) {
    poiHint.value = null
    poiHintPlace = null
    announcedPoiKey = null
    return
  }
  const alertM = userPreferences().points_of_interest.alert_m
  const near = alertM > 0 ? pois.nearestVisiblePoi(here, alertM) : null
  if (!near) {
    poiHint.value = null
    poiHintPlace = null
    announcedPoiKey = null
    return
  }
  poiHintPlace = near.place
  const cat = categoryForType(near.place.type)
  poiHint.value = {
    name: near.place.name || t('routes.point_of_interest'),
    icon: cat?.icon ?? 'fa-location-dot',
    color: cat?.color ?? '#6b7280',
    distM: near.distM,
  }
  // Identité stable d'un POI (type + coordonnées) : une seule alerte par entrée dans
  // le rayon ; announcedPoiKey est remis à null dès qu'on en sort (cf. branches ci-dessus).
  const key = `${near.place.type}:${near.place.lng.toFixed(5)}:${near.place.lat.toFixed(5)}`
  if (key !== announcedPoiKey) {
    announcedPoiKey = key
    if (soundOn.value && !audioMuted.value) playPoi()
    if (!alertsMuted.value) vibratePoi()
  }
}

// Tap sur la notification de POI : recadre la carte pour montrer d'un coup le coureur ET
// le POI signalé (boîte englobant les deux, donc un dézoom — jamais un zoom au-delà du
// zoom courant, d'où maxZoom), et ouvre la bulle du POI (Google Maps / Street View).
// Le suivi caméra est débrayé le temps du coup d'œil, comme pendant le parcours des POI :
// le bouton « Recentrer » ramène sur le coureur.
//
// Deux cas retombent sur la sémantique du tap carte : en veille, où il réveille l'écran ;
// et sans POI géolocalisé sous la main (notification factice du mode débug) ou sans
// position connue, où il n'y a rien à cadrer — il rappelle alors le geste de veille.
function focusPoiHint() {
  const here = anchorPos ?? lastPos
  if (screenOff.value || !poiHintPlace || !here || !map || !maplibre) {
    onSleepZoneTap()
    return
  }
  // Referme le tiroir de commandes s'il est ouvert : il mange la moitié basse de la carte,
  // qu'on vient justement de cadrer.
  hideControls()
  // Détache la caméra : la boucle de rendu ne réécrit plus la vue (cf. `tick`), seul le
  // marqueur de position continue de bouger. cameraUnlocked empêche aussi la reprise
  // automatique du suivi à l'approche d'un virage.
  following.value = false
  cameraUnlocked.value = true
  const b = new maplibre.LngLatBounds(here, here)
  b.extend([poiHintPlace.lng, poiHintPlace.lat])
  // Marges : de quoi laisser respirer les deux points sous les bandeaux (virage en haut,
  // notification POI + barre de stats en bas), bornées à une fraction de la hauteur pour
  // ne jamais dépasser la carte sur un petit écran.
  const h = containerH || map.getContainer()?.clientHeight || 0
  map.fitBounds(b, {
    padding: {
      top: Math.min(90, Math.round(h * 0.15)),
      bottom: Math.min(180, Math.round(h * 0.3)),
      left: 60,
      right: 60,
    },
    maxZoom: camZoom.value,
    bearing: 0,
    pitch: 0,
    duration: 700,
  })
  pois.openPlacePopup(poiHintPlace)
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
  avgSpeedKmh.value = smoothEtaSpeed(avgSpeedKmh.value, kmh)
}

// When off route, point an arrow back to the nearest vertex of the route. The
// map is rotated so its bearing is "up", so the on-screen angle is the absolute
// bearing-to-route minus the map's bearing.
function updateOffRoute(here: LngLat, idx: number) {
  if (!offRoute.value) return
  const toRoute = bearingBetween(here, geometry[idx])
  const mapBearing = map ? map.getBearing() : currentBearing
  offRouteRelBearing.value = bearingDelta(mapBearing, toRoute)
}

function updateBearing(pos: GeolocationPosition, here: LngLat) {
  // Le cycliste a explicitement forcé la boussole côté appli — geste
  // volontaire pour un couvert forestier où SA PROPRE vitesse GPS (celle
  // captée ici, dans ce WebView) n'est presque jamais nulle : les paliers
  // GPS/déplacement ci-dessous gagneraient donc systématiquement et
  // ignoreraient en silence le cap forcé, précisément le cas qu'on veut
  // couvrir. D'où la priorité absolue, avant tout calcul GPS local.
  if (companionStore.headingForced.value && companionStore.headingDeg.value != null) {
    currentBearing = companionStore.headingDeg.value
    return
  }
  const speed = pos.coords.speed
  const heading = pos.coords.heading
  if (heading != null && !Number.isNaN(heading) && speed != null && speed > MIN_SPEED_MS) {
    currentBearing = heading
    return
  }
  if (lastPos && haversine(lastPos, here) > MIN_MOVE_M) {
    currentBearing = bearingBetween(lastPos, here)
    return
  }
  // À l'ARRÊT, un GPS n'a plus aucun cap à donner : la course se déduit du
  // déplacement, et il n'y en a pas. La flèche restait donc figée sur la
  // dernière direction connue — pile au moment (feu, carrefour, hésitation) où
  // l'on cherche par où repartir, et où une flèche fausse envoie dans la
  // mauvaise rue. L'appli compagnon, elle, a une boussole : elle ne publie ce
  // cap QUE quand elle est à l'arrêt et qu'elle a pu vérifier son magnétomètre
  // contre la course GPS (les supports aimantés le rendent inutilisable), donc
  // sa seule présence vaut autorisation de s'en servir.
  const compass = companionStore.headingDeg.value
  if (compass != null) currentBearing = compass
}

function updateProgress(idx: number) {
  const p = progressFor(idx, geometry, cumDistM, snapDistAlongM)
  remainingM.value = p.remainingM
  remainingGainM.value = p.remainingGainM
  doneRatio.value = p.doneRatio
  // Détection d'arrivée (heuristique anti-faux-positif sur les tracés qui se recoupent) :
  // voir arrivalStep, qui porte l'état d'un fix au suivant.
  const step = arrivalStep(arrivalState, {
    remainingM: p.remainingM,
    hasRoute: hasRoute.value,
    onRoute: !offRoute.value,
    arrived: arrived.value,
  })
  arrivalState = { seenEnRoute: step.seenEnRoute, lastRemainingM: step.lastRemainingM }
  if (step.justArrived) {
    arrived.value = true
    if (soundOn.value && !audioMuted.value) playArrival()
    if (!alertsMuted.value) vibrateArrival()
  }
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
    // Même garde que le cache local : ce cache-miss est exactement « on vient
    // d'entrer dans un nouveau col », le seul moment où l'appli a besoin du
    // profil (voir companionClimbProfile, silencieux hors appli).
    companionClimbProfile(buildCompanionClimbProfile(climb, alts, cumDistM))
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
  // Revenir au suivi clôt le parcours des POI (le popup et le bandeau de parcours).
  stopPoiBrowse()
  following.value = true
  cameraUnlocked.value = false
  // Rétablit le zoom PAR DÉFAUT du profil (et non le zoom courant de la séance) :
  // la boucle réapplique camZoom à chaque frame, donc le remettre ici suffit à
  // figer la vue au zoom du compte (ou, sans compte, au dernier zoom enregistré en
  // localStorage — cf. savedZoom dans useNavCamera).
  camZoom.value = savedZoom.value
  if (!lastPos) return
  // Pause the loop so it doesn't jump-cancel the glide back; re-center, re-orient,
  // restore the 3D tilt AND the profile zoom, then hand the camera back to the loop
  // once we're settled over the rider.
  stopAnimation()
  displayBearing = currentBearing
  // Recentrer sur l'ancre affichée (snappée sur le tracé si on est dessus) pour que
  // caméra et flèche coïncident — la boucle recentre déjà sur la position affichée.
  const opts = followOptions(anchorPos ?? lastPos)
  opts.zoom = savedZoom.value   // followOptions n'ajoute le zoom qu'au tout premier cadrage
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
  // Dans l'appli mobile, la veille éteint aussi le rétroéclairage : le voile
  // noir ne coûte plus que le GPS et les capteurs. Sans effet dans un
  // navigateur ordinaire, qui n'a pas la main sur la luminosité.
  companionScreen(screenOff.value ? 'dimmed' : 'normal')
}

// Bascule manuelle (tap utilisateur) : on annule l'état « réveil automatique » pour
// ne pas re-endormir de soi-même un écran que l'utilisateur a lui-même rallumé (ni
// re-réveiller un écran qu'il vient d'éteindre).
function toggleScreenOffManual() {
  autoWoken = false
  toggleScreenOff()
}

// Tap sur le voile de veille (en dehors du tiroir du bas, qui passe au-dessus). Si le
// tiroir est ouvert, ce premier tap se contente de le refermer — sans quitter la veille,
// comme un clic hors d'un menu déroulant. Sinon (tiroir fermé), on réveille l'écran.
function onScreenOffTap() {
  if (controlsVisible.value) { hideControls(); return }
  toggleScreenOffManual()
}
</script>

<template>
  <!-- nav-page--drawer : le tiroir de commandes est déployé en barre (pas en panneau) et
       occupe le bas de l'écran — les overlays du bas remontent d'autant pour rester
       lisibles (cf. --nav-bottom-inset). En mode panneau, la feuille est haute et les
       recouvre volontairement : on règle quelque chose, la carte passe au second plan.

       nav-page--nobar : rien n'occupe le bas, donc le bouton « recentrer » descend à ras
       du bord. Dans l'appli c'est vrai en permanence — elle masque les deux barres, avec
       ou sans itinéraire — d'où la condition en tête et non plus accrochée à hasRoute. -->
  <div
    class="nav-page"
    :class="{
      'nav-page--drawer': controlsVisible && activePanel === null,
      'nav-page--nobar': appOwnsChrome || (hasRoute && !bottomOverlaysVisible),
    }"
  >
    <div ref="mapEl" class="nav-map" :class="{ 'nav-map--climbing': isClimbing }"></div>

    <!-- Battery saver: black screen — GPS and turn sounds still active -->
    <NavScreenOff
      v-if="screenOff"
      :turn-hint="turnHint"
      :follow-turns="followTurns"
      :arrived="arrived"
      :has-fix="hasFix"
      :off-route="offRoute"
      :climb-info="isClimbing ? climbInfo : null"
      :urgent-m="sportNav.turn_urgent_m"
      :speed-kmh="speedKmh"
      :muted="turnAlertMuted"
      @resume="onScreenOffTap"
      @mute="muteTurnAlert"
    />

    <div v-if="loading" class="nav-overlay-center text-muted">
      <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ hasRoute ? t('routes.computing_route') : t('routes.gps_waiting') }}
    </div>
    <div v-else-if="error" class="nav-overlay-center text-danger">
      <i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>{{ error }}
    </div>

    <!-- Zone de veille : fine bande transparente en haut. Un appui long y endort (comme
         sur la carte, qu'elle recouvre), un tap y réveille — et hors veille, rappelle le
         geste. Active dès que le tiroir est replié (quand il est ouvert, l'utilisateur
         règle quelque chose : un appui au bord haut ne doit pas endormir l'écran) ; en
         veille elle passe au-dessus du voile noir pour réveiller. -->
    <div
      v-if="!controlsVisible"
      class="nav-reveal-zone"
      :class="{ 'nav-reveal-zone--sleep': screenOff }"
      @pointerdown="onSleepZoneDown"
      @pointermove="onSleepZoneMove"
      @pointerup="onSleepZoneUp"
      @pointercancel="onSleepZoneCancel"
    ></div>

    <!-- Anneau de progression de l'appui long (sous le doigt) et explication de ce que la
         veille coupe — et de ce qu'elle ne coupe pas. Voir useSleepHold / NavSleepHold. -->
    <NavSleepHold :press="sleepPress" :hint="sleepHint" />

    <!-- Panneau de commandes : feuille qui glisse depuis le BAS au swipe vers le haut.
         Regroupe TOUS les boutons (retour, profil, style de carte, son, caméra,
         POI) — à portée de pouce, et le haut de l'écran reste aux notifications pleine
         largeur (virage, POI). Masqué hors séance, rappelé par la zone de swipe. -->
    <NavControlsPanel
      :controls-visible="controlsVisible"
      :screen-off="screenOff"
      :logged-in="loggedIn"
      :debug-mode="debugMode"
      :map-style-id="mapStyleId"
      :sound-on="soundOn"
      :sound-volume="soundVolume"
      v-model:active-panel="activePanel"
      :offline-supported="offlineIsSup && !!routeToken"
      :offline-ready="offlineReady"
      :offline-stale="offlineStale"
      :offline-downloading="offlineDownloading"
      :offline-pct="offlinePct"
      :offline-est-mb="offlineEst.mb.toFixed(0)"
      :offline-est-tiles="offlineEst.tiles"
      :offline-errored="offlineErrored"
      :offline-layers="offlineLayerRows"
      :offline-nothing-selected="selectedLayers.length === 0"
      :route-loaded="hasRoute"
      :can-edit="canEditRoute"
      :route-sport="routeSport"
      :route-profile="routeProfile"
      :edit-mode="editMode"
      :climb-card-visible="hasRoute ? showClimbCard : undefined"
      v-model:cam-zoom="camZoom"
      :zoom-saved="zoomSaved"
      :has-unsaved-zoom="hasUnsavedZoom"
      :cam-zoom-min="CAM_ZOOM_MIN"
      :cam-zoom-max="CAM_ZOOM_MAX"
      :poi-cats="POI_CATS"
      :poi-visible="poiVisible"
      :poi-counts="poiCounts"
      :poi-loading="poiLoading"
      :poi-browse-count="poiBrowseCount"
      :route-search="hasRoute"
      :dbg-climb="dbgClimb"
      :dbg-turn-label="dbgTurnLabel"
      :dbg-poi="dbgPoi"
      @arm-controls-hide="armControlsHide"
      @open-route-picker="showRoutePicker = true"
      @navigate-place="() => { activePanel = null; startPlaceNav() }"
      @unload-route="unloadRoute"
      @change-routing="applyRouteRouting"
      @toggle-edit="editMode ? finishEditMode() : enterEditMode()"
      @set-map-style="setMapStyle"
      @toggle-sound="toggleSound"
      @update:sound-volume="setVolume"
      @toggle-climb-card="showClimbCard = !showClimbCard"
      @zoom-input="onZoomInput"
      @save-zoom="saveZoomToProfile"
      @toggle-poi="pois.togglePoi"
      @search-pois="searchPois({ center: lastPos ?? undefined })"
      @search-pois-route="searchPois()"
      @browse-pois="startPoiBrowse"
      @start-offline="startOfflineDownload"
      @cancel-offline="cancelOfflineDownload"
      @remove-offline="removeOfflineMap"
      @toggle-offline-layer="toggleOfflineLayer"
      @toggle-debug-climb="toggleDebugClimb"
      @cycle-debug-turn="cycleDebugTurn"
      @toggle-debug-poi="toggleDebugPoi"
      @reset-storage="resetNavigationState"
    />

    <!-- Toast transitoire : résultat d'une recherche POI (« autour de moi » / trajet). -->
    <Transition name="nav-toast">
      <div
        v-if="poiToast"
        class="nav-toast"
        :class="poiToast.ok ? 'nav-toast--ok' : 'nav-toast--err'"
        role="status"
        aria-live="polite"
      >
        <i class="fa-solid" :class="poiToast.ok ? 'fa-circle-check' : 'fa-circle-exclamation'" aria-hidden="true"></i>
        <span>{{ poiToast.text }}</span>
      </div>
    </Transition>

    <!-- Dialogue de chargement d'un itinéraire (itinéraires sauvegardés + « naviguer
         vers un lieu »). Bascule la page de la navigation libre vers le suivi de tracé. -->
    <NavRoutePicker
      v-if="showRoutePicker"
      :logged-in="loggedIn"
      @load="loadRoute"
      @close="showRoutePicker = false"
    />

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
        <i class="fa-solid fa-circle-info me-2" aria-hidden="true"></i>{{ destPoints.length ? t('routes.navigate_drag_hint') : t('routes.navigate_pick_hint') }}
      </div>
    </div>

    <!-- Confirmation : itinéraire depuis la position GPS passant par les points posés.
         Un bouton « annuler le dernier point » permet de corriger une étape avant de
         lancer le guidage. -->
    <div v-if="placeNavActive && destPoints.length" class="nav-place-confirm-wrap">
      <!-- Réglages du routage (sport + profil BRouter) et aperçu du trajet : distance
           estimée (ou calcul en cours), au-dessus des boutons. Chaque changement relance
           le calcul, dont la ligne pointillée tracée sur la carte. Ces réglages ne valent
           que pour ce trajet : ils ne touchent pas aux préférences du compte. -->
      <div class="nav-place-routing shadow">
        <NavRoutingPicker
          :sport="navSport"
          :profile="navProfile"
          :disabled="navStarting"
          @change="applyNavRouting"
        />
        <div v-if="previewLoading || previewDistM != null" class="nav-place-preview-info">
          <template v-if="previewLoading">
            <i class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>{{ t('routes.computing_route') }}
          </template>
          <template v-else>
            <i class="fa-solid fa-route me-1" aria-hidden="true"></i>{{ (previewDistM / 1000).toFixed(1) }} km
          </template>
        </div>
      </div>
      <div class="nav-place-actions">
        <button
          type="button"
          class="btn btn-light shadow nav-place-undo"
          :title="t('routes.undo_point')"
          :aria-label="t('routes.undo_point')"
          :disabled="navStarting"
          @click="removeLastDestPoint"
        >
          <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
        </button>
        <button
          type="button"
          class="btn btn-primary shadow nav-place-confirm"
          :disabled="navStarting || !hasFix"
          @click="confirmPlaceNav"
        >
          <i v-if="navStarting" class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>
          <i v-else class="fa-solid fa-diamond-turn-right me-1" aria-hidden="true"></i>
          {{ navStarting ? t('routes.computing_route') : (hasFix ? confirmLabel : t('routes.gps_waiting')) }}
        </button>
      </div>
      <div v-if="navError" class="nav-place-error">{{ navError }}</div>
    </div>

    <!-- Mode édition de l'itinéraire : bandeau de consigne en haut + barre d'actions en
         bas. Les points d'ancrage déplaçables sont posés sur la carte (marqueurs JS). -->
    <div v-if="editMode && editHintVisible" class="nav-edit-banner shadow" @click="editHintVisible = false">
      <i class="fa-solid fa-circle-info me-2" aria-hidden="true"></i>{{ t('routes.edit_hint') }}
    </div>
    <div v-if="editMode" class="nav-edit-bar">
      <div v-if="editError" class="nav-edit-error">{{ editError }}</div>
      <div v-else-if="editBusy" class="nav-edit-status shadow">
        <i class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>{{ t('routes.computing_route') }}
      </div>
      <div class="nav-edit-actions">
        <button
          type="button"
          class="btn btn-light shadow nav-edit-cancel"
          :disabled="editSaving"
          @click="cancelEditMode"
        >
          <i class="fa-solid fa-xmark me-1" aria-hidden="true"></i>{{ t('routes.edit_cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary shadow nav-edit-done"
          :disabled="editBusy || editSaving"
          @click="finishEditMode"
        >
          <i v-if="editSaving" class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>
          <i v-else class="fa-solid fa-check me-1" aria-hidden="true"></i>
          {{ editSaving ? t('routes.save') : t('routes.edit_done') }}
        </button>
      </div>
    </div>

    <!-- Upcoming turn indicator. Masqué en mode recherche : l'utilisateur a la tête
         dans la carte pour choisir une nouvelle destination, pas sur le tracé courant. -->
    <NavTurnBanner
      v-if="turnHint && hasFix && !offRoute && !arrived && !placeNavActive && !editMode && !poiBrowseActive"
      :turn-hint="turnHint"
      :follow-turns="followTurns"
      :urgent-m="sportNav.turn_urgent_m"
      :speed-kmh="speedKmh"
      :muted="turnAlertMuted"
      @mute="muteTurnAlert"
    />

    <!-- Arrivée à destination : carte centrée « vous êtes arrivé » (éveillé ; la version
         veille est rendue par NavScreenOff). Masquée en édition / recherche / navigation
         libre vers un POI, où la notion d'arrivée au tracé ne s'applique pas. -->
    <div
      v-if="arrived && hasFix && !placeNavActive && !editMode && !poiBrowseActive"
      class="nav-arrived shadow"
    >
      <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>
      <span class="nav-arrived-text">{{ t('routes.arrived') }}</span>
    </div>

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
      v-if="offRoute && hasFix && !placeNavActive && !editMode && !poiBrowseActive"
      class="fa-solid fa-arrow-up nav-offroute-bigarrow"
      :class="{ 'nav-offroute-bigarrow--sleep': screenOff }"
      :style="{ transform: `translate(-50%, -50%) rotate(${offRouteRelBearing}deg)` }"
      aria-hidden="true"
    ></i>

    <!-- Reroutage manuel : recalcule un chemin BRouter de la position vers le tracé.
         Reste visible en veille (au-dessus du voile noir) : quitter le tracé est une
         info de sécurité ; l'erreur éventuelle s'affiche sous le bouton. -->
    <div v-if="offRoute && hasFix && !placeNavActive && !editMode && !poiBrowseActive" class="nav-reroute" :class="{ 'nav-reroute--sleep': screenOff }">
      <button
        type="button"
        class="btn btn-warning shadow nav-reroute-btn"
        :disabled="rerouting"
        @click="recalcRoute"
      >
        <i v-if="rerouting" class="fa-solid fa-spinner fa-spin me-1" aria-hidden="true"></i>
        <i v-else class="fa-solid fa-route me-1" aria-hidden="true"></i>
        {{ rerouting ? t('routes.rerouting') : t('routes.reroute') }}
        <span v-if="!rerouting && autoRerouteLeftS > 0" class="nav-reroute-cooldown">{{ autoRerouteLeftS }}s</span>
      </button>
      <div v-if="rerouteError" class="nav-reroute-error">{{ rerouteError }}</div>
    </div>

    <!-- Recenter button. Masqué en mode recherche : recentrer sur l'utilisateur
         annulerait la vue sur le lieu cherché et chevaucherait « Naviguer ici ». Masqué
         de même pendant le parcours des POI, où la caméra vole volontairement de POI en
         POI : le bouton apparaîtrait à chaque vol (la caméra n'est plus asservie) et
         recentrer ferait perdre le POI qu'on est en train de regarder. -->
    <button
      v-if="!following && hasFix && !placeNavActive && !editMode && !poiBrowseActive"
      type="button"
      class="btn btn-warning shadow nav-recenter"
      @click="recenter"
    >
      <i class="fa-solid fa-location-arrow me-1" aria-hidden="true"></i>{{ t('routes.recenter') }}
    </button>

    <!-- Bouton flottant « enregistrer le zoom » : même gabarit que « recentrer », côté
         opposé (droite). Libellé court (icône + « Zoom », sens complet dans l'aria-label)
         pour ne pas déborder sur « Recentrer » en portrait étroit. Ne s'affiche que quand
         la séance s'est écartée du zoom de référence (profil, ou fallback localStorage
         sans compte — cf. useNavCamera), reste un instant après le clic pour confirmer
         l'enregistrement. Masqué en mode édition, dont la barre d'outils occupe déjà ce
         coin de l'écran. -->
    <button
      v-if="(hasUnsavedZoom || zoomSaved) && !editMode"
      type="button"
      class="btn btn-warning shadow nav-savezoom"
      :class="{ 'nav-savezoom--done': zoomSaved }"
      :aria-label="zoomSaved ? t('routes.camera_zoom_saved') : t('routes.camera_save_zoom')"
      @click="saveZoomToProfile"
    >
      <i class="fa-solid" :class="zoomSaved ? 'fa-check' : 'fa-floppy-disk'" aria-hidden="true"></i>
      {{ t('routes.camera_zoom') }}
    </button>

    <!-- Climb card: full graded elevation profile with a position cursor.
         Reste visible (au-dessus du voile noir) en mode veille ; un tap réveille. Hors
         veille il ne l'endort plus (c'est l'appui long) : la carte du col est faite pour
         être lue, et on la touche en la lisant. -->
    <NavClimbCard
      v-if="showClimbCard && bottomOverlaysVisible && climbInfo && !offRoute && !approachingTurn && !editMode && !poiBrowseActive"
      :climb-info="climbInfo"
      :screen-off="screenOff"
      @resume="onSleepZoneTap"
    />

    <!-- Notification de proximité d'un point d'intérêt : bandeau compact en bas, juste
         au-dessus de la barre de progression. Le pendant « POI » du virage (en haut).
         Maintenu en veille (un point d'eau / une boulangerie reste utile écran éteint) :
         rendu ici (et non dans NavScreenOff) pour échapper au contexte d'empilement du
         voile et pouvoir passer AU-DESSUS de la carte de col en veille (z-index relevé
         via screen-off). -->
    <NavPoiBanner v-if="poiHint && hasFix && bottomOverlaysVisible && !poiBrowseActive" :poi-hint="poiHint" :screen-off="screenOff" @focus-poi="focusPoiHint" />

    <!-- Parcours des POI : bandeau de pilotage (précédent / suivant) qui enchaîne les POI
         visibles, du plus proche au plus loin, en faisant voler la caméra sur chacun.
         Remplace la notification de proximité tant qu'il est actif. -->
    <NavPoiBrowser
      v-if="poiBrowseActive && poiBrowseHint && !placeNavActive && !editMode"
      :place="poiBrowseHint"
      :dist-m="poiBrowseDistM"
      :index="poiBrowseIndex"
      :total="poiBrowseList.length"
      :cats="poiBrowseCats"
      :filter="poiBrowseFilter"
      @prev="browsePrev"
      @next="browseNext"
      @set-filter="setPoiBrowseFilter"
      @close="stopPoiBrowse"
    />

    <!-- Bottom stats : barre complète (distance / D+ / ETA / progression) en navigation
         sur itinéraire (masquable par le geste latéral) ; en navigation libre, carte
         réduite à la vitesse. Escamotée pendant le parcours des POI, où le bandeau de
         parcours prend sa place tout en bas.

         Ni l'une ni l'autre dans l'appli mobile (`appOwnsChrome`) : elle a son propre
         bandeau, natif, juste sous le WebView. La garde manquait sur la carte de
         navigation libre, et vitesse et cardio s'y affichaient donc deux fois, l'un
         au-dessus de l'autre. -->
    <NavStatsBar
      v-if="hasRoute && bottomOverlaysVisible && !poiBrowseActive && !appOwnsChrome"
      :remaining-m="remainingM"
      :remaining-gain-m="remainingGainM"
      :done-percent="donePercent"
      :speed-kmh="speedKmh"
      :eta-speed-kmh="avgSpeedKmh"
    />
    <div
      v-else-if="!hasRoute && !poiBrowseActive && !appOwnsChrome"
      class="nav-stats nav-stats--free shadow"
    >
      <div class="nav-stat-value">{{ Math.round(speedKmh) }}<span class="nav-stat-unit"> km/h</span></div>
      <div class="nav-stat-label">{{ t('routes.speed') }}</div>
      <!-- En navigation libre il n'y a pas de barre de stats : les capteurs de
           l'application mobile se rangent sous la vitesse. -->
      <CompanionSensors />
    </div>

    <!-- Révélation du tiroir de commandes : zone alignée sur la barre du bas (avancement /
         vitesse) qui capte le swipe vers le haut (ou un tap), poignée centrée au bord
         inférieur. Active tant que le tiroir est replié, y compris en veille (elle passe
         alors au-dessus du voile noir, comme le tiroir lui-même). -->
    <div
      v-if="!controlsVisible && !appOwnsChrome"
      class="nav-menu-reveal-zone"
      :class="{
        'nav-menu-reveal-zone--sleep': screenOff,
        'nav-menu-reveal-zone--browse': poiBrowseActive,
      }"
      @pointerdown="onMenuDown"
      @pointermove="onMenuMove"
      @pointerup="onMenuUp"
      @pointercancel="cancelMenuReveal"
    >
      <span class="nav-menu-grabber" aria-hidden="true">
        <i class="fa-solid fa-chevron-up"></i>
      </span>
    </div>

    <!-- Masquage groupé des overlays du bas : une fine zone au bord DROIT capte le swipe
         de droite à gauche (ou un tap) et bascule la visibilité de tous les overlays du
         bas. Geste horizontal — le vertical est pris par le tiroir de commandes, juste en
         dessous. Disponible aussi en veille (pour masquer la carte de col écran éteint,
         comme hors veille) ; masquée seulement en recherche / édition. Le chevron pointe
         vers la droite quand tout est visible (geste → masquer) et vers la gauche quand
         c'est masqué (geste → réafficher). -->
    <div
      v-if="hasRoute && !placeNavActive && !editMode && !appOwnsChrome"
      class="nav-bottom-reveal-zone"
      :class="{ 'nav-bottom-reveal-zone--sleep': screenOff }"
      @pointerdown="onBottomDown"
      @pointermove="onBottomMove"
      @pointerup="onBottomUp"
      @pointercancel="cancelBottomReveal"
    >
      <span class="nav-bottom-grabber" aria-hidden="true">
        <i class="fa-solid" :class="bottomOverlaysVisible ? 'fa-chevron-right' : 'fa-chevron-left'"></i>
      </span>
    </div>

    <!-- Opacité du tracé : fine zone au bord GAUCHE, glissé vertical continu (haut =
         plus opaque, bas = plus transparent) pour voir un repère de la carte que le
         tracé recouvrirait. Symétrique de la zone de masquage des overlays, mais un
         glissé continu et non un geste à seuil — voir useTrackOpacityDrag. Masquée en
         recherche / édition, où le geste sert déjà à poser un point, et en veille : le
         voile noir cache justement ce que ce geste sert à voir. -->
    <div
      v-if="hasRoute && !placeNavActive && !editMode && !screenOff"
      class="nav-opacity-drag-zone"
      @pointerdown="onOpacityDragDown"
      @pointermove="onOpacityDragMove"
      @pointerup="onOpacityDragUp"
      @pointercancel="cancelOpacityDrag"
    >
      <span class="nav-opacity-grabber" aria-hidden="true">
        <i class="fa-solid fa-droplet"></i>
      </span>
    </div>
    <div v-if="opacityDragging" class="nav-opacity-indicator" aria-hidden="true">
      {{ Math.round(trackOpacity * 100) }} %
    </div>
  </div>
</template>

<style scoped>
.nav-page {
  position: relative;
  width: 100%;
  /* Décalage vers le haut des overlays ancrés en bas (stats, carte de col, bandeau POI,
     recentrer) quand le tiroir de commandes occupe le bas en mode barre. Hérité par les
     composants enfants : les variables CSS traversent les styles scopés. Hauteur de la
     barre = 0.75rem de padding × 2 + 3.25rem de bouton. */
  --nav-bottom-inset: 0rem;
  /* Hauteur réservée au-dessus de la barre du bas (avancement ou vitesse) pour le bouton
     « recentrer », qui se pose sur son bord supérieur. Tombe à ras du bord quand la barre
     est escamotée (cf. nav-page--nobar). */
  --nav-bar-clearance: 5.75rem;
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
.nav-page--drawer { --nav-bottom-inset: 4.75rem; }
/* Overlays du bas escamotés (geste de droite à gauche) : plus de barre d'avancement à
   surplomber, le bouton « recentrer » descend au ras du coin bas-gauche. */
.nav-page--nobar { --nav-bar-clearance: 0.9rem; }
.nav-map { position: absolute; inset: 0; }
/* Carte à deux doigts (cf. TWO_FINGER_PAN) : MapLibre rend alors le glissement à un doigt
   au navigateur (touch-action: pan-x pan-y), ce qui rouvre la porte au « tirer pour
   rafraîchir » de Chrome — un rechargement de page en pleine navigation. La page ne défile
   jamais (nav-page: overflow hidden), donc rien à céder : on remet touch-action: none. */
.nav-map :deep(.maplibregl-cooperative-gestures),
.nav-map :deep(.maplibregl-cooperative-gestures .maplibregl-canvas) { touch-action: none; }
/* Message « déplacez la carte à deux doigts » : par défaut MapLibre noircit toute la carte
   (voile 40 %, z-index 99999 — .nav-map n'étant pas un contexte d'empilement, il passerait
   même devant le tiroir de commandes). Réduit à une pastille posée en haut, sous les
   overlays : elle dit pourquoi la carte n'a pas bougé sans masquer la route. */
.nav-map :deep(.maplibregl-cooperative-gesture-screen) {
  background: none; align-items: flex-start; padding-top: 7rem; z-index: 4;
}
.nav-map :deep(.maplibregl-cooperative-gesture-screen .maplibregl-mobile-message),
.nav-map :deep(.maplibregl-cooperative-gesture-screen .maplibregl-desktop-message) {
  background: rgba(0, 0, 0, 0.72); border-radius: 999px; padding: 0.45rem 0.9rem;
  font-size: 0.95rem; font-weight: 500; text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
/* Pendant un col, la carte se rétrécit pour laisser le bas de l'écran à la carte du
   col (bottom: 6.25rem, hauteur ≈ 16rem) : la flèche reste dans la carte visible. */
.nav-map--climbing { bottom: calc(22.75rem + var(--nav-bottom-inset)); }

.nav-overlay-center {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 5; font-weight: 500;
}

/* Zone de veille : bande transparente en haut de l'écran, sensible au seul tap (le
   tiroir de commandes est en bas). touch-action:none pour que le geste ne parte pas en
   scroll. Au-dessus de la carte mais sous le voile de veille (z-index 20). */
.nav-reveal-zone {
  position: absolute; top: 0; left: 0; right: 0; height: 6rem;
  z-index: 6; touch-action: none;
}
/* En veille, le voile noir (z 20) recouvre tout : on remonte la zone au-dessus pour
   qu'un tap au bord haut réveille l'écran. */
.nav-reveal-zone--sleep { z-index: 21; }

@keyframes nav-reveal-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.7; }
}

/* Zone de geste « swipe vers le haut » du tiroir de commandes : couvre toute la barre du
   bas (avancement en navigation sur itinéraire, vitesse en navigation libre) — on part du
   pouce posé sur les chiffres, sans viser une poignée de la taille d'un timbre. Alignée
   sur cette barre (mêmes marges latérales, hauteur = 0.75rem d'écart + ~4.7rem de barre).
   touch-action:none pour que le glissement vertical déclenche pointermove. z-index 8 :
   au-dessus des overlays du bas (stats z6, POI z7 — qui commence à 6rem, juste au-dessus
   de la zone), au niveau du tiroir lui-même — qu'elle ne côtoie jamais, l'un n'existant
   que quand l'autre est replié. */
.nav-menu-reveal-zone {
  position: absolute; bottom: 0; left: 0.75rem; right: 0.75rem;
  height: 5.5rem; z-index: 8; touch-action: none;
  display: flex; justify-content: center; align-items: flex-end;
}
/* En veille, le voile noir (z 20) recouvre tout : on remonte la zone au-dessus pour
   qu'un swipe vers le haut ouvre le tiroir écran éteint (le tiroir lui-même passe aussi
   au-dessus du voile, cf. nav-controls-panel--sleep). */
.nav-menu-reveal-zone--sleep { z-index: 21; }
/* Parcours des POI : le bandeau de parcours occupe le bas et passe devant (z 9). La zone
   de geste se replie juste au-dessus de lui pour rester utilisable — et sa poignée
   visible — sans lui voler ses taps. */
.nav-menu-reveal-zone--browse { bottom: 5rem; height: 2.4rem; }
/* Chevron discret indiquant qu'on peut faire glisser vers le haut pour déployer le
   tiroir de commandes. */
.nav-menu-grabber {
  margin-bottom: 0.2rem;
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.8rem; height: 1.3rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.28); color: #fff; font-size: 0.7rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  animation: nav-reveal-pulse 2.4s ease-in-out infinite;
}
/* Fond sombre du grabber confondu avec le voile : on l'éclaircit en veille. */
.nav-menu-reveal-zone--sleep .nav-menu-grabber { background: rgba(255, 255, 255, 0.25); }

/* Zone de geste « swipe de droite à gauche » du masquage des overlays du bas : poignée
   collée au bord DROIT, à mi-hauteur. Horizontale parce que le vertical est pris par le
   tiroir de commandes, en bas. touch-action:none pour que le glissement déclenche
   pointermove plutôt qu'un pan de carte. z-index 8 : au-dessus des overlays du bas
   (stats z6, POI z7). */
.nav-bottom-reveal-zone {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  width: 2.4rem; height: 8rem; z-index: 8; touch-action: none;
  display: flex; justify-content: flex-end; align-items: center;
}
/* En veille, le voile noir (z 20) recouvre tout : on remonte la zone de geste au-dessus
   (comme la carte de col à z 21) pour pouvoir masquer la carte de col écran éteint. */
.nav-bottom-reveal-zone--sleep { z-index: 21; }
/* Chevron discret indiquant qu'on peut balayer vers la gauche pour escamoter les
   overlays du bas (et les rappeler). */
.nav-bottom-grabber {
  margin-right: 0.2rem;
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.3rem; height: 2.4rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.28); color: #fff; font-size: 0.7rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  animation: nav-reveal-pulse 2.4s ease-in-out infinite;
}
/* En veille, le fond sombre du grabber se confondrait avec le voile noir : on l'éclaircit
   pour qu'il reste repérable. */
.nav-bottom-reveal-zone--sleep .nav-bottom-grabber { background: rgba(255, 255, 255, 0.25); }

/* Zone de geste « glissé vertical » de l'opacité du tracé : bord GAUCHE, symétrique de
   .nav-bottom-reveal-zone. touch-action:none pour que le glissement déclenche pointermove
   plutôt qu'un pan de carte. Même z-index : les deux bords ne se recouvrent jamais. */
.nav-opacity-drag-zone {
  position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 4rem; height: 16rem; z-index: 8; touch-action: none;
  display: flex; justify-content: flex-start; align-items: center;
}
/* Goutte discrète indiquant qu'on peut glisser verticalement pour régler l'opacité. */
.nav-opacity-grabber {
  margin-left: 0.2rem;
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.3rem; height: 2.4rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.28); color: #fff; font-size: 0.7rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  animation: nav-reveal-pulse 2.4s ease-in-out infinite;
}
/* Pastille de retour affichée pendant le geste, valeur en pourcent — même famille que le
   bandeau de virage. Centrée verticalement à côté de la zone de geste. */
.nav-opacity-indicator {
  position: absolute; left: 4.6rem; top: 50%; transform: translateY(-50%);
  z-index: 9; padding: 0.35rem 0.7rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.72); color: #fff; font-weight: 600; font-size: 0.9rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); pointer-events: none;
}

.nav-banner {
  /* + --app-inset-top : encoche du téléphone quand l'application mobile affiche
     la navigation en plein écran (0 dans un navigateur). Voir NavTurnBanner. */
  position: absolute; top: calc(0.75rem + var(--app-inset-top, 0px)); left: 50%; transform: translateX(-50%);
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

/* Arrivée à destination : carte centrée, verte (cohérente avec le vert « virage atteint »),
   drapeau à damier + « vous êtes arrivé ». z-index 8 : au-dessus des overlays de virage/POI
   mais sous le tiroir de commandes (9). pointer-events: none — purement informatif. */
.nav-arrived {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 8; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 1.25rem;
  background: #16a34a; color: #fff;
  padding: 2.5rem 3.5rem; border-radius: 1.5rem;
  text-align: center;
}
.nav-arrived i { font-size: 5rem; line-height: 1; }
.nav-arrived-text { font-size: 2.4rem; font-weight: 700; line-height: 1.1; }

/* Toast transitoire de résultat de recherche POI : centré en haut, au-dessus des
   panneaux (z 10), non interactif. Vert si abouti, rouge si échec. */
.nav-toast {
  position: absolute; top: 4.5rem; left: 50%; transform: translateX(-50%);
  /* z-index 24 : au-dessus de la feuille de réglages (23), d'où partent justement les
     recherches de POI dont ce toast rend compte. */
  z-index: 24; display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 1rem; border-radius: 999px;
  font-weight: 600; font-size: 0.9rem; white-space: nowrap;
  color: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.nav-toast--ok { background: #198754; }
.nav-toast--err { background: #dc3545; }
.nav-toast-enter-active, .nav-toast-leave-active { transition: opacity 0.25s, transform 0.25s; }
.nav-toast-enter-from, .nav-toast-leave-to { opacity: 0; transform: translate(-50%, -0.5rem); }

/* Bouton recentrer : calé à gauche, JUSTE AU-DESSUS de la barre du bas (avancement ou
   vitesse) — le bas de l'écran appartient désormais au geste d'ouverture du tiroir, qui
   couvre toute cette barre. Aligné sur sa marge latérale (0.75rem) et posé sur son bord
   supérieur (--nav-bar-clearance : 0.75rem d'écart + ~4.7rem de barre, ramené au ras du
   bord quand la barre est escamotée). Remonte encore du tiroir déployé
   (--nav-bottom-inset). Au-dessus de TOUS les autres éléments (z-index 22 > voile de
   veille 20/21 et marqueurs POI 1) pour rester toujours accessible. */
.nav-recenter {
  position: absolute; bottom: calc(var(--nav-bar-clearance) + var(--nav-bottom-inset)); left: 0.75rem; z-index: 22;
  transition: bottom 0.28s ease;
  border-radius: 999px; font-weight: 700;
  font-size: 1.35rem; padding: 0.85rem 1.8rem;
}

/* Bouton enregistrer le zoom : symétrique de « recentrer », posé à droite avec le
   même gabarit (gouttière, taille, z-index). */
.nav-savezoom {
  position: absolute; bottom: calc(var(--nav-bar-clearance) + var(--nav-bottom-inset)); right: 0.75rem; z-index: 22;
  transition: bottom 0.28s ease;
  border-radius: 999px; font-weight: 700;
  font-size: 1.35rem; padding: 0.85rem 1.8rem;
}
.nav-savezoom--done { background: #198754; border-color: #198754; color: #fff; }

/* Bouton de reroutage : centré AU-DESSUS de la grande flèche hors-tracé (flèche
   centrée à 50 %, ~20 vmin de demi-hauteur). On ancre le bas du bloc juste au-dessus
   du sommet de la flèche pour qu'il la surplombe. z-index 7 pour rester cliquable
   au-dessus de la flèche (z 6). */
.nav-reroute {
  position: absolute; bottom: calc(50% + 21vmin); left: 50%; transform: translateX(-50%);
  z-index: 7; display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
}
/* Mode veille : au-dessus du voile noir (z 20) pour rester cliquable écran éteint,
   comme la grande flèche hors-tracé. */
.nav-reroute--sleep { z-index: 21; }
.nav-reroute-btn {
  border-radius: 999px; font-weight: 700;
  font-size: 1.45rem; padding: 0.9rem 2rem;
}
.nav-reroute-cooldown {
  display: inline-block; margin-left: 0.5rem;
  background: rgba(0, 0, 0, 0.18); border-radius: 999px;
  padding: 0.05em 0.55em; font-size: 0.8em; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.nav-reroute-error {
  background: #fff3cd; color: #664d03; border-radius: 999px;
  padding: 0.3rem 0.8rem; font-size: 0.85rem; font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* Mode « cible » : barre de recherche centrée en haut + consigne ; au-dessus du
   tiroir de commandes (z 8) car il est replié pendant ce mode. */
.nav-place-picker {
  /* + --app-inset-top : encoche du téléphone quand l'application mobile affiche
     la navigation en plein écran (0 dans un navigateur). Voir NavTurnBanner. */
  position: absolute; top: calc(0.75rem + var(--app-inset-top, 0px)); left: 50%; transform: translateX(-50%);
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
.nav-place-actions { display: flex; align-items: center; gap: 0.5rem; }
/* Carte de réglage du routage : sport, profil BRouter, distance de l'aperçu. */
.nav-place-routing {
  background: rgba(255, 255, 255, 0.95); color: #1f2937; border-radius: 0.75rem;
  padding: 0.5rem 0.6rem; display: flex; flex-direction: column; gap: 0.4rem;
  min-width: 16rem; max-width: 92vw;
}
.nav-place-preview-info {
  font-size: 0.9rem; font-weight: 600; min-height: 1.6rem;
  display: inline-flex; align-items: center; justify-content: center;
}
.nav-place-undo {
  flex-shrink: 0; width: 3rem; height: 3rem; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 1.1rem;
}
.nav-place-confirm {
  border-radius: 999px; font-weight: 600; font-size: 1.1rem; padding: 0.6rem 1.4rem;
}
.nav-place-error {
  background: #fff3cd; color: #664d03; border-radius: 999px;
  padding: 0.3rem 0.8rem; font-size: 0.85rem; font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* Mode édition : bandeau de consigne en haut (au-dessus de la carte, sous le tiroir
   replié z 8) + barre d'actions ancrée en bas, au-dessus du bandeau de stats. */
.nav-edit-banner {
  /* + --app-inset-top : encoche du téléphone quand l'application mobile affiche
     la navigation en plein écran (0 dans un navigateur). Voir NavTurnBanner. */
  position: absolute; top: calc(0.75rem + var(--app-inset-top, 0px)); left: 50%; transform: translateX(-50%);
  z-index: 7; width: min(440px, calc(100% - 1.5rem));
  background: rgba(124, 58, 237, 0.96); color: #fff;
  padding: 0.5rem 0.9rem; border-radius: 0.6rem;
  font-size: 0.85rem; font-weight: 500; text-align: center;
  /* Un tap masque l'aide (cf. editHintVisible) et rend la bande haute — devenue une
     zone de tap pour la veille — de nouveau accessible. */
  cursor: pointer;
}
.nav-edit-bar {
  position: absolute; bottom: 8rem; left: 50%; transform: translateX(-50%);
  z-index: 9; display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
}
.nav-edit-status {
  background: rgba(255, 255, 255, 0.95); color: #1f2937; border-radius: 999px;
  padding: 0.25rem 0.8rem; font-size: 0.9rem; font-weight: 600;
  display: inline-flex; align-items: center;
}
.nav-edit-actions {
  display: flex; align-items: center; gap: 0.6rem;
}
.nav-edit-done {
  border-radius: 999px; font-weight: 600; font-size: 1.1rem; padding: 0.6rem 1.6rem;
}
.nav-edit-cancel {
  border-radius: 999px; font-weight: 600; font-size: 1.1rem; padding: 0.6rem 1.4rem;
}
.nav-edit-error {
  background: #fff3cd; color: #664d03; border-radius: 999px;
  padding: 0.3rem 0.8rem; font-size: 0.85rem; font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* Barre du bas en navigation libre : réduite à la vitesse (reprend l'allure de
   NavStatsBar), centrée. Affichée tant qu'aucun itinéraire n'est chargé. Remonte
   au-dessus du tiroir de commandes quand il est déployé (cf. --nav-bottom-inset). */
.nav-stats {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: calc(0.75rem + var(--nav-bottom-inset));
  transition: bottom 0.28s ease;
  /* z-index 6 : au-dessus de TOUTE la couche de marqueurs de la carte (POI z1,
     pastilles de virage z2-4, destination z4, flèche du coureur z5), qui sont des
     overlays DOM MapLibre remontant dans le contexte d'empilement racine. Cf. le
     même choix dans NavStatsBar.vue. */
  z-index: 6; background: #fff; border-radius: 0.75rem; padding: 0.7rem 0.85rem;
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
  /* Position de l'utilisateur : au-dessus de tous les autres marqueurs (POI, virages
     inactifs/actif, destination). */
  z-index: 5;
}

/* Marqueur de destination posé au tap en mode « cible » (créé en JS, donc style
   global, hors scope). */
.nav-dest-marker {
  position: relative;
  color: #dc2626;
  font-size: 2rem;
  line-height: 1;
  /* Interactif : déplaçable au glisser, tooltip au tap. touch-action: none laisse
     MapLibre gérer le glissement au doigt sans déclencher le pan de la carte. */
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  z-index: 4;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45));
}
.nav-dest-marker:active { cursor: grabbing; }
/* Numéro d'ordre du point d'étape, posé dans le rond de la goutte. */
.nav-dest-num {
  position: absolute;
  top: 0.18em; left: 50%; transform: translateX(-50%);
  font-size: 0.5em; font-weight: 700; line-height: 1;
  color: #fff;
}

/* Point d'ancrage déplaçable en mode édition (créé en JS, donc style global). Pastille
   ronde violette numérotée, posée sur le tracé ; déplaçable au glisser, suppression au
   tap. touch-action: none laisse MapLibre gérer le glissement au doigt. */
.nav-edit-marker {
  display: flex; align-items: center; justify-content: center;
  width: 1.6rem; height: 1.6rem; border-radius: 50%;
  background: #7c3aed; color: #fff; border: 2px solid #fff;
  font-size: 0.8rem; font-weight: 700; line-height: 1;
  pointer-events: auto; cursor: grab; touch-action: none;
  z-index: 4;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.45);
}
.nav-edit-marker:active { cursor: grabbing; }
.nav-edit-num { pointer-events: none; }

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
  /* Au-dessus des POI (z 1). Le prochain virage (--selected) passe encore au-dessus
     des virages inactifs voisins (z 3) pour ne jamais être recouvert. */
  z-index: 2;
}
.nav-turn-marker--selected { z-index: 3; }
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

/* Tooltip de virage (« franchi / pas encore »). Les pastilles gardent
   `pointer-events: none` : le tap est reconnu en pixels dans le gestionnaire de clic de
   la carte (cf. handleTurnTap), pas par un écouteur DOM sur la pastille. */

/* Un virage listé : son état, puis le bouton qui le contredit. Séparés d'un filet quand
   le tracé repasse au même endroit et qu'il y en a plusieurs à départager. */
.nav-turn-popup-row + .nav-turn-popup-row {
  border-top: 1px solid #e5e7eb;
  margin-top: 0.35rem;
  padding-top: 0.35rem;
}
.nav-turn-popup-state {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.6rem 0.1rem;
  font-size: 0.9rem;
  color: #4b5563;
}
/* Portée du geste (« et les 52 virages avant lui ») : discrète, mais c'est elle qui dit
   qu'un seul tap suffit à rattraper tout un tronçon. */
.nav-turn-popup-span {
  padding: 0 0.6rem 0.25rem;
  font-size: 0.8rem;
  color: #6b7280;
}

/* Suivi d'itinéraire : toutes les pastilles restent posées sur le tracé. Les virages
   autres que le prochain sont grisés (désaturés + estompés) comme désactivés, pour
   rester discrets sans disparaître. Le grisage porte sur le corps (la racine garde la
   rotation/position MapLibre). */
.nav-turn-marker--inactive .nav-turn-marker-body {
  filter: grayscale(1);
  opacity: 0.5;
}

/* Prochain virage : pastille en couleur qui pulse pour attirer l'œil. Le halo reprend
   la couleur de fond de l'indicateur (--turn-pulse-color, posée en JS) et un fin liseré
   blanc le détache du fond. Porté par le corps (qui subit déjà le scale du zoom), donc
   il grossit/rétrécit avec la pastille. */
.nav-turn-marker--selected .nav-turn-marker-body {
  animation: nav-turn-pulse 1.2s ease-in-out infinite;
}
@keyframes nav-turn-pulse {
  0%, 100% {
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), 0 0 6px 2px var(--turn-pulse-color, #f97316);
  }
  50% {
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 1), 0 0 20px 8px var(--turn-pulse-color, #f97316);
  }
}

/* Virage atteint (« now ») : la pastille passe en vert (couleur posée en inline par
   setGreenTurn) et pulse en vert pour confirmer « tournez ici », en cohérence avec le
   bandeau vert. filter/opacity annulent un éventuel grisage (le virage atteint est
   souvent déjà « inactive », derrière le coureur). Au-dessus des autres pastilles. */
.nav-turn-marker--now { z-index: 4; }
.nav-turn-marker--now .nav-turn-marker-body {
  filter: none;
  opacity: 1;
  animation: nav-turn-pulse 1.2s ease-in-out infinite;
}
</style>
