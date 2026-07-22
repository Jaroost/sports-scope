<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, useTemplateRef, nextTick } from 'vue'
import { t } from '../i18n'
import {
  mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT,
  MAP_OVERLAYS, overlaySource, overlaySourceId, overlayLayerId,
} from '../mapStyles'
import { RouteBuilderState } from '../pageState'
import MapStyleDropdown from './MapStyleDropdown.vue'
import { routeStore, MAX_WAYPOINTS } from '../stores/routeStore'
import { persistDefaultMapStyle, persistOverlays, sportPreferences, userPreferences } from '../userPreferences'
import type { MapStyleId } from '../userPreferences'
import { selectionStore } from '../stores/selectionStore'
import { placesStore } from '../stores/placesStore'
import type { Place } from '../stores/placesStore'
import { savedPoisStore } from '../stores/savedPoisStore'
import type { SavedPoi } from '../savedPois'
import { categoryForType, POI_CATEGORIES } from '../poiCategories'
import { MARKER_KINDS, markerMeta, markerKindLabel } from '../routeMarkers'
import type { MarkerKind } from '../routeMarkers'
import {
  GRADE_BUCKETS, haversine, buildGradedSegments, geomIdxForKm, generateCircle,
  streetViewUrl, bearingFromRoute, bearingAlongRoute, simplifyTrack,
} from '../routeHelpers'
import type { Climb, Coord, LngLat } from '../routeHelpers'
import { buildCoordPopupContent, attachLongPress } from '../mapCoordPopup'

const props = defineProps<{ state: RouteBuilderState }>()
const emit = defineEmits<{
  'waypoints-changed': []
  'uturn-ok-changed': []
  'select-place': [place: Place]
  'hover-place': [place: Place | null]
  'retry-places': []
  'toggle-chart': []
  'toggle-mobile-sheet': []
}>()

const mapEl = useTemplateRef('mapEl')

// Couleur (hors mode pente), opacité et épaisseur du tracé, réglables PAR SPORT dans le
// profil. L'opacité s'applique dans tous les modes ; la couleur ne sert qu'en mode uni
// (le mode pente garde son dégradé). L'épaisseur sert de base aux largeurs des couches
// du tracé : bordure, ligne, tronçons libres et sélection s'en déduisent pour rester
// proportionnés (cf. routeLineBaseWidths). Relus à chaque changement de sport, d'où des
// fonctions plutôt que des constantes.
function routePrefs() {
  return sportPreferences(routeStore.sport.value).route
}

// Icône FontAwesome du sport courant (même logique que la sidebar Stats).
function sportIcon() {
  const s = routeStore.sport.value
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

let mapInstance: any = null
let _maplibregl: any = null
const waypointMarkers: any[] = []
let hoverMarker: any = null
// Point d'insertion sous le curseur, projeté sur l'arête du tracé (pas snappé au sommet).
// Mémorisé au survol pour que le clic insère exactement sous le « + », et non sur le
// sommet de géométrie le plus proche (qui sautait « par grille » sur les tronçons droits).
let hoverInsert: { lng: number; lat: number; edgeIdx: number } | null = null
let locationMarker: any = null
let lastLocationCoords: [number, number] | null = null
let lastLocationAccuracy = 0
const locationVisible = ref(false)
const locating = ref(false)
const hoverMarkerVisible = ref(false)
let suppressNextMapClick = false
let suppressNextWpClick = false
let overClimbMarker = false
const divergentMarkers: any[] = []
let chartCrossMarker: any = null
let selectionMarkerA: any = null
let selectionMarkerB: any = null
let selectionMarkerAKm: number | null = null
let selectionMarkerBKm: number | null = null
let selectionMarkerDragging = false
const climbMarkers: any[] = []
const climbMarkerObservers: MutationObserver[] = []
const turnAnomalyMarkers: any[] = []
const snapMarkers: any[] = []
const placeMarkers: any[] = []
const placeMarkerObservers: MutationObserver[] = []
// Permet de retrouver l'élément DOM d'un POI à partir de ses coordonnées, pour
// surligner le bon marqueur au survol (depuis la carte ou la liste latérale).
const placeMarkerEls = new Map<string, HTMLElement>()
// ── POI sauvegardés (table `pois`, globaux à l'utilisateur) ──────────────────
// Marqueurs persistants distincts des POI Overpass : posés à la main ou épinglés,
// rendus en permanence (indépendamment d'une recherche Overpass). Badge étoile pour
// les distinguer ; clic → popup renommer/supprimer.
const savedPoiMarkers: any[] = []
const savedPoiMarkerObservers: MutationObserver[] = []
let savedPoiPopup: any = null
// Mode d'édition courant, piloté par le dropdown « Mode d'édition » (hors lecture
// seule) : 'route' modifie le tracé au clic, 'poi' pose un POI, 'marker' pose un
// repère. Par défaut on édite l'itinéraire.
type EditMode = 'route' | 'poi' | 'marker'
const editMode = ref<EditMode>('route')
// Dérivés conservés pour les gardes de clic/survol de la carte.
const placePoiMode = computed(() => editMode.value === 'poi')
const placeMarkerMode = computed(() => editMode.value === 'marker')
// Dialogue de création d'un POI (nom + catégorie) ouvert au clic en mode « poser ».
const poiDialog = ref<{ lng: number; lat: number; name: string; category: string } | null>(null)
const POI_CATS = POI_CATEGORIES

// ── Repères d'itinéraire (départ / arrivée / parking) ────────────────────────
// Posés à la main et enregistrés avec l'itinéraire (routeStore.markers). Rendus en
// permanence, déplaçables, éditables via popup. Distincts des POI (cf. routeMarkers.ts).
const MARKER_KIND_LIST = MARKER_KINDS
const routeMarkerObjs: any[] = []
const routeMarkerObservers: MutationObserver[] = []
let routeMarkerPopup: any = null
// Dialogue de création d'un repère (type + libellé optionnel).
const markerDialog = ref<{ lng: number; lat: number; kind: MarkerKind; label: string } | null>(null)

// Dropdown ouvert dans la toolbar de la carte, ou null. Un seul à la fois : ouvrir
// un dropdown (style de carte / « Affichage » / « Mode d'édition ») ferme l'autre.
// 'style' est piloté par MapStyleDropdown via v-model:open.
const openMenu = ref<'style' | 'display' | 'edit' | null>(null)
const EDIT_MODES: Array<{ mode: EditMode; icon: string; labelKey: string }> = [
  { mode: 'route',  icon: 'fa-route',            labelKey: 'routes.edit_mode_route' },
  { mode: 'poi',    icon: 'fa-map-location-dot', labelKey: 'routes.edit_mode_poi' },
  { mode: 'marker', icon: 'fa-signs-post',       labelKey: 'routes.edit_mode_marker' },
]
const currentEditMode = computed(() => EDIT_MODES.find((m) => m.mode === editMode.value) ?? EDIT_MODES[0])
let hoveredPlaceEl: HTMLElement | null = null
let selectedPlaceEl: HTMLElement | null = null
let placePopup: any = null
// Popup informatif d'un point quelconque du tracé (lecture seule) : mêmes liens
// qu'un point d'itinéraire (coordonnées, Google Maps, Street View, Komoot).
let routePointPopup: any = null
// Popup d'un point quelconque de la carte (clic droit / appui long n'importe où) :
// coordonnées copiables, Google Maps, Street View. Voir mapCoordPopup.
let coordPopup: any = null
let detachLongPress: (() => void) | null = null
let waypointGeomIndices: number[] = []
let selectedWpIdx = -1
const svCache = new Map<string, boolean>()

const searchQuery = ref('')
const searchResults = ref<any[]>([])
const searchOpen = ref(false)
const searching = ref(false)
const searchExpanded = ref(false)
const searchInputEl = useTemplateRef('searchInputEl')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

// ─── Utils ────────────────────────────────────────────────────────────────────

function getInitialView(skip: boolean) {
  if (skip) return { center: [2.35, 48.85], zoom: 6 }
  try {
    const raw = localStorage.getItem('sportsScope.routeBuilderView')
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v.center) && v.center.length === 2 && typeof v.zoom === 'number') return v
    }
  } catch { /* ignore */ }
  return { center: [2.35, 46.6], zoom: 5 }
}

function saveMapView() {
  if (!mapInstance) return
  try {
    const c = mapInstance.getCenter()
    localStorage.setItem('sportsScope.routeBuilderView', JSON.stringify({ center: [c.lng, c.lat], zoom: mapInstance.getZoom() }))
  } catch { /* ignore */ }
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

function flagSvg(kind: 'start' | 'end') {
  if (kind === 'start') {
    return `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
      <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
      <path d="M4 4 L24 4 L24 18 L4 18 Z" fill="#22c55e" stroke="#15803d" stroke-width="1"/>
    </svg>`
  }
  const cells = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = 4 + col * 5, y = 4 + row * 5
      const dark = (row + col) % 2 === 0
      cells.push(`<rect x="${x}" y="${y}" width="5" height="5" fill="${dark ? '#ef4444' : '#ffffff'}"/>`)
    }
  }
  return `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
    <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
    <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
    <rect x="4" y="4" width="20" height="15" fill="none" stroke="#7f1d1d" stroke-width="1"/>
    ${cells.join('')}
  </svg>`
}

// Chevron blanc (cerné de noir translucide pour rester lisible sur tout fond de
// tracé) pointant vers la droite. La couche symbole le fait pivoter pour l'aligner
// sur le sens de la ligne, indiquant ainsi le sens de parcours.
function buildArrowImage(size = 28): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const draw = () => {
    ctx.beginPath()
    ctx.moveTo(size * 0.34, size * 0.24)
    ctx.lineTo(size * 0.7, size * 0.5)
    ctx.lineTo(size * 0.34, size * 0.76)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'
  ctx.lineWidth = size * 0.22
  draw()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = size * 0.12
  draw()
  return ctx.getImageData(0, 0, size, size)
}

// ─── Grade paint ──────────────────────────────────────────────────────────────

function gradePaintExpression() {
  return [
    'match', ['coalesce', ['get', 'bucket'], -1],
    0, GRADE_BUCKETS[0].color, 1, GRADE_BUCKETS[1].color, 2, GRADE_BUCKETS[2].color,
    3, GRADE_BUCKETS[3].color, 4, GRADE_BUCKETS[4].color, 5, GRADE_BUCKETS[5].color,
    6, GRADE_BUCKETS[6].color, '#fc4c02',
  ]
}

// ─── Map init ─────────────────────────────────────────────────────────────────

