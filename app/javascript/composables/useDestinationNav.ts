import { ref, computed, type Ref } from 'vue'
import { t } from '../i18n'
import { ROUTE_LINE_LAYOUT } from '../mapStyles'
import { buildDistancesM } from '../routeHelpers'
import type { Coord, LngLat, VoiceHint } from '../routeHelpers'
import { fetchRouteVia, stopInsertIndex } from '../navRoute'
import { buildDestPointPopupContent } from '../mapCoordPopup'
import { catalogDefaultForSport } from '../brouter'
import type { Sport } from '../userPreferences'
import type { PlaceResult } from './usePlaceSearch'

// Identifiants des couches d'aperçu, internes au sous-système : la couche `…-hit` est une
// bande transparente et large posée sous la ligne pointillée pour élargir la cible de tap.
const PREVIEW_SOURCE = 'nav-place-preview'
const PREVIEW_HIT_LAYER = 'nav-place-preview-hit'

export interface UseDestinationNavOptions {
  getMap: () => any
  getMaplibre: () => any
  /** Dernière position GPS connue : origine du trajet, donc rien n'est calculable sans elle. */
  getLastPos: () => LngLat | null
  /** Bandeau d'erreur de la séance, partagé avec les autres calculs BRouter du composant. */
  navError: Ref<string | null>
  // Sport, profil, nom et token DE LA SÉANCE : valeurs de départ du trajet en composition,
  // écrasées par les siennes au lancement du guidage.
  routeSport: Ref<Sport>
  routeProfile: Ref<string>
  routeName: Ref<string>
  routeToken: Ref<string | null>
  following: Ref<boolean>
  cameraUnlocked: Ref<boolean>
  /** Largeur de trait (expression MapLibre) de la ligne d'aperçu, calée sur celle du tracé. */
  lineWidthExpr: () => any
  /** Installe le trajet calculé comme tracé suivi (réinitialise tout le suivi). */
  applyReroute: (geometry: Coord[], hints: VoiceHint[]) => void
  /** Retient les étapes comme source de recalcul du tracé (un tel trajet n'en a pas d'autre). */
  setRouteVias: (vias: LngLat[]) => void
  persistSession: () => void
  hideControls: () => void
}

