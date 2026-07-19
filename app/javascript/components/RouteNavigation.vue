<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import {
  buildDistancesM, detectClimbs, detectTurns, turnsFromVoiceHints, computeGainLoss,
  haversine, bearingBetween, nearestGeomIndex, projectOnRoute,
  lngLatAtDistanceM, progressFor, activeClimb, gradeForIndex, colorForGrade,
  buildOffsetDisplayLine, formatDistancePrecise,
} from '../routeHelpers'
import type { Coord, Climb, LngLat, TurnPoint, VoiceHint, Maneuver } from '../routeHelpers'
import { fetchRouteToPlace, fetchRouteVia, fetchRouteFromWaypoints } from '../navRoute'
import type { Waypoint } from '../navRoute'
import { MAX_WAYPOINTS } from '../stores/routeStore'
import {
  textColorOn, moveLngLat, buildClimbProfile, profileYAt, buildDebugClimb,
} from '../navHelpers'
import type { TurnHint, ClimbInfo, ClimbProfile } from '../navHelpers'
import { unlockAudio, playManeuver, playManeuverBurst, playOffRoute, playPoi } from '../navAudio'
import { vibrateManeuver, vibrateApproach, vibrateOffRoute, vibratePoi } from '../navHaptics'
import { categoryForType } from '../poiCategories'
import RadarOverlay from './RadarOverlay.vue'
import NavTurnBanner from './NavTurnBanner.vue'
import NavPoiBanner from './NavPoiBanner.vue'
import NavPoiBrowser from './NavPoiBrowser.vue'
import NavScreenOff from './NavScreenOff.vue'
import NavClimbCard from './NavClimbCard.vue'
import NavStatsBar from './NavStatsBar.vue'
import NavControlsPanel from './NavControlsPanel.vue'
import NavPlaceSearch from './NavPlaceSearch.vue'
import NavRoutePicker from './NavRoutePicker.vue'
import type { PlaceResult } from '../composables/usePlaceSearch'
import { radarStore } from '../stores/radarStore'
import { userPreferences, persistNavigationStyle, sportPreferences, setActiveSport, isLoggedIn, routeProfileForSport } from '../userPreferences'
import type { Sport } from '../userPreferences'
import { catalogDefaultForSport, isProfileValidForSport } from '../brouter'
import NavRoutingPicker from './NavRoutingPicker.vue'
import { useNavPois } from '../composables/useNavPois'
import type { NavPlace } from '../composables/useNavPois'
import type { RouteMarker } from '../routeMarkers'
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
  offlineSupported, hasOfflineArchive, registerOfflineArchive, offlineStyle, OFFLINE_DEFAULTS,
  downloadOfflineArchive, deleteOfflineArchive, estimateOffline, saveOfflinePois, deleteOfflinePois,
  routeSignature, saveArchiveSignature, archiveSignature, deleteArchiveSignature,
  purgeLegacyArchive, OFFLINE_LAYERS, isOfflineLayer, type OfflineLayer,
} from '../offline/offlineMaps'
import { buildCoordPopupContent, buildDestPointPopupContent, attachLongPress } from '../mapCoordPopup'

// Page de navigation unifiée : démarre en mode libre (carte + GPS + vitesse, sans
// tracé) et peut charger/décharger un itinéraire à chaud. shareToken : si présent
// (lien partageable /routes/:token/navigate), l'itinéraire est chargé automatiquement
// au montage. Absent → on démarre en navigation libre.
const props = defineProps<{ shareToken?: string; canDebug?: boolean }>()

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
// Son de la séance (alertes virage / radar). Voir useNavSound.
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
// Chaque fond swisstopo (gris / couleur / satellite) a sa propre archive : le coureur
// coche ce qu'il veut emporter, et ne paie que ça en Mo.
type LayerFlags = Record<OfflineLayer, boolean>
const noLayers = (): LayerFlags => ({ swissgrau: false, swisstopo: false, swissimage: false })

let baseIsOffline = false              // le fond actif est-il la version locale ?
const offlineIsSup = offlineSupported()
const offlineDownloading = ref(false)
const offlineProgress = ref({ done: 0, total: 0, failed: 0 })
const offlineErrored = ref(false)
let offlineAbort: AbortController | null = null
// Archives présentes dans l'OPFS, et celles branchées sur le protocole pmtiles://.
const offlineHas = ref<LayerFlags>(noLayers())
let offlineRegistered: LayerFlags = noLayers()
// Couches cochées pour le prochain téléchargement.
const offlineSelected = ref<LayerFlags>(noLayers())
// Empreinte du tracé au moment du téléchargement, par couche. `null` = archive absente, ou
// téléchargée avant l'introduction du suivi (on ne réclame alors rien).
const archivedSigs = ref<Record<OfflineLayer, string | null>>({ swissgrau: null, swisstopo: null, swissimage: null })

// Le tracé a changé depuis le téléchargement (reroutage, détour, édition) : l'archive ne
// couvre plus tout l'itinéraire, il faut la retélécharger.
const currentSig = computed(() => routeSignature(offlineCoords.value))
function layerStale(l: OfflineLayer): boolean {
  const sig = archivedSigs.value[l]
  return offlineHas.value[l] && !!sig && sig !== currentSig.value
}
const offlineReady = computed(() => OFFLINE_LAYERS.some((l) => offlineHas.value[l]))
const offlineStale = computed(() => OFFLINE_LAYERS.some(layerStale))
const selectedLayers = computed(() => OFFLINE_LAYERS.filter((l) => offlineSelected.value[l]))
const offlineEst = computed(() => estimateOffline(offlineCoords.value, selectedLayers.value))
// Vue à plat pour le panneau : une ligne par fond téléchargeable.
const offlineLayerRows = computed(() =>
  OFFLINE_LAYERS.map((id) => ({ id, ready: offlineHas.value[id], stale: layerStale(id), selected: offlineSelected.value[id] })),
)
function toggleOfflineLayer(id: OfflineLayer) {
  offlineSelected.value = { ...offlineSelected.value, [id]: !offlineSelected.value[id] }
}
const offlinePct = computed(() =>
  offlineProgress.value.total ? Math.round((offlineProgress.value.done / offlineProgress.value.total) * 100) : 0,
)

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
// Toast transitoire du résultat d'une recherche POI manuelle (boutons « autour de moi »
// / « sur le trajet ») : nombre de lieux trouvés, ou échec de la recherche. Auto-effacé.
const poiToast = ref<{ ok: boolean; text: string } | null>(null)
let poiToastTimer: number | null = null
function showPoiToast(ok: boolean, text: string) {
  poiToast.value = { ok, text }
  if (poiToastTimer != null) clearTimeout(poiToastTimer)
  poiToastTimer = window.setTimeout(() => { poiToast.value = null; poiToastTimer = null }, 3000)
}

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
// Enchaîne les POI visibles, du plus proche au plus loin, en faisant voler la caméra
// sur chacun (zoom rapproché) et en affichant sa distance depuis la position courante.
// L'ordre est figé au lancement (tri par distance) : seule la distance affichée se met
// à jour en roulant, l'index ne saute pas. La caméra est détachée (following=false) le
// temps du parcours ; le bouton « Recentrer » la ramène sur le coureur.
// Compteur réactif incrémenté à chaque fix GPS : `lastPos` est non réactif (gros volume,
// lu dans des callbacks), ce tick permet aux computed dépendants de la position (distance
// du POI parcouru) de se recalculer en roulant.
const posTick = ref(0)
const poiBrowseActive = ref(false)
const poiBrowseIndex = ref(0)
// Liste complète des POI à parcourir (tous les POI visibles, triés par distance au
// lancement). Le filtre par catégorie s'applique par-dessus sans retoucher cette liste,
// pour qu'un changement de filtre ne rejoue pas le tri.
const poiBrowseAll = ref<NavPlace[]>([])
// Catégorie de POI parcourue (clé du registre POI) ou null = toutes les catégories.
const poiBrowseFilter = ref<string | null>(null)
const poiBrowseCount = computed(() => pois.visiblePlaces.value.length)
// Liste effectivement parcourue : la liste complète filtrée par la catégorie choisie.
const poiBrowseList = computed(() =>
  poiBrowseFilter.value
    ? poiBrowseAll.value.filter((p) => categoryForType(p.type)?.key === poiBrowseFilter.value)
    : poiBrowseAll.value,
)
// Catégories présentes dans la liste, dans l'ordre du registre, avec leur nombre de POI :
// alimente le menu déroulant de filtre du bandeau de parcours. On ne propose que les
// catégories effectivement trouvées (filtrer sur une catégorie vide n'aurait aucun sens).
const poiBrowseCats = computed(() => {
  const counts = new Map<string, number>()
  for (const p of poiBrowseAll.value) {
    const k = categoryForType(p.type)?.key
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return POI_CATS
    .filter((c) => counts.has(c.key))
    .map((c) => ({ key: c.key, icon: c.icon, color: c.color, labelKey: c.labelKey, count: counts.get(c.key)! }))
})
const poiBrowseCurrent = computed(() => poiBrowseList.value[poiBrowseIndex.value] ?? null)
// Distance live (recalculée quand `lastPos` change via posTick) du POI courant à la position.
const poiBrowseDistM = computed(() => {
  posTick.value   // dépendance : force le recalcul à chaque fix GPS
  const cur = poiBrowseCurrent.value
  return cur && lastPos ? haversine(lastPos, [cur.lng, cur.lat]) : 0
})
const poiBrowseHint = computed(() => {
  const cur = poiBrowseCurrent.value
  if (!cur) return null
  const cat = categoryForType(cur.type)
  return {
    name: cur.name || t('routes.point_of_interest'),
    icon: cat?.icon ?? 'fa-location-dot',
    color: cat?.color ?? '#6b7280',
  }
})

function startPoiBrowse() {
  activePanel.value = null
  const list = [...pois.visiblePlaces.value]
  if (lastPos) {
    const here = lastPos
    list.sort((a, b) => haversine(here, [a.lng, a.lat]) - haversine(here, [b.lng, b.lat]))
  }
  if (list.length === 0) return
  poiBrowseAll.value = list
  poiBrowseFilter.value = null   // on parcourt toutes les catégories par défaut
  poiBrowseIndex.value = 0
  poiBrowseActive.value = true
  focusBrowsePlace()
}

// Change la catégorie parcourue (null = toutes) : on repart du premier POI de la liste
// filtrée et on recadre la caméra dessus. Le menu ne propose que des catégories présentes,
// donc poiBrowseCurrent est normalement défini après le filtrage.
function setPoiBrowseFilter(key: string | null) {
  poiBrowseFilter.value = key
  poiBrowseIndex.value = 0
  if (poiBrowseCurrent.value) focusBrowsePlace()
}

function focusBrowsePlace() {
  const place = poiBrowseCurrent.value
  if (!place || !map) return
  // Détache la caméra : la boucle de rendu ne touchera plus la vue (cf. `tick`,
  // `if (following.value)`), seul le marqueur de position continue de bouger.
  following.value = false
  cameraUnlocked.value = true
  map.flyTo({ center: [place.lng, place.lat], zoom: 16, pitch: 0, bearing: 0, duration: 700 })
  pois.openPlacePopup(place)
}

// Suivant / précédent en boucle : depuis le dernier POI on revient au premier, et depuis
// le premier on saute au dernier (modulo la longueur de la liste filtrée).
function browseNext() {
  const n = poiBrowseList.value.length
  if (n === 0) return
  poiBrowseIndex.value = (poiBrowseIndex.value + 1) % n
  focusBrowsePlace()
}

function browsePrev() {
  const n = poiBrowseList.value.length
  if (n === 0) return
  poiBrowseIndex.value = (poiBrowseIndex.value - 1 + n) % n
  focusBrowsePlace()
}

function stopPoiBrowse() {
  poiBrowseActive.value = false
  pois.closePlacePopup()
}

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
  isPanelOpen: () => activePanel.value !== null,
  closePanels: () => { activePanel.value = null },
})