async function initMap() {
  if (!mapEl.value) return
  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')
  _maplibregl = maplibregl
  const { center, zoom } = getInitialView(!!routeStore.currentId.value)
  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(props.state.mapStyleId) as any,
    center,
    zoom,
    // On désactive l'attribution par défaut (étalée « MapLibre | swisstopo ») pour la
    // remplacer par sa version compacte : juste une icône ⓘ qu'on déplie d'un clic.
    attributionControl: false,
    ...({ preserveDrawingBuffer: true } as any),
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showZoom: false }), 'top-right')
  mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }))
  mapInstance.on('styleimagemissing', (e: any) => {
    mapInstance.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  await new Promise<void>((resolve) => {
    mapInstance.on('load', () => {
      installRouteLayer()
      installOverlays()
      mapInstance.on('click', (e: any) => {
        if (suppressNextMapClick) { suppressNextMapClick = false; return }
        // Tooltip « point quelconque » (clic droit / appui long) ouverte : un clic ne
        // fait que la refermer, sans ajouter de point au tracé.
        if (coordPopup) { closeCoordPopup(); return }
        // Mode « poser un POI » : le clic ouvre le dialogue de création d'un POI
        // sauvegardé au point cliqué, sans toucher au tracé.
        if (placePoiMode.value && !routeStore.readOnly.value) {
          // Calque POI masqué : les POI sont invisibles, le mode est inerte.
          if (!props.state.showPois) return
          if (savedPoiPopup) closeSavedPoiPopup()
          openPoiDialog(e.lngLat.lng, e.lngLat.lat)
          return
        }
        // Mode « poser un repère » : le clic ouvre le dialogue de création (type +
        // libellé) au point cliqué, sans toucher au tracé.
        if (placeMarkerMode.value && !routeStore.readOnly.value) {
          // Calque repères masqué : les repères sont invisibles, le mode est inerte.
          if (!props.state.showMarkers) return
          if (routeMarkerPopup) closeRouteMarkerPopup()
          openMarkerDialog(e.lngLat.lng, e.lngLat.lat)
          return
        }
        // Lecture seule : le clic ne modifie jamais le tracé. Il referme une tooltip
        // ouverte (POI ou point du trajet), ou — si l'on clique sur le tracé — ouvre
        // une tooltip informative sur le point du trajet le plus proche.
        if (routeStore.readOnly.value) {
          if (placePopup) { closePlacePopup(); return }
          if (savedPoiPopup) { closeSavedPoiPopup(); return }
          if (routeMarkerPopup) { closeRouteMarkerPopup(); return }
          if (routePointPopup) { closeRoutePointPopup(); return }
          const idx = nearestGeomIndexAt(e.point)
          if (idx != null) {
            const [lng, lat] = routeStore.geometry.value[idx]
            showRoutePointPopup(lng, lat)
          }
          return
        }
        // Tooltip de POI (cimetière/boulangerie) ouverte : le clic ne fait que la
        // refermer, sans ajouter de point au trajet.
        if (placePopup) { closePlacePopup(); return }
        // Popup d'un POI sauvegardé ouvert : le clic ne fait que le refermer.
        if (savedPoiPopup) { closeSavedPoiPopup(); return }
        // Popup d'un repère ouvert : le clic ne fait que le refermer.
        if (routeMarkerPopup) { closeRouteMarkerPopup(); return }
        // Un point sélectionné (tooltip ouverte) : le clic ne fait que refermer la
        // tooltip, sans ajouter de nouveau point au trajet.
        if (selectedWpIdx >= 0) { deselectAll(); return }
        // Col épinglé : le clic désélectionne sans ajouter de point au trajet.
        if (selectionStore.selectionPinned.value) {
          selectionStore.selectionRange.value = null
          selectionStore.selectionPinned.value = false
          updateSelectionLayer()
          return
        }
        deselectAll()
        // Calque « Points de passage » masqué : puisque les points ne sont pas
        // visibles, un clic sur la carte ne doit rien faire (pas d'ajout au tracé).
        if (!props.state.showWaypoints) return
        if (hoverInsert) {
          insertWaypointAtHover(hoverInsert)
        } else {
          addWaypoint(e.lngLat.lng, e.lngLat.lat)
        }
      })
      mapInstance.on('mousemove', (e: any) => {
        // Mode « poser un POI/repère » : pas de marqueur d'insertion de point sur le
        // tracé. Curseur viseur seulement si le calque correspondant est visible ;
        // sinon le mode est inerte (rien ne se pose au clic) et rien ne le suggère.
        if ((placePoiMode.value || placeMarkerMode.value) && !routeStore.readOnly.value) {
          hideHoverMarker()
          const layerShown = placePoiMode.value ? props.state.showPois : props.state.showMarkers
          mapInstance.getCanvas().style.cursor = layerShown ? 'crosshair' : ''
          return
        }
        if (routeStore.readOnly.value) {
          hideHoverMarker()
          // Curseur « pointer » au survol du tracé pour signaler qu'il est cliquable.
          mapInstance.getCanvas().style.cursor = nearestGeomIndexAt(e.point) != null ? 'pointer' : ''
          return
        }
        if (overClimbMarker) { hideHoverMarker(); return }
        // Calque « Points de passage » masqué : aucun ajout possible, donc pas de
        // marqueur d'insertion au survol du tracé qui le suggérerait.
        if (!props.state.showWaypoints) { hideHoverMarker(); return }
        if (routeStore.waypoints.value.length < 2) { hideHoverMarker(); return }
        const hit = nearestPointOnRouteAt(e.point)
        if (hit == null) { hideHoverMarker(); return }
        if (isNearWaypoint(e.point)) { hideHoverMarker(); return }
        selectionStore.hoverIdx.value = hit.vertexIdx
        hoverInsert = { lng: hit.lng, lat: hit.lat, edgeIdx: hit.edgeIdx }
        showHoverMarker([hit.lng, hit.lat])
      })
      mapInstance.on('mouseout', hideHoverMarker)
      // Clic droit (ordinateur) n'importe où : tooltip coordonnées / Google Maps / Street View.
      mapInstance.on('contextmenu', (e: any) => {
        e.preventDefault?.()
        showCoordPopup(e.lngLat.lng, e.lngLat.lat, e.point)
      })
      // Appui long (mobile) : même tooltip. On supprime le clic synthétique de relâchement
      // pour qu'il n'ajoute pas un point au tracé (suppressNextMapClick), avec garde temporelle
      // au cas où aucun clic ne serait émis. Voir attachLongPress.
      detachLongPress = attachLongPress(mapInstance.getCanvas(), (clientX, clientY) => {
        const rect = mapInstance.getContainer().getBoundingClientRect()
        const px = { x: clientX - rect.left, y: clientY - rect.top }
        const ll = mapInstance.unproject([px.x, px.y])
        showCoordPopup(ll.lng, ll.lat, px)
        suppressNextMapClick = true
        suppressNextWpClick = true
        setTimeout(() => { suppressNextMapClick = false; suppressNextWpClick = false }, 500)
      })
      mapInstance.on('moveend', () => { if (!routeStore.currentId.value) saveMapView() })
      const applyMarkerScale = () => {
        const z = mapInstance.getZoom()
        const scale = Math.max(0.35, Math.min(1, (z - 5) / 9))
        mapInstance.getContainer().style.setProperty('--wp-scale', String(scale))
      }
      mapInstance.on('zoom', applyMarkerScale)
      applyMarkerScale()
      // En lecture seule, pas de curseur « crosshair » qui suggérerait l'ajout de points.
      mapInstance.getCanvas().style.cursor = routeStore.readOnly.value ? '' : 'crosshair'
      // POI sauvegardés de l'utilisateur : chargés une fois, rendus en permanence.
      void savedPoisStore.load().then(() => installSavedPoiMarkers())
      // Repères de l'itinéraire (déjà chargés si l'on rouvre un itinéraire existant).
      installRouteMarkers()
      resolve()
    })
  })
}

// ─── Route layers ─────────────────────────────────────────────────────────────

function installRouteLayer() {
  if (!mapInstance) return
  if (!mapInstance.getSource('builder-route')) {
    mapInstance.addSource('builder-route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
  }
  if (!mapInstance.getSource('builder-route-graded')) {
    mapInstance.addSource('builder-route-graded', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    mapInstance.addLayer({ id: 'builder-route-border', type: 'line', source: 'builder-route-graded', layout: ROUTE_LINE_LAYOUT, paint: ROUTE_BORDER_PAINT })
    mapInstance.addLayer({ id: 'builder-route-line', type: 'line', source: 'builder-route-graded', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': gradePaintExpression(), 'line-width': 5, 'line-opacity': routePrefs().opacity } })
  }
  // Tronçons « libres » : tracés en ligne droite (beeline) entre points, rendus en
  // traitillé pour les distinguer du tracé routé. La géométrie droite est exclue de
  // la source graduée (applyColorMode) pour que le pointillé reste lisible.
  if (!mapInstance.getSource('builder-route-straight')) {
    mapInstance.addSource('builder-route-straight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    mapInstance.addLayer({ id: 'builder-route-straight-line', type: 'line', source: 'builder-route-straight', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': routePrefs().color, 'line-width': 4, 'line-dasharray': [1.6, 1.4], 'line-opacity': routePrefs().opacity } })
  }
  if (!mapInstance.getSource('builder-divergent')) {
    mapInstance.addSource('builder-divergent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    mapInstance.addLayer({ id: 'builder-divergent-line', type: 'line', source: 'builder-divergent', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#d62828', 'line-width': 4, 'line-dasharray': [1.4, 1.4] } })
  }
  if (!mapInstance.getSource('builder-route-selected')) {
    mapInstance.addSource('builder-route-selected', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
    mapInstance.addLayer({ id: 'builder-route-selected-line', type: 'line', source: 'builder-route-selected', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#00b4d8', 'line-width': 7 } })
  }
  // Flèches de sens de parcours : espacées en pixels écran (constantes au zoom) et
  // posées au-dessus du tracé, sur la géométrie continue de `builder-route`.
  if (!mapInstance.hasImage('route-arrow')) {
    mapInstance.addImage('route-arrow', buildArrowImage(28), { pixelRatio: 2 })
  }
  if (!mapInstance.getLayer('builder-route-arrows')) {
    mapInstance.addLayer({
      id: 'builder-route-arrows',
      type: 'symbol',
      source: 'builder-route',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 90,
        'icon-image': 'route-arrow',
        'icon-size': 0.85,
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
  }
  // Applique l'échelle d'affichage (élargissement mobile) aux largeurs natives ci-dessus.
  setRouteLineScale(1)
}

// Épaisseurs natives (px écran) des couches de tracé. Utilisé par l'export image pour
// élargir le tracé proportionnellement à la résolution, sinon il devient invisible.
function routeLineBaseWidths(): Record<string, number> {
  const width = routePrefs().width
  return {
    'builder-route-border': width + 3,
    'builder-route-line': width,
    'builder-route-straight-line': Math.max(2, width - 1),
    'builder-route-selected-line': width + 2,
    'builder-divergent-line': 4,
  }
}
// Sur petit écran tactile, on élargit légèrement le tracé pour offrir une cible de clic
// plus généreuse (insertion de point sur la ligne) et éviter les clics au mauvais endroit.
const ROUTE_LINE_DISPLAY_SCALE = window.matchMedia('(max-width: 767px), (max-height: 500px)').matches ? 1.3 : 1
function setRouteLineScale(factor: number) {
  if (!mapInstance) return
  // factor === 1 = état d'affichage par défaut (à l'init et après un export) : on applique
  // l'élargissement mobile. Tout autre facteur vient de l'export (mise à l'échelle selon la
  // résolution de sortie) et doit rester identique sur mobile et PC — pas de boost mobile.
  const eff = factor === 1 ? ROUTE_LINE_DISPLAY_SCALE : factor
  for (const [id, base] of Object.entries(routeLineBaseWidths())) {
    if (mapInstance.getLayer(id)) mapInstance.setPaintProperty(id, 'line-width', base * eff)
  }
}

function updateRouteLayer() {
  if (!mapInstance) return
  // Le tracé a changé : une éventuelle tooltip de point du trajet pointe désormais
  // sur une géométrie obsolète, on la referme.
  closeRoutePointPopup()
  const baseSrc = mapInstance.getSource('builder-route')
  if (baseSrc) {
    baseSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeStore.geometry.value.map(([lng, lat]) => [lng, lat]) } })
  }
  // Tient selectionStore.cumDistKm à jour même quand le chart n'est pas monté (mobile).
  const geom = routeStore.geometry.value
  if (geom.length >= 2) {
    const cumDistKm = [0]
    let d = 0
    for (let i = 1; i < geom.length; i++) { d += haversine(geom[i - 1], geom[i]); cumDistKm.push(d / 1000) }
    selectionStore.cumDistKm = cumDistKm
  } else {
    selectionStore.cumDistKm = []
  }
  applyColorMode()
}

// Pour chaque arête j (geom[j] → geom[j+1]), renvoie true si elle appartient à un
// tronçon « libre » (ligne droite entre un point et le point libre qui le suit). On se
// base sur les index géométriques des waypoints, alignés sur la règle de routage de
// recomputeRoute : le tronçon i (waypoint[i] → waypoint[i+1]) est droit ssi waypoint[i+1]
// est libre.
function straightEdgeFlags(): boolean[] {
  const geom = routeStore.geometry.value
  const flags = new Array(Math.max(0, geom.length - 1)).fill(false)
  const wps = routeStore.waypoints.value
  // Sans index à jour (longueur incohérente), on retombe sur un tracé entièrement plein.
  if (geom.length < 2 || waypointGeomIndices.length !== wps.length) return flags
  for (let i = 0; i < wps.length - 1; i++) {
    if (!wps[i + 1]?.free) continue
    const a = waypointGeomIndices[i]
    const b = waypointGeomIndices[i + 1]
    if (a == null || b == null) continue
    const lo = Math.min(a, b), hi = Math.max(a, b)
    for (let j = lo; j < hi; j++) flags[j] = true
  }
  return flags
}

function applyColorMode() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-route-graded')
  const straightSrc = mapInstance.getSource('builder-route-straight')
  if (!src) return
  const geom = routeStore.geometry.value
  const coords: LngLat[] = geom.map((c) => [c[0], c[1]])
  const gradeMode = props.state.colorMode === 'grade'
  const routedFeatures: any[] = []
  const straightFeatures: any[] = []
  let paint: any = routePrefs().color

  if (coords.length >= 2) {
    if (gradeMode) paint = gradePaintExpression()
    const flags = straightEdgeFlags()
    const altitudes = geom.map((c) => c[2])
    const distances = [0]
    for (let i = 1; i < geom.length; i++) distances.push(distances[i - 1] + haversine(geom[i - 1], geom[i]))

    // Découpe la géométrie en runs contigus de même nature (droit / routé). Les arêtes
    // [j, k) couvrent les sommets j..k.
    let j = 0
    while (j < flags.length) {
      const isStraight = flags[j]
      let k = j
      while (k < flags.length && flags[k] === isStraight) k++
      const sub = coords.slice(j, k + 1)
      if (sub.length >= 2) {
        // En mode pente, les tronçons libres sont aussi colorés : leur altitude est
        // interpolée le long de la ligne droite (open-meteo), la pente y est donc exploitable.
        const target = isStraight ? straightFeatures : routedFeatures
        if (gradeMode) {
          target.push(...buildGradedSegments(sub, altitudes.slice(j, k + 1), distances.slice(j, k + 1)))
        } else {
          target.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub }, properties: {} })
        }
      }
      j = k
    }
  }

  src.setData({ type: 'FeatureCollection', features: routedFeatures })
  if (straightSrc) straightSrc.setData({ type: 'FeatureCollection', features: straightFeatures })
  if (mapInstance.getLayer('builder-route-line')) mapInstance.setPaintProperty('builder-route-line', 'line-color', paint)
  // Le traitillé suit le même code couleur que la ligne pleine en mode pente.
  if (mapInstance.getLayer('builder-route-straight-line')) mapInstance.setPaintProperty('builder-route-straight-line', 'line-color', paint)
}

// ─── Alternatives de tronçon ──────────────────────────────────────────────────
// La comparaison/choix des variantes se fait dans RouteAlternativesDialog (carte
// dédiée) ; ici on ne conserve que l'application de la variante retenue au tracé.

// Remplace la portion du tracé entre les index géométrie lo..hi par la variante
// choisie : on retire les waypoints intérieurs, on ancre les deux extrémités (en
// réutilisant un waypoint de bord s'il est déjà là) et on insère des points de passage
// échantillonnés le long de la variante. recomputeRoute (via waypoints-changed) re-route
// à travers ces points et reproduit la variante.
function applyAlternative(lo: number, hi: number, altCoords: Coord[]) {
  if (routeStore.readOnly.value) return
  recomputeWaypointGeomIndices()
  const wps = routeStore.waypoints.value
  const geom = routeStore.geometry.value
  if (waypointGeomIndices.length !== wps.length || geom.length < 2 || altCoords.length < 2) return

  // Waypoints à conserver : ceux avant/au niveau de lo, et ceux après/au niveau de hi.
  const before = wps.filter((_, i) => waypointGeomIndices[i] <= lo)
  const after = wps.filter((_, i) => waypointGeomIndices[i] >= hi)

  // Ancres : réutilise le waypoint de bord s'il coïncide ~avec l'extrémité (< 20 m),
  // sinon ancre neuve sur le point de géométrie exact.
  const ANCHOR_TOL_M = 20
  const startPt = geom[lo]
  const endPt = geom[hi]
  const startAnchor = before.length && haversine([before[before.length - 1].lng, before[before.length - 1].lat], startPt) < ANCHOR_TOL_M
    ? [] : [{ lng: startPt[0], lat: startPt[1] }]
  const endAnchor = after.length && haversine([after[0].lng, after[0].lat], endPt) < ANCHOR_TOL_M
    ? [] : [{ lng: endPt[0], lat: endPt[1] }]

  // Points de passage le long de la variante (hors extrémités, déjà couvertes par les
  // ancres). On ne garde que les sommets significatifs (virages/jonctions) via une
  // simplification Ramer-Douglas-Peucker : bien moins de points qu'un échantillonnage
  // régulier, tout en épinglant la variante à ses jonctions, de sorte que le re-routage
  // à travers les vias la reproduise sans que BRouter recoupe droit. Plafonné pour
  // respecter MAX_WAYPOINTS.
  const budget = MAX_WAYPOINTS - before.length - after.length - startAnchor.length - endAnchor.length
  if (budget < 0) { routeStore.error.value = t('routes.error_max_waypoints', { count: MAX_WAYPOINTS }); return }
  const VIA_SIMPLIFY_TOL_M = 25
  const simplified = simplifyTrack(altCoords, VIA_SIMPLIFY_TOL_M, budget + 2)
  const vias = simplified.slice(1, -1).map((c) => ({ lng: c[0], lat: c[1] }))

  routeStore.waypoints.value = [...before, ...startAnchor, ...vias, ...endAnchor, ...after]
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function updateSelectionLayer() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-route-selected')
  if (!src) return
  if (!selectionStore.selectionRange.value || !selectionStore.cumDistKm.length) {
    src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }); return
  }
  const i0 = geomIdxForKm(selectionStore.selectionRange.value.startKm, selectionStore.cumDistKm)
  const i1 = geomIdxForKm(selectionStore.selectionRange.value.endKm, selectionStore.cumDistKm)
  const lo = Math.min(i0, i1), hi = Math.max(i0, i1)
  const coords = routeStore.geometry.value.slice(lo, hi + 1).map(([lng, lat]) => [lng, lat])
  src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } })
}

function updateDivergentLayer() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-divergent')
  if (!src) return
  src.setData({ type: 'FeatureCollection', features: [] })
}

// ─── Climb markers ────────────────────────────────────────────────────────────

function installClimbMarkers() {
  if (!_maplibregl || !mapInstance) return
  climbMarkerObservers.forEach((obs) => obs.disconnect()); climbMarkerObservers.length = 0
  climbMarkers.forEach((m) => m.remove()); climbMarkers.length = 0
  if (!props.state.showClimbs || routeStore.geometry.value.length < 2) return
  routeStore.detectedClimbs.value.forEach((climb) => {
    const pt = routeStore.geometry.value[climb.startIdx]
    if (!pt) return
    const el = buildClimbMarkerEl(climb)
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom-left' })
      .setLngLat([pt[0], pt[1]])
      .addTo(mapInstance)
    climbMarkerObservers.push(attachClimbMarkerScaleObserver(el))
    climbMarkers.push(marker)
  })
}

function attachClimbMarkerScaleObserver(el: HTMLElement) {
  let lastSet = ''
  const obs = new MutationObserver(() => {
    const raw = el.style.transform
    if (!raw || raw === lastSet) return
    const base = raw.replace(/ scale\([^)]+\)$/, '')
    const s = parseFloat(mapInstance.getContainer().style.getPropertyValue('--wp-scale') || '1')
    lastSet = `${base} scale(${s})`
    el.style.transform = lastSet
  })
  obs.observe(el, { attributes: true, attributeFilter: ['style'] })
  return obs
}

function buildClimbMarkerEl(climb: Climb) {
  const el = document.createElement('div')
  const catClass = climb.category ? `climb-cat-${climb.category}` : 'climb-cat-uncat'
  el.className = `climb-marker ${catClass}`
  const lengthStr = climb.lengthM >= 1000 ? `${(climb.lengthM / 1000).toFixed(1)} km` : `${Math.round(climb.lengthM)} m`
  el.innerHTML = `<i class="fa-solid fa-mountain" aria-hidden="true"></i><span class="climb-marker-stats">${lengthStr}&nbsp;·&nbsp;+${Math.round(climb.gain)}m&nbsp;·&nbsp;${climb.avgGrade.toFixed(1)}%</span>${climb.category ? `<span class="climb-marker-cat">${climb.category}</span>` : ''}`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    selectionStore.selectionRange.value = { startKm: climb.startKm, endKm: climb.endKm }
    selectionStore.selectionPinned.value = true
    updateSelectionLayer()
    fitMapToSelection()
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  el.addEventListener('mouseenter', () => {
    overClimbMarker = true; hideHoverMarker()
    // Survol = sélection du col (drapeaux + tronçon bleu), remplace la précédente.
    selectionStore.selectionRange.value = { startKm: climb.startKm, endKm: climb.endKm }
    selectionStore.selectionPinned.value = false
  })
  el.addEventListener('mouseleave', () => {
    overClimbMarker = false
    // On quitte le col : on efface la sélection temporaire (sauf si épinglée par un clic).
    if (!selectionStore.selectionPinned.value) selectionStore.selectionRange.value = null
  })
  return el
}

// ─── Place markers (cimetières / boulangeries) ─────────────────────────────────

function placeMarkerKey(lng: number, lat: number) { return `${lng.toFixed(6)},${lat.toFixed(6)}` }

