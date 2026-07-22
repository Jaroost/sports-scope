<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, useTemplateRef, nextTick } from 'vue'
import { Dropdown } from 'bootstrap'
import { t } from '../i18n'
import { mapStyleFor, exportTileInfoFor } from '../mapStyles'
import { RouteBuilderState } from '../pageState'
import { routeStore } from '../stores/routeStore'
import { selectionStore } from '../stores/selectionStore'
import { placesStore } from '../stores/placesStore'
import { POI_CATEGORIES, isPointType } from '../poiCategories'
import { haversine, buildDistancesM, downsample, densifyGeometry, formatDuration, formatDistancePrecise, geomIdxForKm, computeGainLoss, turnsFromVoiceHints, detectTurnAnomalies, detectUturnAnomalies, nearestGeomIndex, shareVersionParam } from '../routeHelpers'
import type { Coord, LngLat, VoiceHint, TurnAnomaly } from '../routeHelpers'
import type { Sport } from '../userPreferences'
import { turnAnomalyDiameterForSport, snapWarnDistanceForSport } from '../userPreferences'
import { BROUTER_URL, profilesForSport } from '../brouter'
import { fetchSegmentAlternatives, equivalentGeometry } from '../routeAlternatives'
import type { RouteAlternative } from '../routeAlternatives'
import { parseGpxWaypoints } from '../gpxImport'
import RouteBuilderStats from './RouteBuilderStats.vue'
import RouteBuilderChart from './RouteBuilderChart.vue'
import RouteBuilderMap from './RouteBuilderMap.vue'
import MapStyleDropdown from './MapStyleDropdown.vue'
import RouteAlternativesDialog from './RouteAlternativesDialog.vue'

const props = defineProps({
  routeId: { type: [String, Number], default: null },
  // Jeton de partage : présent => itinéraire ouvert en lecture seule via un lien
  // public (fonctionne sans être connecté).
  shareToken: { type: String, default: null },
  // GPX partagé via le Web Share Target, transmis en base64 par le filet de sécurité
  // serveur (cf. PagesController#share_target) quand le service worker n'a pas
  // intercepté le POST. Voie alternative à applySharedGpx() (cache du SW).
  sharedGpx: { type: String, default: null },
  sharedGpxName: { type: String, default: null },
})

// Lecture seule effective : pilotée par le store. Activée d'office par un lien de
// partage (verrou permanent), ou basculée manuellement via le toggle de la carte.
const readOnly = computed(() => routeStore.readOnly.value)

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

// La vue partagée persiste ses calques sous une clé à part (cf. RouteBuilderState) :
// le rendu « invité » qu'on lui impose ne doit pas écraser la configuration d'édition.
const state = reactive(new RouteBuilderState(!!props.shareToken))
const saving = ref(false)
// Indicateur transitoire affiché brièvement après un enregistrement réussi.
const saved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null
// Modifications non enregistrées : passe à true dès qu'on édite les données
// persistées (points, nom, activité), repasse à false après un enregistrement.
// Sert à avertir l'utilisateur avant de quitter la page (voir onBeforeUnload).
const dirty = ref(false)
// Activé seulement une fois le chargement initial terminé, pour ne pas marquer
// « sale » les mutations programmatiques de reset/fetchRoute.
let trackDirty = false
const exporting = ref(false)
// Jeton de partage de l'itinéraire courant : sert à construire le lien de
// navigation (/routes/:token/navigate). En lecture seule on le tient du prop ;
// en édition il vient de l'itinéraire chargé/enregistré (null tant qu'il n'est
// pas sauvegardé, donc pas de navigation possible avant l'enregistrement).
const routeShareToken = ref<string | null>(null)
// Horodatage de dernière modification, tenu à jour au chargement et à chaque
// enregistrement : il version le lien de partage (cf. shareVersionParam).
const routeUpdatedAt = ref<string | null>(null)
const showExportDialog = ref(false)
// ─── Avertissements sur le tracé ───────────────────────────────────────────────
// Les deux ne sont calculés qu'à la tentative de sauvegarde (cf. save), et non au fil de
// l'édition : un tracé en cours de construction passe par des états intermédiaires bancals
// dont il n'y a rien à dire tant qu'on n'a pas fini. Toute modification du tracé les périme
// donc (cf. clearRouteWarnings). L'erreur de routage, elle, reste immédiate : elle décrit
// l'échec du calcul qu'on vient de lancer, pas la qualité du tracé.
//
// « Amas de virages » / « demi-tour » : un point d'étape mal posé (à côté de la route, ou
// sur une impasse) fait crocheter BRouter, ce qui fausse la navigation.
const turnWarnings = ref<TurnAnomaly[]>([])
const showTurnWarning = ref(false)
// « Point accroché au loin » : BRouter projette chaque waypoint sur la voie routable la plus
// proche. Quand aucun chemin n'existe à l'endroit cliqué (trou de données OSM, plein champ…),
// il l'accroche silencieusement des dizaines de mètres plus loin — au pire, plusieurs points
// atterrissent sur la même voie et le tracé s'écrase en ligne droite. Seuil réglable par
// sport (cf. snapWarnDistanceForSport), comme le diamètre de détection des amas.
const snapWarnings = ref<Array<{ idx: number; distM: number }>>([])
// Vrai une fois la sauvegarde tentée malgré des avertissements : fait apparaître
// « enregistrer quand même ». Retombe à faux dès que le tracé change.
const saveBlocked = ref(false)
// « Aucun repère » : à l'enregistrement, si l'itinéraire n'a aucun repère posé, on
// prévient qu'un lien partagé n'affiche par défaut que le parcours et les repères.
// Purement informatif — la sauvegarde reste possible via « enregistrer quand même ».
const noMarkersWarn = ref(false)

// Fermer une alerte ne fait que la replier : la cause (erreur, points accrochés, amas de
// virages) est toujours là et l'utilisateur doit pouvoir la relire. On masque donc
// l'affichage sans jeter les données, et une pastille propose de tout rouvrir. Chaque
// drapeau se relève de lui-même dès que l'alerte a un nouveau contenu à montrer.
const errorDismissed = ref(false)
const snapDismissed = ref(false)
const noMarkersDismissed = ref(false)
watch(() => routeStore.error.value, (v) => { if (v) errorDismissed.value = false })
watch(snapWarnings, () => { snapDismissed.value = false })

// Les points accrochés au loin portent un marqueur : c'est lui qui les situe sur la carte
// (les puces de l'alerte ne font que cadrer dessus). Ce watch en est le seul propriétaire,
// snapWarnings étant leur seule source. Replier l'alerte les LAISSE en place, comme le fait
// closeTurnWarning pour les amas : ils guident la correction, et la pastille rappelle d'où
// ils viennent. Ils disparaissent quand le tracé change (cf. clearRouteWarnings).
watch(snapWarnings, (list) => {
  const wps = routeStore.waypoints.value
  mapRef.value?.showSnapMarkers(
    list.map((s) => wps[s.idx]).filter((w): w is { lng: number; lat: number } => !!w),
  )
})

// Ce qui est réellement à l'écran, source unique pour l'affichage comme pour la pastille.
const snapVisible = computed(() => snapWarnings.value.length > 0 && !snapDismissed.value)
const turnVisible = computed(() => turnWarnings.value.length > 0 && showTurnWarning.value)
const noMarkersVisible = computed(() => noMarkersWarn.value && !noMarkersDismissed.value)

// Alertes repliées mais toujours d'actualité : elles gardent leurs données, seule leur
// vue est masquée, et la pastille les rappelle.
const hiddenNoticeCount = computed(() => {
  let n = 0
  if (routeStore.error.value && errorDismissed.value) n++
  if (snapWarnings.value.length && snapDismissed.value) n++
  if (turnWarnings.value.length && !showTurnWarning.value) n++
  if (noMarkersWarn.value && noMarkersDismissed.value) n++
  return n
})

function reopenNotices() {
  errorDismissed.value = false
  snapDismissed.value = false
  noMarkersDismissed.value = false
  if (turnWarnings.value.length) showTurnWarning.value = true
}
const exportStyleId = ref('')
const exportShowGrade = ref(false)
const exportShowClimbs = ref(false)
const exportShowStats = ref(true)
const exportShowChart = ref(true)
// Pourcentage de la résolution max (= maxzoom de la source). 100 % par défaut.
const exportResolutionPct = ref(100)

// Largeur/hauteur max du canvas de carte (en px réels). Au-delà, certains navigateurs
// échouent à produire l'image ; on plafonne donc la précision à cette limite.
const EXPORT_MAX_DIM = 6000
const EXPORT_PAD = 30
const EXPORT_MIN_CONTENT = 600
// Largeur de référence (px) pour dimensionner les surcouches (titre, stats, tracé) :
// fixe et indépendante de l'appareil, sinon le tracé/texte est démesuré sur mobile
// (où la carte affichée est étroite) par rapport au PC.
const EXPORT_REF_WIDTH = 900

const mapFlex = ref(0.80)
const sidebarWidth = ref(195)
let resizing = false
let resizeStartY = 0
let resizeStartFlex = 0
let resizingH = false
let resizeStartX = 0
let resizeStartWidth = 0
// Observe la navbar fixe pour garder --rb-navbar-h à jour : sa hauteur n'est pas
// toujours connue au montage (layout/polices pas encore stabilisés), ce qui faussait
// la hauteur de la page mobile et reléguait le bouton de profil hors écran.
let navbarResizeObserver: ResizeObserver | null = null

const mobileSheetOpen = ref(false)
// Le mode mobile doit suivre le même critère que le CSS : largeur étroite OU
// écran court (téléphone en paysage). Sinon le JS reste en "desktop" alors que
// le CSS est déjà passé en mobile.
function computeIsMobile() {
  return typeof window !== 'undefined' && (window.innerWidth < 768 || window.innerHeight <= 500)
}
const isMobile = ref(computeIsMobile())
const SHEET_HEIGHT_DEFAULT = Math.round(window.innerHeight * 0.45)
const SHEET_HEIGHT_MIN = 140
const SHEET_HEIGHT_MAX = Math.round(window.innerHeight * 0.85)
const mobileSheetHeight = ref(SHEET_HEIGHT_DEFAULT)

const mapRef = useTemplateRef('mapRef')
const chartRef = useTemplateRef('chartRef')
const rightColEl = useTemplateRef('rightColEl')
// Chart dédié à l'export, monté hors écran à la volée : garantit un profil d'altitude
// dans l'image quel que soit l'appareil (sur mobile aucun chart n'est monté hors sheet).
const exportChartRef = useTemplateRef('exportChartRef')
const exportChartMounted = ref(false)

let recomputeToken = 0

// ─── Utils ────────────────────────────────────────────────────────────────────

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

function isEditMode() {
  return routeStore.currentId.value != null
}

function interpolateElevation(fullCoords: any[], sampled: any[], sampledEle: number[]) {
  const total = fullCoords.length
  const step = total / sampled.length
  for (let i = 0; i < total; i++) {
    const s = i / step
    const lo = Math.floor(s)
    const hi = Math.min(lo + 1, sampled.length - 1)
    const f = s - lo
    const eLo = sampledEle[lo]
    const eHi = sampledEle[hi]
    if (eLo == null || eHi == null) fullCoords[i][2] = eLo ?? eHi ?? null
    else fullCoords[i][2] = eLo + (eHi - eLo) * f
  }
  routeStore.geometry.value = fullCoords.slice()
}

// ─── Places fetch ─────────────────────────────────────────────────────────────

async function fetchImportantPlaces() {
  const token = ++placesStore.token
  const geom = routeStore.geometry.value
  if (geom.length < 2) { placesStore.isFetchingPlaces.value = false; return }

  // On ne recherche que les catégories cochées dans le profil. Si aucune n'est
  // activée, on n'interroge pas Overpass du tout.
  const types = POI_CATEGORIES.filter((c) => placesStore.search[c.key]).map((c) => c.key)
  if (types.length === 0) {
    placesStore.importantPlaces.value = []
    placesStore.isFetchingPlaces.value = false
    return
  }
  placesStore.isFetchingPlaces.value = true
  placesStore.placesFetchFailed.value = false

  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity
  for (const [lng, lat] of geom) {
    if (lat < south) south = lat
    if (lat > north) north = lat
    if (lng < west) west = lng
    if (lng > east) east = lng
  }
  // La bbox doit englober le rayon de détection configurable, sinon les POI
  // au-delà de ~2 km ne seraient pas remontés par Overpass.
  const BUFFER = Math.max(0.02, (placesStore.placeRadiusM.value + 200) / 111000)
  south -= BUFFER; north += BUFFER; west -= BUFFER; east += BUFFER

  try {
    const res = await fetch(`/api/geocode/places?south=${south}&west=${west}&north=${north}&east=${east}&types=${types.join(',')}`)
    if (token !== placesStore.token) return
    if (!res.ok) { placesStore.placesFetchFailed.value = true; placesStore.isFetchingPlaces.value = false; return }

    const nodes = await res.json()
    if (token !== placesStore.token) return

    const distancesM = buildDistancesM(geom)
    const THRESHOLD_M = 2000
    const seen = new Set<string>()
    const results: any[] = []

    // POI ponctuels (eau, boulangeries, cimetières…) : filtrés par le rayon
    // configurable, marqueur posé sur le lieu. Localités : accrochées au point le
    // plus proche du tracé.
    const radiusM = placesStore.placeRadiusM.value
    for (const node of nodes) {
      const isPoi = isPointType(node.type)
      const seenKey = isPoi
        ? `${node.type}:${node.lat.toFixed(3)}:${node.lng.toFixed(3)}`
        : `${node.type ?? ''}:${node.name}`
      if (seen.has(seenKey)) continue
      const cosLat = Math.cos(node.lat * Math.PI / 180)
      let minD2 = Infinity, nearestIdx = 0
      for (let i = 0; i < geom.length; i++) {
        const dLng = (geom[i][0] - node.lng) * cosLat
        const dLat = geom[i][1] - node.lat
        const d2 = dLng * dLng + dLat * dLat
        if (d2 < minD2) { minD2 = d2; nearestIdx = i }
      }
      const threshold = isPoi ? radiusM : THRESHOLD_M
      const dist = haversine(geom[nearestIdx], [node.lng, node.lat])
      if (dist > threshold) continue
      seen.add(seenKey)
      results.push({
        name: node.name,
        type: node.type,
        distanceM: distancesM[nearestIdx],
        distFromRouteM: isPoi ? dist : 0,
        lng: node.lng,
        lat: node.lat,
        markerLng: isPoi ? node.lng : geom[nearestIdx][0],
        markerLat: isPoi ? node.lat : geom[nearestIdx][1],
      })
    }
    results.sort((a, b) => a.distanceM - b.distanceM)
    if (token !== placesStore.token) return
    placesStore.importantPlaces.value = results
  } catch {
    if (token !== placesStore.token) return
    placesStore.placesFetchFailed.value = true
  }

  if (token !== placesStore.token) return
  placesStore.isFetchingPlaces.value = false
}