// ─── Geste de révélation (swipe vers le bas depuis le bandeau haut) ────────────
// Swipe → rappelle les boutons (y compris en veille, par-dessus le voile noir) ; tap
// quasi immobile → bascule la veille dans les deux sens (endort hors veille, réveille
// en veille, comme un tap n'importe où sur le voile). Voir useRevealGesture.
const { onRevealDown, onRevealMove, onRevealUp, cancel: cancelReveal } = useRevealGesture({
  onReveal: showControls,
  onTap: () => toggleScreenOffManual(),
  canTap: () => true,
})

// ─── Masquage groupé des overlays du bas (cols / POI / avancement) ─────────────
// Un swipe vers le haut depuis le bord inférieur (ou un tap sur la poignée) bascule la
// visibilité de TOUS les overlays du bas d'un coup, pour dégager la carte.
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
  direction: 'up',
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
// Mode recherche (cible) / édition : l'utilisateur cherche un nouveau lieu / itinéraire ou
// retouche le tracé — la tête dans la carte et le clavier, pas sur la route. Bipper ou
// vibrer pour un virage du tracé qu'il s'apprête à abandonner ne serait que du bruit
// parasite. Base commune aux différentes sourdines ci-dessous.
const searchOrEditMuted = computed(() => placeNavActive.value || editMode.value)
// Sourdine des alertes du TRACÉ (virage, hors-trace, POI) — sons ET vibrations. On y
// ajoute le parcours des POI : pendant qu'il enchaîne ses POI à la main, on ne le
// dérange pas avec les indications du tracé. Le radar, lui, n'est PAS coupé par le
// parcours POI (cf. radarMuted) : une voiture qui arrive derrière reste une alerte de
// sécurité, à signaler quoi qu'il fasse.
const alertsMuted = computed(() => searchOrEditMuted.value || poiBrowseActive.value)
// Sourdine AUDIO des alertes du tracé = sourdine alertes OU tiroir de commandes affiché.
// Tant que le panneau de boutons est visible (l'utilisateur le consulte / ajuste un
// réglage), on coupe les sons (virage, hors-trace, POI) — un bip par-dessus le menu serait
// du bruit parasite. Les vibrations, elles, restent pilotées par alertsMuted.
const audioMuted = computed(() => alertsMuted.value || controlsVisible.value)
// Sourdine du RADAR : mêmes conditions que les sons du tracé MAIS sans le parcours POI —
// l'alerte radar (son + overlay) reste active pendant qu'on parcourt ses POI, car c'est
// une info de sécurité (voiture arrivant par l'arrière).
const radarMuted = computed(() => searchOrEditMuted.value || controlsVisible.value)
// Points d'étape posés au tap avant de valider : la navigation passera par chacun
// dans l'ordre, depuis la position GPS. Un seul point = destination directe.
const destPoints = ref<LngLat[]>([])
const destName = ref('')
// Libellé du bouton de validation : « Naviguer ici » pour un point, « Naviguer (N
// points) » dès qu'on a posé plusieurs étapes.
const confirmLabel = computed(() =>
  destPoints.value.length > 1
    ? t('routes.navigate_via_points', { count: destPoints.value.length })
    : t('routes.navigate_here'),
)
// Sport et profil du trajet en cours de composition, ajustables dans le panneau de
// destination pour ce seul trajet. Réamorcés sur ceux de la séance à chaque ouverture du
// mode « cible » (cf. startPlaceNav), et reversés dans la séance au lancement du guidage.
const navSport = ref<Sport>('cycling')
const navProfile = ref<string>(catalogDefaultForSport('cycling'))

// Sport et profil effectifs du prochain calcul BRouter : ceux du panneau de destination
// pendant qu'on le compose, ceux de la séance partout ailleurs.
function navRouting(): { sport: Sport; profile: string } {
  return placeNavActive.value
    ? { sport: navSport.value, profile: navProfile.value }
    : { sport: routeSport.value, profile: routeProfile.value }
}

// Réglage du trajet en cours de composition : chaque changement relance l'aperçu.
function applyNavRouting({ sport, profile }: { sport: Sport; profile: string }) {
  navSport.value = sport
  navProfile.value = profile
  updatePlacePreview()
}

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

const navStarting = ref(false)
const navError = ref<string | null>(null)
// Insertion d'un point intermédiaire dans le tracé en cours (POI / clic droit) : appel
// BRouter du détour en cours. Évite un double déclenchement et neutralise le bouton.
const viaInserting = ref(false)
// Marqueurs (numérotés) des points d'étape posés au tap, alignés sur destPoints.
let destMarkers: any[] = []
// Aperçu du trajet BRouter à travers les points posés, recalculé à chaque
// ajout/retrait. previewSeq sert de garde anti-désynchronisation : une réponse
// arrivée après un nouveau changement de points est ignorée. previewResult est
// réutilisé tel quel à la validation pour éviter un second appel BRouter.
const previewLoading = ref(false)
const previewDistM = ref<number | null>(null)
let previewResult: { geometry: Coord[]; hints: VoiceHint[] } | null = null
let previewSeq = 0
const climbInfo = ref<ClimbInfo | null>(null)
// state : 'far' (lointain, bandeau discret) · 'near' (approche, violet/orange) ·
// 'now' (virage atteint, maintenu en vert quelques secondes comme confirmation).
const turnHint = ref<TurnHint | null>(null)

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

let map: any = null
let maplibre: any = null
let locationMarker: any = null
let watchId: number | null = null
let turnMarkers: any[] = []    // marqueurs DOM des indicateurs de virage (au-dessus des POI)
// Tooltip d'un point quelconque de la carte (clic droit / appui long) : coordonnées
// copiables, Google Maps, Street View. Voir mapCoordPopup. suppressNextMapClick neutralise
// le clic synthétique de relâchement d'un appui long (sinon il basculerait la veille).
let coordPopup: any = null
let detachCoordLongPress: (() => void) | null = null
let suppressNextMapClick = false
// Tooltip d'un point d'étape posé en mode « cible » (clic sur son marqueur) :
// suppression du point, Google Maps, Street View. Voir mapCoordPopup.
let destPopup: any = null

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

// Réglages de navigation du sport de la séance : aspect du tracé, indicateurs de direction,
// distances et cadences des annonces de virage. Réglés PAR SPORT dans le profil — un virage
// annoncé 100 m à l'avance arrive dans 20 s à vélo et dans 80 s à pied, et on ne lit pas une
// carte au guidon comme un sentier à pied. Relus dès que le sport de la séance change (tracé
// chargé, choix manuel dans NavRoutingPicker).
const sportNav = computed(() => sportPreferences(routeSport.value).navigation)

// Largeur (px) du tracé ; la bordure ajoute 4 px de part et d'autre.
const routeLineWidth = computed(() => sportNav.value.line_width)
const routeBorderWidth = computed(() => routeLineWidth.value + 4)
// Rayon (px) des pastilles de changement de direction.
const turnMarkerSize = computed(() => sportNav.value.turn_marker_size)

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
  const { line_color: color, line_opacity: opacity } = sportNav.value
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
  if (map.getLayer('nav-place-preview')) map.setPaintProperty('nav-place-preview', 'line-width', zoomWidthExpr(routeLineWidth.value))
}

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
// Mode édition : affiche les points d'ancrage déplaçables ; un tap sur la carte en
// ajoute un (au plus proche du tracé), un tap sur un point ouvre sa suppression. Toute
// modification re-route l'itinéraire entier via BRouter (mêmes règles qu'au créateur).
const editMode = ref(false)
// Bandeau d'aide de l'édition : visible à l'entrée, masqué dès qu'on tape dessus
// (il recouvre la poignée du tiroir de commandes en haut au centre).
const editHintVisible = ref(false)
// Recalcul BRouter d'une édition en cours : neutralise les actions concurrentes.
const editBusy = ref(false)
// Vrai dès qu'un point a été modifié : pilote l'enregistrement à la sortie du mode.
const editDirty = ref(false)
const editError = ref<string | null>(null)
const editSaving = ref(false)
let editMarkers: any[] = []
let editPopup: any = null
let editToken = 0
// Instantané de l'itinéraire pris à l'entrée du mode édition : permet d'annuler
// (restaurer points d'ancrage, géométrie et voicehints d'origine) sans enregistrer.
let editSnapshot: { waypoints: Waypoint[]; geometry: Coord[]; hints: VoiceHint[] } | null = null
// L'itinéraire est-il éditable ? Il faut ses points d'ancrage (≥ 2). routeWaypoints
// n'est pas réactif (gros tableau lu dans des callbacks), donc on reflète l'éligibilité
// dans ce ref, recalculé via syncEditable() aux moments où elle peut changer (chargement,
// reroutage, déchargement).
const canEditRoute = ref(false)
function syncEditable() { canEditRoute.value = hasRoute.value && routeWaypoints.length >= 2 }

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
// tracé : le maintien dure tant qu'on n'a pas parcouru turn_green_hold_m après le virage.
let reachedTurn: { direction: 'left' | 'right'; kind: Maneuver; angle: number; exitNumber?: number; distM: number } | null = null
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
// Pointeur du virage pour lequel le double buzz d'entrée en zone orange a déjà été
// émis : garantit qu'on ne vibre qu'une fois au franchissement du seuil, pas à
// chaque frame tant qu'on reste dans la zone.
let urgentBuzzedTurn = -1
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
const showClimbCard = ref(navPrefs.show_climb_card ?? true)
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

// ─── Radar arrière (Garmin Varia) ─────────────────────────────────────────────
// Connexion/déconnexion + alertes sonores (une par véhicule). Voir useRadarAlerts.
const { radarKnown, toggleRadar } = useRadarAlerts({ soundOn, muted: radarMuted })