// Ferme le popup de POI et retire le surlignage « actif » de son marqueur. Point
// d'entrée unique pour toute fermeture (bouton, clic carte, ouverture d'un autre POI).
function closePlacePopup() {
  if (placePopup) { placePopup.remove(); placePopup = null }
  if (selectedPlaceEl) { selectedPlaceEl.classList.remove('place-marker--active'); selectedPlaceEl = null }
}

function clearPlaceMarkers() {
  placeMarkerObservers.forEach((obs) => obs.disconnect()); placeMarkerObservers.length = 0
  placeMarkers.forEach((m) => m.remove()); placeMarkers.length = 0
  placeMarkerEls.clear(); hoveredPlaceEl = null
  closePlacePopup()
}

// Popup proposant d'ouvrir le lieu sur Google Maps et en Street View, comme les
// points de l'itinéraire (même format d'URL `maps?q=lat,lng`). Le lien Street
// View est grisé quand aucune imagerie n'est disponible à proximité.
function showPlacePopup(place: Place) {
  if (!_maplibregl || !mapInstance) return
  closePlacePopup()
  // Décalage de ~15 m : centrée pile sur le lieu, l'épingle rouge de Google masque
  // le POI. On vise juste à côté pour le laisser visible/cliquable.
  const OFFSET = 0.00008
  const mapsUrl = `https://www.google.com/maps?q=${place.lat + OFFSET},${place.lng + OFFSET}`
  // Caméra Street View orientée depuis le tracé vers le POI (s'il y a un tracé chargé).
  const svUrl = streetViewUrl(place.lat, place.lng, bearingFromRoute(routeStore.geometry.value, place.lng, place.lat))
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  // En édition, on propose d'insérer le POI dans le tracé (au plus proche). En lecture
  // seule, le popup reste informatif (Google Maps / Street View seulement).
  const addAction = routeStore.readOnly.value
    ? ''
    : `<button type="button" class="place-popup-link place-popup-link--add-route">
        <i class="fa-solid fa-circle-plus" aria-hidden="true"></i>
        <span>${escapeHtml(t('routes.add_to_route'))}</span>
      </button>`
  // « Sauvegarder ce POI » : épingle le POI Overpass dans la table `pois` (hors
  // lecture seule, et seulement si sa catégorie est reconnue).
  const saveAction = routeStore.readOnly.value || !categoryForType(place.type)
    ? ''
    : `<button type="button" class="place-popup-link place-popup-link--save-poi">
        <i class="fa-solid fa-bookmark" aria-hidden="true"></i>
        <span>${escapeHtml(t('routes.save_poi'))}</span>
      </button>`
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(place.name)}</span>
      <button type="button" class="place-popup-close" aria-label="Fermer">×</button>
    </div>
    ${addAction}
    ${saveAction}
    <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${t('routes.street_view')}</span>
    </a>`
  // closeOnClick désactivé : la fermeture sur clic carte est gérée dans le handler
  // de clic de la carte, pour que ce clic ne fasse que fermer sans ajouter de point.
  placePopup = new _maplibregl.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([place.markerLng, place.markerLat])
    .setDOMContent(wrap)
    .addTo(mapInstance)
  // Remplit le marqueur du POI tant que son popup est ouvert (même rendu que le survol).
  selectedPlaceEl = placeMarkerEls.get(placeMarkerKey(place.markerLng, place.markerLat)) ?? null
  if (selectedPlaceEl) selectedPlaceEl.classList.add('place-marker--active')
  wrap.querySelector('.place-popup-close')?.addEventListener('click', closePlacePopup)
  wrap.querySelector('.place-popup-link--add-route')?.addEventListener('click', () => {
    insertWaypointSmart(place.lng, place.lat)
    closePlacePopup()
  })
  wrap.querySelector('.place-popup-link--save-poi')?.addEventListener('click', () => {
    void savePlaceAsPoi(place)
    closePlacePopup()
  })
  const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
  if (svLink) {
    checkSV(place.lat, place.lng).then((ok) => {
      svLink.classList.toggle('place-popup-link--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
}

function escapeHtml(s: string) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function closeRoutePointPopup() {
  if (routePointPopup) { routePointPopup.remove(); routePointPopup = null }
}

function closeCoordPopup() {
  if (coordPopup) { coordPopup.remove(); coordPopup = null }
}

// Tooltip d'un point quelconque de la carte (clic droit / appui long). Lecture seule :
// n'ajoute jamais de point au tracé, propose juste les coordonnées et les liens carto.
function showCoordPopup(lng: number, lat: number, point?: { x: number; y: number }) {
  if (!_maplibregl || !mapInstance) return
  closeCoordPopup()
  // En édition, le popup propose d'insérer ce point dans le tracé (au plus proche).
  // En lecture seule, pas d'action d'ajout : tooltip purement informative.
  const onAdd = routeStore.readOnly.value
    ? undefined
    : (plng: number, plat: number) => { insertWaypointSmart(plng, plat); closeCoordPopup() }
  // Si le clic vise le tracé (proximité testée en pixels), oriente Street View dans le
  // sens de parcours ; sinon point quelconque, vue par défaut.
  const onRoute = point != null && nearestGeomIndexAt(point) != null
  const heading = onRoute ? bearingAlongRoute(routeStore.geometry.value, lng, lat) : undefined
  coordPopup = new _maplibregl.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([lng, lat])
    .setDOMContent(buildCoordPopupContent(lng, lat, closeCoordPopup, onAdd, heading))
    .addTo(mapInstance)
}

// Popup informatif pour un point quelconque du tracé (lecture seule). Reprend le
// même contenu que la tooltip d'un point d'itinéraire — coordonnées copiables,
// Google Maps, Street View, Komoot — mais ancré sur le point cliqué du tracé.
function showRoutePointPopup(lng: number, lat: number) {
  if (!_maplibregl || !mapInstance) return
  closeRoutePointPopup()
  const komootUrl = `https://www.komoot.com/plan/@${lat},${lng},13z?sport=touringbicycle&p[0][loc]=${lat},${lng}`
  // Caméra Street View orientée dans le sens de parcours du tracé à cet endroit.
  const svUrl = streetViewUrl(lat, lng, bearingAlongRoute(routeStore.geometry.value, lng, lat))
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${t('routes.route_point')}</span>
      <button type="button" class="place-popup-close" aria-label="${t('routes.close')}">×</button>
    </div>
    <div class="wp-tooltip-coords-row">
      <button type="button" class="wp-tooltip-action wp-tooltip-action--copy" data-coord="${lat.toFixed(6)}" title="${t('routes.copy_latitude')}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span class="wp-tooltip-coords"><span class="wp-tooltip-coord-label">Lat</span>${lat.toFixed(6)}</span>
      </button>
      <button type="button" class="wp-tooltip-action wp-tooltip-action--copy" data-coord="${lng.toFixed(6)}" title="${t('routes.copy_longitude')}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span class="wp-tooltip-coords"><span class="wp-tooltip-coord-label">Lng</span>${lng.toFixed(6)}</span>
      </button>
    </div>
    <a class="wp-tooltip-action" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="wp-tooltip-action wp-tooltip-action--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${t('routes.street_view')}</span>
    </a>
    <a class="wp-tooltip-action wp-tooltip-action--komoot" href="${komootUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
      <span>Komoot</span>
    </a>`
  // closeOnClick désactivé : la fermeture sur clic carte est gérée dans le handler
  // de clic, pour qu'un clic ne fasse que fermer la tooltip (cf. handler lecture seule).
  routePointPopup = new _maplibregl.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([lng, lat])
    .setDOMContent(wrap)
    .addTo(mapInstance)
  wrap.querySelector('.place-popup-close')?.addEventListener('click', closeRoutePointPopup)
  wrap.querySelectorAll('.wp-tooltip-action--copy').forEach((btn) => {
    btn.addEventListener('click', (ev: any) => {
      ev.stopPropagation(); ev.preventDefault()
      const el = ev.currentTarget as HTMLElement
      copyCoords(el, el.dataset.coord || '')
    })
  })
  const svLink = wrap.querySelector<HTMLElement>('.wp-tooltip-action--streetview')
  if (svLink) {
    checkSV(lat, lng).then((ok) => {
      svLink.classList.toggle('wp-tooltip-action--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
}

// Rend une icône persistante et cliquable pour chaque POI ponctuel filtré (eau,
// boulangeries, cimetières…). Réutilise le pattern des marqueurs de cols
// (observateur de scale au zoom). Les localités n'ont pas de marqueur (liste seule).
function installPlaceMarkers() {
  if (!_maplibregl || !mapInstance) return
  clearPlaceMarkers()
  if (!props.state.showPois) return
  for (const place of placesStore.filteredPlaces.value) {
    const cat = categoryForType(place.type)
    if (!cat || !cat.point) continue
    const el = buildPlaceMarkerEl(place)
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([place.markerLng, place.markerLat])
      .addTo(mapInstance)
    placeMarkerObservers.push(attachClimbMarkerScaleObserver(el))
    placeMarkers.push(marker)
    placeMarkerEls.set(placeMarkerKey(place.markerLng, place.markerLat), el)
  }
}

function buildPlaceMarkerEl(place: Place) {
  const el = document.createElement('div')
  const cat = categoryForType(place.type)
  const icon = cat?.icon ?? 'fa-location-dot'
  el.className = 'place-marker'
  // Couleur pilotée par le registre (currentColor → bordure et remplissage au survol).
  el.style.color = cat?.color ?? '#6b7280'
  el.title = place.name
  el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    emit('select-place', place)
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  el.addEventListener('mouseenter', () => { overClimbMarker = true; hideHoverMarker(); emit('hover-place', place) })
  el.addEventListener('mouseleave', () => { overClimbMarker = false; emit('hover-place', null) })
  return el
}

// ─── Hover / cross markers ────────────────────────────────────────────────────

function showHoverMarker(coord: any) {
  if (!_maplibregl || !mapInstance || !coord) return
  const lngLat = [coord[0], coord[1]]
  if (!hoverMarker) {
    const el = document.createElement('div')
    el.className = 'route-insert-marker'
    el.innerHTML = '<i class="fa-solid fa-plus"></i>'
    hoverMarker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(mapInstance)
  } else {
    hoverMarker.setLngLat(lngLat)
    hoverMarker.getElement().style.display = ''
  }
}

function hideHoverMarker() {
  selectionStore.hoverIdx.value = null
  hoverInsert = null
  if (hoverMarker) hoverMarker.getElement().style.display = 'none'
}

function showChartCrossMarker(lng: number, lat: number) {
  if (!_maplibregl || !mapInstance) return
  if (!chartCrossMarker) {
    const el = document.createElement('div')
    el.className = 'chart-cross-marker'
    chartCrossMarker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(mapInstance)
  } else {
    chartCrossMarker.setLngLat([lng, lat])
    chartCrossMarker.getElement().style.display = ''
  }
}

function hideChartCrossMarker() {
  if (chartCrossMarker) chartCrossMarker.getElement().style.display = 'none'
}

// Marqueurs d'alerte « amas de virages » : posés à la sauvegarde quand un point mal
// placé déclenche plusieurs virages serrés au même endroit (cf. detectTurnAnomalies).
// Purement informatifs ; retirés dès que l'utilisateur ferme l'avertissement.
function clearTurnAnomalyMarkers() {
  turnAnomalyMarkers.forEach((m) => m.remove())
  turnAnomalyMarkers.length = 0
}

function showTurnAnomalyMarkers(anomalies: Array<{ lng: number; lat: number; kind?: string }>) {
  if (!_maplibregl || !mapInstance) return
  clearTurnAnomalyMarkers()
  for (const a of anomalies) {
    const el = document.createElement('div')
    el.className = 'turn-anomaly-marker'
    // Même icône que la puce correspondante dans l'alerte, pour relier les deux d'un coup d'œil.
    el.innerHTML = a.kind === 'uturn'
      ? '<i class="fa-solid fa-arrows-turn-to-dots"></i>'
      : '<i class="fa-solid fa-triangle-exclamation"></i>'
    const marker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([a.lng, a.lat])
      .addTo(mapInstance)
    turnAnomalyMarkers.push(marker)
  }
}

// Marqueurs d'alerte « point accroché au loin » : même rôle que ci-dessus pour l'autre
// avertissement, afin que les points en cause se repèrent sur la carte sans avoir à
// ouvrir leur bulle. Posés à l'endroit CLIQUÉ (et non sur le tracé) : c'est l'écart entre
// les deux que l'avertissement dénonce.
function clearSnapMarkers() {
  snapMarkers.forEach((m) => m.remove())
  snapMarkers.length = 0
}

function showSnapMarkers(points: Array<{ lng: number; lat: number }>) {
  if (!_maplibregl || !mapInstance) return
  clearSnapMarkers()
  for (const p of points) {
    const el = document.createElement('div')
    el.className = 'snap-warning-marker'
    el.innerHTML = '<i class="fa-solid fa-map-pin"></i>'
    const marker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([p.lng, p.lat])
      .addTo(mapInstance)
    snapMarkers.push(marker)
  }
}

// Surligne le POI survolé en remplissant son marqueur (le fond passe à la couleur
// du POI). lng/lat sont les coordonnées du marqueur (markerLng/markerLat), qui
// servent de clé. Le survol peut venir de la carte ou de la liste latérale.
function showPlaceHoverMarker(lng: number, lat: number, distanceM: number) {
  const el = placeMarkerEls.get(placeMarkerKey(lng, lat)) ?? null
  if (el !== hoveredPlaceEl) {
    if (hoveredPlaceEl) hoveredPlaceEl.classList.remove('place-marker--hover')
    if (el) el.classList.add('place-marker--hover')
    hoveredPlaceEl = el
  }
  placesStore.placeHoverKm = distanceM / 1000
}

function hidePlaceHoverMarker() {
  if (hoveredPlaceEl) { hoveredPlaceEl.classList.remove('place-marker--hover'); hoveredPlaceEl = null }
  placesStore.placeHoverKm = null
}

// ─── POI sauvegardés ──────────────────────────────────────────────────────────
// Rendu permanent des POI de la table `pois` (posés à la main ou épinglés). Style
// identique aux POI Overpass + badge étoile (.place-marker--saved). Filtrés par
// l'état d'affichage par catégorie (savedPoisStore.show).

function clearSavedPoiMarkers() {
  savedPoiMarkerObservers.forEach((o) => o.disconnect()); savedPoiMarkerObservers.length = 0
  savedPoiMarkers.forEach((m) => m.remove()); savedPoiMarkers.length = 0
}

function installSavedPoiMarkers() {
  if (!_maplibregl || !mapInstance) return
  clearSavedPoiMarkers()
  if (!props.state.showPois) return
  for (const poi of savedPoisStore.pois.value) {
    if (savedPoisStore.show[poi.category] === false) continue
    const el = buildSavedPoiMarkerEl(poi)
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([poi.lng, poi.lat])
      .addTo(mapInstance)
    savedPoiMarkerObservers.push(attachClimbMarkerScaleObserver(el))
    savedPoiMarkers.push(marker)
  }
}

function buildSavedPoiMarkerEl(poi: SavedPoi) {
  const el = document.createElement('div')
  const cat = POI_CATEGORIES.find((c) => c.key === poi.category)
  const icon = cat?.icon ?? 'fa-location-dot'
  el.className = 'place-marker place-marker--saved'
  el.style.color = cat?.color ?? '#6b7280'
  el.title = poi.name
  el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`
  el.addEventListener('click', (ev) => { ev.stopPropagation(); showSavedPoiPopup(poi) })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  el.addEventListener('mouseenter', () => { overClimbMarker = true; hideHoverMarker() })
  el.addEventListener('mouseleave', () => { overClimbMarker = false })
  return el
}

function closeSavedPoiPopup() {
  if (savedPoiPopup) { savedPoiPopup.remove(); savedPoiPopup = null }
}