// ─── Route computation ────────────────────────────────────────────────────────

// Changement de catégorie d'activité par l'utilisateur : le profil de routage est
// réaligné sur le défaut du nouveau sport (setSport → routeProfileForSport), donc on
// relance le routage pour redessiner un tracé adapté (la rando emprunte des sentiers
// refusés au vélo, etc.).
function onChangeSport(sport: Sport) {
  if (routeStore.readOnly.value) return
  if (sport === routeStore.sport.value) return
  routeStore.setSport(sport)
  if (routeStore.waypoints.value.length >= 2) recomputeRoute()
}

// Changement de profil de routage BRouter par l'utilisateur (même sport) : on
// relance le routage pour redessiner un tracé selon le nouveau profil (ex.
// trekking → fastbike privilégie les grands axes).
function onChangeProfile(profile: string) {
  if (routeStore.readOnly.value) return
  if (profile === routeStore.profile.value) return
  routeStore.setProfile(profile)
  if (routeStore.waypoints.value.length >= 2) recomputeRoute()
}

async function recomputeRoute() {
  const token = ++recomputeToken
  selectionStore.clear()
  // Le tracé change : les avertissements portaient sur le précédent, et un éventuel
  // « enregistrer quand même » ne vaut plus. Ils seront recalculés à la prochaine
  // tentative de sauvegarde.
  // Exception : si une sauvegarde a déjà été tentée (saveBlocked) et que l'utilisateur est
  // en train de corriger les points signalés, on ne se contente pas d'effacer — on
  // ré-évalue la liste une fois le nouveau tracé calculé (cf. reevaluateWarnings plus bas),
  // pour que les points réglés disparaissent au fil des corrections sans re-sauvegarder.
  const wasReviewing = saveBlocked.value
  clearRouteWarnings()

  if (routeStore.waypoints.value.length < 2) {
    routeStore.geometry.value = []
    routeStore.distanceM.value = 0
    routeStore.elevGainM.value = 0
    routeStore.elevLossM.value = 0
    mapRef.value?.updateRouteLayer()
    mapRef.value?.installClimbMarkers()
    chartRef.value?.destroy()
    return
  }

  routeStore.isFetchingRoute.value = true
  routeStore.error.value = null

  try {
    const wps = routeStore.waypoints.value
    const lonlats = wps.map((w) => `${w.lng},${w.lat}`).join('|')
    // Un waypoint « libre » n'affecte que son tronçon entrant : on trace une ligne droite
    // (beeline BRouter) depuis le point précédent jusqu'à lui. Le tronçon sortant (libre →
    // point suivant) reste routé/accroché à la route, sauf si le point suivant est lui aussi
    // libre. `straight` indexe des tronçons : le tronçon i relie waypoint[i] → waypoint[i+1],
    // donc le tronçon i est droit ssi waypoint[i+1] est libre.
    const straight = new Set<number>()
    wps.forEach((w, i) => {
      if (i > 0 && w.free) straight.add(i - 1)
    })
    const straightParam = straight.size ? `&straight=${[...straight].sort((a, b) => a - b).join(',')}` : ''
    // timode=2 makes BRouter emit turn-by-turn voicehints in the GeoJSON properties.
    const profile = routeStore.profile.value
    const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timode=2${straightParam}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`)
    const data = await res.json()
    if (token !== recomputeToken) return
    const feature = data?.features?.[0]
    const coords = feature?.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) throw new Error('Routing impossible (no route)')
    const trackLen = parseFloat(feature.properties?.['track-length'] || '0')
    routeStore.distanceM.value = Number.isFinite(trackLen) && trackLen > 0 ? trackLen : 0
    let geom = coords.map((c: number[]) => [c[0], c[1], c.length > 2 ? c[2] : null]) as Coord[]
    // Voicehints BRouter : [indexInTrack, command, exitNumber, distanceToNext, angle].
    // On les ancre sur la coordonnée brute (avant densification, qui décalerait les
    // index) ; la navigation les reprojettera sur la géométrie sauvegardée.
    const rawHints = Array.isArray(feature.properties?.voicehints) ? feature.properties.voicehints : []
    routeStore.voiceHints.value = rawHints
      .map((h: number[]) => {
        const c = coords[h[0]]
        return c ? { lng: c[0], lat: c[1], cmd: h[1], angle: h[4] ?? 0, exit_number: h[2] ?? 0 } : null
      })
      .filter(Boolean) as VoiceHint[]
    // Les tronçons droits (points libres) ne contiennent que leurs extrémités : on les
    // densifie pour qu'open-meteo échantillonne le relief le long de la ligne.
    if (straight.size) geom = densifyGeometry(geom)
    routeStore.geometry.value = geom


    // Recalcule d'abord les index géométriques des waypoints : le rendu du tracé
    // (updateRouteLayer → applyColorMode) s'en sert pour repérer les tronçons droits
    // (points libres) à dessiner en traitillé.
    mapRef.value?.recomputeWaypointGeomIndices()
    mapRef.value?.updateRouteLayer()
    mapRef.value?.installClimbMarkers()
    // Régénère les tooltips des waypoints avec les coordonnées et la géométrie à jour :
    // après un déplacement, leurs liens (Street View, Google Maps, Komoot, coordonnées
    // copiables) doivent refléter la nouvelle position, pas celle d'avant le drag.
    mapRef.value?.refreshWaypointMarkers()

    // Correction en cours après une sauvegarde bloquée : le tracé vient d'être recalculé,
    // on ré-évalue les avertissements (qui ne dépendent que de la géométrie et des points).
    if (wasReviewing) reevaluateWarnings()

    // BRouter ne renvoie pas d'altitude pour les tronçons « straight » (points libres).
    // On ne se fie aux altitudes inline que si TOUS les points en ont ; sinon on
    // interroge open-meteo pour combler les trous (sans quoi le dénivelé serait faux).
    const hasInlineElevation = routeStore.geometry.value.every((c) => c[2] != null)
    if (hasInlineElevation) {
      routeStore.recomputeGain()
      await nextTick()
      chartRef.value?.render()
    } else {
      await fetchElevation(token)
    }
  } catch (e: any) {
    if (token === recomputeToken) {
      routeStore.error.value = `${t('routes.error_routing')}: ${e.message}`
      // Le tracé garde l'ancienne géométrie alors que les waypoints, eux, ont déjà changé :
      // on réaligne les index dessus, sinon l'insertion de point resterait bloquée.
      mapRef.value?.recomputeWaypointGeomIndices()
    }
  } finally {
    if (token === recomputeToken) routeStore.isFetchingRoute.value = false
  }
}

async function fetchElevation(token: number) {
  if (!routeStore.geometry.value.length) return
  routeStore.isFetchingElevation.value = true
  try {
    const coords = routeStore.geometry.value
    const sampled = downsample(coords, 100)
    const lats = sampled.map((c) => (c[1] as number).toFixed(5)).join(',')
    const lngs = sampled.map((c) => (c[0] as number).toFixed(5)).join(',')
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (token !== recomputeToken) return
    const elev = Array.isArray(data.elevation) ? data.elevation : []
    if (elev.length !== sampled.length) throw new Error('elevation size mismatch')
    interpolateElevation(coords as any[], sampled as any[], elev)
    routeStore.recomputeGain()
    // Le tracé et les cols ont été rendus avant l'arrivée des altitudes (BRouter n'en
    // fournit pas pour les tronçons libres) : on recolore selon la pente et on réinstalle
    // les cols maintenant que le relief est connu, sinon couleur/cols restent faux.
    mapRef.value?.applyColorMode()
    mapRef.value?.installClimbMarkers()
    await nextTick()
    chartRef.value?.render()
  } catch (e: any) {
    // Sur mobile on n'affiche pas l'alerte d'échec d'altitude : elle masque la carte
    // et le tracé reste utilisable sans le profil. On la conserve sur ordinateur.
    if (token === recomputeToken && !isMobile.value) routeStore.error.value = `${t('routes.error_elevation')}: ${e.message}`
  } finally {
    if (token === recomputeToken) routeStore.isFetchingElevation.value = false
  }
}

// ─── Save / load ──────────────────────────────────────────────────────────────

async function fetchRoute(id: number) {
  try {
    const res = await fetch(`/api/routes/${id}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const r = payload.route
    routeShareToken.value = r.share_token || null
    routeUpdatedAt.value = r.updated_at || null
    routeStore.name.value = r.name || ''
    // Réaligne la catégorie d'activité (et donc la vitesse moyenne) sur celle
    // enregistrée avec l'itinéraire. setSport réinitialise le profil au défaut du
    // sport ; setProfile applique ensuite le profil enregistré (ignoré s'il est
    // invalide/hérité → défaut du sport conservé).
    if (r.activity) routeStore.setSport(r.activity)
    if (r.profile) routeStore.setProfile(r.profile)
    // Après setSport, qui a réaligné la vitesse sur le profil : on restaure celle
    // enregistrée avec l'itinéraire.
    routeStore.setAvgSpeedKmh(r.avg_speed_kmh)
    routeStore.waypoints.value = Array.isArray(r.waypoints) ? r.waypoints : []
    routeStore.geometry.value = Array.isArray(r.geometry) ? r.geometry : []
    routeStore.voiceHints.value = Array.isArray(r.voice_hints) ? r.voice_hints : []
    routeStore.markers.value = Array.isArray(r.markers) ? r.markers : []
    routeStore.distanceM.value = r.distance_m || 0
    routeStore.elevGainM.value = r.elevation_gain_m || 0
    routeStore.elevLossM.value = r.elevation_loss_m || 0
    if (routeStore.geometry.value.length >= 2) {
      const lngs = routeStore.geometry.value.map((c) => c[0])
      const lats = routeStore.geometry.value.map((c) => c[1])
      mapRef.value?.fitBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)], { padding: 40, duration: 0 })
    }
    mapRef.value?.refreshWaypointMarkers()
    mapRef.value?.refreshRouteMarkers()
    mapRef.value?.recomputeWaypointGeomIndices()
    mapRef.value?.updateRouteLayer()
    await nextTick()
    chartRef.value?.render()
    if (routeStore.waypoints.value.length >= 2) recomputeRoute()
    // À l'ouverture d'un itinéraire enregistré (ou au rechargement), on recherche
    // les lieux sur la géométrie chargée — l'édition, elle, ne déclenche plus la
    // recherche (réservée à l'enregistrement, voir save()).
    if (routeStore.geometry.value.length >= 2) fetchImportantPlaces()
  } catch (e: any) {
    routeStore.error.value = e.message
  }
}