// Le bandeau radar (RadarOverlay) occupe le tout-haut de l'écran. Quand il est
// visible, on descend la vitesse/le virage pour ne pas passer dessous. Même
// condition d'affichage que le composant.
const radarBannerVisible = computed(() => radarStore.isConnected.value)

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
// prévisualiser, sans GPS / col réel / radar Varia, les overlays clés :
//   • le radar arrière (RadarOverlay)
//   • la carte de col (climbInfo)
//   • la notification de virage (turnHint)
//   • la notification de POI (poiHint)
// Tant qu'une bascule est active, les mises à jour live (updateTurns / updateProgress /
// updatePoiProximity) ne réécrivent PAS l'overlay correspondant (gardes dbgTurn /
// dbgClimb / dbgPoi), pour qu'un vrai fix GPS ne l'efface pas pendant qu'on l'inspecte.
const debugMode = props.canDebug === true || (() => {
  try { return new URLSearchParams(window.location.search).has('debug') } catch { return false }
})()
const dbgRadar = ref(false)
const dbgClimb = ref(false)
const dbgTurn = ref(false)
const dbgPoi = ref(false)

// Scénarios de virage parcourus en boucle (un clic = scénario suivant, puis « off »).
// Couvre chaque état visuel : lointain (gris), approche (violet), urgent (orange),
// rond-point (numéro de sortie) et virage atteint (vert).
const DBG_TURNS: { label: string; state: 'far' | 'near' | 'now'; kind: Maneuver; direction: 'left' | 'right'; angle: number; distM: number; exitNumber?: number }[] = [
  { label: 'Lointain', state: 'far', kind: 'turn', direction: 'right', angle: 60, distM: 850 },
  { label: 'Approche', state: 'near', kind: 'turn', direction: 'left', angle: -70, distM: 180 },
  { label: 'Urgent', state: 'near', kind: 'sharp', direction: 'right', angle: 110, distM: Math.min(sportNav.value.turn_urgent_m, 40) },
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
  // Prévisualisation sonore : joue le bip du virage correspondant (comme en vrai).
  if (soundOn.value) playManeuver(p.kind, p.direction)
}

function toggleDebugClimb() {
  if (dbgClimb.value) { dbgClimb.value = false; climbInfo.value = null; return }
  dbgClimb.value = true
  hasFix.value = true
  climbInfo.value = buildDebugClimb()
}

// Notification POI factice : épingle un bandeau « boulangerie » à 80 m pour
// prévisualiser le rendu (bas d'écran, et en veille via NavScreenOff) sans devoir
// passer à portée d'un vrai POI.
function toggleDebugPoi() {
  if (dbgPoi.value) { dbgPoi.value = false; poiHint.value = null; return }
  dbgPoi.value = true
  hasFix.value = true
  const cat = categoryForType('bakery')
  poiHint.value = {
    name: 'Boulangerie du Col',
    icon: cat?.icon ?? 'fa-location-dot',
    color: cat?.color ?? '#6b7280',
    distM: 80,
  }
  // Prévisualisation sonore : joue la ritournelle d'approche POI (comme en vrai).
  if (soundOn.value) playPoi()
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
    // Lien partagé : on charge l'itinéraire AVANT la carte pour qu'initMap cadre
    // directement sur le tracé. Sans token, on démarre en navigation libre.
    if (props.shareToken) {
      try { await loadSharedRouteData(props.shareToken) } catch { /* tracé introuvable : on reste en libre */ }
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
  if (poiToastTimer != null) { clearTimeout(poiToastTimer); poiToastTimer = null }
  stopAnimation()
  window.removeEventListener('pointerdown', onFirstGesture, true)
  window.removeEventListener('touchstart', onFirstGesture, true)
  window.removeEventListener('online', refreshBaseMap)
  window.removeEventListener('offline', refreshBaseMap)
  window.removeEventListener('resize', refreshContainerH)
  if (detachCoordLongPress) { detachCoordLongPress(); detachCoordLongPress = null }
  closeCoordPopup()
  closeEditPopup()
  for (const m of editMarkers) m.remove()
  editMarkers = []
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
  rebuildRouteState(geom, (route.voice_hints || []) as VoiceHint[])
  const savedPois = (route.pois || []) as Array<{ name: string; type: string; lat: number; lng: number }>
  offlinePois.value = savedPois
  if (savedPois.length > 0) pois.setRoutePlaces(savedPois)
  pois.setRouteMarkers((route.markers || []) as RouteMarker[])
  hasRoute.value = true
  syncEditable()
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
// On passe le cap courant à BRouter (heading) : le moteur interdit alors un demi-tour
// collé au départ et repart vers l'avant — voir fetchRouteToPlace / headingParam.

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
// DEVANT le coureur (dans l'arc autour de son cap) : continuer tout droit raccroche alors
// le tracé plus loin, au lieu de raccorder derrière soi (point le plus proche après un
// virage manqué) et de ressortir aussitôt. À défaut de point exploitable devant (cap peu
// fiable à l'arrêt, ou tracé entièrement derrière), on retombe sur le sommet le plus proche
// depuis la progression : BRouter, guidé par le cap, en tracera quand même un accès qui
// repart vers l'avant, sans demi-tour collé au départ.
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

// Étapes d'une destination ad hoc encore devant le coureur : on projette chacune sur le
// tracé et on garde celles situées au-delà de sa position. Repli sur la destination seule
// si le GPS les a toutes « dépassées » — il reste toujours quelque part où aller.
function viasAhead(): LngLat[] {
  if (routeVias.length === 0) return []
  const ahead = routeVias.filter((v) => nearestGeomIdxOf(v[0], v[1]) > lastIdx)
  return ahead.length > 0 ? ahead : [routeVias[routeVias.length - 1]]
}

// Refait le trajet d'une destination ad hoc depuis la position, par les étapes restantes.
async function recomputeVias(): Promise<boolean> {
  const ahead = viasAhead()
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
  await rerouteToward(rejoinIndexAhead(lastPos, currentBearing, fromIdx))
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

    // Épissage : détour (départ → raccord) + suite inchangée du tracé original.
    const tail = geometry.slice(rejoinIdx)
    const newGeometry = detour.concat(tail)
    // On ne garde des hints originaux que ceux du tronçon restant : leurs coordonnées
    // (ancrées à l'identique sur les sommets du tracé sauvegardé) existent encore dans
    // `tail`. turnsFromVoiceHints les ré-attache au bon passage du nouveau tracé.
    const tailKeys = new Set(tail.map((c) => `${c[0]},${c[1]}`))
    const tailHints = rawHints.filter((h) => tailKeys.has(`${h.lng},${h.lat}`))
    applyReroute(newGeometry, detourHints.concat(tailHints))
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
  announcedTurn = -1
  urgentBuzzedTurn = -1
  reachedTurn = null
  reachedTurnIdx = -1
  activeTurn = null
  turnHint.value = null
  turnAlertMuted.value = false
  mutedTurnPtr = -1
  // Recalculé au prochain fix ; remis à faux pour que le bandeau hors-tracé disparaisse.
  offRoute.value = false
  // La progression mémorisée pointe un passage de l'ancien tracé : on l'efface.
  try { localStorage.removeItem(progressKey()) } catch { /* quota / private mode */ }
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
  rebuildRouteState(geom, (route.voice_hints || []) as VoiceHint[])
  const savedPois = (route.pois || []) as Array<{ name: string; type: string; lat: number; lng: number }>
  offlinePois.value = savedPois
  void syncOfflineState()
  if (savedPois.length > 0) pois.setRoutePlaces(savedPois)
  pois.setRouteMarkers((route.markers || []) as RouteMarker[])
  resetRouteTracking(false)
  hasRoute.value = true
  syncEditable()
  showRoutePicker.value = false
  ensureRouteInstalled()
  refreshRemaining()
  // Cadre sur l'ensemble du tracé puis rend la caméra au suivi.
  if (map && maplibre) {
    const coords = geom.map(([lng, lat]) => [lng, lat] as LngLat)
    const b = new maplibre.LngLatBounds(coords[0], coords[0])
    coords.forEach((c) => b.extend(c))
    map.fitBounds(b, { padding: 60, duration: 600, pitch: camPitch.value })
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
  void syncOfflineState()
  geometry = []
  displayLine = []
  displayWScale = []
  alts = []
  cumDistM = []
  climbs = []
  turns = []
  rawHints = []
  turnHint.value = null
  // État de suivi des virages : sans ça, `activeTurn` reste pointé sur le dernier
  // virage et le timer de répétition (tickTurnRepeat) continue de jouer l'alerte sonore
  // indéfiniment après l'effacement du tracé (typiquement quand on efface à un carrefour,
  // alerte en cours). On remet aussi à zéro les pointeurs/anti-rejeu pour repartir propre.
  nextTurnPtr = 0
  announcedTurn = -1
  urgentBuzzedTurn = -1
  reachedTurn = null
  reachedTurnIdx = -1
  activeTurn = null
  activeTurnUrgent = false
  turnAlertMuted.value = false
  mutedTurnPtr = -1
  climbInfo.value = null
  offRoute.value = false
  remainingM.value = 0
  remainingGainM.value = 0
  doneRatio.value = 0
  for (const m of turnMarkers) m.remove()
  turnMarkers = []
  if (map) {
    for (const id of ['nav-route-border', 'nav-route-done', 'nav-route-remaining']) {
      if (map.getLayer(id)) map.removeLayer(id)
    }
    for (const id of ['nav-route', 'nav-remaining']) {
      if (map.getSource(id)) map.removeSource(id)
    }
  }
  // L'ancre repart sur le GPS brut ; on relance la boucle pour figer la flèche.
  anchorOnRoute = false
  if (lastPos) { anchorPos = lastPos; anchorTime = performance.now() }
}

// ─── Navigation vers un lieu choisi sur la carte ───────────────────────────────

function startPlaceNav() {
  // Le trajet part des réglages de la séance ; l'utilisateur peut ensuite les ajuster pour
  // ce seul trajet, et son choix redeviendra celui de la séance au lancement du guidage.
  navSport.value = routeSport.value
  navProfile.value = routeProfile.value
  placeNavActive.value = true
  navError.value = null
  // Le tiroir de commandes et la recherche se disputent le haut de l'écran : on
  // referme le tiroir pour laisser la barre de recherche seule en tête.
  hideControls()
}

function cancelPlaceNav() {
  placeNavActive.value = false
  navError.value = null
  destPoints.value = []
  destName.value = ''
  for (const m of destMarkers) m.remove()
  destMarkers = []
  closeDestPopup()
  clearPlacePreview()
}

// FeatureCollection (une LineString, ou vide) pour la source d'aperçu.
function previewFC(coords: number[][]) {
  return {
    type: 'FeatureCollection' as const,
    features: coords.length >= 2
      ? [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} }]
      : [],
  }
}

// Efface l'aperçu (ligne + état) et invalide toute réponse BRouter encore en vol.
function clearPlacePreview() {
  previewSeq++
  previewResult = null
  previewLoading.value = false
  previewDistM.value = null
  const src = map?.getSource('nav-place-preview') as any
  if (src) src.setData(previewFC([]))
}

// Recalcule l'aperçu du trajet à travers les points posés (depuis la position GPS).
// Appelé à chaque ajout/retrait de point. La garde previewSeq écarte les réponses
// devenues obsolètes (un point posé/retiré pendant le calcul).
async function updatePlacePreview() {
  if (!map) return
  ensurePlacePreviewLayer()
  const pts = destPoints.value.slice()
  // Il faut la position GPS + au moins un point pour tracer un trajet.
  if (!lastPos || pts.length === 0) { clearPlacePreview(); return }
  const seq = ++previewSeq
  previewLoading.value = true
  const { profile } = navRouting()
  try {
    const result = await fetchRouteVia([lastPos, ...pts], profile)
    if (seq !== previewSeq) return
    previewResult = result
    const cum = buildDistancesM(result.geometry)
    previewDistM.value = cum[cum.length - 1] ?? null
    const src = map.getSource('nav-place-preview') as any
    if (src) src.setData(previewFC(result.geometry.map(([lng, lat]) => [lng, lat])))
  } catch {
    if (seq !== previewSeq) return
    previewResult = null
    previewDistM.value = null
    const src = map.getSource('nav-place-preview') as any
    if (src) src.setData(previewFC([]))
  } finally {
    if (seq === previewSeq) previewLoading.value = false
  }
}

// Recadre la carte sur le lieu recherché (sans fixer de destination) : l'utilisateur
// ajuste ensuite la vue et touche le point exact. Repris de RouteBuilderMap.pickPlace.
function onLocate(p: PlaceResult) {
  destName.value = p.display_name.split(',')[0]
  if (!map) return
  // On débraye le suivi caméra (comme un déplacement manuel) : sinon la boucle
  // d'animation rejette aussitôt la caméra sur la position GPS et annule le recadrage
  // sur le lieu cherché. cameraUnlocked empêche aussi le réarmement auto à l'approche
  // d'un virage. Le suivi reprend à la validation (confirmPlaceNav) ou via « recentrer ».
  following.value = false
  cameraUnlocked.value = true
  if (p.boundingbox?.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = p.boundingbox.map(parseFloat)
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 800, maxZoom: 14 })
  } else {
    const lat = parseFloat(p.lat), lng = parseFloat(p.lon)
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) map.flyTo({ center: [lng, lat], zoom: 13, duration: 800 })
  }
}