// Popup d'un POI sauvegardé : renommer / supprimer (hors lecture seule) en plus des
// liens Google Maps / Street View (mêmes que les POI Overpass).
function showSavedPoiPopup(poi: SavedPoi) {
  if (!_maplibregl || !mapInstance) return
  closeSavedPoiPopup()
  const OFFSET = 0.00008
  const mapsUrl = `https://www.google.com/maps?q=${poi.lat + OFFSET},${poi.lng + OFFSET}`
  // Caméra Street View orientée depuis le tracé vers le POI (s'il y a un tracé chargé).
  const svUrl = streetViewUrl(poi.lat, poi.lng, bearingFromRoute(routeStore.geometry.value, poi.lng, poi.lat))
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  const editActions = routeStore.readOnly.value ? '' : `
    <button type="button" class="place-popup-link place-popup-link--rename">
      <i class="fa-solid fa-pen" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.rename_poi'))}</span>
    </button>
    <button type="button" class="place-popup-link place-popup-link--delete">
      <i class="fa-solid fa-trash" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.delete_poi'))}</span>
    </button>`
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(poi.name)}</span>
      <button type="button" class="place-popup-close" aria-label="Fermer">×</button>
    </div>
    ${editActions}
    <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${t('routes.street_view')}</span>
    </a>`
  savedPoiPopup = new _maplibregl.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([poi.lng, poi.lat])
    .setDOMContent(wrap)
    .addTo(mapInstance)
  wrap.querySelector('.place-popup-close')?.addEventListener('click', closeSavedPoiPopup)
  wrap.querySelector('.place-popup-link--rename')?.addEventListener('click', async () => {
    const name = window.prompt(t('routes.poi_name'), poi.name)?.trim()
    closeSavedPoiPopup()
    if (name) { await savedPoisStore.update(poi.id, { name }); installSavedPoiMarkers() }
  })
  wrap.querySelector('.place-popup-link--delete')?.addEventListener('click', async () => {
    closeSavedPoiPopup()
    await savedPoisStore.remove(poi.id)
    installSavedPoiMarkers()
  })
  const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
  if (svLink) {
    checkSV(poi.lat, poi.lng).then((ok) => {
      svLink.classList.toggle('place-popup-link--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
}

// Ouvre le dialogue de création (nom + catégorie) au point cliqué en mode « poser ».
function openPoiDialog(lng: number, lat: number) {
  poiDialog.value = { lng, lat, name: '', category: POI_CATEGORIES[0].key }
}

// Enregistre le POI saisi dans le dialogue. Nom vide → libellé de la catégorie.
async function savePoiFromDialog() {
  const d = poiDialog.value
  if (!d) return
  const cat = POI_CATEGORIES.find((c) => c.key === d.category) ?? POI_CATEGORIES[0]
  const name = d.name.trim() || t(`profile.poi.${cat.labelKey}`)
  poiDialog.value = null
  const poi = await savedPoisStore.add({ name, category: cat.key, lng: d.lng, lat: d.lat, source: 'custom' })
  if (poi) installSavedPoiMarkers()
}

// Épingle un POI Overpass découvert : le sauvegarde dans la table `pois`.
async function savePlaceAsPoi(place: Place) {
  const cat = categoryForType(place.type)
  if (!cat) return
  const poi = await savedPoisStore.add({ name: place.name, category: cat.key, lng: place.lng, lat: place.lat, source: 'overpass' })
  if (poi) installSavedPoiMarkers()
}

// ─── Repères d'itinéraire (départ / arrivée / parking) ──────────────────────────
// Rendu permanent des repères posés à la main (routeStore.markers), déplaçables et
// éditables hors lecture seule. Réinstallés à chaque mutation (ajout / drag / édition
// / suppression) et au chargement d'un itinéraire (refreshRouteMarkers).

function clearRouteMarkers() {
  routeMarkerObservers.forEach((obs) => obs.disconnect()); routeMarkerObservers.length = 0
  routeMarkerObjs.forEach((m) => m.remove()); routeMarkerObjs.length = 0
}

function installRouteMarkers() {
  if (!_maplibregl || !mapInstance) return
  clearRouteMarkers()
  if (!props.state.showMarkers) return
  const editable = !routeStore.readOnly.value
  routeStore.markers.value.forEach((marker, idx) => {
    const el = buildRouteMarkerEl(marker)
    const m = new _maplibregl.Marker({ element: el, anchor: 'bottom-left', draggable: editable })
      .setLngLat([marker.lng, marker.lat])
      .addTo(mapInstance)
    // Réduit le repère quand on dézoome (comme les cols), via --wp-scale.
    routeMarkerObservers.push(attachClimbMarkerScaleObserver(el))
    if (editable) {
      // Fige le déplacement de la carte pendant le drag et écrit la nouvelle position
      // dans le store à la fin (le tableau reste indexé comme au rendu).
      m.on('dragstart', () => { overClimbMarker = true; if (routeMarkerPopup) closeRouteMarkerPopup() })
      m.on('dragend', () => {
        const { lng, lat } = m.getLngLat()
        const cur = routeStore.markers.value[idx]
        if (cur) routeStore.markers.value[idx] = { ...cur, lng, lat }
        overClimbMarker = false
      })
    }
    routeMarkerObjs.push(m)
  })
}

function buildRouteMarkerEl(marker: { kind: string; lng: number; lat: number; label?: string }) {
  const el = document.createElement('div')
  const meta = markerMeta(marker.kind)
  const icon = meta?.icon ?? 'fa-location-dot'
  const kindLabel = markerKindLabel(marker.kind)
  // Libellé toujours visible (pastille type « col ») : type + libellé libre éventuel.
  const text = marker.label ? `${escapeHtml(kindLabel)} · ${escapeHtml(marker.label)}` : escapeHtml(kindLabel)
  el.className = 'route-marker'
  el.style.color = meta?.color ?? '#6b7280'
  el.title = marker.label ? `${kindLabel} · ${marker.label}` : kindLabel
  el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span class="route-marker-label">${text}</span>`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    // Zoome raisonnablement sur le repère (sans jamais dézoomer) et ouvre le popup
    // (Google Maps / Street View, plus renommer / supprimer hors lecture seule).
    flyTo(marker.lng, marker.lat, Math.max(mapInstance?.getZoom() ?? 15, 15))
    showRouteMarkerPopup(marker)
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  el.addEventListener('mouseenter', () => { overClimbMarker = true; hideHoverMarker() })
  el.addEventListener('mouseleave', () => { overClimbMarker = false })
  return el
}

function closeRouteMarkerPopup() {
  if (routeMarkerPopup) { routeMarkerPopup.remove(); routeMarkerPopup = null }
}

// Popup d'un repère : titre = libellé (ou type), liens Google Maps / Street View (mêmes
// que les POI) et — hors lecture seule — actions renommer / supprimer. Retrouve le repère
// par identité de coordonnées.
function showRouteMarkerPopup(marker: { kind: string; lng: number; lat: number; label?: string }) {
  if (!_maplibregl || !mapInstance) return
  closeRouteMarkerPopup()
  const title = marker.label ? `${markerKindLabel(marker.kind)} — ${marker.label}` : markerKindLabel(marker.kind)
  const OFFSET = 0.00008
  const mapsUrl = `https://www.google.com/maps?q=${marker.lat + OFFSET},${marker.lng + OFFSET}`
  // Navigation Google Maps en voiture depuis la position courante vers le repère
  // (l'app mobile prend le relais du lien si elle est installée) : les repères sont
  // des points d'accès (parking, départ), on s'y rend en voiture.
  const dirUrl = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${marker.lat},${marker.lng}`
  // Caméra Street View orientée depuis le tracé vers le repère (s'il y a un tracé chargé).
  const svUrl = streetViewUrl(marker.lat, marker.lng, bearingFromRoute(routeStore.geometry.value, marker.lng, marker.lat))
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  const editActions = routeStore.readOnly.value ? '' : `
    <button type="button" class="place-popup-link place-popup-link--rename">
      <i class="fa-solid fa-pen" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.marker_edit_label'))}</span>
    </button>
    <button type="button" class="place-popup-link place-popup-link--delete">
      <i class="fa-solid fa-trash" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.marker_delete'))}</span>
    </button>`
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(title)}</span>
      <button type="button" class="place-popup-close" aria-label="${t('routes.close')}">×</button>
    </div>
    ${editActions}
    <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="place-popup-link" href="${dirUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-diamond-turn-right" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.directions'))}</span>
    </a>
    <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${t('routes.street_view')}</span>
    </a>`
  routeMarkerPopup = new _maplibregl.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
    .setLngLat([marker.lng, marker.lat])
    .setDOMContent(wrap)
    .addTo(mapInstance)
  wrap.querySelector('.place-popup-close')?.addEventListener('click', closeRouteMarkerPopup)
  wrap.querySelector('.place-popup-link--rename')?.addEventListener('click', () => {
    const label = window.prompt(t('routes.marker_label'), marker.label || '')
    if (label == null) return
    const idx = routeStore.markers.value.indexOf(marker as any)
    closeRouteMarkerPopup()
    if (idx < 0) return
    const clean = label.trim()
    const cur = routeStore.markers.value[idx]
    routeStore.markers.value[idx] = clean ? { ...cur, label: clean } : { kind: cur.kind, lng: cur.lng, lat: cur.lat }
    installRouteMarkers()
  })
  wrap.querySelector('.place-popup-link--delete')?.addEventListener('click', () => {
    const idx = routeStore.markers.value.indexOf(marker as any)
    closeRouteMarkerPopup()
    if (idx < 0) return
    routeStore.markers.value.splice(idx, 1)
    installRouteMarkers()
  })
  const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
  if (svLink) {
    checkSV(marker.lat, marker.lng).then((ok) => {
      svLink.classList.toggle('place-popup-link--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
}

// Sélectionne le mode d'édition (dropdown). Ferme les dialogues/popups de pose en
// cours pour repartir d'un état propre, et referme le menu.
function setEditMode(mode: EditMode) {
  editMode.value = mode
  openMenu.value = null
  if (mode !== 'poi') poiDialog.value = null
  if (mode !== 'marker') markerDialog.value = null
}

// Ouvre le dialogue de création (type + libellé) au point cliqué en mode « poser ».
function openMarkerDialog(lng: number, lat: number) {
  markerDialog.value = { lng, lat, kind: MARKER_KINDS[0].kind, label: '' }
}

// Enregistre le repère saisi dans le dialogue et le rend immédiatement.
function saveMarkerFromDialog() {
  const d = markerDialog.value
  if (!d) return
  const label = d.label.trim()
  const marker = label ? { kind: d.kind, lng: d.lng, lat: d.lat, label } : { kind: d.kind, lng: d.lng, lat: d.lat }
  routeStore.markers.value.push(marker)
  markerDialog.value = null
  installRouteMarkers()
}

// ─── Selection markers ────────────────────────────────────────────────────────

function updateSelectionMarkers() {
  if (!_maplibregl || !mapInstance || selectionMarkerDragging) return
  if (!selectionStore.selectionRange.value || !selectionStore.cumDistKm.length || !routeStore.geometry.value.length) {
    if (selectionMarkerA) { selectionMarkerA.remove(); selectionMarkerA = null }
    if (selectionMarkerB) { selectionMarkerB.remove(); selectionMarkerB = null }
    selectionMarkerAKm = null; selectionMarkerBKm = null; return
  }
  const { startKm, endKm } = selectionStore.selectionRange.value
  const ptStart = routeStore.geometry.value[geomIdxForKm(startKm, selectionStore.cumDistKm)]
  const ptEnd = routeStore.geometry.value[geomIdxForKm(endKm, selectionStore.cumDistKm)]
  if (!ptStart || !ptEnd) return
  if (!selectionMarkerA) selectionMarkerA = makeSelectionMarker('start')
  if (!selectionMarkerB) selectionMarkerB = makeSelectionMarker('end')
  selectionMarkerAKm = startKm; selectionMarkerBKm = endKm
  selectionMarkerA.setLngLat([ptStart[0], ptStart[1]])
  selectionMarkerB.setLngLat([ptEnd[0], ptEnd[1]])
}

function makeSelectionMarker(kind: 'start' | 'end') {
  const el = document.createElement('div')
  el.className = 'sel-flag-marker'
  el.style.cssText = 'width:28px;height:36px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));cursor:grab'
  el.innerHTML = flagSvg(kind)
  el.addEventListener('mouseenter', () => { overClimbMarker = true; hideHoverMarker() })
  el.addEventListener('mouseleave', () => { overClimbMarker = false })
  const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom-left', draggable: true })
    .setLngLat([0, 0])
    .addTo(mapInstance)
  marker.on('dragstart', () => { selectionMarkerDragging = true })
  marker.on('drag', () => {
    const { lng: dLng, lat: dLat } = marker.getLngLat()
    let best = 0, bestDist = Infinity
    for (let i = 0; i < routeStore.geometry.value.length; i++) {
      const dx = routeStore.geometry.value[i][0] - dLng
      const dy = routeStore.geometry.value[i][1] - dLat
      const d = dx * dx + dy * dy
      if (d < bestDist) { bestDist = d; best = i }
    }
    const km = selectionStore.cumDistKm[best]
    if (km == null) return
    marker.setLngLat([routeStore.geometry.value[best][0], routeStore.geometry.value[best][1]])
    if (marker === selectionMarkerA) selectionMarkerAKm = km
    else selectionMarkerBKm = km
    const lo = Math.min(selectionMarkerAKm ?? km, selectionMarkerBKm ?? km)
    const hi = Math.max(selectionMarkerAKm ?? km, selectionMarkerBKm ?? km)
    selectionStore.selectionRange.value = { startKm: lo, endKm: hi }
    selectionStore.selectionPinned.value = true
    updateSelectionLayer()
  })
  marker.on('dragend', () => { selectionMarkerDragging = false; fitMapToSelection() })
  return marker
}

// ─── Fit to bounds ────────────────────────────────────────────────────────────

function fitMapToRoute() {
  if (!mapInstance || routeStore.geometry.value.length < 2) return
  const lngs = routeStore.geometry.value.map((c) => c[0])
  const lats = routeStore.geometry.value.map((c) => c[1])
  mapInstance.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40, duration: 500 })
}

function fitMapToSelection() {
  if (!mapInstance || !selectionStore.selectionRange.value || !routeStore.geometry.value.length) return
  const i0 = geomIdxForKm(selectionStore.selectionRange.value.startKm, selectionStore.cumDistKm)
  const i1 = geomIdxForKm(selectionStore.selectionRange.value.endKm, selectionStore.cumDistKm)
  const slice = routeStore.geometry.value.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)
  if (slice.length < 2) return
  const lngs = slice.map((c) => c[0]), lats = slice.map((c) => c[1])
  mapInstance.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, duration: 500 })
}

function flyTo(lng: number, lat: number, zoom = 15) {
  mapInstance?.flyTo({ center: [lng, lat], zoom, duration: 600 })
}

function fitBounds(sw: [number, number], ne: [number, number], opts = {}) {
  mapInstance?.fitBounds([sw, ne], { padding: 40, duration: 0, ...opts })
}

// ─── Waypoints ────────────────────────────────────────────────────────────────

function recomputeWaypointGeomIndices() {
  const wps = routeStore.waypoints.value
  const geom = routeStore.geometry.value
  if (!wps.length || !geom.length) { waypointGeomIndices = []; return }
  // La géométrie routée parcourt les waypoints dans l'ordre : on cherche le sommet
  // le plus proche de chaque waypoint en repartant de l'index du précédent, ce qui
  // garantit des index monotones croissants. Sinon, sur un itinéraire en boucle où
  // le dernier waypoint = le premier, il se rattacherait au début du tracé (index 0)
  // et le tronçon final deviendrait un intervalle vide, cassant l'insertion de point.
  let from = 0
  waypointGeomIndices = wps.map((w, wi) => {
    // Le premier waypoint peut chercher sur tout le tracé ; les suivants repartent
    // de l'index du précédent pour rester monotones.
    const start = wi === 0 ? 0 : from
    let best = start, bestDist = Infinity
    for (let i = start; i < geom.length; i++) {
      const dx = geom[i][0] - w.lng, dy = geom[i][1] - w.lat
      const d = dx * dx + dy * dy
      if (d < bestDist) { bestDist = d; best = i }
    }
    from = best
    return best
  })
}

// Bloque tout ajout de point au-delà du plafond serveur (sinon le waypoint serait
// tronqué silencieusement à la sauvegarde). Affiche une erreur et renvoie true.
function atWaypointLimit(): boolean {
  if (routeStore.waypoints.value.length >= MAX_WAYPOINTS) {
    routeStore.error.value = t('routes.error_max_waypoints', { count: MAX_WAYPOINTS })
    return true
  }
  return false
}