// Chargement public en lecture seule via le jeton de partage. Contrairement à
// fetchRoute, on ne relance pas BRouter (recomputeRoute) : on affiche la
// géométrie enregistrée telle quelle. Les marqueurs de points d'étape sont posés
// en version lecture seule (numéro + tooltip informatif, sans actions d'édition).
async function fetchSharedRoute(token: string) {
  try {
    const res = await fetch(`/api/routes/shared/${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(res.status === 404 ? t('routes.error_shared_not_found') : `HTTP ${res.status}`)
    const payload = await res.json()
    const r = payload.route
    // Le propriétaire connecté peut repasser en édition depuis la vue partagée
    // (cf. editUrl) ; pour tout autre visiteur, `owned` est faux.
    editableRouteId.value = r.owned && r.id ? Number(r.id) : null
    routeUpdatedAt.value = r.updated_at || null
    routeStore.name.value = r.name || ''
    if (r.activity) routeStore.setSport(r.activity)
    if (r.profile) routeStore.setProfile(r.profile)
    // Vitesse du créateur, pas celle du visiteur : la durée annoncée en lecture seule
    // doit être la même que sur la page de partage.
    routeStore.setAvgSpeedKmh(r.avg_speed_kmh)
    routeStore.waypoints.value = Array.isArray(r.waypoints) ? r.waypoints : []
    routeStore.geometry.value = Array.isArray(r.geometry) ? r.geometry : []
    routeStore.voiceHints.value = Array.isArray(r.voice_hints) ? r.voice_hints : []
    routeStore.markers.value = Array.isArray(r.markers) ? r.markers : []
    routeStore.distanceM.value = r.distance_m || 0
    routeStore.elevGainM.value = r.elevation_gain_m || 0
    routeStore.elevLossM.value = r.elevation_loss_m || 0
    if (routeStore.geometry.value.length >= 2) {
      const lngs = routeStore.geometry.value.map((c) => c[0])
      const lats = routeStore.geometry.value.map((c) => c[1])
      mapRef.value?.fitBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)], { padding: 40, duration: 0 })
    }
    mapRef.value?.applyColorMode()
    mapRef.value?.installClimbMarkers()
    mapRef.value?.refreshWaypointMarkers()
    mapRef.value?.refreshRouteMarkers()
    mapRef.value?.updateRouteLayer()
    await nextTick()
    chartRef.value?.render()
    // Pas de recherche de POI dans le visionneur partagé : le proxy Overpass
    // exige une session (visiteur déconnecté), donc on n'interroge pas les lieux.
  } catch (e: any) {
    routeStore.error.value = e.message
  }
}

// Recherche les amas de virages (point mal placé) sur le tracé courant à partir des
// voicehints BRouter déjà calculés. Vide tant que la géométrie est trop courte.
// Les deux signatures d'un point d'étape mal posé, réunies en une liste : l'amas de virages
// (crochet compact) et le demi-tour (crochet étalé sur une impasse, que l'amas ne voit pas).
// Un même crochet peut déclencher les deux ; on ne garde alors que l'amas, plus informatif
// (il compte les virages), pour ne pas signaler deux fois le même point.
function computeTurnAnomalies(): TurnAnomaly[] {
  const geom = routeStore.geometry.value
  if (geom.length < 3) return []
  const cumDistM = buildDistancesM(geom)
  const turns = turnsFromVoiceHints(routeStore.voiceHints.value, geom, cumDistM)
  const diameterM = turnAnomalyDiameterForSport(routeStore.sport.value)
  const wps = routeStore.waypoints.value
  const waypoints = wps.map((w) => [w.lng, w.lat] as LngLat)
  const uturnOk = wps.map((w) => w.uturn_ok === true)
  const clusters = detectTurnAnomalies(turns, geom, { diameterM, waypoints })
  const claimed = new Set(clusters.map((a) => a.waypointIdx).filter((i) => i >= 0))
  const uturns = detectUturnAnomalies(turns, geom, { waypoints, uturnOk })
    .filter((a) => a.waypointIdx < 0 || !claimed.has(a.waypointIdx))
  return [...clusters, ...uturns].sort((a, b) => a.distM - b.distM)
}

// Un demi-tour sans point d'étape à portée n'accuse personne : on le situe à la distance
// parcourue plutôt que d'annoncer un numéro de point qui n'existe pas.
function turnWarningLabel(a: TurnAnomaly): string {
  const distance = formatDistancePrecise(a.distM)
  if (a.kind === 'uturn') {
    return a.waypointIdx >= 0
      ? t('routes.uturn_warning_item', { point: a.waypointIdx + 1, distance })
      : t('routes.uturn_warning_item_orphan', { distance })
  }
  return t('routes.turn_warning_item', { point: a.waypointIdx + 1, count: a.count, distance })
}

// Publie la liste des crochets : alerte + marqueurs, ou table rase. Comme pour les points
// accrochés au loin, une liste non vide rouvre l'alerte même si elle avait été repliée —
// le tracé a changé depuis, le repli ne vaut plus.
function setTurnWarnings(anomalies: TurnAnomaly[]) {
  turnWarnings.value = anomalies
  showTurnWarning.value = anomalies.length > 0
  if (anomalies.length) mapRef.value?.showTurnAnomalyMarkers(anomalies)
  else mapRef.value?.clearTurnAnomalyMarkers()
}

// Écart entre chaque point d'étape et le tracé réellement obtenu. Un point « libre » est
// traversé par sa ligne droite, donc son écart est nul : il ne se signale jamais de
// lui-même. Un point posé là où aucun chemin n'est cartographié, lui, ressort.
function computeSnapWarnings(): Array<{ idx: number; distM: number }> {
  const geom = routeStore.geometry.value
  if (geom.length < 2) return []
  const threshold = snapWarnDistanceForSport(routeStore.sport.value)
  return routeStore.waypoints.value
    .map((w, idx) => ({ idx, distM: nearestGeomIndex([w.lng, w.lat], geom).distM }))
    .filter((s) => s.distM >= threshold)
}

// Périme les avertissements : ils ne décrivaient que le tracé qui les a produits.
function clearRouteWarnings() {
  snapWarnings.value = []   // le watch ci-dessus retire les marqueurs correspondants
  setTurnWarnings([])
  noMarkersWarn.value = false
  saveBlocked.value = false
}

// Recalcule la liste après un changement qui ne retouche pas le tracé (marquer un demi-tour
// comme normal) : sans ça l'alerte continuerait de lister un point déjà réglé. Ne réveille
// rien si aucun avertissement n'est affiché — ils n'apparaissent qu'à la sauvegarde.
function refreshTurnWarnings() {
  if (!turnWarnings.value.length) return
  setTurnWarnings(computeTurnAnomalies())
}

// Ré-évalue tous les avertissements après un recalcul du tracé, pendant que l'utilisateur
// corrige les points signalés par une sauvegarde bloquée (cf. recomputeRoute). Chaque point
// réglé sort de la liste et le barrage (saveBlocked) tombe de lui-même quand il ne reste
// rien — l'utilisateur n'a plus à re-sauvegarder juste pour voir ce qu'il reste à corriger.
function reevaluateWarnings() {
  snapWarnings.value = computeSnapWarnings()
  setTurnWarnings(computeTurnAnomalies())
  noMarkersWarn.value = routeStore.markers.value.length === 0
  saveBlocked.value = snapWarnings.value.length > 0 || turnWarnings.value.length > 0 || noMarkersWarn.value
}

async function save() {
  if (routeStore.readOnly.value) return
  // Sur mobile le champ nom du header n'est pas affiché : on le demande au moment de
  // l'enregistrement plutôt que de bloquer sur une erreur impossible à corriger.
  if (!routeStore.name.value.trim()) {
    const raw = window.prompt(t('routes.name_prompt'), '')
    if (raw == null) return // annulé
    const name = raw.trim().slice(0, 80)
    if (!name) { routeStore.error.value = t('routes.error_name_required'); return }
    routeStore.name.value = name
  }
  if (routeStore.waypoints.value.length < 2) { routeStore.error.value = t('routes.error_min_points'); return }
  // Seul endroit où les avertissements sont calculés : le tracé est terminé, il y a enfin
  // quelque chose à en dire. S'il y a matière, on fait barrage une fois — l'utilisateur
  // corrige, ou passe outre.
  snapWarnings.value = computeSnapWarnings()
  setTurnWarnings(computeTurnAnomalies())
  // Rappel informatif : un itinéraire sans repère perd de sa lisibilité une fois
  // partagé (le lecteur ne voit par défaut que le parcours et les repères).
  noMarkersWarn.value = routeStore.markers.value.length === 0
  if (snapWarnings.value.length || turnWarnings.value.length || noMarkersWarn.value) {
    saveBlocked.value = true
    snapDismissed.value = false
    noMarkersDismissed.value = false
    return
  }
  await persistAndIndexPlaces()
}

async function persistAndIndexPlaces() {
  await persist()
  // Les lieux ne sont recherchés qu'à l'enregistrement (et non à chaque édition du
  // tracé) : on lance la requête Overpass maintenant que l'itinéraire est figé.
  fetchImportantPlaces()
}

// Enregistre malgré les avertissements : l'utilisateur assume le tracé, on retire donc
// alertes et marqueurs.
async function saveAnyway() {
  clearRouteWarnings()
  await persistAndIndexPlaces()
}

// Ferme l'alerte mais LAISSE les marqueurs sur la carte : ils guident l'utilisateur vers
// les points à corriger et disparaissent au prochain recalcul du tracé (cf. recomputeRoute).
function closeTurnWarning() {
  showTurnWarning.value = false
}

// Recentre la carte sur un amas. On se contente de cadrer : le marqueur d'alerte déjà posé
// désigne l'endroit, et ouvrir la bulle du point la ferait recouvrir l'alerte dont elle
// vient (elle s'affiche au-dessus du marqueur, donc en plein milieu de la pile). À
// l'utilisateur de cliquer le point s'il veut ses actions de correction.
// L'alerte reste ouverte : contrairement à une modale, elle ne masque pas la carte et
// sert de liste de tâches tant que les amas ne sont pas corrigés.
function focusTurnAnomaly(a: TurnAnomaly) {
  mapRef.value?.flyTo(a.lng, a.lat, 17)
}

// Recentre sur un point accroché au loin — repéré sur la carte par son propre marqueur
// (cf. le watch ci-dessous), même logique que pour les amas.
function focusSnapWarning(idx: number) {
  const w = routeStore.waypoints.value[idx]
  if (!w) return
  mapRef.value?.flyTo(w.lng, w.lat, 17)
}

async function persist() {
  if (routeStore.readOnly.value) return
  saving.value = true
  routeStore.error.value = null
  try {
    const body = JSON.stringify({
      name: routeStore.name.value.trim(),
      waypoints: routeStore.waypoints.value,
      geometry: routeStore.geometry.value,
      voice_hints: routeStore.voiceHints.value,
      pois: placesStore.importantPlaces.value.map(({ name, type, lat, lng }) => ({ name, type, lat, lng })),
      markers: routeStore.markers.value,
      distance_m: routeStore.distanceM.value,
      elevation_gain_m: routeStore.elevGainM.value,
      elevation_loss_m: routeStore.elevLossM.value,
      profile: routeStore.profile.value,
      activity: routeStore.sport.value,
      // Vitesse ajustée pour ce tracé précis (null si elle suit encore le profil) :
      // l'enregistrer évite que la page de partage et la réouverture annoncent une
      // autre durée que celle qu'on avait sous les yeux.
      avg_speed_kmh: routeStore.avgSpeedOverride.value,
    })
    const url = isEditMode() ? `/api/routes/${routeStore.currentId.value}` : '/api/routes'
    const method = isEditMode() ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const r = payload.route
    // Mémorise le jeton de partage renvoyé pour activer le bouton de navigation
    // dès le premier enregistrement (un itinéraire neuf n'en avait pas encore).
    if (r?.share_token) routeShareToken.value = r.share_token
    routeUpdatedAt.value = r?.updated_at || null
    if (!isEditMode() && r?.id) {
      routeStore.currentId.value = r.id
      window.history.replaceState({}, '', `${localePrefix}/routes/${r.id}/edit`)
    }
    dirty.value = false
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { saved.value = false }, 2500)
  } catch (e: any) {
    routeStore.error.value = e.message
  } finally {
    saving.value = false
  }
}

// Téléchargement GPX : en mode partage (lecture seule), on passe par l'endpoint
// public adressé par le jeton ; sinon par l'itinéraire enregistré (édition).
function canExportGpx() {
  return props.shareToken ? true : isEditMode()
}

function exportGpx() {
  if (props.shareToken) {
    window.location.href = `/api/routes/shared/${encodeURIComponent(props.shareToken)}/gpx`
    return
  }
  if (!isEditMode()) return
  window.location.href = `/api/routes/${routeStore.currentId.value}/gpx`
}

// ─── Navigation ─────────────────────────────────────────────────────────────────

// Le jeton de navigation : prop de partage en lecture seule, sinon celui de
// l'itinéraire chargé/enregistré. Null tant que l'itinéraire n'a pas de jeton
// (création non encore sauvegardée).
const navigateToken = computed(() => props.shareToken ?? routeShareToken.value)

// Vue en lecture seule ouverte par son propre auteur : identifiant de l'itinéraire,
// pour proposer le passage en édition. null pour un visiteur (ou hors partage).
const editableRouteId = ref<number | null>(null)
const editUrl = computed(() =>
  editableRouteId.value ? `${localePrefix}/routes/${editableRouteId.value}/edit` : null,
)

// La navigation n'est proposée qu'une fois l'itinéraire enregistré (jeton présent)
// et tracé : elle s'appuie sur la géométrie publiée via le lien de partage.
const canNavigate = computed(() => !!navigateToken.value && routeStore.hasGeometry.value)

function navigateRoute() {
  if (!navigateToken.value) return
  window.location.href = `${localePrefix}/routes/${encodeURIComponent(navigateToken.value)}/navigate`
}

// ─── Partage ──────────────────────────────────────────────────────────────────

// Même lien que la liste des itinéraires : la page de résumé publique, porteuse des
// balises Open Graph et menant aux trois formes de l'itinéraire (lecture seule,
// navigation, GPX). Feuille de partage native si disponible, sinon presse-papier.
const shareUrl = computed(() =>
  navigateToken.value
    ? `${window.location.origin}${localePrefix}/routes/${encodeURIComponent(navigateToken.value)}${shareVersionParam(routeUpdatedAt.value)}`
    : null,
)
const shareCopied = ref(false)
let shareCopiedTimer: ReturnType<typeof setTimeout> | null = null

async function shareRoute() {
  const url = shareUrl.value
  if (!url) return
  const text = [
    formatDistancePrecise(routeStore.distanceM.value),
    routeStore.elevGainM.value ? `${Math.round(routeStore.elevGainM.value)} m D+` : null,
  ].filter(Boolean).join(' · ')
  try {
    if (navigator.share) {
      await navigator.share({ title: routeStore.name.value || t('routes.share'), text, url })
      return
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return // feuille de partage refermée par l'utilisateur
  }
  try {
    await navigator.clipboard.writeText(url)
    shareCopied.value = true
    if (shareCopiedTimer) clearTimeout(shareCopiedTimer)
    shareCopiedTimer = setTimeout(() => { shareCopied.value = false }, 2000)
  } catch {
    window.prompt(t('routes.share'), url)
  }
}

// ─── Komoot ───────────────────────────────────────────────────────────────────

function openInKomoot() {
  const wps = routeStore.waypoints.value
  if (wps.length < 2) return
  const MAX = 20
  let pts = wps
  if (pts.length > MAX) {
    if (!window.confirm(t('routes.komoot_waypoint_limit', { count: pts.length }))) return
    const middle = pts.slice(1, -1)
    const step = middle.length / (MAX - 2)
    const sampled = Array.from({ length: MAX - 2 }, (_, i) => middle[Math.floor(i * step)])
    pts = [pts[0], ...sampled, pts[pts.length - 1]]
  }
  const lats = pts.map((w) => w.lat), lngs = pts.map((w) => w.lng)
  const centerLat = ((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5)
  const centerLng = ((Math.min(...lngs) + Math.max(...lngs)) / 2).toFixed(5)
  const points = pts.map((w, i) => `p[${i}][loc]=${w.lat},${w.lng}`).join('&')
  window.open(`https://www.komoot.com/plan/@${centerLat},${centerLng},12z?sport=touringbicycle&${points}`, '_blank', 'noopener,noreferrer')
}

function openSelectionInKomoot() {
  if (!selectionStore.selectionRange.value || !routeStore.geometry.value.length) return
  const i0 = selectionStore.cumDistKm.indexOf(selectionStore.selectionRange.value.startKm) || 0
  const i1 = selectionStore.cumDistKm.indexOf(selectionStore.selectionRange.value.endKm) || 0
  const lo = Math.min(i0, i1), hi = Math.max(i0, i1)
  const geom = routeStore.geometry.value
  if (!geom[lo] || !geom[hi]) return
  const MAX = 20
  const indices = [lo]
  if (hi - lo > 1) {
    const middle = Array.from({ length: hi - lo - 1 }, (_, i) => lo + 1 + i)
    const step = middle.length / (MAX - 2)
    const sampled = middle.length <= MAX - 2 ? middle : Array.from({ length: MAX - 2 }, (_, i) => middle[Math.floor(i * step)])
    indices.push(...sampled)
  }
  indices.push(hi)
  const pts = indices.map((i) => ({ lat: geom[i][1], lng: geom[i][0] }))
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng)
  const centerLat = ((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5)
  const centerLng = ((Math.min(...lngs) + Math.max(...lngs)) / 2).toFixed(5)
  const points = pts.map((p, i) => `p[${i}][loc]=${p.lat},${p.lng}`).join('&')
  window.open(`https://www.komoot.com/plan/@${centerLat},${centerLng},12z?sport=touringbicycle&${points}`, '_blank', 'noopener,noreferrer')
}

// ─── Menu d'actions secondaires ───────────────────────────────────────────────
// Une seule description des entrées, rendue de deux façons : menu déroulant dans le
// bandeau sur ordinateur, modale plein écran sur téléphone (cibles tactiles). Les
// deux se ferment après un clic — d'où l'appel systématique à closeActionsMenu.

interface MenuAction {
  key: string
  icon: string
  label: string
  disabled?: boolean
  // Remplace l'icône par un spinner (export d'image en cours).
  busy?: boolean
  // Entrée-lien (nouvel onglet) plutôt que bouton.
  href?: string
  run?: () => void
  // Ouvre la modale de préférences : ProfileDialog écoute les clics sur ces attributs.
  profileTrigger?: boolean
}

interface MenuGroup { key: string; label?: string; items: MenuAction[] }

const mobileActionsOpen = ref(false)

function closeActionsMenu() {
  mobileActionsOpen.value = false
}

// Le dropdown desktop est en auto-close="outside" (pour ne pas se fermer quand on
// règle le sport / profil) : on le referme donc à la main après une action.
const actionsToggleEl = useTemplateRef<HTMLElement>('actionsToggleEl')
function closeActionsDropdown() {
  if (actionsToggleEl.value) Dropdown.getOrCreateInstance(actionsToggleEl.value).hide()
}

const menuGroups = computed<MenuGroup[]>(() => {
  const groups: MenuGroup[] = []

  if (canNavigate.value) {
    groups.push({
      key: 'navigate',
      items: [{ key: 'navigate', icon: 'fa-solid fa-location-arrow', label: t('routes.navigate'), run: navigateRoute }],
    })
  }

  const exportItems: MenuAction[] = [{
    key: 'image',
    icon: 'fa-solid fa-image',
    label: t('routes.export_image'),
    disabled: !routeStore.hasGeometry.value || exporting.value,
    busy: exporting.value,
    run: openExportDialog,
  }]
  if (canExportGpx()) {
    exportItems.push({ key: 'gpx', icon: 'fa-solid fa-download', label: t('routes.export_gpx'), run: exportGpx })
  }
  if (routeStore.waypoints.value.length >= 2) {
    exportItems.push({ key: 'komoot', icon: 'fa-solid fa-person-biking', label: t('routes.open_in_komoot'), run: openInKomoot })
  }
  groups.push({ key: 'export', label: t('routes.group_export'), items: exportItems })

  if (shareUrl.value) {
    groups.push({
      key: 'share',
      label: t('routes.group_share'),
      items: [
        {
          key: 'share',
          icon: shareCopied.value ? 'fa-solid fa-check text-success' : 'fa-solid fa-share-nodes',
          label: shareCopied.value ? t('routes.share_copied') : t('routes.share'),
          run: shareRoute,
        },
        {
          key: 'share-preview',
          icon: 'fa-solid fa-up-right-from-square',
          label: t('routes.share_preview'),
          href: shareUrl.value,
        },
      ],
    })
  }

  if (!readOnly.value) {
    groups.push({
      key: 'profile',
      items: [{ key: 'profile', icon: 'fa-solid fa-sliders', label: t('nav.profile'), profileTrigger: true }],
    })
  }

  return groups
})

// Sélecteur de type d'itinéraire (sport + profil de routage) : dans le panneau latéral
// sur ordinateur, mais celui-ci est masqué sur téléphone — on le rejoue donc dans la
// modale d'actions. Même helpers que RouteBuilderStats.
const ACTIVITIES = ['cycling', 'mtb', 'hiking'] as const
function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// Attributs du déclencheur de préférences, posés seulement sur l'entrée concernée.
const PROFILE_TRIGGER_ATTRS = {
  'data-profile-trigger': '',
  'data-profile-sections': 'display,sport,map,search,climb,poi',
}

// ─── Alternatives de tronçon ──────────────────────────────────────────────────
// Sur une sélection, on rejoue le routage BRouter entre ses deux extrémités
// (alternativeidx 0..3) pour proposer d'autres tracés du tronçon. Le choix d'une
// variante remplace la portion via mapRef.applyAlternative.

interface AlternativeView extends RouteAlternative {
  color: string
  deltaDistanceM: number
  deltaGainM: number
}
const ALT_COLORS = ['#f77f00', '#7209b7', '#0096c7', '#d62828']

const alternatives = ref<AlternativeView[]>([])
const alternativesLoading = ref(false)
const alternativesError = ref<string | null>(null)
// Géométrie du tronçon actuel, tracée en référence dans la dialogue des variantes.
const altCurrentCoords = ref<Coord[]>([])
// Bornes géométrie de la sélection au moment de la proposition (figées : la sélection
// est effacée à l'application, mais on en a besoin pour le splice).
let altBounds: { lo: number; hi: number } | null = null
let altToken = 0

// La dialogue s'ouvre dès qu'une proposition est en cours (chargement, erreur ou
// variantes trouvées) et se referme via cancelAlternatives.
const showAlternativesDialog = computed(() => alternativesLoading.value || alternativesError.value != null || alternatives.value.length > 0)

async function proposeAlternatives() {
  if (routeStore.readOnly.value) return
  const range = selectionStore.selectionRange.value
  const geom = routeStore.geometry.value
  if (!range || !selectionStore.cumDistKm.length || geom.length < 2) return
  const lo = geomIdxForKm(range.startKm, selectionStore.cumDistKm)
  const hi = geomIdxForKm(range.endKm, selectionStore.cumDistKm)
  const loI = Math.min(lo, hi), hiI = Math.max(lo, hi)
  if (hiI - loI < 2) { alternativesError.value = t('routes.alternatives_too_short'); alternatives.value = []; altBounds = null; return }

  const token = ++altToken
  altBounds = { lo: loI, hi: hiI }
  alternatives.value = []
  alternativesError.value = null
  alternativesLoading.value = true

  // Tronçon actuel (entre les extrémités) : sert de référence pour les écarts, pour
  // écarter les variantes identiques au tracé déjà en place, et de tracé de référence
  // dans la dialogue.
  const currentCoords = geom.slice(loI, hiI + 1)
  altCurrentCoords.value = currentCoords
  const currentDists = buildDistancesM(currentCoords)
  const currentDist = currentDists[currentDists.length - 1] ?? 0
  const currentGL = computeGainLoss(currentCoords)

  try {
    const p0: LngLat = [geom[loI][0], geom[loI][1]]
    const p1: LngLat = [geom[hiI][0], geom[hiI][1]]
    const alts = await fetchSegmentAlternatives(p0, p1, routeStore.profile.value)
    if (token !== altToken) return
    // Écarte les variantes identiques au tronçon actuel : rien à proposer d'utile.
    const distinct = alts.filter((a) => !equivalentGeometry(a, { coords: currentCoords, distanceM: currentDist }))
    if (!distinct.length) { alternativesError.value = t('routes.alternatives_none'); return }
    alternatives.value = distinct.slice(0, ALT_COLORS.length).map((a, i) => ({
      ...a,
      color: ALT_COLORS[i % ALT_COLORS.length],
      deltaDistanceM: a.distanceM - currentDist,
      deltaGainM: a.gainM - currentGL.gain,
    }))
  } catch (e: any) {
    if (token === altToken) alternativesError.value = `${t('routes.alternatives_error')}: ${e.message}`
  } finally {
    if (token === altToken) alternativesLoading.value = false
  }
}

// La dialogue émet `select` avec l'index de la variante choisie.
function onSelectAlternative(altId: number) {
  const alt = alternatives.value[altId]
  if (alt) applyChosenAlternative(alt)
}

function applyChosenAlternative(alt: AlternativeView) {
  if (!altBounds) return
  mapRef.value?.applyAlternative(altBounds.lo, altBounds.hi, alt.coords)
  cancelAlternatives()
}

function cancelAlternatives() {
  altToken++
  alternatives.value = []
  alternativesError.value = null
  alternativesLoading.value = false
  altCurrentCoords.value = []
  altBounds = null
}

// La sélection disparaît (effacée, ou tracé recalculé) → on ferme la dialogue.
watch(() => selectionStore.selectionRange.value, (r) => {
  if (!r && (alternatives.value.length || alternativesLoading.value || alternativesError.value)) cancelAlternatives()
})

// ─── Undo / clear ─────────────────────────────────────────────────────────────

function undoLast() {
  if (!routeStore.waypoints.value.length) return
  routeStore.waypoints.value = routeStore.waypoints.value.slice(0, -1)
  mapRef.value?.refreshWaypointMarkers()
  recomputeRoute()
}

function clearAll() {
  if (!routeStore.waypoints.value.length) return
  if (!window.confirm(t('routes.clear_confirm'))) return
  routeStore.waypoints.value = []
  mapRef.value?.refreshWaypointMarkers()
  recomputeRoute()
}

// ─── Stats events ─────────────────────────────────────────────────────────────

function onSelectClimb(climb: any) {
  selectionStore.selectionRange.value = { startKm: climb.startKm, endKm: climb.endKm }
  selectionStore.selectionPinned.value = true
  mapRef.value?.updateSelectionLayer()
  chartRef.value?.update()
  mapRef.value?.fitMapToSelection()
}

function onHoverClimb(climb: any) {
  // Sur ordinateur, survoler un col le sélectionne (drapeaux départ/arrivée +
  // tronçon en bleu), en remplaçant la sélection précédente s'il y en a une.
  if (isMobile.value) return
  if (climb) {
    selectionStore.selectionRange.value = { startKm: climb.startKm, endKm: climb.endKm }
    selectionStore.selectionPinned.value = false
  } else if (!selectionStore.selectionPinned.value) {
    // On ne survole plus de col : on efface la sélection temporaire (sauf si elle
    // a été épinglée par un clic / glissé).
    selectionStore.selectionRange.value = null
  }
  mapRef.value?.updateSelectionLayer()
  chartRef.value?.update()
}

function onSelectPlace(place: any) {
  mapRef.value?.flyTo(place.lng, place.lat)
  mapRef.value?.showPlacePopup(place)
  placesStore.placeSelectedKm = place.distanceM / 1000
  chartRef.value?.update()
}

function onHoverPlace(place: any) {
  if (place) {
    mapRef.value?.showPlaceHoverMarker(place.markerLng, place.markerLat, place.distanceM)
  } else {
    mapRef.value?.hidePlaceHoverMarker()
  }
}

// ─── Chart events ─────────────────────────────────────────────────────────────

function onChartFlyTo(lng: number, lat: number) {
  mapRef.value?.showChartCrossMarker(lng, lat)
}

function onChartZoomTo(lng: number, lat: number) {
  mapRef.value?.showChartCrossMarker(lng, lat)
  mapRef.value?.flyTo(lng, lat)
}

function onChartHoverEnd() {
  mapRef.value?.hideChartCrossMarker()
}

function onChartFitToSelection() {
  mapRef.value?.fitMapToSelection()
}

function onChartCollapse() {
  state.showElevationChart = false
  nextTick(() => mapRef.value?.resize())
}

// ─── Export image ─────────────────────────────────────────────────────────────

const CLIMB_CAT_COLORS: Record<string, string> = {
  HC: '#111827', '1': '#b91c1c', '2': '#ea580c', '3': '#ca8a04', '4': '#16a34a',
}

// Web Mercator normalisé [0,1] — sert à dimensionner l'image pour qu'elle contienne
// tout l'itinéraire au zoom voulu.
function mercX(lng: number) { return (lng + 180) / 360 }
function mercY(lat: number) {
  const s = Math.sin((lat * Math.PI) / 180)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}

interface ExportDims { cssW: number; cssH: number; tileZoom: number; pad: number }

// Calcule les dimensions du canvas pour rendre l'itinéraire aux plus petites tuiles
// (maxzoom) de la source, plafonné à EXPORT_MAX_DIM. Si l'itinéraire est trop étendu
// pour tenir au maxzoom, le zoom réellement atteint est réduit en conséquence.
function computeExportDims(styleId: string, maxDim: number = EXPORT_MAX_DIM): ExportDims | null {
  const geom = routeStore.geometry.value
  if (!geom.length) return null
  const info = exportTileInfoFor(styleId)
  // transform.zoom qui charge les tuiles de niveau `maxzoom` : maxzoom - log2(512/tileSize).
  const offset = Math.log2(512 / info.tileSize)
  let z = info.maxzoom - offset

  const xs = geom.map((c) => mercX(c[0]))
  const ys = geom.map((c) => mercY(c[1]))
  const dx = Math.max(...xs) - Math.min(...xs)
  const dy = Math.max(...ys) - Math.min(...ys)

  const spanAt = (zoom: number) => {
    const world = 512 * 2 ** zoom
    return { w: dx * world, h: dy * world }
  }

  let { w: pxW, h: pxH } = spanAt(z)
  let maxSpan = Math.max(pxW, pxH)
  if (maxSpan + 2 * EXPORT_PAD > maxDim) {
    const k = (maxDim - 2 * EXPORT_PAD) / maxSpan
    z += Math.log2(k)
    ;({ w: pxW, h: pxH } = spanAt(z))
    maxSpan = Math.max(pxW, pxH)
  }
  // Marge dynamique : agrandit le cadre des petits itinéraires sans gonfler le détail.
  let pad = EXPORT_PAD
  if (maxSpan + 2 * pad < EXPORT_MIN_CONTENT) pad = (EXPORT_MIN_CONTENT - maxSpan) / 2

  const tileZoom = Math.min(info.maxzoom, Math.floor(z + offset))
  return { cssW: Math.round(pxW + 2 * pad), cssH: Math.round(pxH + 2 * pad), tileZoom, pad: Math.round(pad) }
}

// Estimation affichée dans la modale (carte seule, hors titre/stats/profil), tenant
// compte du curseur de résolution.
const exportEstimate = computed<ExportDims | null>(() => {
  void routeStore.geometry.value // dépendance réactive
  if (!exportStyleId.value) return null
  return computeExportDims(exportStyleId.value, EXPORT_MAX_DIM * (exportResolutionPct.value / 100))
})

function openExportDialog() {
  exportStyleId.value = state.mapStyleId
  exportShowGrade.value = state.colorMode === 'grade'
  exportShowClimbs.value = state.showClimbs
  exportResolutionPct.value = 100
  showExportDialog.value = true
}

async function applyStyleForExport(styleId: string) {
  const mapInst = mapRef.value?.getMapInstance()
  if (!mapInst || styleId === state.mapStyleId) return
  state.mapStyleId = styleId
  mapInst.setStyle(mapStyleFor(styleId) as any, { diff: false })
  await new Promise<void>((resolve) => {
    mapInst.once('style.load', () => {
      mapRef.value?.updateRouteLayer()
      mapRef.value?.updateSelectionLayer()
      resolve()
    })
  })
}

function drawClimbMarkersOnCanvas(ctx: CanvasRenderingContext2D, mapOffsetY: number, pscale: number, s: number) {
  const mapInst = mapRef.value?.getMapInstance()
  if (!mapInst) return
  routeStore.detectedClimbs.value.forEach((climb) => {
    const pt = routeStore.geometry.value[climb.startIdx]
    if (!pt) return
    const sp = mapInst.project([pt[0], pt[1]])
    const cx = sp.x * pscale, cy = sp.y * pscale + mapOffsetY
    const color = CLIMB_CAT_COLORS[climb.category] ?? '#6c757d'
    const r = 13 * s
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = color; ctx.fill()
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * s; ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(11 * s)}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(climb.category ?? 'NC', cx, cy)
    const lengthStr = climb.lengthM >= 1000 ? `${(climb.lengthM / 1000).toFixed(1)} km` : `${Math.round(climb.lengthM)} m`
    const line1 = `${climb.avgGrade.toFixed(1)}%  ·  ${lengthStr}`
    const line2 = `+${Math.round(climb.gain)} m D+`
    const fs = Math.round(9.5 * s)
    ctx.font = `${fs}px system-ui,sans-serif`
    const tw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width)
    const tPad = 7 * s, tW = tw + tPad * 2, lineH = fs + 4 * s, tH = lineH * 2 + tPad * 1.5
    const tX = cx - tW / 2, tY = cy - r - tH - 5 * s
    ctx.fillStyle = 'rgba(17,24,39,0.88)'
    ctx.beginPath(); ctx.roundRect(tX, tY, tW, tH, 4 * s); ctx.fill()
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.font = `${fs}px system-ui,sans-serif`; ctx.fillText(line1, cx, tY + tPad)
    ctx.font = `${Math.round(fs * 0.88)}px system-ui,sans-serif`
    ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.fillText(line2, cx, tY + tPad + lineH)
  })
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

function drawTitleOnCanvas(ctx: CanvasRenderingContext2D, h: number, s: number) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, ctx.canvas.width, h)
  ctx.fillStyle = '#111827'
  ctx.font = `bold ${Math.round(22 * s)}px system-ui,sans-serif`
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  ctx.fillText((routeStore.name.value ?? '').trim() || 'Itinéraire', Math.round(20 * s), h / 2)
  ctx.textBaseline = 'alphabetic'
}