function closeDestPopup() {
  if (destPopup) { destPopup.remove(); destPopup = null }
}

// Tooltip d'un point d'étape (clic sur son marqueur) : suppression, Google Maps,
// Street View. L'index est recalculé via le marqueur (et non capturé) pour rester
// juste après un déplacement ou une suppression d'un autre point.
function showDestPointPopup(marker: any) {
  if (!maplibre || !map) return
  const idx = destMarkers.indexOf(marker)
  if (idx < 0) return
  closeDestPopup()
  const [lng, lat] = destPoints.value[idx]
  destPopup = new maplibre.Popup({ offset: 28, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([lng, lat])
    .setDOMContent(buildDestPointPopupContent(lng, lat, closeDestPopup, () => {
      closeDestPopup()
      const i = destMarkers.indexOf(marker)
      if (i >= 0) removeDestPointAt(i)
    }))
    .addTo(map)
}

// Renumérote les marqueurs d'après leur position courante dans destMarkers (après
// insertion, déplacement ou suppression au milieu de la séquence).
function renumberDestMarkers() {
  destMarkers.forEach((m, i) => {
    const span = m.getElement().querySelector('.nav-dest-num')
    if (span) span.textContent = String(i + 1)
  })
}

// Crée un marqueur d'étape déplaçable. Glisser-déposer : à la fin du glissement, on
// met à jour le point correspondant et on recalcule l'aperçu. Un tap (sans glissement)
// ouvre la tooltip du point. L'index est résolu dynamiquement (indexOf) car insertions
// et suppressions décalent les positions.
function makeDestMarker(lngLat: LngLat): any {
  const el = document.createElement('div')
  el.className = 'nav-dest-marker'
  el.innerHTML = '<i class="fa-solid fa-location-dot"></i><span class="nav-dest-num"></span>'
  const marker = new maplibre.Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat(lngLat).addTo(map)
  // Distingue un glissement d'un simple tap : un dragend émet un clic synthétique
  // qu'il ne faut pas interpréter comme une ouverture de tooltip.
  let dragged = false
  marker.on('dragstart', () => { dragged = true; closeDestPopup() })
  marker.on('dragend', () => {
    const idx = destMarkers.indexOf(marker)
    if (idx >= 0) {
      const ll = marker.getLngLat()
      destPoints.value.splice(idx, 1, [ll.lng, ll.lat])
      updatePlacePreview()
    }
    // Le clic synthétique de relâchement (souris) suit le dragend : on laisse `dragged`
    // armé brièvement pour qu'il soit ignoré, puis on le réarme pour un prochain tap.
    // (Sur écran tactile, aucun clic ne suit un glissement → ce délai libère le tap.)
    setTimeout(() => { dragged = false }, 300)
  })
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (dragged) return
    showDestPointPopup(marker)
  })
  return marker
}

// Ajoute un point d'étape au tap sur la carte. Les points s'accumulent (marqueurs
// numérotés) jusqu'à la validation ; la navigation passera par chacun dans l'ordre.
function addDestPoint(lngLat: LngLat) {
  destPoints.value.push(lngLat)
  navError.value = null
  if (!map || !maplibre) return
  destMarkers.push(makeDestMarker(lngLat))
  renumberDestMarkers()
  updatePlacePreview()
}

// Insère un point d'étape à une position donnée de la séquence (tap sur le trajet).
function insertDestPoint(index: number, lngLat: LngLat) {
  navError.value = null
  if (!map || !maplibre) { destPoints.value.splice(index, 0, lngLat); return }
  destPoints.value.splice(index, 0, lngLat)
  destMarkers.splice(index, 0, makeDestMarker(lngLat))
  renumberDestMarkers()
  updatePlacePreview()
}

// Tap sur le trajet d'aperçu : insère un point au bon rang de la séquence (entre les
// deux étapes que ce tronçon relie) plutôt que de l'ajouter en fin. On repère, sur la
// géométrie BRouter, l'index le plus proche du tap, puis la première étape dont l'index
// géométrique le dépasse : le point s'insère juste avant elle.
function insertDestPointOnLine(lngLat: LngLat) {
  if (!previewResult || !lastPos) { addDestPoint(lngLat); return }
  const geom = previewResult.geometry
  const clickIdx = nearestGeomIndex(lngLat, geom).idx
  const waypoints = [lastPos, ...destPoints.value]
  let insertAt = destPoints.value.length
  for (let k = 1; k < waypoints.length; k++) {
    if (clickIdx <= nearestGeomIndex(waypoints[k], geom).idx) { insertAt = k - 1; break }
  }
  insertDestPoint(insertAt, lngLat)
}

// Retire un point d'étape donné (et son marqueur), puis renumérote.
function removeDestPointAt(index: number) {
  destPoints.value.splice(index, 1)
  const [m] = destMarkers.splice(index, 1)
  if (m) m.remove()
  navError.value = null
  renumberDestMarkers()
  updatePlacePreview()
}

// Retire le dernier point d'étape posé.
function removeLastDestPoint() {
  if (destPoints.value.length === 0) return
  removeDestPointAt(destPoints.value.length - 1)
}

// Itinéraire BRouter depuis la position GPS, passant par une suite de points d'étape
// (au moins un), qui remplace le tracé courant (applyReroute réinitialise tout le
// suivi). Cœur partagé entre la destination choisie sur la carte (« Naviguer ici »,
// éventuellement avec plusieurs étapes) et un POI tapé sur la carte (point unique).
async function navigateVia(name: string, vias: LngLat[], precomputed?: { geometry: Coord[]; hints: VoiceHint[] }) {
  if (navStarting.value || !lastPos || vias.length === 0) return
  navStarting.value = true
  navError.value = null
  try {
    const { sport, profile } = navRouting()
    // Réutilise l'aperçu déjà calculé (« ce que tu as vu est ce que tu auras »),
    // sinon route à la volée (cas d'un POI tapé, sans aperçu préalable).
    const { geometry: geom, hints } = precomputed ?? await fetchRouteVia([lastPos, ...vias], profile)
    routeName.value = name || t('routes.destination')
    // Destination ad hoc (non sauvegardée) : pas de token → ni hors-ligne ni reprise.
    routeToken.value = null
    routeSport.value = sport
    routeProfile.value = profile
    applyReroute(geom, hints)
    // Étapes retenues comme source de recalcul : ce trajet n'a pas d'autre définition.
    routeVias = vias.slice()
    cancelPlaceNav()
    following.value = true
    cameraUnlocked.value = false
  } catch {
    navError.value = t('routes.error_routing')
  } finally {
    navStarting.value = false
  }
}

// « Naviguer ici » depuis un POI : trajet direct vers un point unique.
function navigateTo(name: string, dest: LngLat) {
  navigateVia(name, [dest])
}

// Lance la navigation par les points d'étape posés sur la carte (un ou plusieurs).
function confirmPlaceNav() {
  if (destPoints.value.length === 0) return
  navigateVia(destName.value, destPoints.value, previewResult ?? undefined)
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
    let nearIdx = 0, bestDist = Infinity
    for (let i = 0; i < geometry.length; i++) {
      const d = haversine([lng, lat], [geometry[i][0], geometry[i][1]])
      if (d < bestDist) { bestDist = d; nearIdx = i }
    }
    // Ancrages du détour, ~40 m de part et d'autre du sommet le plus proche, pour
    // laisser BRouter raccorder proprement le passage par le nouveau point.
    let a = nearIdx
    while (a > 0 && cumDistM[nearIdx] - cumDistM[a] < VIA_ANCHOR_GAP_M) a--
    let b = nearIdx
    while (b < geometry.length - 1 && cumDistM[b] - cumDistM[nearIdx] < VIA_ANCHOR_GAP_M) b++
    const { geometry: detour, hints: detourHints } = await fetchRouteVia(
      [[geometry[a][0], geometry[a][1]], [lng, lat], [geometry[b][0], geometry[b][1]]],
      routeProfile.value,
    )
    const head = geometry.slice(0, a)
    const tail = geometry.slice(b + 1)
    const newGeometry = head.concat(detour).concat(tail)
    // Voicehints des portions inchangées : leurs coordonnées (ancrées sur les sommets
    // conservés) existent encore. On les garde dans l'ordre tête → détour → queue, comme
    // l'attend turnsFromVoiceHints (appariement monotone le long du tracé).
    const headKeys = new Set(head.map((c) => `${c[0]},${c[1]}`))
    const tailKeys = new Set(tail.map((c) => `${c[0]},${c[1]}`))
    const headHints = rawHints.filter((h) => headKeys.has(`${h.lng},${h.lat}`))
    const tailHints = rawHints.filter((h) => tailKeys.has(`${h.lng},${h.lat}`))
    // Garde les points d'ancrage en phase avec la géométrie : le point inséré devient un
    // vrai ancrage (au bon rang), pour que l'édition ultérieure ne le perde pas. Calculé
    // sur l'ancienne géométrie (nearIdx), avant qu'elle ne soit remplacée ci-dessous.
    if (routeWaypoints.length >= 2) routeWaypoints.splice(waypointInsertIndex(lng, lat, nearIdx), 0, { lng, lat })
    rebuildRouteState(newGeometry, headHints.concat(detourHints).concat(tailHints))
    // Le tracé a changé : on relocalise au prochain fix (le coureur peut être n'importe
    // où dessus) plutôt que de repartir du début.
    resetRouteTracking(false)
    ensureRouteInstalled()
    refreshRemaining()
  } catch {
    navError.value = t('routes.error_routing')
  } finally {
    viaInserting.value = false
  }
}