function addWaypoint(lng: number, lat: number) {
  if (atWaypointLimit()) return
  const wps = routeStore.waypoints.value
  // Ergonomie : si le dernier point est libre, le nouveau l'est aussi par défaut,
  // jusqu'à ce qu'on rebascule le dernier point en point accroché à la route.
  const inheritFree = wps.length > 0 && wps[wps.length - 1].free === true
  routeStore.waypoints.value = [...wps, inheritFree ? { lng, lat, free: true } : { lng, lat }]
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function removeWaypoint(idx: number) {
  routeStore.waypoints.value = routeStore.waypoints.value.filter((_, i) => i !== idx)
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function moveWaypoint(from: number, to: number) {
  const wps = routeStore.waypoints.value
  if (from < 0 || from >= wps.length) return
  to = Math.max(0, Math.min(wps.length - 1, to))
  if (to === from) return
  const next = wps.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  routeStore.waypoints.value = next
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function toggleWaypointFree(idx: number) {
  const wps = routeStore.waypoints.value
  if (idx < 0 || idx >= wps.length) return
  const next = wps.slice()
  next[idx] = { ...next[idx], free: !next[idx].free }
  routeStore.waypoints.value = next
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

// Marque (ou non) le demi-tour provoqué par ce point comme délibéré. Purement informatif :
// le drapeau ne change pas le tracé, donc on n'émet PAS `waypoints-changed` — un recalcul
// BRouter serait inutile et ferait perdre l'alerte en cours. On demande juste à l'éditeur
// de relister ses anomalies.
function toggleWaypointUturnOk(idx: number) {
  const wps = routeStore.waypoints.value
  if (idx < 0 || idx >= wps.length) return
  const next = wps.slice()
  next[idx] = { ...next[idx], uturn_ok: !next[idx].uturn_ok }
  routeStore.waypoints.value = next
  deselectAll()
  refreshWaypointMarkers()
  emit('uturn-ok-changed')
}

// Inverse le sens du parcours. Le drapeau `free` d'un point marque son tronçon
// ENTRANT comme droit (waypoint[i] → waypoint[i+1] droit ssi waypoint[i+1].free) :
// après inversion, on réaffecte les drapeaux pour que chaque tronçon garde sa nature
// (droit / routé) et que la géométrie soit préservée à l'identique. `uturn_ok`, lui,
// qualifie le point lui-même (et non un tronçon) : il le suit tel quel.
function reverseWaypoints() {
  const wps = routeStore.waypoints.value
  if (wps.length < 2) return
  const n = wps.length
  const reversed = wps.slice().reverse().map((w) => ({ lng: w.lng, lat: w.lat, ...(w.uturn_ok ? { uturn_ok: true } : {}) })) as Array<{ lng: number; lat: number; free?: boolean; uturn_ok?: boolean }>
  // Le tronçon j du tableau inversé (reversed[j] → reversed[j+1]) correspond au
  // tronçon original (n-2-j) ; il est droit ssi l'ancien waypoint[n-1-j] était libre.
  for (let j = 0; j < n - 1; j++) {
    if (wps[n - 1 - j]?.free) reversed[j + 1].free = true
  }
  routeStore.waypoints.value = reversed
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function addReturnTo(idx: number) {
  if (atWaypointLimit()) return
  const wps = routeStore.waypoints.value
  if (wps.length < 2 || idx >= wps.length - 1) return
  routeStore.waypoints.value = [...wps, { ...wps[idx] }]
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

// Insère un point à l'endroit exact du « + » (point projeté sur l'arête `edgeIdx`),
// dans le tronçon de waypoints qui contient cette arête. L'arête j relie geom[j]→geom[j+1] ;
// le tronçon entre waypoint i et i+1 couvre les arêtes [wgi[i], wgi[i+1][.
function insertWaypointAtHover(hit: { lng: number; lat: number; edgeIdx: number }) {
  if (atWaypointLimit()) return
  // Les index ne sont rafraîchis que par un routage réussi : après un échec BRouter ils
  // restent désynchronisés des waypoints, et l'insertion se bloquerait en silence.
  recomputeWaypointGeomIndices()
  if (waypointGeomIndices.length !== routeStore.waypoints.value.length) return
  let insertAt = routeStore.waypoints.value.length
  for (let i = 0; i < waypointGeomIndices.length - 1; i++) {
    if (hit.edgeIdx >= waypointGeomIndices[i] && hit.edgeIdx < waypointGeomIndices[i + 1]) { insertAt = i + 1; break }
  }
  const next = routeStore.waypoints.value.slice()
  // Si l'un des deux points encadrants est libre, le point inséré l'est aussi :
  // on prolonge la nature du tronçon plutôt que d'y forcer un bout routé.
  const inheritFree = next[insertAt - 1]?.free === true || next[insertAt]?.free === true
  next.splice(insertAt, 0, inheritFree ? { lng: hit.lng, lat: hit.lat, free: true } : { lng: hit.lng, lat: hit.lat })
  routeStore.waypoints.value = next
  hideHoverMarker()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

// Insère un point quelconque (POI ou clic droit) dans le tracé, au plus proche : on
// repère le sommet de la géométrie routée le plus proche du point, puis le tronçon de
// waypoints auquel il appartient, et on insère le nouveau point dans ce tronçon. Sans
// tracé encore routé (moins de deux points, ou index pas à jour), on ajoute à la fin.
function insertWaypointSmart(lng: number, lat: number) {
  if (atWaypointLimit()) return
  recomputeWaypointGeomIndices()
  const wps = routeStore.waypoints.value
  const geom = routeStore.geometry.value
  if (wps.length < 2 || geom.length < 2 || waypointGeomIndices.length !== wps.length) {
    addWaypoint(lng, lat)
    return
  }
  let nearIdx = 0, bestDist = Infinity
  for (let i = 0; i < geom.length; i++) {
    const d = haversine([lng, lat], geom[i])
    if (d < bestDist) { bestDist = d; nearIdx = i }
  }
  let insertAt = wps.length
  for (let i = 0; i < waypointGeomIndices.length - 1; i++) {
    if (nearIdx >= waypointGeomIndices[i] && nearIdx <= waypointGeomIndices[i + 1]) { insertAt = i + 1; break }
  }
  const next = wps.slice()
  // Si l'un des deux points encadrants est libre, le point inséré l'est aussi :
  // on prolonge la nature du tronçon plutôt que d'y forcer un bout routé.
  const inheritFree = next[insertAt - 1]?.free === true || next[insertAt]?.free === true
  next.splice(insertAt, 0, inheritFree ? { lng, lat, free: true } : { lng, lat })
  routeStore.waypoints.value = next
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function nearestGeomIndexAt(point: { x: number; y: number }) {
  if (!mapInstance || !routeStore.geometry.value.length) return null
  const features = mapInstance.queryRenderedFeatures(
    [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]],
    { layers: ['builder-route-line', 'builder-route-straight-line'] },
  )
  if (!features.length) return null
  let best = -1, bestDist = Infinity
  for (let i = 0; i < routeStore.geometry.value.length; i++) {
    const pt = routeStore.geometry.value[i]
    const px = mapInstance.project([pt[0], pt[1]])
    const dx = px.x - point.x, dy = px.y - point.y
    const d = dx * dx + dy * dy
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best >= 0 ? best : null
}

// Renvoie le point du tracé le plus proche du curseur, projeté sur l'arête (et non snappé
// au sommet de géométrie le plus proche) : { lng, lat, edgeIdx, vertexIdx }. edgeIdx est
// l'arête geom[j]→geom[j+1] sur laquelle tombe la projection ; vertexIdx le sommet le plus
// proche (pour le surlignage du graphe via hoverIdx). Le « + » suit ainsi la ligne en
// continu, y compris sur les tronçons droits dépourvus de sommets intermédiaires (où il
// sautait auparavant d'un point à l'autre, « par grille »). Gardé par queryRenderedFeatures
// pour ne réagir qu'au survol réel du tracé.
function nearestPointOnRouteAt(point: { x: number; y: number }) {
  if (!mapInstance || routeStore.geometry.value.length < 2) return null
  const features = mapInstance.queryRenderedFeatures(
    [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]],
    { layers: ['builder-route-line', 'builder-route-straight-line'] },
  )
  if (!features.length) return null
  const geom = routeStore.geometry.value
  const px = geom.map((pt) => mapInstance.project([pt[0], pt[1]]))
  let bestEdge = -1, bestT = 0, bestDist = Infinity
  for (let j = 0; j < px.length - 1; j++) {
    const a = px[j], b = px[j + 1]
    const vx = b.x - a.x, vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    let t = len2 > 0 ? ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2 : 0
    if (t < 0) t = 0; else if (t > 1) t = 1
    const cx = a.x + t * vx, cy = a.y + t * vy
    const dx = cx - point.x, dy = cy - point.y
    const d = dx * dx + dy * dy
    if (d < bestDist) { bestDist = d; bestEdge = j; bestT = t }
  }
  if (bestEdge < 0) return null
  const a = px[bestEdge], b = px[bestEdge + 1]
  const ll = mapInstance.unproject([a.x + bestT * (b.x - a.x), a.y + bestT * (b.y - a.y)])
  const vertexIdx = bestT < 0.5 ? bestEdge : bestEdge + 1
  return { lng: ll.lng, lat: ll.lat, edgeIdx: bestEdge, vertexIdx }
}

function isNearWaypoint(point: { x: number; y: number }) {
  if (!mapInstance) return false
  const TOL = 22
  for (const w of routeStore.waypoints.value) {
    const px = mapInstance.project([w.lng, w.lat])
    const dx = px.x - point.x, dy = px.y - point.y
    if (dx * dx + dy * dy <= TOL * TOL) return true
  }
  return false
}

// ─── Waypoint markers ─────────────────────────────────────────────────────────

function selectWaypoint(idx: number) {
  waypointMarkers.forEach((m, i) => {
    if (!m) return
    const el = m.getElement()
    el.classList.remove('wp-marker--selected')
    el.style.zIndex = i === idx ? '9999' : '1'
  })
  if (selectedWpIdx === idx) {
    selectedWpIdx = -1
    waypointMarkers.forEach((m) => { if (m) m.getElement().style.zIndex = '' })
    return
  }
  selectedWpIdx = idx
  if (waypointMarkers[idx]) {
    const el = waypointMarkers[idx].getElement()
    el.classList.add('wp-marker--selected')
    el.style.zIndex = '9999'
  }
  const wp = routeStore.waypoints.value[idx]
  if (wp) {
    checkSV(wp.lat, wp.lng).then((ok) => {
      if (selectedWpIdx === idx && waypointMarkers[idx]) applySVState(waypointMarkers[idx].getElement(), ok)
    })
  }
}

function deselectAll() {
  waypointMarkers.forEach((m) => {
    if (!m) return
    m.getElement().classList.remove('wp-marker--selected')
    m.getElement().style.zIndex = ''
  })
  selectedWpIdx = -1
}

async function copyCoords(btn: HTMLElement, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    document.body.removeChild(ta)
  }
  const icon = btn.querySelector('i')
  if (icon) {
    icon.classList.replace('fa-regular', 'fa-solid')
    icon.classList.replace('fa-copy', 'fa-check')
    icon.classList.add('wp-tooltip-coords--copied')
    setTimeout(() => {
      icon.classList.replace('fa-check', 'fa-copy')
      icon.classList.replace('fa-solid', 'fa-regular')
      icon.classList.remove('wp-tooltip-coords--copied')
    }, 1200)
  }
}

function refreshWaypointMarkers() {
  if (!_maplibregl || !mapInstance) return
  waypointMarkers.forEach((m) => m.remove()); waypointMarkers.length = 0
  selectedWpIdx = -1
  if (!props.state.showWaypoints) return
  // Lecture seule (vue partagée) : on affiche les mêmes marqueurs numérotés et leur
  // tooltip informatif (coordonnées, Google Maps, Street View, Komoot), mais sans les
  // éléments d'édition (déplacement, réordonnancement, inversion, libération, suppression).
  const ro = routeStore.readOnly.value
  routeStore.waypoints.value.forEach((w, idx) => {
    const el = document.createElement('div')
    el.className = w.free ? 'wp-marker wp-marker--free' : 'wp-marker'
    const isLast = idx === routeStore.waypoints.value.length - 1
    const returnHtml = !ro && !isLast
      ? `<button type="button" class="wp-tooltip-action wp-tooltip-action--return">
           <i class="fa-solid fa-right-left" aria-hidden="true"></i>
           <span>${t('routes.return_via_same_route')}</span>
         </button>`
      : ''
    const komootNeighbors = [
      idx > 0 ? routeStore.waypoints.value[idx - 1] : null,
      w,
      idx < routeStore.waypoints.value.length - 1 ? routeStore.waypoints.value[idx + 1] : null,
    ].filter(Boolean)
    const komootPoints = komootNeighbors.map((p: any, i) => `p[${i}][loc]=${p.lat},${p.lng}`).join('&')
    const komootUrl = `https://www.komoot.com/plan/@${w.lat},${w.lng},13z?sport=touringbicycle&${komootPoints}`
    // Caméra Street View orientée dans le sens de parcours du tracé à ce waypoint.
    const svUrl = streetViewUrl(w.lat, w.lng, bearingAlongRoute(routeStore.geometry.value, w.lng, w.lat))
    el.innerHTML = `
      <div class="wp-tooltip">
        <div class="wp-tooltip-header">
          <span class="wp-tooltip-title">Point&nbsp;${ro ? (idx + 1) : `<input type="number" class="wp-tooltip-num-input" min="1" max="${routeStore.waypoints.value.length}" value="${idx + 1}" title="${t('routes.reorder_waypoint')}" />`}</span>
          <button type="button" class="wp-tooltip-close" aria-label="Fermer">×</button>
        </div>
        <div class="wp-tooltip-coords-row">
          <button type="button" class="wp-tooltip-action wp-tooltip-action--copy" data-coord="${w.lat.toFixed(6)}" title="${t('routes.copy_latitude')}">
            <i class="fa-regular fa-copy" aria-hidden="true"></i>
            <span class="wp-tooltip-coords"><span class="wp-tooltip-coord-label">Lat</span>${w.lat.toFixed(6)}</span>
          </button>
          <button type="button" class="wp-tooltip-action wp-tooltip-action--copy" data-coord="${w.lng.toFixed(6)}" title="${t('routes.copy_longitude')}">
            <i class="fa-regular fa-copy" aria-hidden="true"></i>
            <span class="wp-tooltip-coords"><span class="wp-tooltip-coord-label">Lng</span>${w.lng.toFixed(6)}</span>
          </button>
        </div>
        <a class="wp-tooltip-action" href="https://www.google.com/maps?q=${w.lat},${w.lng}" target="_blank" rel="noopener noreferrer">
          <i class="fa-brands fa-google" aria-hidden="true"></i>
          <span>Google Maps</span>
        </a>
        <a class="wp-tooltip-action wp-tooltip-action--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-street-view" aria-hidden="true"></i>
          <span>${t('routes.street_view')}</span>
        </a>
        <a class="wp-tooltip-action wp-tooltip-action--komoot" href="${komootUrl}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
          <span>Komoot</span>
        </a>
        ${returnHtml}
        ${ro ? '' : `
        <button type="button" class="wp-tooltip-action wp-tooltip-action--reverse">
          <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
          <span>${t('routes.reverse_route')}</span>
        </button>
        <button type="button" class="wp-tooltip-action wp-tooltip-action--free">
          <i class="fa-solid fa-bezier-curve" aria-hidden="true"></i>
          <span>${w.free ? t('routes.anchor_to_road') : t('routes.make_free')}</span>
        </button>
        <button type="button" class="wp-tooltip-action wp-tooltip-action--uturn-ok">
          <i class="fa-solid fa-arrows-turn-to-dots" aria-hidden="true"></i>
          <span>${w.uturn_ok ? t('routes.uturn_flag_again') : t('routes.uturn_is_expected')}</span>
        </button>
        <button type="button" class="wp-tooltip-action wp-tooltip-action--delete">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
          <span>${t('routes.remove_waypoint')}</span>
        </button>`}
        <div class="wp-tooltip-arrow"></div>
      </div>
      <span class="wp-marker-num">${idx + 1}</span>
    `
    const marker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([w.lng, w.lat]).addTo(mapInstance)
    if (!ro) attachWaypointDrag(el, marker, idx)
    el.addEventListener('click', (ev: any) => {
      ev.stopPropagation()
      if (suppressNextWpClick) { suppressNextWpClick = false; return }
      if (ev.target.closest('.wp-tooltip')) return
      selectWaypoint(idx)
    })
    el.querySelector('.wp-tooltip-close')!.addEventListener('click', (ev: any) => { ev.stopPropagation(); deselectAll() })
    // Actions purement informatives : présentes aussi en lecture seule (vue partagée).
    el.querySelectorAll('.wp-tooltip-action:not(.wp-tooltip-action--delete):not(.wp-tooltip-action--free):not(.wp-tooltip-action--uturn-ok):not(.wp-tooltip-action--copy):not(.wp-tooltip-action--reverse)').forEach((a) => {
      a.addEventListener('click', (ev: any) => { ev.stopPropagation(); deselectAll() })
    })
    el.querySelectorAll('.wp-tooltip-action--copy').forEach((btn) => {
      btn.addEventListener('click', (ev: any) => {
        ev.stopPropagation(); ev.preventDefault()
        const el = ev.currentTarget as HTMLElement
        copyCoords(el, el.dataset.coord || '')
      })
    })
    if (!ro) {
      // Réordonnancement et actions d'édition : uniquement dans l'éditeur.
      const numInput = el.querySelector('.wp-tooltip-num-input') as HTMLInputElement
      const commitNum = () => {
        const v = parseInt(numInput.value, 10)
        const total = routeStore.waypoints.value.length
        if (!Number.isFinite(v)) { numInput.value = String(idx + 1); return }
        const target = Math.max(1, Math.min(total, v)) - 1
        if (target === idx) { numInput.value = String(idx + 1); return }
        moveWaypoint(idx, target)
      }
      numInput.addEventListener('click', (ev) => ev.stopPropagation())
      numInput.addEventListener('mousedown', (ev) => ev.stopPropagation())
      numInput.addEventListener('keydown', (ev: KeyboardEvent) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') { ev.preventDefault(); numInput.blur() }
        else if (ev.key === 'Escape') { numInput.value = String(idx + 1); numInput.blur() }
      })
      numInput.addEventListener('change', commitNum)
      el.querySelector('.wp-tooltip-action--free')!.addEventListener('click', (ev: any) => {
        ev.stopPropagation(); ev.preventDefault(); toggleWaypointFree(idx)
      })
      el.querySelector('.wp-tooltip-action--uturn-ok')!.addEventListener('click', (ev: any) => {
        ev.stopPropagation(); ev.preventDefault(); toggleWaypointUturnOk(idx)
      })
      el.querySelector('.wp-tooltip-action--reverse')!.addEventListener('click', (ev: any) => {
        ev.stopPropagation(); ev.preventDefault(); reverseWaypoints()
      })
      el.querySelector('.wp-tooltip-action--return')?.addEventListener('click', (ev: any) => {
        ev.stopPropagation(); ev.preventDefault(); addReturnTo(idx)
      })
      el.querySelector('.wp-tooltip-action--delete')!.addEventListener('click', (ev: any) => {
        ev.stopPropagation(); ev.preventDefault(); removeWaypoint(idx)
      })
      el.addEventListener('contextmenu', (ev: any) => { ev.preventDefault(); ev.stopPropagation(); removeWaypoint(idx) })
    }
    waypointMarkers.push(marker)
  })
}

function attachWaypointDrag(el: HTMLElement, marker: any, idx: number) {
  el.addEventListener('mousedown', (ev: MouseEvent) => {
    if (ev.button !== 0) return
    if ((ev.target as Element).closest('.wp-tooltip')) return
    ev.preventDefault(); ev.stopPropagation()
    let moved = false
    mapInstance.dragPan.disable()
    mapInstance.getCanvas().style.cursor = 'grabbing'
    el.style.cursor = 'grabbing'
    const onMove = (e: MouseEvent) => {
      moved = true
      const rect = mapInstance.getContainer().getBoundingClientRect()
      const ll = mapInstance.unproject([e.clientX - rect.left, e.clientY - rect.top])
      marker.setLngLat([ll.lng, ll.lat])
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      mapInstance.dragPan.enable()
      mapInstance.getCanvas().style.cursor = 'crosshair'
      el.style.cursor = ''
      if (!moved) return
      suppressNextMapClick = true
      suppressNextWpClick = true
      setTimeout(() => { suppressNextMapClick = false; suppressNextWpClick = false }, 50)
      const pos = marker.getLngLat()
      const next = routeStore.waypoints.value.slice()
      next[idx] = { ...next[idx], lng: pos.lng, lat: pos.lat }
      routeStore.waypoints.value = next
      emit('waypoints-changed')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  el.addEventListener('touchstart', (ev: TouchEvent) => {
    if ((ev.target as Element).closest('.wp-tooltip')) return
    if (ev.touches.length !== 1) return
    ev.preventDefault(); ev.stopPropagation()
    const startTouch = ev.touches[0]
    let moved = false
    mapInstance.dragPan.disable()
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      e.preventDefault()
      const touch = e.touches[0]
      const dx = touch.clientX - startTouch.clientX, dy = touch.clientY - startTouch.clientY
      if (!moved && dx * dx + dy * dy < 25) return
      moved = true
      const rect = mapInstance.getContainer().getBoundingClientRect()
      const ll = mapInstance.unproject([touch.clientX - rect.left, touch.clientY - rect.top])
      marker.setLngLat([ll.lng, ll.lat])
    }
    const onTouchEnd = () => {
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      mapInstance.dragPan.enable()
      if (!moved) { selectWaypoint(idx); return }
      suppressNextWpClick = true
      setTimeout(() => { suppressNextWpClick = false }, 50)
      const pos = marker.getLngLat()
      const next = routeStore.waypoints.value.slice()
      next[idx] = { ...next[idx], lng: pos.lng, lat: pos.lat }
      routeStore.waypoints.value = next
      emit('waypoints-changed')
    }
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
  }, { passive: false })
}

// ─── Street View ──────────────────────────────────────────────────────────────

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

function applySVState(markerEl: HTMLElement, available: boolean) {
  const link = markerEl.querySelector<HTMLElement>('.wp-tooltip-action--streetview')
  if (!link) return
  link.classList.toggle('wp-tooltip-action--disabled', !available)
  if (!available) link.setAttribute('aria-disabled', 'true')
  else link.removeAttribute('aria-disabled')
}

// ─── Location ─────────────────────────────────────────────────────────────────

function installLocationLayers(coords: [number, number], accuracy: number) {
  if (!mapInstance) return
  const data = { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [generateCircle(coords, accuracy)] } }
  if (!mapInstance.getSource('user-location')) {
    mapInstance.addSource('user-location', { type: 'geojson', data })
    mapInstance.addLayer({ id: 'user-location-fill', type: 'fill', source: 'user-location', paint: { 'fill-color': '#4285f4', 'fill-opacity': 0.12 } })
    mapInstance.addLayer({ id: 'user-location-stroke', type: 'line', source: 'user-location', paint: { 'line-color': '#4285f4', 'line-width': 1.5, 'line-opacity': 0.5 } })
  } else { mapInstance.getSource('user-location').setData(data) }
}

function showLocation(coords: [number, number], accuracy: number) {
  if (!mapInstance || !_maplibregl) return
  lastLocationCoords = coords; lastLocationAccuracy = accuracy
  installLocationLayers(coords, accuracy)
  if (locationMarker) { locationMarker.setLngLat(coords) } else {
    const el = document.createElement('div')
    el.className = 'user-location-dot'
    locationMarker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coords).addTo(mapInstance)
  }
  locationVisible.value = true
}

function hideLocation() {
  if (locationMarker) { locationMarker.remove(); locationMarker = null }
  lastLocationCoords = null
  if (mapInstance) {
    if (mapInstance.getLayer('user-location-stroke')) mapInstance.removeLayer('user-location-stroke')
    if (mapInstance.getLayer('user-location-fill')) mapInstance.removeLayer('user-location-fill')
    if (mapInstance.getSource('user-location')) mapInstance.removeSource('user-location')
  }
  locationVisible.value = false
}

async function toggleLocation() {
  if (locationVisible.value) { hideLocation(); return }
  locating.value = true
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 })
    })
    const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude]
    mapInstance?.flyTo({ center: coords, zoom: 14, duration: 800 })
    showLocation(coords, pos.coords.accuracy)
  } catch { /* permission refusée */ }
  finally { locating.value = false }
}