function drawStatsOnCanvas(ctx: CanvasRenderingContext2D, offsetY: number, h: number, s: number) {
  const distM = routeStore.distanceM.value
  const speed = routeStore.avgSpeedKmh.value
  const items = [
    {
      value: distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM)} m`,
      sub: t('routes.export_stat_distance'),
    },
    {
      value: `+${Math.round(routeStore.elevGainM.value)} m`,
      sub: t('routes.export_stat_gain'),
    },
    {
      value: formatDuration(routeStore.estimatedSeconds.value),
      sub: `${t('routes.export_stat_duration')} · ${speed} km/h`,
    },
  ]
  const W = ctx.canvas.width
  ctx.fillStyle = '#f9fafb'; ctx.fillRect(0, offsetY, W, h)

  const valueFs = Math.round(26 * s)
  const subFs = Math.round(13 * s)
  const gap = Math.round(8 * s)
  const blockH = valueFs + gap + subFs
  const top = offsetY + (h - blockH) / 2
  const cellW = W / items.length

  ctx.textAlign = 'center'
  items.forEach((item, i) => {
    const cx = cellW * i + cellW / 2
    // séparateur vertical entre les colonnes
    if (i > 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = Math.max(1, s)
      ctx.beginPath(); ctx.moveTo(cellW * i, offsetY + h * 0.2); ctx.lineTo(cellW * i, offsetY + h * 0.8); ctx.stroke()
    }
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#111827'
    ctx.font = `bold ${valueFs}px system-ui,sans-serif`
    ctx.fillText(item.value, cx, top)
    ctx.fillStyle = '#6b7280'
    ctx.font = `${subFs}px system-ui,sans-serif`
    ctx.fillText(item.sub, cx, top + valueFs + gap)
  })
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

async function exportImage() {
  const mapInst = mapRef.value?.getMapInstance()
  if (!mapInst || !routeStore.geometry.value.length) return
  const dims = computeExportDims(exportStyleId.value, EXPORT_MAX_DIM * (exportResolutionPct.value / 100))
  if (!dims) return
  exporting.value = true
  showExportDialog.value = false
  const savedStyleId = state.mapStyleId
  const savedColorMode = state.colorMode
  const savedShowClimbs = state.showClimbs
  const savedPixelRatio = mapInst.getPixelRatio()
  const dpr = window.devicePixelRatio || 1

  // On agrandit temporairement le conteneur de carte (hors écran) à la taille requise pour
  // afficher tout l'itinéraire au maxzoom, puis on capture au ratio 1:1. C'est le zoom de la
  // carte — et non le pixelRatio — qui détermine le niveau de tuiles chargé par MapLibre.
  const container = mapInst.getContainer()
  const savedContainerCss = container.style.cssText
  const savedHtmlOverflow = document.documentElement.style.overflow

  try {
    await applyStyleForExport(exportStyleId.value)
    const targetColorMode = exportShowGrade.value ? 'grade' : 'none'
    if (state.colorMode !== targetColorMode) { state.colorMode = targetColorMode; mapRef.value?.applyColorMode() }

    document.documentElement.style.overflow = 'hidden'
    container.style.position = 'fixed'
    container.style.top = '0'
    container.style.left = '0'
    container.style.width = `${dims.cssW}px`
    container.style.height = `${dims.cssH}px`
    container.style.zIndex = '-1'
    container.style.visibility = 'hidden'
    mapInst.setPixelRatio(1)
    mapInst.resize()

    const lngs = routeStore.geometry.value.map((c) => c[0])
    const lats = routeStore.geometry.value.map((c) => c[1])
    mapInst.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: dims.pad, duration: 0 })
    await new Promise<void>((resolve) => mapInst.once('idle', resolve))

    const mapCanvas = mapInst.getCanvas()
    const outW = mapCanvas.width
    const mapOutH = mapCanvas.height
    // Échelle visuelle des surcouches (titre, stats, marqueurs, tracé) relative à une largeur
    // de référence fixe — donc identique sur mobile et PC pour une même résolution de sortie.
    const s = outW / EXPORT_REF_WIDTH

    // Élargit le tracé proportionnellement à la résolution (sinon quasi invisible sur une
    // grande image), puis attend le re-rendu avant la capture.
    mapRef.value?.setRouteLineScale(s)
    await new Promise<void>((resolve) => mapInst.once('idle', resolve))
    // Ratio réel des pixels du canvas (CSS → buffer) : sert à projeter les cols exactement
    // là où ils sont rendus, quel que soit le pixelRatio effectif de MapLibre.
    const pscale = mapCanvas.width / (mapCanvas.clientWidth || dims.cssW)
    const chartOutH = exportShowChart.value ? Math.round(mapOutH * 0.40) : 0
    const titleH = Math.round(58 * s)
    const statsH = exportShowStats.value ? Math.round(104 * s) : 0
    const out = document.createElement('canvas')
    out.width = outW; out.height = titleH + mapOutH + chartOutH + statsH
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height)

    // Monte et rend un chart dédié hors écran (profil complet, identique sur mobile et PC).
    if (exportShowChart.value) {
      exportChartMounted.value = true
      await nextTick()
      await exportChartRef.value?.render()
    }
    const chartInst = exportShowChart.value ? exportChartRef.value?.getChartInstance() : null
    if (chartInst) {
      const o = chartInst.options as any
      const fs = (base: number) => ({ size: Math.round((base * s) / dpr) })
      o.scales.x.ticks.font = fs(11); o.scales.y.ticks.font = fs(11)
      o.scales.x.title.font = fs(10); o.scales.y.title.font = fs(10)
      chartInst.update('none')
      chartInst.resize(outW / dpr, chartOutH / dpr)
      await nextTick()
    }

    const mapOffsetY = titleH + statsH
    drawTitleOnCanvas(ctx, titleH, s)
    if (exportShowStats.value) drawStatsOnCanvas(ctx, titleH, statsH, s)
    ctx.drawImage(mapCanvas, 0, mapOffsetY, outW, mapOutH)
    if (exportShowClimbs.value) drawClimbMarkersOnCanvas(ctx, mapOffsetY, pscale, s)
    if (chartInst) {
      const chartEl = exportChartRef.value?.getChartEl()
      if (chartEl) ctx.drawImage(chartEl, 0, mapOffsetY + mapOutH, outW, chartOutH)
    }

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    if (blob) {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.download = `${(routeStore.name.value ?? 'itineraire').trim() || 'itineraire'}.png`
      link.href = url
      link.click()
      URL.revokeObjectURL(url)
    }
  } finally {
    container.style.cssText = savedContainerCss
    document.documentElement.style.overflow = savedHtmlOverflow
    mapRef.value?.setRouteLineScale(1)
    mapInst.setPixelRatio(savedPixelRatio)
    mapInst.resize()
    // Démonte le chart d'export (Vue détruit l'instance Chart.js via onBeforeUnmount).
    exportChartRef.value?.destroy()
    exportChartMounted.value = false
    await applyStyleForExport(savedStyleId)
    if (state.colorMode !== savedColorMode) { state.colorMode = savedColorMode; mapRef.value?.applyColorMode() }
    if (state.showClimbs !== savedShowClimbs) { state.showClimbs = savedShowClimbs; mapRef.value?.installClimbMarkers() }
    exporting.value = false
  }
}

// ─── Resize handles ───────────────────────────────────────────────────────────

function startResize(e: MouseEvent) {
  resizing = true; resizeStartY = e.clientY; resizeStartFlex = mapFlex.value
  document.addEventListener('mousemove', onResize); document.addEventListener('mouseup', stopResize)
  e.preventDefault()
}
function onResize(e: MouseEvent) {
  if (!resizing || !rightColEl.value) return
  const colH = (rightColEl.value as HTMLElement).getBoundingClientRect().height
  if (colH === 0) return
  const delta = (e.clientY - resizeStartY) / colH
  mapFlex.value = Math.max(0.2, Math.min(0.8, resizeStartFlex + delta))
}
function stopResize() {
  resizing = false
  document.removeEventListener('mousemove', onResize); document.removeEventListener('mouseup', stopResize)
  mapRef.value?.resize(); chartRef.value?.resize()
}
function startResizeH(e: MouseEvent) {
  resizingH = true; resizeStartX = e.clientX; resizeStartWidth = sidebarWidth.value
  document.addEventListener('mousemove', onResizeH); document.addEventListener('mouseup', stopResizeH)
  e.preventDefault()
}
function onResizeH(e: MouseEvent) {
  if (!resizingH) return
  sidebarWidth.value = Math.max(130, Math.min(500, resizeStartWidth + (e.clientX - resizeStartX)))
}
function stopResizeH() {
  resizingH = false
  document.removeEventListener('mousemove', onResizeH); document.removeEventListener('mouseup', stopResizeH)
  mapRef.value?.resize(); chartRef.value?.resize()
}

// ─── Mobile sheet ─────────────────────────────────────────────────────────────

function onSheetHandleTouchStart(ev: TouchEvent) {
  if (ev.touches.length !== 1) return
  const startY = ev.touches[0].clientY; const startH = mobileSheetHeight.value
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    const dy = startY - e.touches[0].clientY
    mobileSheetHeight.value = Math.min(SHEET_HEIGHT_MAX, Math.max(SHEET_HEIGHT_MIN, startH + dy))
    chartRef.value?.resize()
  }
  const onEnd = () => {
    window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd)
    if (mobileSheetHeight.value < SHEET_HEIGHT_MIN + 40) mobileSheetOpen.value = false
    chartRef.value?.resize()
  }
  window.addEventListener('touchmove', onMove, { passive: true }); window.addEventListener('touchend', onEnd)
}

// ─── GPX import ───────────────────────────────────────────────────────────────

// Charge un jeu de waypoints importés (GPX) dans le créateur : nom + type si
// fournis, puis recalcule le tracé via BRouter et cadre la carte dessus.
function applyImportedWaypoints(
  wps: Array<{ lng: number; lat: number; free?: boolean }>,
  name?: string,
  activity?: string,
  profile?: string,
) {
  if (!Array.isArray(wps) || wps.length < 2) return
  if (name && !routeStore.name.value.trim()) routeStore.name.value = String(name).slice(0, 80)
  if (activity === 'cycling' || activity === 'mtb' || activity === 'hiking') {
    routeStore.setSport(activity)
  }
  // setSport a réaligné le profil sur le défaut du sport ; on applique ensuite le
  // profil choisi à la création (ignoré s'il n'est pas proposé pour ce sport).
  if (profile) routeStore.setProfile(profile)
  routeStore.waypoints.value = wps
  mapRef.value?.refreshWaypointMarkers()
  const lngs = wps.map((w) => w.lng), lats = wps.map((w) => w.lat)
  mapRef.value?.fitBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)], { padding: 60, duration: 600, maxZoom: 14 })
  recomputeRoute()
}

function applyPendingGpxImport() {
  try {
    const u = new URL(window.location.href)
    if (u.searchParams.get('fromGpx') !== '1') return
    u.searchParams.delete('fromGpx'); window.history.replaceState({}, '', u.toString())
    const raw = sessionStorage.getItem('sportsScope.gpxImport')
    sessionStorage.removeItem('sportsScope.gpxImport')
    if (!raw) return
    const payload = JSON.parse(raw)
    applyImportedWaypoints(payload?.waypoints, payload?.name, payload?.activity, payload?.profile)
  } catch { /* stale payload */ }
}

// Web Share Target (Android) : un .gpx partagé à l'app est mis en cache par le
// service worker, qui redirige ici avec ?fromShare=1. On récupère le fichier
// (consommation one-shot côté SW) et on charge directement le tracé.
async function applySharedGpx() {
  try {
    const u = new URL(window.location.href)
    if (u.searchParams.get('fromShare') !== '1') return
    u.searchParams.delete('fromShare'); window.history.replaceState({}, '', u.toString())
    const res = await fetch('/__shared_gpx__', { cache: 'no-store' })
    if (!res.ok) return
    const text = await res.text()
    const filename = decodeURIComponent(res.headers.get('X-Filename') || '').replace(/\.gpx$/i, '').trim()
    applyImportedWaypoints(parseGpxWaypoints(text), filename || undefined)
  } catch { /* partage illisible */ }
}

// Web Share Target — filet de sécurité serveur : si le service worker n'a pas
// intercepté le POST, le serveur rend le créateur avec le GPX en prop (base64).
// On le décode (UTF-8 pour les accents des noms de points) et on charge le tracé.
function applySharedGpxProp() {
  if (!props.sharedGpx) return
  try {
    const bytes = Uint8Array.from(atob(props.sharedGpx), (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8').decode(bytes)
    const name = (props.sharedGpxName ?? '').trim()
    applyImportedWaypoints(parseGpxWaypoints(text), name || undefined)
  } catch { /* partage illisible : on reste sur un créateur vierge */ }
}

// File Handling API : quand l'OS ouvre un .gpx avec l'app installée (PWA), il
// lance le créateur — action déclarée dans public/manifest.webmanifest — et nous
// transmet le fichier via launchQueue. On le parse et on charge directement le
// tracé, sans détour par la liste ni la modale.
function setupGpxFileHandler() {
  const queue = (window as { launchQueue?: { setConsumer: (cb: (p: { files?: FileSystemFileHandle[] }) => void) => void } }).launchQueue
  if (!queue || typeof queue.setConsumer !== 'function') return
  queue.setConsumer(async (params) => {
    const handle = params?.files?.[0]
    if (!handle) return
    try {
      const file = await handle.getFile()
      const waypoints = parseGpxWaypoints(await file.text())
      applyImportedWaypoints(waypoints, file.name.replace(/\.gpx$/i, '').trim())
    } catch { /* fichier illisible : on reste sur un créateur vierge */ }
  })
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

watch(state, () => state.save(), { deep: true })

// Toute édition des données persistées marque l'itinéraire comme non enregistré.
watch([routeStore.waypoints, routeStore.name, routeStore.sport, routeStore.profile], () => {
  if (trackDirty) dirty.value = true
}, { deep: true })

// Titre de l'onglet : « Itinéraire - <nom> » ; retombe sur le seul préfixe tant
// que l'itinéraire n'a pas de nom.
watch(routeStore.name, (name) => {
  const n = (name ?? '').trim()
  document.title = n ? `${t('routes.page_title')} - ${n}` : t('routes.page_title')
}, { immediate: true })

watch(() => state.showElevationChart, async () => {
  await nextTick()
  mapRef.value?.resize()
  if (state.showElevationChart && routeStore.hasGeometry.value) {
    chartRef.value?.render()
  }
})
watch(() => state.showStatsSidebar, async () => {
  await nextTick(); mapRef.value?.resize()
})
watch(mobileSheetOpen, async (open) => {
  if (!open || !isMobile.value || !routeStore.hasGeometry.value) return
  await nextTick()
  chartRef.value?.render()
})
watch(isMobile, async (mobile) => {
  if (!routeStore.hasGeometry.value) return
  chartRef.value?.destroy()
  if (mobile && !mobileSheetOpen.value) return
  await nextTick(); chartRef.value?.render()
})
// La recherche de lieux (Overpass) n'est plus déclenchée à chaque modification du
// tracé : elle est lancée uniquement à l'enregistrement (voir save()). On se contente
// ici de purger les lieux quand le tracé devient vide.
watch(routeStore.geometry, (newGeom) => {
  if (newGeom.length < 2) {
    placesStore.token++
    placesStore.importantPlaces.value = []
    placesStore.isFetchingPlaces.value = false
    placesStore.placesFetchFailed.value = false
  }
}, { deep: false })

function onWindowResize() {
  const mobile = computeIsMobile()
  if (mobile !== isMobile.value) isMobile.value = mobile
  updateNavbarHeight()
  setTimeout(() => mapRef.value?.resize(), 100)
}

// Mesure la hauteur réelle de la navbar fixe et l'expose en variable CSS : sur
// mobile elle est plus basse que les 4rem réservés par défaut, ce qui laissait un
// vide au-dessus de la carte (voir le media query .route-builder-page).
// En mode PWA standalone, 100dvh inclut les zones système (barre maison iOS,
// barre de geste Android) qui masquent le bouton de profil en bas de carte.
// On pose --rb-available-h depuis window.visualViewport.height, qui reflète la
// hauteur réellement visible sans ces zones — et qu'on utilise à la place de 100dvh.
function updateNavbarHeight() {
  const nav = document.querySelector('nav.navbar') as HTMLElement | null
  // offsetHeight peut valoir 0 avant la mise en page : on retombe alors sur 64px
  // (4rem) plutôt que de poser une hauteur nulle qui casserait le calc() mobile.
  const h = nav?.offsetHeight || 64
  document.body.style.setProperty('--rb-navbar-h', `${h}px`)

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true
  if (isStandalone && window.visualViewport) {
    document.body.style.setProperty('--rb-available-h', `${window.visualViewport.height}px`)
  } else {
    document.body.style.removeProperty('--rb-available-h')
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

// Avertit avant de quitter la page (rechargement, fermeture d'onglet, navigation
// sortante) tant que des modifications n'ont pas été enregistrées. En lecture
// seule (lien de partage), aucune édition possible : pas d'avertissement.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(async () => {
  state.load()
  routeStore.reset()
  // Un lien de partage verrouille la lecture seule (non débrayable) ; en édition
  // normale on démarre déverrouillé, l'utilisateur peut basculer via le toggle.
  routeStore.shareLocked.value = !!props.shareToken
  routeStore.readOnly.value = !!props.shareToken
  routeStore.currentId.value = props.routeId ? Number(props.routeId) : null
  updateNavbarHeight()
  // Re-mesure dès que la navbar prend sa taille définitive (polices, layout) puis à
  // chaque variation, pour que la hauteur de page mobile reste correcte sans avoir à
  // pivoter l'appareil.
  const nav = document.querySelector('nav.navbar') as HTMLElement | null
  if (nav && typeof ResizeObserver !== 'undefined') {
    navbarResizeObserver = new ResizeObserver(() => { updateNavbarHeight(); mapRef.value?.resize() })
    navbarResizeObserver.observe(nav)
  }
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('beforeunload', onBeforeUnload)
  // En mode PWA standalone, le visual viewport peut changer sans déclencher
  // window.resize (ex. clavier virtuel). On s'y abonne pour garder --rb-available-h
  // à jour et éviter que le bouton de profil disparaisse sous la barre maison.
  window.visualViewport?.addEventListener('resize', updateNavbarHeight)

  // Mode lecture seule (lien de partage) : on charge l'itinéraire via le jeton
  // public, sans brancher la sauvegarde ni lire les paramètres de pré-remplissage.
  if (props.shareToken) {
    // Sur un lien partagé, on sélectionne par défaut uniquement les repères posés par
    // l'auteur (départ / arrivée / parking) et les couleurs de pente ; les autres
    // calques (points, cols, POI) partent masqués. Le menu Affichage reste complet,
    // le destinataire peut donc tout réactiver — et ses choix, enregistrés sous la clé
    // de la vue partagée, ne sont plus réimposés aux visites suivantes.
    if (!state.hasStoredState) {
      state.showMarkers = true
      state.colorMode = 'grade'
      state.showWaypoints = false
      state.showClimbs = false
      state.showPois = false
    }
    await mapRef.value?.initMap()
    await fetchSharedRoute(props.shareToken as string)
    return
  }

  document.getElementById('navbar-route-save-btn')?.addEventListener('click', save)
  if (!routeStore.currentId.value) {
    try {
      const u = new URL(window.location.href)
      const presetName = u.searchParams.get('name')
      if (presetName) {
        routeStore.name.value = presetName.slice(0, 80)
        u.searchParams.delete('name')
      }
      const presetActivity = u.searchParams.get('activity')
      if (presetActivity === 'cycling' || presetActivity === 'mtb' || presetActivity === 'hiking') {
        routeStore.setSport(presetActivity)
        u.searchParams.delete('activity')
      }
      // Profil de routage pré-choisi dans la modale de création (?profile=…).
      // Appliqué après setSport (qui aurait sinon réaligné sur le défaut du sport) ;
      // ignoré s'il n'est pas proposé pour le sport.
      const presetProfile = u.searchParams.get('profile')
      if (presetProfile) {
        routeStore.setProfile(presetProfile)
        u.searchParams.delete('profile')
      }
      if (presetName || presetActivity || presetProfile) {
        window.history.replaceState({}, '', u.toString())
      }
    } catch { /* ignore */ }
  }
  await mapRef.value?.initMap()
  if (routeStore.currentId.value) {
    await fetchRoute(routeStore.currentId.value)
  } else {
    applyPendingGpxImport()
    // .gpx partagé à l'app (Android, Web Share Target) : voie SW (cache) puis, à
    // défaut, voie serveur (prop base64, si le SW n'a pas intercepté le POST).
    await applySharedGpx()
    applySharedGpxProp()
    // Fichier ouvert via le gestionnaire de fichiers PWA (desktop, File Handling API).
    setupGpxFileHandler()
  }
  // Chargement initial terminé : on commence à suivre les modifications. Un
  // import GPX en cours (applyPendingGpxImport) reste lui marqué comme non
  // enregistré, ses mutations de points étant vues une fois trackDirty activé.
  trackDirty = true
})

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onResize); document.removeEventListener('mouseup', stopResize)
  document.removeEventListener('mousemove', onResizeH); document.removeEventListener('mouseup', stopResizeH)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('beforeunload', onBeforeUnload)
  navbarResizeObserver?.disconnect(); navbarResizeObserver = null
  document.getElementById('navbar-route-save-btn')?.removeEventListener('click', save)
  if (savedTimer) clearTimeout(savedTimer)
  if (shareCopiedTimer) clearTimeout(shareCopiedTimer)
  document.body.style.removeProperty('--rb-navbar-h')
  document.body.style.removeProperty('--rb-available-h')
  window.visualViewport?.removeEventListener('resize', updateNavbarHeight)
  placesStore.reset()
  selectionStore.clear()
})
</script>

<template>
  <div class="route-builder-page">
    <!-- Rappel du type d'itinéraire à côté du logo (téléphone) : le titre de l'app étant
         masqué sur petit écran, on rappelle ici le sport courant. -->
    <Teleport to="#rb-brand-type">
      <span class="rb-brand-type-badge" :title="t(`routes.wt_sport_${routeStore.sport.value}`)">
        <i :class="`fa-solid ${sportIcon(routeStore.sport.value)}`" aria-hidden="true"></i>
        <span>{{ t(`routes.wt_sport_${routeStore.sport.value}`) }}</span>
      </span>
    </Teleport>

    <!-- Actions mobiles téléportées dans la navbar. La barre n'a la place que de trois
         boutons entre le retour et l'enregistrement (posés par la vue) : tout le reste
         passe par ce menu, ouvert en modale plein écran (cibles tactiles). -->
    <Teleport to="#rb-navbar-actions">
      <button type="button" class="btn btn-sm btn-outline-light" @click="mobileActionsOpen = true"
        :title="t('routes.more_actions')" :aria-label="t('routes.more_actions')">
        <span v-if="exporting" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
        <i v-else class="fa-solid fa-ellipsis" aria-hidden="true"></i>
      </button>
      <!-- Retour à l'édition depuis son propre lien partagé — la navbar est la seule
           barre d'actions sur téléphone, le bandeau d'en-tête étant réservé au desktop. -->
      <a v-if="editUrl" :href="editUrl" class="btn btn-sm btn-light"
        :title="t('routes.edit_route')" :aria-label="t('routes.edit_route')">
        <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
      </a>
    </Teleport>

    <!-- Modale des actions (téléphone) : même contenu que le menu déroulant du bandeau. -->
    <Transition name="modal">
      <div v-if="mobileActionsOpen" class="modal-backdrop-custom" @click.self="closeActionsMenu">
        <div class="modal-dialog-custom shadow-lg">
          <div class="modal-header-custom">
            <strong>{{ t('routes.more_actions') }}</strong>
            <button type="button" class="btn-close" @click="closeActionsMenu"
              :aria-label="t('routes.snap_warning_dismiss')"></button>
          </div>
          <div class="modal-body-custom actions-modal-body">
            <!-- Type d'itinéraire — accessible seulement ici sur téléphone (panneau latéral
                 masqué). Modifie le tracé, donc réservé à l'édition. -->
            <template v-if="!readOnly">
              <h6 class="actions-modal-group">{{ t('routes.wt_sport') }}</h6>
              <div class="activity-toggle btn-group btn-group-sm w-100" role="group" :aria-label="t('routes.wt_sport')">
                <button
                  v-for="s in ACTIVITIES"
                  :key="s"
                  type="button"
                  class="btn"
                  :class="routeStore.sport.value === s ? 'btn-primary' : 'btn-outline-secondary'"
                  :aria-label="t(`routes.wt_sport_${s}`)"
                  @click="onChangeSport(s)"
                >
                  <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
                  <span class="ms-1">{{ t(`routes.wt_sport_${s}`) }}</span>
                </button>
              </div>
              <label class="form-label small text-muted mb-1 mt-2" for="mobile-route-profile-select">
                {{ t('routes.profile_label') }}
              </label>
              <select
                id="mobile-route-profile-select"
                class="form-select form-select-sm"
                :value="routeStore.profile.value"
                @change="onChangeProfile(($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="p in profilesForSport(routeStore.sport.value)"
                  :key="p"
                  :value="p"
                >
                  {{ t(`routes.brouter_profile.${p}`) }}
                </option>
              </select>
              <hr class="dropdown-divider">
            </template>
            <template v-for="g in menuGroups" :key="g.key">
              <h6 v-if="g.label" class="actions-modal-group">{{ g.label }}</h6>
              <template v-for="a in g.items" :key="a.key">
                <a v-if="a.href" :href="a.href" class="actions-modal-item" target="_blank" rel="noopener"
                  @click="closeActionsMenu">
                  <i :class="a.icon" aria-hidden="true"></i>
                  <span>{{ a.label }}</span>
                </a>
                <button v-else type="button" class="actions-modal-item"
                  v-bind="a.profileTrigger ? PROFILE_TRIGGER_ATTRS : {}"
                  :disabled="a.disabled" @click="a.run?.(); closeActionsMenu()">
                  <span v-if="a.busy" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                  <i v-else :class="a.icon" aria-hidden="true"></i>
                  <span>{{ a.label }}</span>
                </button>
              </template>
            </template>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Chart hors écran utilisé uniquement pour l'export image -->
    <div v-if="exportChartMounted" aria-hidden="true"
      style="position: fixed; left: -99999px; top: 0; width: 900px; height: 320px; pointer-events: none;">
      <RouteBuilderChart ref="exportChartRef" />
    </div>

    <!-- Desktop header -->
    <div class="card shadow-sm border-0 d-none d-md-block route-builder-header-card">
      <div class="card-body d-flex align-items-center gap-2 py-1 px-3">
        <a v-if="!readOnly" :href="`${localePrefix}/routes`" class="btn btn-sm btn-link p-0 me-1 d-inline-flex align-items-center gap-1 flex-shrink-0">
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
          <span>{{ t('routes.back') }}</span>
        </a>
        <!-- Rappel du type d'activité, collé au début du nom : le sélecteur vivant
             désormais dans le menu, l'icône rappelle en permanence le sport courant. -->
        <span class="route-sport-badge flex-shrink-0" :title="t(`routes.wt_sport_${routeStore.sport.value}`)">
          <i :class="`fa-solid ${sportIcon(routeStore.sport.value)}`" aria-hidden="true"></i>
        </span>
        <input
          v-model="routeStore.name.value"
          type="text"
          class="form-control route-name-input flex-grow-1"
          :placeholder="t('routes.name_placeholder')"
          :maxlength="80"
          :readonly="readOnly"
        />
        <span v-if="readOnly" class="badge bg-secondary d-inline-flex align-items-center gap-1 flex-shrink-0">
          <i class="fa-solid fa-eye" aria-hidden="true"></i>{{ t('routes.readonly_badge') }}
        </span>
        <div class="d-flex gap-2 flex-shrink-0">
          <button v-if="!readOnly" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="!routeStore.hasGeometry.value" @click="undoLast" :title="t('routes.undo')">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
          </button>
          <button v-if="!readOnly" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="!routeStore.hasGeometry.value" @click="clearAll" :title="t('routes.clear')">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
          <!-- Actions secondaires (navigation, export, partage, préférences) : regroupées pour
               garder le bandeau lisible, l'édition et l'enregistrement seuls restant en accès direct. -->
          <!-- `d-flex` sur le conteneur : sans lui, le bouton ne s'étire pas comme ses
               voisins (la rangée est en align-items: stretch) et paraît plus court. -->
          <div class="dropdown d-flex">
            <!-- `auto-close="outside"` : les contrôles de type d'itinéraire vivent dans le
                 menu — un clic dessus ne doit pas le refermer, seul un clic à l'extérieur. -->
            <button ref="actionsToggleEl" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
              data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false"
              :title="t('routes.more_actions')" :aria-label="t('routes.more_actions')">
              <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
            </button>
            <ul class="dropdown-menu dropdown-menu-end route-actions-menu">
              <!-- Type d'itinéraire (sport + profil de routage), réservé à l'édition. -->
              <template v-if="!readOnly">
                <li><h6 class="dropdown-header">{{ t('routes.wt_sport') }}</h6></li>
                <li class="px-3 pb-2">
                  <div class="activity-toggle btn-group btn-group-sm w-100" role="group" :aria-label="t('routes.wt_sport')">
                    <button
                      v-for="s in ACTIVITIES"
                      :key="s"
                      type="button"
                      class="btn"
                      :class="routeStore.sport.value === s ? 'btn-primary' : 'btn-outline-secondary'"
                      :title="t(`routes.wt_sport_${s}`)"
                      :aria-label="t(`routes.wt_sport_${s}`)"
                      @click="onChangeSport(s)"
                    >
                      <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
                      <span class="ms-1 d-none d-lg-inline">{{ t(`routes.wt_sport_${s}`) }}</span>
                    </button>
                  </div>
                  <label class="form-label small text-muted mb-1 mt-2" for="route-profile-select">
                    {{ t('routes.profile_label') }}
                  </label>
                  <select
                    id="route-profile-select"
                    class="form-select form-select-sm"
                    :value="routeStore.profile.value"
                    :title="t(`routes.brouter_profile.${routeStore.profile.value}_desc`)"
                    @change="onChangeProfile(($event.target as HTMLSelectElement).value)"
                  >
                    <option
                      v-for="p in profilesForSport(routeStore.sport.value)"
                      :key="p"
                      :value="p"
                      :title="t(`routes.brouter_profile.${p}_desc`)"
                    >
                      {{ t(`routes.brouter_profile.${p}`) }}
                    </option>
                  </select>
                  <p class="profile-desc small text-muted mb-0 mt-1">
                    {{ t(`routes.brouter_profile.${routeStore.profile.value}_desc`) }}
                  </p>
                </li>
                <li><hr class="dropdown-divider"></li>
              </template>
              <template v-for="(g, gi) in menuGroups" :key="g.key">
                <li v-if="gi"><hr class="dropdown-divider"></li>
                <li v-if="g.label"><h6 class="dropdown-header">{{ g.label }}</h6></li>
                <li v-for="a in g.items" :key="a.key">
                  <a v-if="a.href" :href="a.href" class="dropdown-item d-flex align-items-center gap-2"
                    target="_blank" rel="noopener" @click="closeActionsDropdown">
                    <i :class="a.icon" aria-hidden="true"></i>
                    <span>{{ a.label }}</span>
                  </a>
                  <button v-else type="button" class="dropdown-item d-flex align-items-center gap-2"
                    v-bind="a.profileTrigger ? PROFILE_TRIGGER_ATTRS : {}"
                    :disabled="a.disabled" @click="a.run?.(); closeActionsDropdown()">
                    <span v-if="a.busy" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                    <i v-else :class="a.icon" aria-hidden="true"></i>
                    <span>{{ a.label }}</span>
                  </button>
                </li>
              </template>
            </ul>
          </div>
          <a v-if="editUrl" :href="editUrl" class="btn btn-sm btn-warning d-flex align-items-center gap-1">
            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
            <span class="d-none d-lg-inline">{{ t('routes.edit_route') }}</span>
          </a>
          <button v-if="!readOnly" type="button" class="btn btn-sm btn-warning d-flex align-items-center gap-1"
            @click="save" :disabled="saving || routeStore.waypoints.value.length < 2 || !routeStore.name.value.trim()">
            <span v-if="saving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
            <span>{{ t('routes.save') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Indicateur transitoire d'enregistrement réussi -->
    <Transition name="saved-toast">
      <div v-if="saved" class="saved-toast" role="status" aria-live="polite">
        <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
        <span>{{ t('routes.saved') }}</span>
      </div>
    </Transition>

    <!-- Main layout -->
    <div class="route-builder-main">

      <!-- Stats sidebar -->
      <RouteBuilderStats
        v-show="state.showStatsSidebar"
        :sidebar-width="sidebarWidth"
        @select-climb="onSelectClimb"
        @hover-climb="onHoverClimb"
        @select-place="onSelectPlace"
        @hover-place="onHoverPlace"
        @retry-places="fetchImportantPlaces"
      />

      <!-- Horizontal resize handle -->
      <div
        v-show="state.showStatsSidebar"
        class="resize-handle-h"
        role="separator"
        @mousedown="startResizeH"
      ></div>

      <!-- Right column: map + chart -->
      <div ref="rightColEl" class="route-builder-right">

        <!-- Map -->
        <div class="route-builder-map-wrap" :style="{ flex: (!isMobile && state.showElevationChart) ? mapFlex : 1 }">
          <RouteBuilderMap
            ref="mapRef"
            :state="state"
            @waypoints-changed="recomputeRoute()"
            @uturn-ok-changed="refreshTurnWarnings"
            @select-place="onSelectPlace"
            @hover-place="onHoverPlace"
            @retry-places="fetchImportantPlaces"
            @toggle-chart="state.showElevationChart = !state.showElevationChart; nextTick(() => mapRef?.resize())"
            @toggle-mobile-sheet="mobileSheetOpen = !mobileSheetOpen"
          >
            <template #overlays>
              <!-- Alertes du tracé, empilées en surimpression de la carte plutôt qu'en flux :
                   elles décaleraient sinon la carte sous le curseur. Calées à droite, sous la
                   rangée de contrôles du haut, pour ne rien couvrir. -->
              <div class="map-notices">
                <TransitionGroup name="map-notice">

                  <!-- Erreur (routage, altitude, enregistrement…) -->
                  <div v-if="routeStore.error.value && !errorDismissed" key="error" class="map-notice map-notice--danger" role="alert">
                    <div class="map-notice-header">
                      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                      <strong class="flex-grow-1">{{ routeStore.error.value }}</strong>
                      <button type="button" class="btn-close btn-close-sm" @click="errorDismissed = true"
                        :aria-label="t('routes.snap_warning_dismiss')"></button>
                    </div>
                  </div>

                  <!-- Points accrochés loin du clic (aucun chemin cartographié à proximité) -->
                  <div v-if="snapVisible" key="snap" class="map-notice map-notice--warning" role="status">
                    <div class="map-notice-header">
                      <i class="fa-solid fa-map-pin" aria-hidden="true"></i>
                      <strong class="flex-grow-1">{{ t('routes.snap_warning_title', { count: snapWarnings.length }) }}</strong>
                      <button type="button" class="btn-close btn-close-sm" @click="snapDismissed = true"
                        :aria-label="t('routes.snap_warning_dismiss')"></button>
                    </div>
                    <p class="map-notice-body">{{ t('routes.snap_warning_body') }}</p>
                    <div class="map-notice-chips">
                      <button v-for="s in snapWarnings" :key="s.idx" type="button" class="map-notice-chip"
                        @click="focusSnapWarning(s.idx)">
                        <i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>
                        {{ t('routes.snap_warning_item', { point: s.idx + 1, distance: formatDistancePrecise(s.distM) }) }}
                      </button>
                    </div>
                  </div>

                  <!-- Crochets : amas de virages / demi-tour (point mal placé) -->
                  <div v-if="turnVisible" key="turns" class="map-notice map-notice--danger" role="alert">
                    <div class="map-notice-header">
                      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                      <strong class="flex-grow-1">{{ t('routes.turn_warning_title') }}</strong>
                      <button type="button" class="btn-close btn-close-sm" @click="closeTurnWarning"
                        :aria-label="t('routes.turn_warning_dismiss')"></button>
                    </div>
                    <p class="map-notice-body">{{ t('routes.turn_warning_body') }}</p>
                    <div class="map-notice-chips">
                      <button v-for="(a, i) in turnWarnings" :key="i" type="button" class="map-notice-chip"
                        @click="focusTurnAnomaly(a)">
                        <i :class="a.kind === 'uturn' ? 'fa-solid fa-arrows-turn-to-dots' : 'fa-solid fa-location-crosshairs'"
                          aria-hidden="true"></i>
                        {{ turnWarningLabel(a) }}
                      </button>
                    </div>
                  </div>

                  <!-- Aucun repère posé : rappel informatif sur le rendu d'un lien partagé -->
                  <div v-if="noMarkersVisible" key="no-markers" class="map-notice map-notice--warning" role="status">
                    <div class="map-notice-header">
                      <i class="fa-solid fa-flag" aria-hidden="true"></i>
                      <strong class="flex-grow-1">{{ t('routes.no_markers_warning_title') }}</strong>
                      <button type="button" class="btn-close btn-close-sm" @click="noMarkersDismissed = true"
                        :aria-label="t('routes.snap_warning_dismiss')"></button>
                    </div>
                    <p class="map-notice-body">{{ t('routes.no_markers_warning_body') }}</p>
                  </div>

                  <!-- « Enregistrer quand même » : hors des alertes, car il vaut pour toutes
                       celles qui font barrage, pas seulement la dernière de la pile. -->
                  <div v-if="saveBlocked && (snapVisible || turnVisible || noMarkersVisible)" key="save-anyway" class="map-notice-actions">
                    <button type="button" class="btn btn-sm btn-warning shadow" :disabled="saving" @click="saveAnyway">
                      <span v-if="saving" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                      {{ t('routes.turn_warning_save_anyway') }}
                    </button>
                  </div>

                  <!-- Rappel des alertes repliées : seul vestige visible tant qu'elles ne sont
                       pas corrigées, sinon l'utilisateur perdrait l'info sans recours. -->
                  <button v-if="hiddenNoticeCount" key="reopen" type="button" class="map-notice-pill"
                    @click="reopenNotices" :title="t('routes.notices_reopen')">
                    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                    <span>{{ t('routes.notices_reopen_count', { count: hiddenNoticeCount }) }}</span>
                  </button>

                </TransitionGroup>
              </div>
            </template>
          </RouteBuilderMap>

        </div>

        <!-- Vertical resize handle (desktop only) -->
        <div
          v-if="!isMobile && state.showElevationChart"
          class="resize-handle"
          role="separator"
          @mousedown="startResize"
        ></div>

        <!-- Elevation chart (desktop only) -->
        <div
          v-if="!isMobile && state.showElevationChart"
          class="route-builder-chart-wrap"
          :style="{ flex: 1 - mapFlex }"
        >
          <RouteBuilderChart
            ref="chartRef"
            @fly-to="onChartFlyTo"
            @zoom-to="onChartZoomTo"
            @hover-end="onChartHoverEnd"
            @fit-to-selection="onChartFitToSelection"
            @open-selection-in-komoot="openSelectionInKomoot"
            @propose-alternatives="proposeAlternatives"
            @collapse="onChartCollapse"
          />
        </div>

      </div>
    </div>

    <!-- Mobile sheet -->
    <Transition name="mobile-sheet">
      <div v-if="mobileSheetOpen && isMobile" class="mobile-sheet" @click.self="mobileSheetOpen = false">
        <div class="mobile-sheet-panel" :style="{ height: mobileSheetHeight + 'px' }">
          <div class="mobile-sheet-handle" @touchstart.prevent="onSheetHandleTouchStart">
            <span class="mobile-sheet-grip"></span>
          </div>
          <div class="mobile-sheet-body">
          <RouteBuilderChart
            ref="chartRef"
            :simplified="true"
            @fly-to="onChartFlyTo"
            @zoom-to="onChartZoomTo"
            @hover-end="onChartHoverEnd"
            @fit-to-selection="onChartFitToSelection"
            @open-selection-in-komoot="openSelectionInKomoot"
            @propose-alternatives="proposeAlternatives"
            @collapse="mobileSheetOpen = false"
          />
          </div>
        </div>
      </div>
    </Transition>

    <!-- Dialogue des variantes de tronçon (carte dédiée + infobulles) -->
    <Transition name="modal">
      <RouteAlternativesDialog
        v-if="showAlternativesDialog"
        :alternatives="alternatives"
        :current-coords="altCurrentCoords"
        :map-style-id="state.mapStyleId"
        :loading="alternativesLoading"
        :error="alternativesError"
        @select="onSelectAlternative"
        @close="cancelAlternatives"
      />
    </Transition>

    <!-- Export image dialog -->
    <Transition name="modal">
      <div v-if="showExportDialog" class="modal-backdrop-custom" @click.self="showExportDialog = false">
        <div class="modal-dialog-custom shadow-lg">
          <div class="modal-header-custom">
            <strong>{{ t('routes.export_image') }}</strong>
            <button type="button" class="btn-close" @click="showExportDialog = false" aria-label="Fermer"></button>
          </div>
          <div class="modal-body-custom d-flex flex-column gap-3">
            <div>
              <label class="form-label small fw-semibold d-block">{{ t('routes.export_style') }}</label>
              <MapStyleDropdown v-model="exportStyleId" />
            </div>
            <div class="form-check">
              <input id="export-grade" v-model="exportShowGrade" type="checkbox" class="form-check-input" />
              <label for="export-grade" class="form-check-label small">{{ t('routes.export_grade_color') }}</label>
            </div>
            <div class="form-check">
              <input id="export-climbs" v-model="exportShowClimbs" type="checkbox" class="form-check-input" />
              <label for="export-climbs" class="form-check-label small">{{ t('routes.export_show_climbs') }}</label>
            </div>
            <div class="form-check">
              <input id="export-stats" v-model="exportShowStats" type="checkbox" class="form-check-input" />
              <label for="export-stats" class="form-check-label small">{{ t('routes.export_show_stats') }}</label>
            </div>
            <div class="form-check">
              <input id="export-chart" v-model="exportShowChart" type="checkbox" class="form-check-input" />
              <label for="export-chart" class="form-check-label small">{{ t('routes.export_show_chart') }}</label>
            </div>
            <div>
              <div class="d-flex justify-content-between align-items-baseline">
                <label for="export-resolution" class="form-label small fw-semibold mb-1">{{ t('routes.export_resolution') }}</label>
                <span class="small text-muted">
                  {{ exportResolutionPct }}%<template v-if="exportResolutionPct === 100"> · {{ t('routes.export_precision_max') }}</template>
                </span>
              </div>
              <input id="export-resolution" v-model.number="exportResolutionPct" type="range" class="form-range" min="25" max="100" step="5" />
              <div v-if="exportEstimate" class="small text-muted">
                {{ exportEstimate.cssW }} × {{ exportEstimate.cssH }} px · zoom {{ exportEstimate.tileZoom }}
              </div>
            </div>
            <button type="button" class="btn btn-warning" @click="exportImage" :disabled="exporting">
              <span v-if="exporting" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
              <i v-else class="fa-solid fa-download me-1" aria-hidden="true"></i>
              {{ t('routes.export_download') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ─── Page layout ─────────────────────────────────────────────────────────── */
.route-builder-page {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  /* Hauteur = viewport moins la navbar réelle (--rb-navbar-h, mesurée en JS) : un
     4rem figé faisait déborder la page de 3rem quand la navbar wrappe sur deux lignes
     (contrôles du bas coupés). Fallback 4rem avant la première mesure. */
  height: calc(100vh - var(--rb-navbar-h, 4rem));
  height: calc(100dvh - var(--rb-navbar-h, 4rem));
  padding: 0.5rem 0.75rem 0;
  gap: 0.5rem;
  overflow: hidden;
}
@media (max-width: 767px), (max-height: 500px) {
  .route-builder-page {
    padding: 0;
    gap: 0;
    /* La navbar mobile est plus basse que le `padding-top: 4rem` réservé sur le
       body : on remonte la page de l'écart mesuré (--rb-navbar-h, posé en JS) pour
       que la carte affleure sous la navbar, et on ajuste la hauteur en conséquence.
       En mode PWA standalone, --rb-available-h est posé par JS depuis
       window.visualViewport.height (hauteur réellement visible, hors barre maison
       et barre de geste Android) ; en navigateur classique, 100dvh s'applique. */
    margin-top: calc(var(--rb-navbar-h, 4rem) - 4rem);
    height: calc(var(--rb-available-h, 100dvh) - var(--rb-navbar-h, 4rem));
  }
  /* La poignée de redimensionnement du panneau stats n'a pas lieu d'être quand le
     panneau est masqué (mobile / paysage) : sinon elle laisse une colonne de 8px. */
  .resize-handle-h { display: none !important; }
}
@media (max-height: 500px) {
  .route-builder-header-card,
  .route-stats-sidebar { display: none !important; }
}

.route-builder-main {
  display: flex;
  align-items: stretch;
  gap: 0.75rem;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 767px) {
  .route-builder-main { gap: 0; }
  :deep(.route-stats-sidebar) { display: none !important; }
}

.route-builder-right {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.route-builder-map-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.route-builder-chart-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* ─── Resize handles ──────────────────────────────────────────────────────── */
.resize-handle {
  flex: 0 0 8px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  user-select: none;
}
.resize-handle::after {
  content: '';
  display: block;
  width: 48px;
  height: 4px;
  border-radius: 2px;
  background: #d1d5db;
  transition: background 0.15s;
}
.resize-handle:hover::after { background: #9ca3af; }

.resize-handle-h {
  flex: 0 0 8px;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  user-select: none;
}
.resize-handle-h::after {
  content: '';
  display: block;
  width: 4px;
  height: 48px;
  border-radius: 2px;
  background: #d1d5db;
  transition: background 0.15s;
}
.resize-handle-h:hover::after { background: #9ca3af; }

/* ─── Header ──────────────────────────────────────────────────────────────── */
.route-name-input { min-width: 0; font-weight: 600; }

/* Rappel du type d'activité, collé au début du nom. */
.route-sport-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 0.4rem;
  background: rgba(13, 110, 253, 0.1);
  color: var(--bs-primary);
}

/* Le menu d'actions loge les contrôles de type d'itinéraire : il lui faut de la
   largeur, sinon les libellés de sport et de profil sont à l'étroit. */
.route-actions-menu { min-width: 16rem; }
.route-actions-menu .profile-desc { white-space: normal; }

/* ─── Saved toast ─────────────────────────────────────────────────────────── */
.saved-toast {
  position: fixed;
  /* Sous la navbar réelle (--rb-navbar-h, mesurée en JS) : un offset fixe passerait
     dessous quand la navbar wrappe sur deux lignes avec beaucoup de menus. */
  top: calc(var(--rb-navbar-h, 4rem) + 0.5rem);
  left: 50%;
  transform: translateX(-50%);
  z-index: 1060;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 2rem;
  background: #198754;
  color: #fff;
  font-weight: 600;
  font-size: 0.9rem;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  pointer-events: none;
}
.saved-toast-enter-active, .saved-toast-leave-active { transition: opacity 0.25s, transform 0.25s; }
.saved-toast-enter-from, .saved-toast-leave-to { opacity: 0; transform: translate(-50%, -0.5rem); }

/* ─── Mobile sheet ────────────────────────────────────────────────────────── */
.mobile-sheet {
  position: fixed;
  inset: 0;
  z-index: 1040;
  display: flex;
  align-items: flex-end;
  background: rgba(0,0,0,0.25);
}
.mobile-sheet-panel {
  width: 100%;
  background: #fff;
  border-radius: 1rem 1rem 0 0;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.mobile-sheet-handle {
  display: flex;
  justify-content: center;
  padding: 0.65rem;
  flex-shrink: 0;
  cursor: ns-resize;
  touch-action: none;
}
.mobile-sheet-grip {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: #d1d5db;
  display: block;
}
.mobile-sheet-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}
.mobile-sheet-enter-active, .mobile-sheet-leave-active { transition: opacity 0.2s; }
.mobile-sheet-enter-from, .mobile-sheet-leave-to { opacity: 0; }

/* ─── Export dialog ────────────────────────────────────────────────────────── */
.modal-backdrop-custom {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-dialog-custom {
  background: #fff;
  border-radius: 0.75rem;
  width: min(440px, 96vw);
  overflow: hidden;
}
.modal-header-custom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid #e5e7eb;
}
.modal-body-custom { padding: 1.25rem; }

/* Modale des actions (téléphone) : entrées empilées en pleine largeur, cibles tactiles. */
.actions-modal-body { display: flex; flex-direction: column; gap: 0.25rem; }
.actions-modal-group {
  margin: 0.5rem 0 0.15rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #6b7280;
}
.actions-modal-group:first-child { margin-top: 0; }
.actions-modal-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.7rem 0.75rem;
  border: none;
  border-radius: 0.5rem;
  background: transparent;
  color: #1f2937;
  font-size: 0.95rem;
  text-align: left;
  text-decoration: none;
}
.actions-modal-item:hover:not(:disabled),
.actions-modal-item:active:not(:disabled) { background: #f3f4f6; }
.actions-modal-item:disabled { opacity: 0.5; }
.actions-modal-item > i { width: 1.25rem; text-align: center; }

.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }

/* ─── Alertes en surimpression de la carte ────────────────────────────────── */
/* Colonne calée sous la rangée de contrôles du haut (contrôles droite : top 56px) et
   entre les deux colonnes de boutons (34px de large + 10px de marge de chaque côté). */
/* Colonne calée à DROITE, sous la rangée de contrôles du haut. Le décalage de 54px la
   laisse passer à gauche de la colonne de boutons de droite (34px de large + 10px de
   marge), qui commence elle aussi à 56px. */
.map-notices {
  position: absolute;
  top: 56px;
  right: 54px;
  width: min(400px, calc(100% - 64px));
  /* Au-dessus de TOUT ce que porte la carte, `.wp-tooltip` (z-index 20) compris : une bulle
     ouverte près du bord recouvrirait sinon l'alerte. */
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: stretch;
  max-height: calc(100% - 76px);
  overflow-y: auto;
  pointer-events: none;
}
.map-notice {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}
.map-notice--warning {
  background: #fff8e6;
  border-color: #ffe08a;
  color: #664d03;
}
.map-notice--danger {
  background: #fef2f2;
  border-color: #fca5a5;
  color: #7f1d1d;
}
.map-notice-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.map-notice-body {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.85;
}
.map-notice-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.map-notice-chip {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
  color: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.12s;
}
.map-notice-chip:hover { background: #fff; }
.map-notice-actions {
  pointer-events: auto;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.btn-close-sm { --bs-btn-close-focus-shadow: none; padding: 0.25rem; background-size: 0.65em; }

/* Pastille de réouverture : discrète (elle vit en permanence sur la carte tant que
   l'alerte n'est pas corrigée) mais assez colorée pour rester repérable. */
.map-notice-pill {
  pointer-events: auto;
  align-self: flex-end;   /* la pastille reste compacte dans une pile désormais étirée */
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  border: 1px solid #fca5a5;
  border-radius: 999px;
  background: #fef2f2;
  color: #7f1d1d;
  font-size: 0.8rem;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: background 0.12s;
}
.map-notice-pill:hover { background: #fee2e2; }

.map-notice-enter-active,
.map-notice-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.map-notice-enter-from,
.map-notice-leave-to { opacity: 0; transform: translateY(-6px); }
.map-notice-leave-active { position: absolute; }

/* Sur mobile la carte est trop étroite pour une colonne de 400px calée à droite : les
   alertes reprennent toute la largeur, aux bords près. */
@media (max-width: 767px), (max-height: 500px) {
  .map-notices {
    left: 8px;
    right: 8px;
    top: 52px;
    width: auto;
  }
}
</style>