// ─── Édition de l'itinéraire en séance ─────────────────────────────────────────
// Un itinéraire chargé (avec ses points d'ancrage) peut être retouché sans quitter la
// navigation : déplacement, ajout et suppression de points. Chaque modification re-route
// l'itinéraire entier via BRouter (mêmes règles que le créateur, tronçons libres
// compris), puis on relocalise au prochain fix. À la sortie du mode, les modifications
// sont enregistrées sur l'itinéraire sauvegardé (si on en est le propriétaire connecté).

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

// Cadre la carte sur l'ensemble du tracé (vue tous-points) et débraye le suivi caméra.
function fitRouteBounds() {
  if (!map || !maplibre || geometry.length < 2) return
  const coords = geometry.map(([lng, lat]) => [lng, lat] as LngLat)
  const b = new maplibre.LngLatBounds(coords[0], coords[0])
  coords.forEach((c) => b.extend(c))
  map.fitBounds(b, { padding: 70, duration: 500, pitch: camPitch.value })
}

// Index du sommet de la géométrie le plus proche d'un point.
function nearestGeomIdxOf(lng: number, lat: number): number {
  let best = 0, bestD = Infinity
  for (let i = 0; i < geometry.length; i++) {
    const d = haversine([lng, lat], [geometry[i][0], geometry[i][1]])
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

// Rang d'insertion d'un nouveau point dans routeWaypoints : on repère le tronçon de
// points d'ancrage (waypoint[i] → waypoint[i+1]) auquel appartient le sommet le plus
// proche du clic, et on insère juste après waypoint[i]. À défaut, on ajoute en fin.
// `nearIdx` peut être fourni si déjà calculé par l'appelant.
function waypointInsertIndex(lng: number, lat: number, nearIdx?: number): number {
  if (routeWaypoints.length < 2 || geometry.length < 2) return routeWaypoints.length
  const near = nearIdx ?? nearestGeomIdxOf(lng, lat)
  const wpIdx = routeWaypoints.map((w) => nearestGeomIdxOf(w.lng, w.lat))
  for (let i = 0; i < wpIdx.length - 1; i++) {
    if (near >= wpIdx[i] && near <= wpIdx[i + 1]) return i + 1
  }
  return routeWaypoints.length
}

// Installe une géométrie recalculée à la place du tracé courant, sans toucher à ses
// sources (points d'ancrage, étapes). Le coureur peut être n'importe où dessus, donc on
// relocalise au prochain fix plutôt que de repartir du début.
function installRecomputedRoute(geom: Coord[], hints: VoiceHint[]) {
  rebuildRouteState(geom, hints)
  resetRouteTracking(false)
  detourEndIdx = -1
  ensureRouteInstalled()
  refreshRemaining()
}

// Re-route l'itinéraire entier à travers les points d'ancrage courants et remplace la
// géométrie de navigation. Appelé après chaque déplacement / ajout / suppression en mode
// édition, et par recomputeForRoutingChange quand le profil de la séance change.
// `markDirty` n'a de sens qu'en édition : un changement de profil ne modifie pas
// l'itinéraire sauvegardé, il ne doit donc pas le marquer comme à enregistrer.
async function recomputeFromWaypoints({ markDirty = true } = {}): Promise<boolean> {
  if (routeWaypoints.length < 2) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    editError.value = t('routes.reroute_offline')
    return false
  }
  editBusy.value = true
  editError.value = null
  const token = ++editToken
  try {
    const { geometry: geom, hints } = await fetchRouteFromWaypoints(routeWaypoints, routeProfile.value)
    if (token !== editToken) return false
    installRecomputedRoute(geom, hints)
    if (markDirty) editDirty.value = true
    return true
  } catch {
    if (token === editToken) editError.value = t('routes.error_routing')
    return false
  } finally {
    if (token === editToken) editBusy.value = false
  }
}

function closeEditPopup() {
  if (editPopup) { editPopup.remove(); editPopup = null }
}

// Renumérote les pastilles d'ancrage d'après leur rang courant.
function renumberEditMarkers() {
  editMarkers.forEach((m, i) => {
    const span = m.getElement().querySelector('.nav-edit-num')
    if (span) span.textContent = String(i + 1)
  })
}

// (Re)pose un marqueur déplaçable par point d'ancrage. Glisser-déposer → met à jour le
// point et re-route ; un tap (sans glissement) ouvre la suppression.
function makeEditMarker(wp: Waypoint): any {
  const el = document.createElement('div')
  el.className = 'nav-edit-marker'
  el.innerHTML = '<span class="nav-edit-num"></span>'
  const marker = new maplibre.Marker({ element: el, anchor: 'center', draggable: true }).setLngLat([wp.lng, wp.lat]).addTo(map)
  let dragged = false
  marker.on('dragstart', () => { dragged = true; closeEditPopup() })
  marker.on('dragend', () => {
    const idx = editMarkers.indexOf(marker)
    if (idx >= 0) {
      const ll = marker.getLngLat()
      routeWaypoints[idx] = { ...routeWaypoints[idx], lng: ll.lng, lat: ll.lat }
      void recomputeFromWaypoints()
    }
    setTimeout(() => { dragged = false }, 300)
  })
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (dragged) return
    showEditPointPopup(marker)
  })
  return marker
}

// Tooltip d'un point d'ancrage (clic sur sa pastille) : suppression + liens carto.
function showEditPointPopup(marker: any) {
  if (!maplibre || !map) return
  const idx = editMarkers.indexOf(marker)
  if (idx < 0) return
  closeEditPopup()
  const wp = routeWaypoints[idx]
  editPopup = new maplibre.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([wp.lng, wp.lat])
    .setDOMContent(buildDestPointPopupContent(wp.lng, wp.lat, closeEditPopup, () => {
      closeEditPopup()
      const i = editMarkers.indexOf(marker)
      if (i >= 0) removeEditWaypoint(i)
    }))
    .addTo(map)
}

function refreshEditMarkers() {
  for (const m of editMarkers) m.remove()
  editMarkers = []
  if (!map || !maplibre || !editMode.value) return
  routeWaypoints.forEach((w) => editMarkers.push(makeEditMarker(w)))
  renumberEditMarkers()
}

// Ajoute un point d'ancrage au tap sur la carte (inséré au plus proche du tracé).
function addEditWaypoint(lng: number, lat: number) {
  if (routeWaypoints.length >= MAX_WAYPOINTS) {
    editError.value = t('routes.error_max_waypoints', { count: MAX_WAYPOINTS })
    return
  }
  routeWaypoints.splice(waypointInsertIndex(lng, lat), 0, { lng, lat })
  refreshEditMarkers()
  void recomputeFromWaypoints()
}

// Retire un point d'ancrage (on en garde au moins deux).
function removeEditWaypoint(idx: number) {
  if (routeWaypoints.length <= 2) { editError.value = t('routes.error_min_points'); return }
  routeWaypoints.splice(idx, 1)
  refreshEditMarkers()
  void recomputeFromWaypoints()
}

function enterEditMode() {
  if (!canEditRoute.value) return
  editMode.value = true
  editHintVisible.value = true
  editError.value = null
  editDirty.value = false
  // Sauvegarde l'état d'origine pour pouvoir l'annuler (copies profondes : ces tableaux
  // sont mutés en place pendant l'édition).
  editSnapshot = {
    waypoints: routeWaypoints.map((w) => ({ ...w })),
    geometry: geometry.map((c) => [...c] as Coord),
    hints: rawHints.map((h) => ({ ...h })),
  }
  // L'édition se fait carte en main : on débraye le suivi caméra et on referme le tiroir.
  following.value = false
  cameraUnlocked.value = true
  closeCoordPopup()
  hideControls()
  fitRouteBounds()
  refreshEditMarkers()
}

// Retire marqueurs et popup d'édition et quitte le mode (sans enregistrer).
function closeEditMode() {
  closeEditPopup()
  for (const m of editMarkers) m.remove()
  editMarkers = []
  editMode.value = false
  editError.value = null
  editSnapshot = null
}

// Annule l'édition : restaure l'itinéraire d'origine (si des modifications ont eu lieu),
// quitte le mode sans enregistrer et rend la caméra au suivi.
function cancelEditMode() {
  if (editSaving.value) return
  // Neutralise un éventuel reroutage BRouter en cours pour qu'il n'écrase pas la restauration.
  editToken++
  editBusy.value = false
  if (editDirty.value && editSnapshot) {
    routeWaypoints = editSnapshot.waypoints
    rebuildRouteState(editSnapshot.geometry, editSnapshot.hints)
    resetRouteTracking(false)
    ensureRouteInstalled()
    refreshRemaining()
  }
  closeEditMode()
  following.value = true
  cameraUnlocked.value = false
  recenter()
}

// Termine l'édition : enregistre les modifications (si itinéraire possédé et connecté)
// puis quitte le mode et rend la caméra au suivi.
async function finishEditMode() {
  if (editBusy.value || editSaving.value) return
  if (editDirty.value && routeId != null && loggedIn) await saveRouteEdits()
  closeEditMode()
  following.value = true
  cameraUnlocked.value = false
  recenter()
}