// ─── Map style ────────────────────────────────────────────────────────────────

// Choix manuel de l'utilisateur : ce fond devient le style par défaut du compte pour le
// sport courant. Le changement de sport, lui, applique un style déjà enregistré et ne
// doit donc rien réécrire — cf. applyMapStyle.
function setMapStyle(id: string) {
  if (!mapInstance || id === props.state.mapStyleId) return
  persistDefaultMapStyle(id as MapStyleId, routeStore.sport.value)
  applyMapStyle(id)
}

function applyMapStyle(id: string) {
  props.state.mapStyleId = id
  if (!mapInstance) return
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  mapInstance.once('style.load', () => {
    installRouteLayer(); installOverlays()
    updateRouteLayer(); updateDivergentLayer(); updateSelectionLayer(); installClimbMarkers(); installPlaceMarkers(); installSavedPoiMarkers()
    if (locationVisible.value && lastLocationCoords) installLocationLayers(lastLocationCoords, lastLocationAccuracy)
    if (props.state.is3D) {
      if (!mapInstance.getSource('terrain-dem')) {
        mapInstance.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
      }
      mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    }
  })
}

// Réconcilie les couches overlay (SuisseMobile/swisstopo) avec props.state.overlays :
// ajoute les actives manquantes, retire les inactives présentes. Insérées sous le tracé
// (beforeId = builder-route-border) pour rester au-dessus du fond mais sous l'itinéraire.
// Idempotente : appelée au toggle comme après un setStyle (qui efface tout).
function installOverlays() {
  if (!mapInstance) return
  const active = new Set(props.state.overlays)
  const beforeId = mapInstance.getLayer('builder-route-border') ? 'builder-route-border' : undefined
  for (const o of MAP_OVERLAYS) {
    const srcId = overlaySourceId(o.id)
    const lyrId = overlayLayerId(o.id)
    const present = !!mapInstance.getLayer(lyrId)
    if (active.has(o.id) && !present) {
      if (!mapInstance.getSource(srcId)) mapInstance.addSource(srcId, overlaySource(o) as any)
      mapInstance.addLayer({ id: lyrId, type: 'raster', source: srcId, paint: { 'raster-opacity': props.state.overlayOpacity } }, beforeId)
    } else if (!active.has(o.id) && present) {
      mapInstance.removeLayer(lyrId)
      if (mapInstance.getSource(srcId)) mapInstance.removeSource(srcId)
    }
  }
}

// Répercute l'opacité réglée (slider de la section « Couches (Suisse) ») sur toutes les
// couches overlay présentes. Appelée au changement du slider ; les nouvelles couches
// prennent l'opacité directement à l'installation (cf. installOverlays).
function applyOverlayOpacity() {
  if (!mapInstance) return
  for (const o of MAP_OVERLAYS) {
    const lyrId = overlayLayerId(o.id)
    if (mapInstance.getLayer(lyrId)) mapInstance.setPaintProperty(lyrId, 'raster-opacity', props.state.overlayOpacity)
  }
}
watch(() => props.state.overlayOpacity, applyOverlayOpacity)

function setOverlays(ids: string[]) {
  props.state.overlays = ids
  persistOverlays(ids, routeStore.sport.value)
  installOverlays()
}

// Bascule d'une couche depuis le menu Affichage (multi-sélection : plusieurs couches
// peuvent être actives). Délègue à setOverlays pour la persistance et le rendu.
function toggleOverlay(id: string) {
  const next = props.state.overlays.includes(id)
    ? props.state.overlays.filter((x) => x !== id)
    : [...props.state.overlays, id]
  setOverlays(next)
}

// Le sport gouverne le fond de carte, les overlays et l'aspect du tracé : en changer
// en cours d'édition réaligne la carte sur les préférences de cette pratique. Un
// changement de style réinstalle tout (style.load) ; sinon on repeint sur place.
watch(routeStore.sport, (sport) => {
  const { map, route } = sportPreferences(sport)
  const styleChanged = map.default_style !== props.state.mapStyleId
  props.state.overlays = [...map.overlays]
  if (styleChanged) {
    applyMapStyle(map.default_style)
    return
  }
  installOverlays()
  if (!mapInstance) return
  for (const id of ['builder-route-line', 'builder-route-straight-line']) {
    if (mapInstance.getLayer(id)) mapInstance.setPaintProperty(id, 'line-opacity', route.opacity)
  }
  applyColorMode()      // couleur du mode uni
  setRouteLineScale(1)  // épaisseurs dérivées de route.width
})

function toggleMap3D() {
  if (!mapInstance) return
  props.state.is3D = !props.state.is3D
  if (props.state.is3D) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    mapInstance.easeTo({ pitch: 60, bearing: -20, duration: 700 })
  } else {
    mapInstance.setTerrain(null)
    mapInstance.easeTo({ pitch: 0, bearing: 0, duration: 700 })
  }
}

async function toggleMapSize() {
  props.state.mapExpanded = !props.state.mapExpanded
  await nextTick()
  if (mapInstance) mapInstance.resize()
}

// ─── Toggles ──────────────────────────────────────────────────────────────────

function toggleWaypoints() {
  props.state.showWaypoints = !props.state.showWaypoints
  refreshWaypointMarkers()
  // Curseur « crosshair » seulement quand l'ajout de points est possible : masqué,
  // le clic ne fait rien, donc pas de curseur qui suggérerait l'ajout.
  if (mapInstance && !routeStore.readOnly.value) {
    mapInstance.getCanvas().style.cursor = props.state.showWaypoints ? 'crosshair' : ''
  }
}

function toggleClimbs() {
  props.state.showClimbs = !props.state.showClimbs
  installClimbMarkers()
}

// Affiche/masque les repères d'itinéraire (départ / arrivée / parking). Ferme un
// éventuel popup pour qu'il ne flotte pas sans marqueur après masquage.
function toggleMarkers() {
  props.state.showMarkers = !props.state.showMarkers
  if (!props.state.showMarkers && routeMarkerPopup) closeRouteMarkerPopup()
  // Masqué alors que le mode « poser un repère » est actif : le mode devient inerte,
  // on retire le curseur viseur qui suggérerait encore un ajout possible.
  if (!props.state.showMarkers && placeMarkerMode.value && mapInstance && !routeStore.readOnly.value) {
    mapInstance.getCanvas().style.cursor = ''
  }
  installRouteMarkers()
}

// Affiche/masque tous les marqueurs de POI : ceux trouvés le long du tracé
// (Overpass) et ceux enregistrés manuellement. La fermeture d'un éventuel popup
// évite qu'il flotte sans marqueur après le masquage.
function togglePois() {
  props.state.showPois = !props.state.showPois
  if (!props.state.showPois && savedPoiPopup) closeSavedPoiPopup()
  // Masqué alors que le mode « poser un POI » est actif : le mode devient inerte,
  // on retire le curseur viseur qui suggérerait encore un ajout possible.
  if (!props.state.showPois && placePoiMode.value && mapInstance && !routeStore.readOnly.value) {
    mapInstance.getCanvas().style.cursor = ''
  }
  installPlaceMarkers()
  installSavedPoiMarkers()
}

function toggleGrade() {
  props.state.colorMode = props.state.colorMode === 'grade' ? 'none' : 'grade'
  applyColorMode()
}

// Bascule la lecture seule manuelle. En l'activant, on referme les outils
// d'édition ouverts (sélection, survol, tooltips) puis on reconstruit les
// marqueurs de points et le curseur dans leur variante non éditable.
function toggleReadOnly() {
  if (routeStore.shareLocked.value) return
  routeStore.readOnly.value = !routeStore.readOnly.value
  if (routeStore.readOnly.value) {
    // La lecture seule masque le dropdown de mode : on revient au mode par défaut
    // pour ne pas rester bloqué en pose de POI/repère au retour en édition.
    setEditMode('route')
    deselectAll()
    hideHoverMarker()
    closePlacePopup()
    closeRoutePointPopup()
  }
  refreshWaypointMarkers()
  if (mapInstance) mapInstance.getCanvas().style.cursor = routeStore.readOnly.value ? '' : 'crosshair'
}

// ─── Search ───────────────────────────────────────────────────────────────────

// Liste ordonnée des pays privilégiés, configurée dans le profil
// (search.country_codes). L'ordre = la priorité d'affichage ; on la passe aussi
// en `countrycodes` à Nominatim pour qu'il ne renvoie d'abord que ces pays.
const PREFERRED_COUNTRIES = userPreferences().search.country_codes
const PREFERRED_COUNTRY_CODES = PREFERRED_COUNTRIES.join(',')
// Étendre la recherche au monde entier quand aucun résultat n'est trouvé dans les
// pays privilégiés (réglage du profil ; false par défaut).
const WORLDWIDE_FALLBACK = userPreferences().search.worldwide_fallback

// Rang de priorité d'un pays = sa position dans la liste du profil ; les pays
// hors liste (repli mondial) passent après tous les autres.
function searchCountryPriority(cc: string): number {
  const i = PREFERRED_COUNTRIES.indexOf(cc)
  return i === -1 ? PREFERRED_COUNTRIES.length : i
}

async function fetchPlaces(q: string, countrycodes?: string): Promise<any[]> {
  let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=10&addressdetails=1`
  if (countrycodes) url += `&countrycodes=${countrycodes}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return []
  const raw = await res.json()
  return Array.isArray(raw) ? raw : []
}