// Navigation vers un lieu choisi sur la carte (mode « cible »). Extrait de RouteNavigation.vue.
//
// On affiche une recherche (qui ne fait que recadrer la carte) et une consigne, puis chaque
// tap sur la carte pose un point d'étape numéroté et déplaçable. Un aperçu BRouter du trajet
// depuis la position GPS à travers ces points est retracé à chaque changement ; à la
// validation, ce même aperçu devient le tracé suivi (« ce que tu as vu est ce que tu auras »).
// Sert aussi au « Naviguer ici » d'un POI, qui court-circuite la composition (point unique).
export function useDestinationNav(opts: UseDestinationNavOptions) {
  const {
    getMap, getMaplibre, getLastPos, navError, routeSport, routeProfile, routeName,
    routeToken, following, cameraUnlocked, lineWidthExpr, applyReroute, setRouteVias,
    persistSession, hideControls,
  } = opts

  const placeNavActive = ref(false)
  // Points d'étape posés au tap avant de valider : la navigation passera par chacun
  // dans l'ordre, depuis la position GPS. Un seul point = destination directe.
  const destPoints = ref<LngLat[]>([])
  const destName = ref('')
  const navStarting = ref(false)
  // Sport et profil du trajet en cours de composition, ajustables dans le panneau de
  // destination pour ce seul trajet. Réamorcés sur ceux de la séance à chaque ouverture du
  // mode « cible » (cf. startPlaceNav), et reversés dans la séance au lancement du guidage.
  const navSport = ref<Sport>('cycling')
  const navProfile = ref<string>(catalogDefaultForSport('cycling'))
  // Aperçu du trajet BRouter à travers les points posés, recalculé à chaque ajout/retrait.
  // previewSeq sert de garde anti-désynchronisation : une réponse arrivée après un nouveau
  // changement de points est ignorée. previewResult est réutilisé tel quel à la validation
  // pour éviter un second appel BRouter.
  const previewLoading = ref(false)
  const previewDistM = ref<number | null>(null)
  let previewResult: { geometry: Coord[]; hints: VoiceHint[] } | null = null
  let previewSeq = 0

  // Marqueurs (numérotés) des points d'étape posés au tap, alignés sur destPoints.
  let destMarkers: any[] = []
  // Tooltip d'un point d'étape (clic sur son marqueur) : suppression, Google Maps,
  // Street View. Voir mapCoordPopup.
  let destPopup: any = null

  // Libellé du bouton de validation : « Naviguer ici » pour un point, « Naviguer (N
  // points) » dès qu'on a posé plusieurs étapes.
  const confirmLabel = computed(() =>
    destPoints.value.length > 1
      ? t('routes.navigate_via_points', { count: destPoints.value.length })
      : t('routes.navigate_here'),
  )

  // Sport et profil effectifs du prochain calcul BRouter : ceux du panneau de destination
  // pendant qu'on le compose, ceux de la séance partout ailleurs (« Naviguer ici » d'un POI).
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

  // ─── Aperçu du trajet ──────────────────────────────────────────────────────────

  // FeatureCollection (une LineString, ou vide) pour la source d'aperçu.
  function previewFC(coords: number[][]) {
    return {
      type: 'FeatureCollection' as const,
      features: coords.length >= 2
        ? [{ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} }]
        : [],
    }
  }

  // Crée à la demande la couche d'aperçu du trajet en mode « cible » (ligne pointillée,
  // semi-transparente). Indépendante des couches du tracé : en navigation libre, ces
  // dernières n'existent pas encore quand l'utilisateur pose ses premiers points.
  function ensurePlacePreviewLayer() {
    const map = getMap()
    if (!map || map.getSource(PREVIEW_SOURCE)) return
    map.addSource(PREVIEW_SOURCE, { type: 'geojson', data: previewFC([]) })
    // Couche de capture transparente et large : tapoter pile sur la ligne fine est
    // difficile (surtout au doigt), on élargit donc la cible de clic pour l'insertion.
    map.addLayer({
      id: PREVIEW_HIT_LAYER,
      type: 'line',
      source: PREVIEW_SOURCE,
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': '#000', 'line-opacity': 0.01, 'line-width': 26 },
    })
    map.addLayer({
      id: PREVIEW_SOURCE,
      type: 'line',
      source: PREVIEW_SOURCE,
      layout: ROUTE_LINE_LAYOUT,
      paint: {
        'line-color': '#2563eb',
        'line-width': lineWidthExpr(),
        'line-opacity': 0.55,
        'line-dasharray': [1.4, 1.1],
      },
    })
  }

  // Repeint la ligne d'aperçu aux réglages du sport courant (largeur du tracé) : appelé
  // avec les couches du tracé, quand le sport de la séance change en cours de composition.
  function applyPreviewLinePaint() {
    const map = getMap()
    if (map?.getLayer(PREVIEW_SOURCE)) map.setPaintProperty(PREVIEW_SOURCE, 'line-width', lineWidthExpr())
  }

  function setPreviewData(coords: number[][]) {
    const src = getMap()?.getSource(PREVIEW_SOURCE) as any
    if (src) src.setData(previewFC(coords))
  }

  // Efface l'aperçu (ligne + état) et invalide toute réponse BRouter encore en vol.
  function clearPlacePreview() {
    previewSeq++
    previewResult = null
    previewLoading.value = false
    previewDistM.value = null
    setPreviewData([])
  }

  // Recalcule l'aperçu du trajet à travers les points posés (depuis la position GPS).
  // Appelé à chaque ajout/retrait de point. La garde previewSeq écarte les réponses
  // devenues obsolètes (un point posé/retiré pendant le calcul).
  async function updatePlacePreview() {
    if (!getMap()) return
    ensurePlacePreviewLayer()
    const pts = destPoints.value.slice()
    const lastPos = getLastPos()
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
      setPreviewData(result.geometry.map(([lng, lat]) => [lng, lat]))
    } catch {
      if (seq !== previewSeq) return
      previewResult = null
      previewDistM.value = null
      setPreviewData([])
    } finally {
      if (seq === previewSeq) previewLoading.value = false
    }
  }

  // ─── Points d'étape ────────────────────────────────────────────────────────────

  // Recadre la carte sur le lieu recherché (sans fixer de destination) : l'utilisateur
  // ajuste ensuite la vue et touche le point exact. Repris de RouteBuilderMap.pickPlace.
  function onLocate(p: PlaceResult) {
    destName.value = p.display_name.split(',')[0]
    const map = getMap()
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
    const map = getMap()
    const maplibre = getMaplibre()
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
    const marker = new (getMaplibre()).Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat(lngLat).addTo(getMap())
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
    if (!getMap() || !getMaplibre()) return
    destMarkers.push(makeDestMarker(lngLat))
    renumberDestMarkers()
    updatePlacePreview()
  }

  // Insère un point d'étape à une position donnée de la séquence (tap sur le trajet).
  function insertDestPoint(index: number, lngLat: LngLat) {
    navError.value = null
    if (!getMap() || !getMaplibre()) { destPoints.value.splice(index, 0, lngLat); return }
    destPoints.value.splice(index, 0, lngLat)
    destMarkers.splice(index, 0, makeDestMarker(lngLat))
    renumberDestMarkers()
    updatePlacePreview()
  }

  // Tap sur le trajet d'aperçu : insère un point au bon rang de la séquence (entre les
  // deux étapes que ce tronçon relie) plutôt que de l'ajouter en fin — cf. stopInsertIndex.
  function insertDestPointOnLine(lngLat: LngLat) {
    const lastPos = getLastPos()
    if (!previewResult || !lastPos) { addDestPoint(lngLat); return }
    insertDestPoint(stopInsertIndex(previewResult.geometry, lastPos, destPoints.value, lngLat), lngLat)
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

  // Tap sur la carte en mode « cible » : le tap pose un point d'étape au lieu de mettre en
  // veille. Tooltip d'un point ouverte → un tap ailleurs la referme d'abord. Tap SUR le
  // trajet d'aperçu → insertion au bon rang ; sinon ajout en fin de séquence. Renvoie vrai
  // si le tap a été consommé (le composant n'a alors plus rien à en faire).
  function handleMapTap(point: any, lngLat: LngLat): boolean {
    if (!placeNavActive.value) return false
    if (destPopup) { closeDestPopup(); return true }
    const map = getMap()
    const onLine = map?.getLayer(PREVIEW_HIT_LAYER)
      ? map.queryRenderedFeatures(point, { layers: [PREVIEW_HIT_LAYER] })
      : []
    if (onLine.length) insertDestPointOnLine(lngLat)
    else addDestPoint(lngLat)
    return true
  }

  // ─── Lancement du guidage ──────────────────────────────────────────────────────

  // Itinéraire BRouter depuis la position GPS, passant par une suite de points d'étape
  // (au moins un), qui remplace le tracé courant (applyReroute réinitialise tout le
  // suivi). Cœur partagé entre la destination choisie sur la carte (« Naviguer ici »,
  // éventuellement avec plusieurs étapes) et un POI tapé sur la carte (point unique).
  async function navigateVia(name: string, vias: LngLat[], precomputed?: { geometry: Coord[]; hints: VoiceHint[] }) {
    const lastPos = getLastPos()
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
      setRouteVias(vias.slice())
      // Réécrit la session : applyReroute l'a déjà persistée, mais sans les étapes ni le
      // nom définitifs de cette destination.
      persistSession()
      cancelPlaceNav()
      following.value = true
      cameraUnlocked.value = false
    } catch {
      navError.value = t('routes.error_routing')
    } finally {
      navStarting.value = false
    }
  }

  // « Naviguer ici » depuis un POI : trajet direct vers un point unique. La promesse est
  // rendue (et non avalée) pour que l'appelant puisse attendre le lancement.
  function navigateTo(name: string, dest: LngLat) {
    return navigateVia(name, [dest])
  }

  // Lance la navigation par les points d'étape posés sur la carte (un ou plusieurs).
  function confirmPlaceNav() {
    if (destPoints.value.length === 0) return
    return navigateVia(destName.value, destPoints.value, previewResult ?? undefined)
  }

  return {
    placeNavActive, destPoints, navSport, navProfile, navStarting,
    previewLoading, previewDistM, confirmLabel,
    startPlaceNav, cancelPlaceNav, confirmPlaceNav, applyNavRouting, onLocate,
    removeLastDestPoint, handleMapTap, applyPreviewLinePaint, navigateTo,
  }
}