// Enregistre l'itinéraire modifié (PATCH). Silencieux à l'échec d'appartenance (404) :
// un lien partagé d'autrui n'a pas de routeId → on n'arrive jamais ici dans ce cas.
async function saveRouteEdits() {
  if (routeId == null) return
  editSaving.value = true
  try {
    const totals = computeGainLoss(geometry)
    const body = JSON.stringify({
      waypoints: routeWaypoints,
      geometry,
      voice_hints: rawHints,
      distance_m: cumDistM[cumDistM.length - 1] || 0,
      elevation_gain_m: totals.gain,
      elevation_loss_m: totals.loss,
    })
    const res = await fetch(`/api/routes/${routeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    editDirty.value = false
    showPoiToast(true, t('routes.edit_saved'))
  } catch {
    showPoiToast(false, t('routes.edit_save_error'))
  } finally {
    editSaving.value = false
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
  baseIsOffline = wantOffline()

  const coords = geometry.map(([lng, lat]) => [lng, lat] as LngLat)
  map = new maplibre.Map({
    container: mapEl.value,
    style: resolveBaseStyle(mapStyleId.value) as any,
    // Mode itinéraire : on part du départ du tracé (recadré sur l'ensemble au load).
    // Mode libre : vue d'ensemble de la Suisse jusqu'au premier fix GPS.
    center: hasRoute.value ? coords[0] : DEFAULT_CENTER,
    zoom: hasRoute.value ? 14 : DEFAULT_ZOOM,
    pitch: camPitch.value,
    maxPitch: CAM_PITCH_MAX,
    attributionControl: false,
    // Tap plus tolérant : on conduit d'un pouce, en mouvement, et un appui « simple »
    // dérive souvent de quelques pixels. Au seuil par défaut (3 px), MapLibre prend ce
    // micro-déplacement pour un déplacement de carte et n'émet PAS l'événement `click` —
    // d'où le tiroir de commandes qui ne se ferme qu'après plusieurs essais. On élargit
    // la tolérance pour fiabiliser tous les taps (fermeture du tiroir, veille, pose de
    // points en édition / cible).
    clickTolerance: 10,
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
    // Clic synthétique de relâchement d'un appui long : déjà traité (tooltip coordonnées).
    if (suppressNextMapClick) { suppressNextMapClick = false; return }
    // Tooltip « point quelconque » ouverte : un tap ne fait que la refermer.
    if (coordPopup) { closeCoordPopup(); return }
    // Tiroir de commandes ouvert : un tap carte le referme d'abord (sans poser de point
    // ni mettre en veille), y compris en mode édition / cible. Priorité sur tout le reste.
    if (controlsVisible.value) { hideControls(); return }
    // Mode édition : un tap pose un nouveau point d'ancrage (ou referme la tooltip d'un
    // point ouverte) au lieu de mettre en veille.
    if (editMode.value) {
      if (editPopup) { closeEditPopup(); return }
      addEditWaypoint(e.lngLat.lng, e.lngLat.lat)
      return
    }
    // Mode « cible » : le tap pose un point d'étape au lieu de mettre en veille.
    // Tooltip d'un point ouverte → un tap ailleurs la referme d'abord. Tap SUR le
    // trajet d'aperçu → insertion au bon rang ; sinon ajout en fin de séquence.
    if (placeNavActive.value) {
      if (destPopup) { closeDestPopup(); return }
      const onLine = map.getLayer('nav-place-preview-hit')
        ? map.queryRenderedFeatures(e.point, { layers: ['nav-place-preview-hit'] })
        : []
      if (onLine.length) insertDestPointOnLine([e.lngLat.lng, e.lngLat.lat])
      else addDestPoint([e.lngLat.lng, e.lngLat.lat])
      return
    }
    // Un popup POI ouvert : le tap carte ne fait que le fermer (pas de mise en veille).
    if (pois.hasOpenPopup()) { pois.closePlacePopup(); return }
    if (!screenOff.value) toggleScreenOffManual()
  })
  // Clic droit (ordinateur) n'importe où : tooltip coordonnées / Google Maps / Street View.
  map.on('contextmenu', (e: any) => {
    e.preventDefault?.()
    showCoordPopup(e.lngLat.lng, e.lngLat.lat)
  })
  // Appui long (mobile) : même tooltip. On neutralise le clic synthétique de relâchement
  // (suppressNextMapClick) pour qu'il ne bascule pas la veille. Voir attachLongPress.
  detachCoordLongPress = attachLongPress(map.getCanvas(), (clientX, clientY) => {
    const rect = map.getContainer().getBoundingClientRect()
    const ll = map.unproject([clientX - rect.left, clientY - rect.top])
    showCoordPopup(ll.lng, ll.lat)
    suppressNextMapClick = true
    setTimeout(() => { suppressNextMapClick = false }, 500)
  })

  await new Promise<void>((resolve) => {
    map.on('load', () => {
      applyTerrain()
      // Mode itinéraire (lien partagé chargé avant la carte) : installe le tracé et
      // cadre dessus avant le premier fix GPS. Mode libre : rien à installer.
      if (hasRoute.value && coords.length) {
        installRouteLayers()
        renderTurnMarkers()
        const b = new maplibre.LngLatBounds(coords[0], coords[0])
        coords.forEach((c) => b.extend(c))
        map.fitBounds(b, { padding: 60, duration: 0, pitch: camPitch.value })
      }
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
  map.addLayer({ id: 'nav-route-done', type: 'line', source: 'nav-route', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': '#9ca3af', 'line-width': zoomWidthExpr(routeLineWidth.value, true), 'line-opacity': sportNav.value.line_opacity } })
  map.addLayer({ id: 'nav-route-remaining', type: 'line', source: 'nav-remaining', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': sportNav.value.line_color, 'line-width': zoomWidthExpr(routeLineWidth.value, true), 'line-opacity': sportNav.value.line_opacity } })
}

// Crée à la demande la couche d'aperçu du trajet en mode « cible » (ligne pointillée,
// semi-transparente). Indépendante des couches du tracé : en navigation libre, ces
// dernières n'existent pas encore quand l'utilisateur pose ses premiers points.
function ensurePlacePreviewLayer() {
  if (!map || map.getSource('nav-place-preview')) return
  map.addSource('nav-place-preview', { type: 'geojson', data: previewFC([]) })
  // Couche de capture transparente et large : tapoter pile sur la ligne fine est
  // difficile (surtout au doigt), on élargit donc la cible de clic pour l'insertion.
  map.addLayer({
    id: 'nav-place-preview-hit',
    type: 'line',
    source: 'nav-place-preview',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': '#000', 'line-opacity': 0.01, 'line-width': 26 },
  })
  map.addLayer({
    id: 'nav-place-preview',
    type: 'line',
    source: 'nav-place-preview',
    layout: ROUTE_LINE_LAYOUT,
    paint: {
      'line-color': '#2563eb',
      'line-width': zoomWidthExpr(routeLineWidth.value),
      'line-opacity': 0.55,
      'line-dasharray': [1.4, 1.1],
    },
  })
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
    const body = el.firstElementChild as HTMLElement | null
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
  // Le fond de carte de la navigation guidée a sa propre préférence, distincte de celle
  // du créateur (elle-même désormais propre à chaque sport).
  persistNavigationStyle(id as any)
  baseIsOffline = wantOffline()
  map.setStyle(resolveBaseStyle(id), { diff: false })
  map.once('style.load', afterStyleLoad)
}

function afterStyleLoad() {
  // Pas de couches de tracé à réinstaller en mode libre.
  if (hasRoute.value) installRouteLayers()
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
  const id = mapStyleId.value
  return isOfflineLayer(id) && offlineRegistered[id] && typeof navigator !== 'undefined' && navigator.onLine === false
}

function resolveBaseStyle(id: string): string | object {
  if (isOfflineLayer(id) && wantOffline()) return offlineStyle(routeToken.value!, id, OFFLINE_DEFAULTS.maxZoom)
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

// (Re)calcule l'état hors-ligne du trajet courant : présence de l'archive, branchement
// sur le protocole pmtiles://, empreinte du tracé archivé. À appeler chaque fois que
// `routeToken` change (montage, choix d'un autre itinéraire, retour en navigation libre)
// — sans quoi l'archive du trajet précédent resterait annoncée, voire affichée.
async function syncOfflineState() {
  offlineRegistered = noLayers()
  offlineHas.value = noLayers()
  archivedSigs.value = { swissgrau: null, swisstopo: null, swissimage: null }
  const token = routeToken.value
  if (token && offlineIsSup) {
    void purgeLegacyArchive(token)
    const has = noLayers()
    const sigs: Record<OfflineLayer, string | null> = { swissgrau: null, swisstopo: null, swissimage: null }
    for (const l of OFFLINE_LAYERS) {
      if (!await hasOfflineArchive(token, l)) continue
      has[l] = true
      sigs[l] = archiveSignature(token, l)
      if (maplibre) {
        try { await registerOfflineArchive(token, l, maplibre); offlineRegistered[l] = true } catch { /* archive illisible : on reste en ligne */ }
      }
    }
    offlineHas.value = has
    archivedSigs.value = sigs
  }
  resetOfflineSelection()
  refreshBaseMap()
}

// Pré-coche ce qui est déjà téléchargé (pour proposer un re-téléchargement à l'identique),
// à défaut le fond actif s'il est archivable, sinon le gris.
function resetOfflineSelection() {
  const sel = noLayers()
  for (const l of OFFLINE_LAYERS) sel[l] = offlineHas.value[l]
  if (!OFFLINE_LAYERS.some((l) => sel[l])) {
    sel[isOfflineLayer(mapStyleId.value) ? mapStyleId.value : 'swissgrau'] = true
  }
  offlineSelected.value = sel
}

// Appelée quand l'archive d'une couche vient d'être écrite, pour le tracé d'empreinte `sig`.
async function onOfflineAvailable(layer: OfflineLayer, sig: string) {
  offlineHas.value = { ...offlineHas.value, [layer]: true }
  archivedSigs.value = { ...archivedSigs.value, [layer]: sig }
  // Re-branchement systématique : après un re-téléchargement, la même clé désigne un
  // nouveau fichier, et le protocole doit servir celui-là.
  if (maplibre && routeToken.value) {
    try { await registerOfflineArchive(routeToken.value, layer, maplibre); offlineRegistered[layer] = true } catch { /* ignore */ }
  }
  refreshBaseMap()
}

function onOfflineRemoved() {
  offlineHas.value = noLayers()
  offlineRegistered = noLayers()
  archivedSigs.value = { swissgrau: null, swisstopo: null, swissimage: null }
  resetOfflineSelection()
  refreshBaseMap()
}

// Télécharge les couches cochées, l'une après l'autre : la progression affichée agrège les
// couches (le corridor a le même nombre de tuiles pour chacune). Un échec ou une annulation
// interrompt la suite, mais les couches déjà écrites restent utilisables.
async function startOfflineDownload() {
  if (offlineDownloading.value || !routeToken.value) return
  const token = routeToken.value
  const layers = selectedLayers.value
  if (layers.length === 0) return
  // Fige le tracé : un reroutage pendant le téléchargement remplace `offlineCoords`, et
  // l'empreinte enregistrée doit décrire ce qui a réellement été archivé.
  const coords = offlineCoords.value
  const archivedPois = offlinePois.value
  const sig = routeSignature(coords)
  const perLayer = estimateOffline(coords, [layers[0]]).tiles
  offlineErrored.value = false
  offlineDownloading.value = true
  offlineProgress.value = { done: 0, total: perLayer * layers.length, failed: 0 }
  offlineAbort = new AbortController()
  try {
    let base = 0
    let failed = 0
    for (const layer of layers) {
      await downloadOfflineArchive(
        token, layer, coords, undefined,
        (p) => { offlineProgress.value = { done: base + p.done, total: perLayer * layers.length, failed: failed + p.failed } },
        offlineAbort.signal,
      )
      base += perLayer
      failed = offlineProgress.value.failed
      saveArchiveSignature(token, layer, sig)
      // Le trajet a pu être déchargé/remplacé pendant le téléchargement : ne branche
      // l'archive que si elle correspond toujours au trajet affiché.
      if (routeToken.value === token) await onOfflineAvailable(layer, sig)
    }
    if (archivedPois.length > 0) saveOfflinePois(token, archivedPois)
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) offlineErrored.value = true
  } finally {
    offlineDownloading.value = false
    offlineAbort = null
  }
}

function cancelOfflineDownload() { offlineAbort?.abort() }

// Le bouton « Supprimer » libère tout ce qui a été emporté pour ce trajet, toutes couches.
async function removeOfflineMap() {
  if (!routeToken.value) return
  const token = routeToken.value
  for (const l of OFFLINE_LAYERS) {
    await deleteOfflineArchive(token, l)
    deleteArchiveSignature(token, l)
  }
  deleteOfflinePois(token)
  onOfflineRemoved()
}

// ─── Reprise après rechargement (tracés auto-recoupants) ──────────────────────
// La position GPS seule ne distingue pas les passages d'un tracé qui se recoupe :
// au même endroit, lng/lat peut appartenir à 2–3 passages. On mémorise donc la
// progression (le sommet courant le long du tracé) dans localStorage et on s'en
// sert comme indice au premier fix après un rechargement, pour repartir sur le bon
// passage au lieu d'une recherche globale ambiguë. L'entrée expire afin de ne pas
// « téléporter » un rider qui relance la même route un autre jour ; la validité est
// en plus confirmée par la proximité réelle au fix GPS (sinon repli global).
// Clé de reprise dérivée du trajet actif (token), ou 'none' en mode libre. Dynamique
// (et non figée au montage) car l'itinéraire peut être chargé/changé en séance.
function progressKey(): string {
  return `sportsScope.navProgress.${routeToken.value ?? 'none'}`
}
const RESUME_MAX_AGE_MS = 30 * 60 * 1000
let lastProgressSaveMs = 0

// Indice de reprise (sommet) si une progression récente est mémorisée, sinon -1.
function resumeHintIdx(): number {
  try {
    const key = progressKey()
    const raw = localStorage.getItem(key)
    if (!raw) return -1
    const saved = JSON.parse(raw) as { idx: number; t: number }
    if (!saved || typeof saved.idx !== 'number' || typeof saved.t !== 'number') return -1
    if (Date.now() - saved.t > RESUME_MAX_AGE_MS) { localStorage.removeItem(key); return -1 }
    return saved.idx >= 0 && saved.idx < geometry.length ? saved.idx : -1
  } catch { return -1 }
}

// Sauvegarde throttlée de la progression (≤ 1 écriture / 3 s). Best-effort : un
// localStorage indisponible (mode privé, quota) ne doit pas casser la séance.
function persistProgress() {
  const now = Date.now()
  if (now - lastProgressSaveMs < 3000) return
  lastProgressSaveMs = now
  try { localStorage.setItem(progressKey(), JSON.stringify({ idx: lastIdx, t: now })) } catch { /* indisponible : best-effort */ }
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
  const hint = located ? lastIdx : resumeHintIdx()
  let { idx, distM } = nearestGeomIndex(here, geometry, hint)
  // Recherche globale de secours quand la projection fenêtrée nous place hors-tracé :
  //  • au premier fix d'un tracé chargé (!located), le coureur peut être n'importe où ;
  //  • en séance (located), s'il a quitté la ligne suivie — typiquement un reroutage auto
  //    ignoré, qui a remplacé la géométrie par un détour+queue — puis rejoint le tracé plus
  //    loin, la fenêtre ±60 autour du dernier indice ne le retrouve pas. On rebalaie tout et
  //    on adopte le point vraiment le plus proche. `relocated` : vrai quand cela fait sauter
  //    la position sur un tout autre passage, ce qui invalide les pointeurs de virage.
  let relocated = false
  if (hint >= 0 && distM > OFF_ROUTE_M + OFF_ROUTE_ACCURACY_CAP) {
    const global = nearestGeomIndex(here, geometry, -1)
    if (global.distM < distM) {
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
    announcedTurn = -1
    urgentBuzzedTurn = -1
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

function onPosition(pos: GeolocationPosition) {
  gpsError.value = null
  hasFix.value = true
  posTick.value++
  const here: LngLat = [pos.coords.longitude, pos.coords.latitude]

  if (hasRoute.value) {
    onPositionRoute(pos, here)
  } else {
    onPositionFree(pos, here)
  }

  // Notification de proximité d'un POI (bandeau du bas), en mode itinéraire comme libre.
  updatePoiProximity(here)

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
    if (GPS_INTERPOLATION && extrapSpeedMs > MIN_SPEED_MS) {
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
    activeTurn = null
    activeTurnUrgent = false
    autoWakeForTurns(null)
    return false
  }
  if (!turns.length) { turnHint.value = null; activeTurn = null; reachedTurn = null; return false }
  const here = snapDistAlongM
  // Avance le pointeur sur les virages dépassés (>5 m derrière), en mémorisant chacun
  // pour le maintien vert. Le décompte ne démarre donc qu'une fois le virage vraiment
  // laissé derrière soi.
  while (nextTurnPtr < turns.length && turns[nextTurnPtr].distM < here - 5) {
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

  // Son / répétition : armé tant que le prochain virage est dans la zone d'alerte.
  let fired = false
  if (turn && dist <= sportNav.value.turn_alert_m && dist > -5) {
    // Le virage est dans la zone d'alerte : on l'arme pour la répétition cadencée
    // par le timer (tickTurnRepeat), indépendante de la fréquence des fixes GPS.
    activeTurn = { kind: turn.kind, direction: turn.direction }
    activeTurnUrgent = dist <= sportNav.value.turn_urgent_m
    // Entrée dans la zone orange : double buzz distinct, une seule fois par virage.
    const enteringUrgent = activeTurnUrgent && urgentBuzzedTurn !== nextTurnPtr
    if (enteringUrgent) {
      urgentBuzzedTurn = nextTurnPtr
      if (!alertsMuted.value && !turnAlertMuted.value) vibrateApproach()
    }
    // Deux déclencheurs d'annonce sonore par virage, chacun rejoué UNE fois à l'entrée
    // de sa zone : la première détection (zone lointaine) et le passage en zone proche
    // (orange). Chaque zone joue son propre paquet (turn_repeat[_urgent]_count lectures),
    // indépendamment de la répétition périodique — sans quoi, répétition coupée, la zone
    // proche resterait muette puisque seule tickTurnRepeat y sonnait. Si le virage
    // apparaît déjà dans la zone proche, les deux déclencheurs coïncident : une seule
    // annonce (compteur de la zone proche), pas de doublon.
    const firstAnnounce = announcedTurn !== nextTurnPtr
    if (firstAnnounce || enteringUrgent) {
      announcedTurn = nextTurnPtr
      lastTurnReminderMs = Date.now()
      const burst = activeTurnUrgent ? sportNav.value.turn_repeat_urgent_count : sportNav.value.turn_repeat_count
      if (soundOn.value && !audioMuted.value && !turnAlertMuted.value) playManeuverBurst(turn.kind, turn.direction, burst)
      // Vibration de manœuvre à la première détection seulement (l'entrée en zone orange
      // a sa propre vibration, vibrateApproach ci-dessus).
      if (firstAnnounce && !alertsMuted.value && !turnAlertMuted.value) vibrateManeuver(turn.kind)
      fired = true
    }
  } else {
    // Hors zone d'alerte (pas encore assez proche, ou virage franchi) : on coupe
    // la répétition jusqu'au prochain virage.
    activeTurn = null
    activeTurnUrgent = false
  }

  // Virage atteint dès qu'on est à turn_now_m (15 m par défaut) devant — et tant que le pointeur
  // n'a pas avancé (on est dessus, potentiellement à l'arrêt à un carrefour) : on
  // rafraîchit le maintien vert pour qu'il ne disparaisse pas tant qu'on n'est pas reparti.
  if (turn && dist <= sportNav.value.turn_now_m) rememberReached(turn, nextTurnPtr)

  // Choix de l'affichage. Priorité au prochain virage s'il est proche (« sauf s'il y a
  // une autre instruction plus proche »). Sinon, on maintient le virage tout juste
  // franchi en vert pendant turn_green_hold_m après lui. Sinon, le prochain virage en mode lointain.
  const greenActive = reachedTurn != null
    && here - reachedTurn.distM < greenHoldM.value
    && Date.now() - reachedAtMs < greenHoldMs.value
  if (turn && dist > sportNav.value.turn_now_m && dist <= sportNav.value.turn_hint_m) {
    turnHint.value = { direction: turn.direction, distM: dist, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber, state: 'near' }
  } else if (greenActive && reachedTurn) {
    turnHint.value = { direction: reachedTurn.direction, distM: 0, kind: reachedTurn.kind, angle: reachedTurn.angle, exitNumber: reachedTurn.exitNumber, state: 'now' }
  } else if (turn && dist > 0) {
    turnHint.value = { direction: turn.direction, distM: dist, kind: turn.kind, angle: turn.angle, exitNumber: turn.exitNumber, state: 'far' }
  } else {
    turnHint.value = null
  }

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
// aussitôt — avec le profil retenu. Même raisonnement que audioMuted / radarMuted, qui
// tiennent déjà « tiroir ouvert » pour « l'utilisateur est en train de régler ».
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
    announcedPoiKey = null
    return
  }
  const alertM = userPreferences().points_of_interest.alert_m
  const near = alertM > 0 ? pois.nearestVisiblePoi(here, alertM) : null
  if (!near) {
    poiHint.value = null
    announcedPoiKey = null
    return
  }
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
  // Revenir au suivi clôt le parcours des POI (le popup et le bandeau de parcours).
  stopPoiBrowse()
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

// Tap sur le voile de veille (en dehors du tiroir du haut, qui passe au-dessus). Si le
// tiroir est ouvert, ce premier tap se contente de le refermer — sans quitter la veille,
// comme un clic hors d'un menu déroulant. Sinon (tiroir fermé), on réveille l'écran.
function onScreenOffTap() {
  if (controlsVisible.value) { hideControls(); return }
  toggleScreenOffManual()
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

    <!-- Zone de swipe (révèle les boutons masqués) : fine bande transparente en haut,
         active dès que les boutons sont masqués (y compris en veille, où elle passe
         au-dessus du voile noir pour permettre d'ouvrir le tiroir du haut écran éteint). -->
    <div
      v-if="!controlsVisible"
      class="nav-reveal-zone"
      :class="{ 'nav-reveal-zone--sleep': screenOff }"
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
      :poi-counts="poiCounts"
      :poi-loading="poiLoading"
      :poi-browse-count="poiBrowseCount"
      :route-search="hasRoute"
      :dbg-radar="dbgRadar"
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
      @toggle-radar="toggleRadar"
      @pitch-input="onPitchInput"
      @persist-pitch-terrain="persistPitchTerrain"
      @zoom-input="onZoomInput"
      @save-zoom="saveZoomToProfile"
      @toggle-terrain="toggleTerrain"
      @toggle-poi="pois.togglePoi"
      @search-pois="searchPois({ center: lastPos ?? undefined })"
      @search-pois-route="searchPois()"
      @browse-pois="startPoiBrowse"
      @start-offline="startOfflineDownload"
      @cancel-offline="cancelOfflineDownload"
      @remove-offline="removeOfflineMap"
      @toggle-offline-layer="toggleOfflineLayer"
      @toggle-debug-radar="toggleDebugRadar"
      @toggle-debug-climb="toggleDebugClimb"
      @cycle-debug-turn="cycleDebugTurn"
      @toggle-debug-poi="toggleDebugPoi"
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

    <!-- Radar arrière (Garmin Varia) — élevé au-dessus du voile de veille pour rester
         visible en mode veille (info de sécurité). -->
    <RadarOverlay :elevated="screenOff" />

    <!-- Upcoming turn indicator. Masqué en mode recherche : l'utilisateur a la tête
         dans la carte pour choisir une nouvelle destination, pas sur le tracé courant. -->
    <NavTurnBanner
      v-if="turnHint && hasFix && !offRoute && !placeNavActive && !editMode && !poiBrowseActive"
      :turn-hint="turnHint"
      :urgent-m="sportNav.turn_urgent_m"
      :radar-banner-visible="radarBannerVisible"
      :speed-kmh="speedKmh"
      :muted="turnAlertMuted"
      @mute="muteTurnAlert"
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
         annulerait la vue sur le lieu cherché et chevaucherait « Naviguer ici ». -->
    <button
      v-if="!following && hasFix && !placeNavActive && !editMode"
      type="button"
      class="btn btn-warning shadow nav-recenter"
      @click="recenter"
    >
      <i class="fa-solid fa-location-arrow me-1" aria-hidden="true"></i>{{ t('routes.recenter') }}
    </button>

    <!-- Climb card: full graded elevation profile with a position cursor.
         Reste visible (au-dessus du voile noir) en mode veille ; un tap réveille. -->
    <NavClimbCard
      v-if="showClimbCard && bottomOverlaysVisible && climbInfo && !offRoute && !approachingTurn && !editMode && !poiBrowseActive"
      :climb-info="climbInfo"
      :screen-off="screenOff"
      @resume="toggleScreenOffManual"
    />

    <!-- Notification de proximité d'un point d'intérêt : bandeau compact en bas, juste
         au-dessus de la barre de progression. Le pendant « POI » du virage (en haut).
         Maintenu en veille (un point d'eau / une boulangerie reste utile écran éteint) :
         rendu ici (et non dans NavScreenOff) pour échapper au contexte d'empilement du
         voile et pouvoir passer AU-DESSUS de la carte de col en veille (z-index relevé
         via screen-off). -->
    <NavPoiBanner v-if="poiHint && hasFix && bottomOverlaysVisible && !poiBrowseActive" :poi-hint="poiHint" :screen-off="screenOff" @toggle="toggleScreenOffManual" />

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
         sur itinéraire (masquable par le geste du bas) ; en navigation libre, carte
         réduite à la vitesse. -->
    <NavStatsBar
      v-if="hasRoute && bottomOverlaysVisible"
      :remaining-m="remainingM"
      :remaining-gain-m="remainingGainM"
      :done-percent="donePercent"
      :speed-kmh="speedKmh"
      :eta-speed-kmh="avgSpeedKmh"
    />
    <div v-else-if="!hasRoute" class="nav-stats nav-stats--free shadow">
      <div class="nav-stat-value">{{ Math.round(speedKmh) }}<span class="nav-stat-unit"> km/h</span></div>
      <div class="nav-stat-label">{{ t('routes.speed') }}</div>
    </div>

    <!-- Masquage groupé des overlays du bas : une fine zone au bord inférieur capte le
         swipe vers le haut (ou un tap) et bascule la visibilité de tous les overlays du
         bas. Disponible aussi en veille (pour masquer la carte de col écran éteint, comme
         hors veille) ; masquée seulement en recherche / édition. Le chevron pointe vers le
         bas quand tout est visible (geste → masquer) et vers le haut quand c'est masqué
         (geste → réafficher). -->
    <div
      v-if="hasRoute && !placeNavActive && !editMode"
      class="nav-bottom-reveal-zone"
      :class="{ 'nav-bottom-reveal-zone--sleep': screenOff }"
      @pointerdown="onBottomDown"
      @pointermove="onBottomMove"
      @pointerup="onBottomUp"
      @pointercancel="cancelBottomReveal"
    >
      <span class="nav-bottom-grabber" aria-hidden="true">
        <i class="fa-solid" :class="bottomOverlaysVisible ? 'fa-chevron-down' : 'fa-chevron-up'"></i>
      </span>
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
  position: absolute; top: 0; left: 0; right: 0; height: 6rem;
  z-index: 6; touch-action: none;
  display: flex; justify-content: center; align-items: flex-start;
}
/* En veille, le voile noir (z 20) recouvre tout : on remonte la zone de geste au-dessus
   pour qu'un swipe vers le bas ouvre le tiroir du haut écran éteint (le tiroir lui-même
   passe aussi au-dessus du voile, cf. nav-controls-panel--sleep). */
.nav-reveal-zone--sleep { z-index: 21; }
/* Fond sombre du grabber confondu avec le voile : on l'éclaircit en veille. */
.nav-reveal-zone--sleep .nav-reveal-grabber { background: rgba(255, 255, 255, 0.25); }
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

/* Zone de geste « swipe vers le haut » du tiroir du bas : petit grabber centré au bord
   inférieur (étroit pour ne pas capter les taps sur la barre de stats au-dessus).
   touch-action:none pour que le glissement vertical déclenche pointermove. z-index 8 :
   au-dessus des overlays du bas (stats z6, POI z7), sous le tiroir lui-même (z9). */
.nav-bottom-reveal-zone {
  position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
  width: 6rem; height: 2.2rem; z-index: 8; touch-action: none;
  display: flex; justify-content: center; align-items: flex-end;
}
/* En veille, le voile noir (z 20) recouvre tout : on remonte la zone de geste au-dessus
   (comme la carte de col à z 21) pour qu'un swipe vers le haut puisse masquer la carte
   de col écran éteint. */
.nav-bottom-reveal-zone--sleep { z-index: 21; }
/* Chevron discret indiquant qu'on peut faire glisser vers le haut pour déployer le
   tiroir d'affichage. */
.nav-bottom-grabber {
  margin-bottom: 0.2rem;
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.4rem; height: 1.3rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.28); color: #fff; font-size: 0.7rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  animation: nav-reveal-pulse 2.4s ease-in-out infinite;
}
/* En veille, le fond sombre du grabber se confondrait avec le voile noir : on l'éclaircit
   pour qu'il reste repérable. */
.nav-bottom-reveal-zone--sleep .nav-bottom-grabber { background: rgba(255, 255, 255, 0.25); }

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

/* Toast transitoire de résultat de recherche POI : centré en haut, au-dessus des
   panneaux (z 10), non interactif. Vert si abouti, rouge si échec. */
.nav-toast {
  position: absolute; top: 4.5rem; left: 50%; transform: translateX(-50%);
  z-index: 10; display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 1rem; border-radius: 999px;
  font-weight: 600; font-size: 0.9rem; white-space: nowrap;
  color: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.nav-toast--ok { background: #198754; }
.nav-toast--err { background: #dc3545; }
.nav-toast-enter-active, .nav-toast-leave-active { transition: opacity 0.25s, transform 0.25s; }
.nav-toast-enter-from, .nav-toast-leave-to { opacity: 0; transform: translate(-50%, -0.5rem); }

/* Bouton recentrer : centré horizontalement, tout en bas (par-dessus la barre
   d'avancement) et au-dessus de TOUS les autres éléments (z-index 22 > voile de
   veille 20/21 et marqueurs POI 1) pour rester toujours accessible. */
.nav-recenter {
  position: absolute; bottom: 0.9rem; left: 50%; transform: translateX(-50%); z-index: 22;
  border-radius: 999px; font-weight: 700;
  font-size: 1.35rem; padding: 0.85rem 1.8rem;
}

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
  position: absolute; top: 2.5rem; left: 50%; transform: translateX(-50%);
  z-index: 7; width: min(440px, calc(100% - 1.5rem));
  background: rgba(124, 58, 237, 0.96); color: #fff;
  padding: 0.5rem 0.9rem; border-radius: 0.6rem;
  font-size: 0.85rem; font-weight: 500; text-align: center;
  /* Descendu sous la poignée de déploiement du tiroir (.nav-reveal-grabber, en haut
     au centre) pour ne pas la recouvrir. Un tap masque l'aide (cf. editHintVisible),
     ce qui libère complètement l'accès au tiroir de commandes. */
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
   NavStatsBar), centrée. Affichée tant qu'aucun itinéraire n'est chargé. */
.nav-stats {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
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
/* POI sauvegardé : badge étoile pour le distinguer d'un POI Overpass découvert. */
.place-marker--saved { position: relative; }
.place-marker--saved::after {
  content: '\2605';
  position: absolute;
  top: -6px;
  right: -6px;
  font-size: 0.6rem;
  line-height: 1;
  color: #f59e0b;
  text-shadow: 0 0 2px #fff, 0 0 2px #fff;
}
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
/* Toujours au-dessus des autres marqueurs (POI z 1, virages 2/3, destination 4,
   position 5) : sans z-index explicite, le popup maplibre (auto = 0) passe dessous. */
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
.place-popup-link--copy {
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.place-popup-coords-row { display: flex; gap: 0.25rem; }
.place-popup-coords-row .place-popup-link { width: auto; flex: 1 1 0; min-width: 0; gap: 0.4rem; }
.place-popup-coords-row .place-popup-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.place-popup-link--navigate {
  border: none;
  cursor: pointer;
  background: #fc4c02;
  color: #fff;
  font: inherit;
  font-weight: 600;
  text-align: left;
}
.place-popup-link--navigate:hover { background: #e34602; color: #fff; }
/* « Ajouter à l'itinéraire » (insertion, ne remplace pas) : violet pour le distinguer
   de l'orange « Naviguer ici » (remplacement). */
.place-popup-link--add-route {
  border: none;
  cursor: pointer;
  background: #7c3aed;
  color: #fff;
  font: inherit;
  font-weight: 600;
  text-align: left;
}
.place-popup-link--add-route:hover { background: #6d28d9; color: #fff; }
/* « Supprimer ce point » (tooltip d'un point d'étape) : rouge pour l'action destructrice. */
.place-popup-link--delete {
  border: none;
  cursor: pointer;
  background: #dc2626;
  color: #fff;
  font: inherit;
  font-weight: 600;
  text-align: left;
}
.place-popup-link--delete:hover { background: #b91c1c; color: #fff; }
</style>