async function searchPlaces(q: string) {
  searching.value = true
  try {
    // On restreint d'abord aux pays privilégiés ; si Nominatim ne renvoie rien
    // (lieu hors zone) et que le repli mondial est activé, on refait une recherche
    // mondiale. Liste vide ⇒ recherche mondiale d'emblée (pas de second appel).
    let data = await fetchPlaces(q, PREFERRED_COUNTRY_CODES)
    if (data.length === 0 && PREFERRED_COUNTRY_CODES && WORLDWIDE_FALLBACK) data = await fetchPlaces(q)
    searchResults.value = data
      .sort((a, b) => searchCountryPriority(a.address?.country_code ?? '') - searchCountryPriority(b.address?.country_code ?? ''))
      .slice(0, 6)
    searchOpen.value = searchResults.value.length > 0
  } catch { searchResults.value = []; searchOpen.value = false }
  finally { searching.value = false }
}

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (trimmed.length < 3) { searchResults.value = []; searchOpen.value = false; return }
  searchTimer = setTimeout(() => searchPlaces(trimmed), 350)
})

function pickPlace(p: any) {
  searchOpen.value = false
  searchQuery.value = p.display_name.split(',')[0]
  if (!mapInstance) return
  if (p.boundingbox?.length === 4) {
    const [minLat, maxLat, minLng, maxLng] = p.boundingbox.map(parseFloat)
    mapInstance.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, duration: 800, maxZoom: 14 })
  } else {
    const lat = parseFloat(p.lat), lng = parseFloat(p.lon)
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) mapInstance.flyTo({ center: [lng, lat], zoom: 13, duration: 800 })
  }
}

function clearSearch() {
  searchQuery.value = ''; searchResults.value = []; searchOpen.value = false; searchExpanded.value = false
}

async function openSearch() {
  searchExpanded.value = true
  await nextTick()
  searchInputEl.value?.focus()
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

watch(selectionStore.selectionRange, () => {
  updateSelectionLayer()
  updateSelectionMarkers()
})

// Réagit aux toggles de filtre et au rafraîchissement de la liste des lieux.
watch(placesStore.filteredPlaces, () => installPlaceMarkers())

// Réagit à l'ajout/suppression de POI sauvegardés et à leurs bascules d'affichage.
watch(savedPoisStore.pois, () => installSavedPoiMarkers())
watch(savedPoisStore.show, () => installSavedPoiMarkers(), { deep: true })

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onBeforeUnmount(() => {
  waypointMarkers.forEach((m) => m.remove()); waypointMarkers.length = 0
  divergentMarkers.forEach((m) => m.remove()); divergentMarkers.length = 0
  climbMarkerObservers.forEach((obs) => obs.disconnect()); climbMarkerObservers.length = 0
  climbMarkers.forEach((m) => m.remove()); climbMarkers.length = 0
  clearTurnAnomalyMarkers()
  clearPlaceMarkers()
  clearSavedPoiMarkers()
  closeSavedPoiPopup()
  closeRoutePointPopup()
  closeCoordPopup()
  if (detachLongPress) { detachLongPress(); detachLongPress = null }
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null }
  if (locationMarker) { locationMarker.remove(); locationMarker = null }
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})

// ─── Expose ───────────────────────────────────────────────────────────────────

defineExpose({
  initMap,
  updateRouteLayer,
  setRouteLineScale,
  applyColorMode,
  installClimbMarkers,
  installPlaceMarkers,
  updateSelectionLayer,
  updateSelectionMarkers,
  applyAlternative,
  refreshWaypointMarkers,
  refreshRouteMarkers: installRouteMarkers,
  recomputeWaypointGeomIndices,
  fitMapToRoute,
  fitMapToSelection,
  flyTo,
  fitBounds,
  showChartCrossMarker,
  hideChartCrossMarker,
  showTurnAnomalyMarkers,
  clearTurnAnomalyMarkers,
  showSnapMarkers,
  showPlaceHoverMarker,
  hidePlaceHoverMarker,
  showPlacePopup,
  setMapStyle,
  resize: () => mapInstance?.resize(),
  getMapInstance: () => mapInstance,
})
</script>

<template>
  <div class="map-wrap" :class="{ expanded: state.mapExpanded, 'map-wrap--grey-basemap': state.mapStyleId === 'swissgrau' }">
    <div ref="mapEl" class="route-builder-map"></div>

    <div class="map-controls">
      <MapStyleDropdown :model-value="state.mapStyleId" :mobile-label="t('strava.map_style_short')" @update:model-value="setMapStyle"
        :open="openMenu === 'style'" @update:open="(v) => openMenu = v ? 'style' : null" />
      <!-- Menu « Affichage » : bascules de calques regroupées (façon menu des couches).
           Les actions de pose (POI / repère) restent des boutons dédiés, hors de ce menu. -->
      <div class="position-relative shadow-sm">
        <button type="button"
          class="btn btn-sm map-ctrl-btn map-ctrl-btn--labeled d-flex align-items-center gap-1"
          :class="openMenu === 'display' ? 'btn-warning text-dark' : 'btn-light'"
          :title="t('routes.display_label')"
          @click="openMenu = openMenu === 'display' ? null : 'display'">
          <i class="fa-solid fa-eye" aria-hidden="true"></i>
          <span>{{ t('routes.display_label') }}</span>
          <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
        </button>
        <ul v-if="openMenu === 'display'" class="dropdown-menu show mt-1" style="min-width: 14rem; z-index: 10;">
          <li><h6 class="dropdown-header">{{ t('routes.display_label') }}</h6></li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showWaypoints }" @click="toggleWaypoints">
              <i class="fa-solid" :class="state.showWaypoints ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-map-pin fa-fw" aria-hidden="true"></i>{{ t('routes.layer_waypoints') }}
            </button>
          </li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showClimbs }" @click="toggleClimbs">
              <i class="fa-solid" :class="state.showClimbs ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-mountain fa-fw" aria-hidden="true"></i>{{ t('routes.layer_climbs') }}
            </button>
          </li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showMarkers }" @click="toggleMarkers">
              <i class="fa-solid" :class="state.showMarkers ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-flag fa-fw" aria-hidden="true"></i>{{ t('routes.layer_markers') }}
            </button>
          </li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showPois }" @click="togglePois">
              <i class="fa-solid" :class="state.showPois ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-location-dot fa-fw" aria-hidden="true"></i>{{ t('routes.layer_pois') }}
            </button>
          </li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showGrade }" @click="toggleGrade">
              <i class="fa-solid" :class="state.showGrade ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-palette fa-fw" aria-hidden="true"></i>{{ t('routes.layer_grade') }}
            </button>
          </li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.is3D }" @click="toggleMap3D">
              <i class="fa-solid" :class="state.is3D ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-cube fa-fw" aria-hidden="true"></i>{{ t('strava.map_3d') }}
            </button>
          </li>
          <template v-if="!routeStore.shareLocked.value">
            <li><hr class="dropdown-divider" /></li>
            <li>
              <button type="button" class="dropdown-item d-flex align-items-center gap-2"
                :class="{ active: routeStore.readOnly.value }" @click="toggleReadOnly">
                <i class="fa-solid" :class="routeStore.readOnly.value ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
                <i class="fa-solid fa-lock fa-fw" aria-hidden="true"></i>{{ t('routes.layer_readonly') }}
              </button>
            </li>
          </template>
          <li><hr class="dropdown-divider" /></li>
          <li><h6 class="dropdown-header">{{ t('strava.overlay_label') }}</h6></li>
          <li v-for="o in MAP_OVERLAYS" :key="o.id">
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.overlays.includes(o.id) }" @click="toggleOverlay(o.id)">
              <i class="fa-solid" :class="state.overlays.includes(o.id) ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-fw" :class="o.icon" aria-hidden="true"></i>{{ t(`strava.overlay_${o.id}`) }}
            </button>
          </li>
          <li>
            <div class="dropdown-item-text px-3 py-1">
              <label for="overlay-opacity-slider" class="d-flex align-items-center gap-2 mb-1 small text-muted">
                <i class="fa-solid fa-droplet fa-fw" aria-hidden="true"></i>{{ t('routes.layer_opacity') }}
                <span class="ms-auto">{{ Math.round(state.overlayOpacity * 100) }}%</span>
              </label>
              <input id="overlay-opacity-slider" type="range" class="form-range" min="0.05" max="1" step="0.05"
                :value="state.overlayOpacity"
                @input="state.overlayOpacity = ($event.target as HTMLInputElement).valueAsNumber" />
            </div>
          </li>
          <li class="d-none d-md-block"><hr class="dropdown-divider" /></li>
          <li class="d-none d-md-block">
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showStatsSidebar }" @click="state.showStatsSidebar = !state.showStatsSidebar">
              <i class="fa-solid" :class="state.showStatsSidebar ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-chart-simple fa-fw" aria-hidden="true"></i>{{ t('routes.layer_stats_sidebar') }}
            </button>
          </li>
          <li class="d-none d-md-block">
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: state.showElevationChart }" @click="$emit('toggle-chart')">
              <i class="fa-solid" :class="state.showElevationChart ? 'fa-square-check' : 'fa-square'" aria-hidden="true"></i>
              <i class="fa-solid fa-chart-area fa-fw" aria-hidden="true"></i>{{ t('routes.layer_elevation_chart') }}
            </button>
          </li>
        </ul>
      </div>
      <!-- Menu « Mode d'édition » : détermine l'effet d'un clic sur la carte (modifier
           l'itinéraire / poser un POI / poser un repère). Masqué en lecture seule. -->
      <div v-if="!routeStore.readOnly.value" class="position-relative shadow-sm">
        <button type="button"
          class="btn btn-sm map-ctrl-btn map-ctrl-btn--labeled d-flex align-items-center gap-1"
          :class="editMode === 'route' ? 'btn-light' : 'btn-warning text-dark'"
          :title="t('routes.edit_mode_label')"
          @click="openMenu = openMenu === 'edit' ? null : 'edit'">
          <i class="fa-solid" :class="currentEditMode.icon" aria-hidden="true"></i>
          <span>{{ t('routes.edit_mode_short') }}</span>
          <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
        </button>
        <ul v-if="openMenu === 'edit'" class="dropdown-menu show mt-1" style="min-width: 13rem; z-index: 10;">
          <li><h6 class="dropdown-header">{{ t('routes.edit_mode_label') }}</h6></li>
          <li v-for="m in EDIT_MODES" :key="m.mode">
            <button type="button" class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: editMode === m.mode }" @click="setEditMode(m.mode)">
              <i class="fa-solid" :class="editMode === m.mode ? 'fa-circle-dot' : 'fa-circle'" aria-hidden="true"></i>
              <i class="fa-solid fa-fw" :class="m.icon" aria-hidden="true"></i>{{ t(m.labelKey) }}
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div class="map-controls-right">
      <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
        <button type="button" class="btn btn-light map-ctrl-btn"
          :disabled="!routeStore.hasGeometry.value"
          @click="fitMapToRoute"
          title="Recentrer sur le trajet">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn map-ctrl-btn"
          :class="locationVisible ? 'btn-warning text-dark active' : 'btn-light'"
          @click="toggleLocation"
          :disabled="locating"
          :title="locationVisible ? 'Masquer ma position' : 'Ma position'"
          :aria-pressed="locationVisible">
          <span v-if="locating" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          <i v-else class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn map-ctrl-btn d-none d-md-flex"
          :class="state.mapExpanded ? 'btn-warning text-dark active' : 'btn-light'"
          @click="toggleMapSize"
          :title="state.mapExpanded ? t('strava.shrink_map') : t('strava.expand_map')"
          :aria-pressed="state.mapExpanded">
          <i :class="state.mapExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" aria-hidden="true"></i>
        </button>
      </div>
    </div>

    <!-- Search -->
    <div v-if="!routeStore.readOnly.value" class="map-search" :class="{ 'map-search--expanded': searchExpanded }">
      <button v-if="!searchExpanded" type="button" class="btn btn-light btn-sm shadow-sm map-search-toggle" @click="openSearch" :title="t('routes.search_placeholder')">
        <i class="fa-solid fa-magnifying-glass"></i>
      </button>
      <template v-else>
        <div class="input-group input-group-sm shadow-sm">
          <span class="input-group-text bg-white">
            <i v-if="searching" class="fa-solid fa-circle-notch fa-spin"></i>
            <i v-else class="fa-solid fa-magnifying-glass"></i>
          </span>
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="search"
            class="form-control"
            :placeholder="t('routes.search_placeholder')"
            @focus="searchOpen = searchResults.length > 0"
            @blur="!searchQuery && clearSearch()"
            @keydown.escape="clearSearch"
            @keydown.enter.prevent="searchResults[0] && pickPlace(searchResults[0])"
          />
          <button type="button" class="btn btn-light" @click="clearSearch" :title="t('routes.clear')">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <ul v-if="searchOpen" class="map-search-results shadow">
          <li v-for="p in searchResults" :key="p.place_id" @click="pickPlace(p)" class="map-search-result">
            <i class="fa-solid fa-location-dot text-muted me-2"></i>
            <span>{{ p.display_name }}</span>
          </li>
        </ul>
      </template>
    </div>

    <!-- Overlays -->
    <div v-if="routeStore.waypoints.value.length === 0" class="map-overlay-hint">
      <i class="fa-solid fa-hand-pointer" aria-hidden="true"></i>
      <span>{{ t('routes.click_hint') }}</span>
    </div>
    <div v-if="routeStore.isFetchingRoute.value || routeStore.isFetchingElevation.value || placesStore.isFetchingPlaces.value" class="map-overlay-loading">
      <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
      <span v-if="routeStore.isFetchingRoute.value">{{ t('routes.computing_route') }}</span>
      <span v-else-if="routeStore.isFetchingElevation.value">{{ t('routes.computing_elevation') }}</span>
      <span v-else>{{ t('routes.places_loading') }}</span>
    </div>
    <!-- Échec chargement POI — affiché uniquement sur mobile, la sidebar gérant le cas sur desktop -->
    <button
      v-if="placesStore.placesFetchFailed.value"
      type="button"
      class="map-overlay-places-error"
      @click="emit('retry-places')"
    >
      <span>{{ t('routes.places_error') }}</span>
      <span class="map-overlay-places-retry">
        <i class="fa-solid fa-rotate-right me-1" aria-hidden="true"></i>{{ t('routes.places_retry') }}
      </span>
    </button>

    <!-- Mobile stats toggle -->
    <button type="button" class="btn btn-light btn-sm shadow-sm mobile-sheet-toggle" @click="$emit('toggle-mobile-sheet')">
      <i :class="`fa-solid ${sportIcon()} me-1`" aria-hidden="true"></i>
      <i class="fa-solid fa-chart-area me-1" aria-hidden="true"></i>
      <span v-if="routeStore.hasGeometry.value">
        {{ routeStore.distanceM.value >= 1000 ? (routeStore.distanceM.value / 1000).toFixed(2) + ' km' : Math.round(routeStore.distanceM.value) + ' m' }}
        · +{{ Math.round(routeStore.elevGainM.value) }} m
      </span>
      <span v-else>Stats</span>
    </button>

    <!-- Dialogue de création d'un POI sauvegardé (mode « poser un POI ») -->
    <div v-if="poiDialog" class="poi-dialog-backdrop" @click.self="poiDialog = null">
      <div class="poi-dialog card shadow">
        <div class="card-body">
          <h6 class="mb-2">{{ t('routes.place_poi') }}</h6>
          <input v-model="poiDialog.name" class="form-control form-control-sm mb-2"
            :placeholder="t('routes.poi_name')" autofocus @keyup.enter="savePoiFromDialog" />
          <select v-model="poiDialog.category" class="form-select form-select-sm mb-3">
            <option v-for="c in POI_CATS" :key="c.key" :value="c.key">{{ t(`profile.poi.${c.labelKey}`) }}</option>
          </select>
          <div class="d-flex gap-2 justify-content-end">
            <button type="button" class="btn btn-sm btn-light" @click="poiDialog = null">{{ t('routes.cancel') }}</button>
            <button type="button" class="btn btn-sm btn-primary" @click="savePoiFromDialog">{{ t('routes.save_poi') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Dialogue de création d'un repère (mode « poser un repère ») -->
    <div v-if="markerDialog" class="poi-dialog-backdrop" @click.self="markerDialog = null">
      <div class="poi-dialog card shadow">
        <div class="card-body">
          <h6 class="mb-2">{{ t('routes.place_marker') }}</h6>
          <select v-model="markerDialog.kind" class="form-select form-select-sm mb-2">
            <option v-for="m in MARKER_KIND_LIST" :key="m.kind" :value="m.kind">{{ t(m.labelKey) }}</option>
          </select>
          <input v-model="markerDialog.label" class="form-control form-control-sm mb-3"
            :placeholder="t('routes.marker_label')" @keyup.enter="saveMarkerFromDialog" />
          <div class="d-flex gap-2 justify-content-end">
            <button type="button" class="btn btn-sm btn-light" @click="markerDialog = null">{{ t('routes.cancel') }}</button>
            <button type="button" class="btn btn-sm btn-primary" @click="saveMarkerFromDialog">{{ t('routes.save_poi') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Surimpressions du parent (pile d'alertes). Elles vivent DANS .map-wrap et non à
         côté : en plein écran .map-wrap passe en position:fixed + z-index 1020, donc tout
         élément resté dehors se retrouve à la fois mal positionné et derrière la carte.
         En dernier dans le DOM pour passer au-dessus du reste de la carte. -->
    <slot name="overlays"></slot>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.map-wrap.expanded {
  position: fixed;
  top: 4rem;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1020;
  background: #fff;
  box-shadow: 0 -2px 20px rgba(0,0,0,0.2);
}
.route-builder-map {
  flex: 1;
  min-height: 0;
  width: 100%;
}
.map-controls {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
  pointer-events: none;
}
.map-controls > * { pointer-events: auto; }
.map-controls-right {
  position: absolute;
  top: 56px;
  right: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-end;
  pointer-events: none;
}
.map-controls-right > * { pointer-events: auto; }
.map-ctrl-btn {
  background: #ffffff;
  border-color: rgba(0,0,0,0.08);
  width: 34px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
}
/* Déclencheur de menu avec libellé (« Affichage ») : on relâche le carré fixe pour
   laisser la place à l'icône + le texte, comme le bouton « Fond de carte ». */
.map-ctrl-btn--labeled {
  width: auto;
  aspect-ratio: auto;
  padding: 0.25rem 0.5rem;
}
/* Les trois menus de la colonne gauche (Fond de carte, Affichage, Mode) partagent la
   même largeur sur desktop, et leur chevron est aligné au bord droit. Le bouton du
   fond de carte vit dans un composant enfant → :deep pour l'atteindre. Ciblé au
   contexte de la carte du créateur (MapStyleDropdown est réutilisé ailleurs). */
.map-controls :deep(.map-ctrl-btn) > i:last-child { margin-left: auto; }
/* Largeur commune aux trois menus, chevron aligné à droite. Plus compacte sur mobile
   (libellés courts : « Carte » / « Affichage » / « Mode ») que sur desktop
   (« Fond de carte »). */
.map-controls :deep(.map-ctrl-btn) { min-width: 7.5rem; }
@media (min-width: 768px) {
  .map-controls :deep(.map-ctrl-btn) { min-width: 9.5rem; }
}
.map-ctrl-btn.active,
.map-ctrl-btn.active:hover,
.map-ctrl-btn.active:focus {
  background: #ffc107;
  color: #212529;
  border-color: rgba(252,76,2,0.7);
}
.map-search {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.map-search--expanded { width: min(420px, calc(100% - 220px)); }
.map-search-toggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; }
.map-search-results {
  list-style: none;
  margin: 6px 0 0;
  padding: 0.25rem 0;
  background: #fff;
  border-radius: 0.4rem;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.85rem;
}
.map-search-result {
  padding: 0.4rem 0.7rem;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 0.3rem;
  border-bottom: 1px solid rgba(0,0,0,0.04);
}
.map-search-result:last-child { border-bottom: 0; }
.map-search-result:hover { background: rgba(252,76,2,0.08); }
.map-overlay-hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(33,37,41,0.88);
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  pointer-events: none;
  z-index: 4;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}
.map-overlay-loading {
  position: absolute;
  top: 12px;
  right: 60px;
  background: rgba(255,255,255,0.95);
  padding: 0.4rem 0.8rem;
  border-radius: 999px;
  font-size: 0.8rem;
  z-index: 5;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  display: flex;
  align-items: center;
}
/* Sur mobile, l'indicateur de chargement (tracé / altitude / POI) passe en bas à
   droite, clairement au-dessus de l'attribution (qui occupe ~10–34px du bas) pour
   ne pas la recouvrir, et libérer le haut de la carte. */
@media (max-width: 767px), (max-height: 500px) {
  .map-overlay-loading {
    top: auto;
    right: 8px;
    bottom: 5px;
  }
}
.mobile-sheet-toggle {
  position: absolute;
  bottom: 5px;
  left: 5px;
  z-index: 6;
  white-space: nowrap;
  display: none;
}
@media (max-width: 767px), (max-height: 500px) { .mobile-sheet-toggle { display: flex; } }

/* Fond swisstopo gris : les contrôles blancs se fondent dans la carte. On les passe
   en jaune (fond + bordure) pour les redétacher. Le bouton du fond de carte vit dans
   MapStyleDropdown → :deep pour l'atteindre. */
.map-wrap--grey-basemap :deep(.map-ctrl-btn),
.map-wrap--grey-basemap .map-search-toggle,
.map-wrap--grey-basemap .mobile-sheet-toggle,
.map-wrap--grey-basemap :deep(.map-ctrl-btn:hover),
.map-wrap--grey-basemap .map-search-toggle:hover,
.map-wrap--grey-basemap .mobile-sheet-toggle:hover {
  background: #ffc107;
  border: 2px solid #ffc107;
  color: #212529;
}
.map-wrap--grey-basemap :deep(.map-ctrl-btn:hover),
.map-wrap--grey-basemap .map-search-toggle:hover,
.map-wrap--grey-basemap .mobile-sheet-toggle:hover {
  background: #ffcd39;
  border-color: #ffcd39;
}
/* Recherche dépliée : la loupe (préfixe du champ) et le bouton de fermeture suivent
   le même traitement ; le champ garde son fond blanc mais une bordure jaune, sinon
   il se détacherait des deux boutons. `.bg-white` étant !important, on surcharge. */
.map-wrap--grey-basemap .map-search .input-group-text,
.map-wrap--grey-basemap .map-search .btn-light {
  background: #ffc107 !important;
  border: 2px solid #ffc107;
  color: #212529;
}
.map-wrap--grey-basemap .map-search .btn-light:hover {
  background: #ffcd39 !important;
  border-color: #ffcd39;
}
.map-wrap--grey-basemap .map-search .form-control {
  border-top: 2px solid #ffc107;
  border-bottom: 2px solid #ffc107;
}
.map-wrap--grey-basemap .map-search-results {
  border: 2px solid #ffc107;
}

/* Bannière d'échec de chargement des POI — visible uniquement sur mobile,
   la sidebar Stats (masquée sur mobile) gérant déjà le cas sur desktop. */
.map-overlay-places-error {
  position: absolute;
  bottom: 5px;
  right: 8px;
  display: none;
  align-items: center;
  gap: 0.6rem;
  background: rgba(33,37,41,0.9);
  color: #fff;
  border: none;
  padding: 0.45rem 0.9rem;
  border-radius: 999px;
  font-size: 0.8rem;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}
.map-overlay-places-retry { color: #6ea8fe; font-weight: 600; white-space: nowrap; }
@media (max-width: 767px) { .map-overlay-places-error { display: flex; } }

/* Dialogue de création d'un POI sauvegardé (mode « poser un POI »). */
.poi-dialog-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
}
.poi-dialog { width: min(320px, 90%); border: none; }
</style>

<style>
/* JS-created DOM elements — must be global (not scoped) */
.wp-marker {
  position: relative;
  width: 28px;
  height: 28px;
  cursor: pointer;
}
.wp-marker-num {
  position: absolute;
  top: 1px;
  left: 1px;
  transform: scale(var(--wp-scale, 1));
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fc4c02;
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0,0,0,0.35);
}
.wp-marker--free .wp-marker-num {
  background: #a855f7;
}
.wp-marker--selected .wp-marker-num {
  background: #1d4ed8;
  box-shadow: 0 0 0 3px rgba(29,78,216,0.32), 0 2px 6px rgba(0,0,0,0.35);
}
.wp-marker--free.wp-marker--selected .wp-marker-num {
  background: #9333ea;
  box-shadow: 0 0 0 3px rgba(168,85,247,0.32), 0 2px 6px rgba(0,0,0,0.35);
}
.wp-tooltip {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.10);
  padding: 4px 4px 4px;
  display: none;
  flex-direction: column;
  gap: 2px;
  min-width: 190px;
  z-index: 20;
  white-space: nowrap;
  pointer-events: auto;
}
.wp-marker--selected .wp-tooltip { display: flex; }
.wp-tooltip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.2rem 0.65rem 0.2rem 0.65rem;
  gap: 0.5rem;
  border-bottom: 1px solid rgba(0,0,0,0.07);
  margin-bottom: 2px;
}
.wp-tooltip-title { font-size: 0.78rem; font-weight: 600; color: #6b7280; display: flex; align-items: center; }
.wp-tooltip-num-input {
  width: 3.2em;
  margin-left: 0.25em;
  padding: 1px 4px;
  font-size: 0.78rem;
  font-weight: 700;
  color: #111827;
  text-align: center;
  border: 1px solid rgba(0,0,0,0.18);
  border-radius: 6px;
  background: #fff;
}
.wp-tooltip-num-input:focus {
  outline: none;
  border-color: #fc4c02;
  box-shadow: 0 0 0 2px rgba(252,76,2,0.18);
}
.wp-tooltip-close {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0,0,0,0.07);
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
.wp-tooltip-close:hover { background: rgba(0,0,0,0.14); color: #111827; }
.wp-tooltip-arrow {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-top: 7px solid #fff;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,0.10));
}
.wp-tooltip-action {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.65rem;
  border-radius: 7px;
  font-size: 0.8rem;
  font-weight: 500;
  text-decoration: none;
  color: #212529;
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  line-height: 1;
  transition: background 0.1s;
}
.wp-tooltip-action i { width: 14px; text-align: center; font-size: 0.78rem; flex-shrink: 0; }
.wp-tooltip-action:hover { background: rgba(0,0,0,0.06); color: #212529; }
.wp-tooltip-action--komoot i { color: #6aaf23; }
.wp-tooltip-action--delete { color: #dc2626; }
.wp-tooltip-action--delete:hover { background: rgba(220,38,38,0.08); color: #dc2626; }
.wp-tooltip-action--disabled { opacity: 0.38; pointer-events: none; cursor: default; }
.wp-tooltip-coords-row { display: flex; gap: 0.25rem; }
.wp-tooltip-coords-row .wp-tooltip-action { width: auto; flex: 1 1 0; min-width: 0; gap: 0.4rem; padding-right: 0.45rem; }
.wp-tooltip-coords { display: flex; align-items: baseline; gap: 0.3rem; min-width: 0; font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
.wp-tooltip-coord-label { font-size: 0.66rem; font-weight: 600; text-transform: uppercase; color: #6c757d; flex-shrink: 0; }
.wp-tooltip-coords--copied { color: #16a34a; }
.divergent-warning-marker {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #d62828;
  color: #fff;
  border: 2px solid #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  font-size: 0.78rem;
  cursor: help;
}
.climb-marker {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  background: rgba(255,255,255,0.96);
  padding: 0.18rem 0.45rem 0.18rem 0.4rem;
  border-radius: 12px;
  font-size: 0.72rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  border: 1.5px solid currentColor;
  box-shadow: 0 3px 8px -3px rgba(0,0,0,0.35);
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
  transform-origin: bottom left;
  transition: box-shadow 0.1s ease;
}
.climb-marker:hover { box-shadow: 0 6px 14px -3px rgba(0,0,0,0.45); }
.climb-marker i { font-size: 0.74rem; }
.climb-marker .climb-marker-stats { color: #212529; }
.climb-marker .climb-marker-cat {
  background: currentColor;
  color: #fff !important;
  padding: 0 0.3rem;
  border-radius: 999px;
  font-size: 0.6rem;
  letter-spacing: 0.02em;
  min-width: 0.85rem;
  text-align: center;
}
.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }
/* Repère d'itinéraire (départ / arrivée / parking) : pastille à libellé toujours
   visible, calquée sur .climb-marker, colorée par le type (currentColor). */
.route-marker {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  background: rgba(255,255,255,0.96);
  padding: 0.18rem 0.5rem 0.18rem 0.42rem;
  border-radius: 12px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
  border: 1.5px solid currentColor;
  box-shadow: 0 3px 8px -3px rgba(0,0,0,0.35);
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
  transform-origin: bottom left;
  transition: box-shadow 0.1s ease;
}
.route-marker:hover { box-shadow: 0 6px 14px -3px rgba(0,0,0,0.45); }
.route-marker i { font-size: 0.74rem; }
.route-marker .route-marker-label { color: #212529; }
.place-marker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid currentColor;
  box-shadow: 0 3px 8px -2px rgba(0,0,0,0.4);
  cursor: pointer;
  user-select: none;
  transform-origin: bottom center;
  transition: box-shadow 0.1s ease;
}
.place-marker i { font-size: 0.78rem; }
/* POI sauvegardé : badge étoile en haut à droite pour le distinguer d'un POI Overpass. */
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
.place-marker--saved { position: relative; }
/* Survol souris, surbrillance synchronisée (carte ou liste) ou popup ouvert : le
   marqueur s'inverse — le fond se remplit de sa couleur, l'icône passe en blanc. */
.place-marker:hover,
.place-marker--hover,
.place-marker--active { background: currentColor; box-shadow: 0 6px 14px -3px rgba(0,0,0,0.5); }
.place-marker:hover i,
.place-marker--hover i,
.place-marker--active i { color: #fff; }
/* La couleur de chaque marqueur est posée en inline depuis le registre POI
   (poiCategories.ts) ; currentColor pilote la bordure et le remplissage au survol. */
/* Sur petit écran tactile, on agrandit légèrement les marqueurs (points POI et points du
   tracé) pour offrir une cible de clic plus généreuse et éviter les clics au mauvais endroit. */
@media (max-width: 767px) {
  .wp-marker { width: 36px; height: 36px; }
  .wp-marker-num { top: 3px; left: 3px; width: 30px; height: 30px; font-size: 0.82rem; }
  .place-marker { width: 32px; height: 32px; }
  .place-marker i { font-size: 0.92rem; }
}
.place-popup-container .maplibregl-popup-content {
  padding: 4px;
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.10);
}
.place-popup { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
.place-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.2rem 0.65rem;
  border-bottom: 1px solid rgba(0,0,0,0.07);
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
  background: rgba(0,0,0,0.07);
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
.place-popup-close:hover { background: rgba(0,0,0,0.14); color: #111827; }
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
.place-popup-link:hover { background: rgba(0,0,0,0.06); color: #212529; text-decoration: none; }
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
/* « Ajouter à l'itinéraire » : action d'insertion d'un point (POI / clic droit) dans
   le tracé, mise en avant en violet (couleur du tracé). */
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
.place-popup-coords-row { display: flex; gap: 0.25rem; }
.place-popup-coords-row .place-popup-link { width: auto; flex: 1 1 0; min-width: 0; gap: 0.4rem; }
.place-popup-coords-row .place-popup-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.route-insert-marker {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(252,76,2,0.95);
  border: 2px solid #fff;
  color: #fff;
  font-size: 0.7rem;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  pointer-events: none;
  transform: translateY(-1px);
}
.chart-cross-marker {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fc4c02;
  border: 2px solid #fff;
  box-shadow: 0 2px 6px rgba(0,0,0,0.45);
  pointer-events: none;
}
/* Repère d'un point accroché au loin. Même gabarit que le marqueur d'amas mais en jaune,
   pour reprendre le code couleur de son alerte (map-notice--warning). */
.snap-warning-marker {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #f59e0b;
  border: 2px solid #fff;
  color: #422006;
  font-size: 0.8rem;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.45);
  pointer-events: none;
}
.turn-anomaly-marker {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #dc2626;
  border: 2px solid #fff;
  color: #fff;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  pointer-events: none;
  animation: turn-anomaly-pulse 1.4s ease-in-out infinite;
}
@keyframes turn-anomaly-pulse {
  0%, 100% { box-shadow: 0 2px 8px rgba(0,0,0,0.5), 0 0 0 0 rgba(220,38,38,0.55); }
  50% { box-shadow: 0 2px 8px rgba(0,0,0,0.5), 0 0 0 10px rgba(220,38,38,0); }
}
.user-location-dot {
  width: 16px;
  height: 16px;
  background: #4285f4;
  border: 2.5px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(66,133,244,0.35);
}
.sel-flag-marker { cursor: grab; }
.sel-flag-marker:active { cursor: grabbing; }
/* Icône d'attribution (compacte) en bas à droite de la carte : marge resserrée à 5px. */
.maplibregl-ctrl-bottom-right .maplibregl-ctrl { margin: 0 5px 5px 0; }
</style>
