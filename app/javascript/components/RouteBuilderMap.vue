<script setup lang="ts">
import { ref, watch, onBeforeUnmount, useTemplateRef, nextTick } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, ROUTE_LINE_LAYOUT, ROUTE_BORDER_PAINT } from '../mapStyles'
import { RouteBuilderState } from '../pageState'
import MapStyleDropdown from './MapStyleDropdown.vue'
import { routeStore } from '../stores/routeStore'
import { selectionStore } from '../stores/selectionStore'
import { placesStore } from '../stores/placesStore'
import type { Place } from '../stores/placesStore'
import {
  GRADE_BUCKETS, haversine, buildGradedSegments, geomIdxForKm, generateCircle,
} from '../routeHelpers'
import type { Climb } from '../routeHelpers'

const props = defineProps<{ state: RouteBuilderState }>()
const emit = defineEmits<{
  'waypoints-changed': []
  'select-place': [place: Place]
  'hover-place': [place: Place | null]
}>()

const mapEl = useTemplateRef('mapEl')

let mapInstance: any = null
let _maplibregl: any = null
const waypointMarkers: any[] = []
let hoverMarker: any = null
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
let climbHoverStartMarker: any = null
let climbHoverEndMarker: any = null
let placeHoverMarker: any = null
let chartCrossMarker: any = null
let selectionMarkerA: any = null
let selectionMarkerB: any = null
let selectionMarkerAKm: number | null = null
let selectionMarkerBKm: number | null = null
let selectionMarkerDragging = false
const climbMarkers: any[] = []
const climbMarkerObservers: MutationObserver[] = []
const placeMarkers: any[] = []
const placeMarkerObservers: MutationObserver[] = []
let placePopup: any = null
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

const wtExpanded = ref(false)
const wtQuery = ref('')
const wtResults = ref<any[]>([])
const wtSearching = ref(false)
const wtImportingId = ref<number | null>(null)
const wtGeomCache = new Map<number, Array<[number, number]>>()
let wtPreviewTimeout: ReturnType<typeof setTimeout> | null = null
const WT_BASE = 'https://cycling.waymarkedtrails.org/api/v1'

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const EU_COUNTRY_CODES = new Set([
  'at','be','bg','cy','cz','de','dk','ee','es','fi','gr','hr','hu','ie',
  'it','lt','lu','lv','mt','nl','pl','pt','ro','se','si','sk',
  'al','ba','gb','li','me','mk','no','rs','xk',
])

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
    ...({ preserveDrawingBuffer: true } as any),
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showZoom: false }), 'top-right')
  mapInstance.on('styleimagemissing', (e: any) => {
    mapInstance.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  await new Promise<void>((resolve) => {
    mapInstance.on('load', () => {
      installRouteLayer()
      installPreviewLayer()
      mapInstance.on('click', (e: any) => {
        if (suppressNextMapClick) { suppressNextMapClick = false; return }
        deselectAll()
        if (selectionStore.hoverIdx.value != null) {
          insertWaypointAtGeomIdx(selectionStore.hoverIdx.value)
        } else {
          addWaypoint(e.lngLat.lng, e.lngLat.lat)
        }
      })
      mapInstance.on('mousemove', (e: any) => {
        if (overClimbMarker) { hideHoverMarker(); return }
        if (routeStore.waypoints.value.length < 2) { hideHoverMarker(); return }
        const idx = nearestGeomIndexAt(e.point)
        if (idx == null) { hideHoverMarker(); return }
        if (isNearWaypoint(e.point)) { hideHoverMarker(); return }
        selectionStore.hoverIdx.value = idx
        showHoverMarker(routeStore.geometry.value[idx])
      })
      mapInstance.on('mouseout', hideHoverMarker)
      mapInstance.on('moveend', () => { if (!routeStore.currentId.value) saveMapView() })
      const applyMarkerScale = () => {
        const z = mapInstance.getZoom()
        const scale = Math.max(0.35, Math.min(1, (z - 5) / 9))
        mapInstance.getContainer().style.setProperty('--wp-scale', String(scale))
      }
      mapInstance.on('zoom', applyMarkerScale)
      applyMarkerScale()
      mapInstance.getCanvas().style.cursor = 'crosshair'
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
    mapInstance.addLayer({ id: 'builder-route-line', type: 'line', source: 'builder-route-graded', layout: ROUTE_LINE_LAYOUT, paint: { 'line-color': gradePaintExpression(), 'line-width': 5 } })
  }
  if (!mapInstance.getSource('builder-divergent')) {
    mapInstance.addSource('builder-divergent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    mapInstance.addLayer({ id: 'builder-divergent-line', type: 'line', source: 'builder-divergent', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#d62828', 'line-width': 4, 'line-dasharray': [1.4, 1.4] } })
  }
  if (!mapInstance.getSource('builder-route-selected')) {
    mapInstance.addSource('builder-route-selected', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
    mapInstance.addLayer({ id: 'builder-route-selected-line', type: 'line', source: 'builder-route-selected', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#00b4d8', 'line-width': 7 } })
  }
}

// Épaisseurs natives (px écran) des couches de tracé. Utilisé par l'export image pour
// élargir le tracé proportionnellement à la résolution, sinon il devient invisible.
const ROUTE_LINE_BASE_WIDTH: Record<string, number> = {
  'builder-route-border': 8,
  'builder-route-line': 5,
  'builder-route-selected-line': 7,
  'builder-divergent-line': 4,
}
function setRouteLineScale(factor: number) {
  if (!mapInstance) return
  for (const [id, base] of Object.entries(ROUTE_LINE_BASE_WIDTH)) {
    if (mapInstance.getLayer(id)) mapInstance.setPaintProperty(id, 'line-width', base * factor)
  }
}

function updateRouteLayer() {
  if (!mapInstance) return
  const baseSrc = mapInstance.getSource('builder-route')
  if (baseSrc) {
    baseSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeStore.geometry.value.map(([lng, lat]) => [lng, lat]) } })
  }
  applyColorMode()
}

function applyColorMode() {
  if (!mapInstance) return
  const src = mapInstance.getSource('builder-route-graded')
  if (!src) return
  const coords = routeStore.geometry.value.map(([lng, lat]: any) => [lng, lat])
  let features: any[] = []
  let paint: any = '#fc4c02'
  if (props.state.colorMode === 'grade' && coords.length >= 2) {
    const altitudes = routeStore.geometry.value.map((c) => c[2])
    const distances = [0]
    let cum = 0
    for (let i = 1; i < routeStore.geometry.value.length; i++) {
      cum += haversine(routeStore.geometry.value[i - 1], routeStore.geometry.value[i])
      distances.push(cum)
    }
    features = buildGradedSegments(coords, altitudes, distances)
    paint = gradePaintExpression()
  } else if (coords.length >= 2) {
    features = [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
  }
  src.setData({ type: 'FeatureCollection', features })
  if (mapInstance.getLayer('builder-route-line')) mapInstance.setPaintProperty('builder-route-line', 'line-color', paint)
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
    updateSelectionLayer()
    fitMapToSelection()
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  el.addEventListener('mouseenter', () => { overClimbMarker = true; hideHoverMarker(); updateClimbHoverLayer(climb) })
  el.addEventListener('mouseleave', () => { overClimbMarker = false; updateClimbHoverLayer(null) })
  return el
}

// ─── Place markers (cimetières / boulangeries) ─────────────────────────────────

function clearPlaceMarkers() {
  placeMarkerObservers.forEach((obs) => obs.disconnect()); placeMarkerObservers.length = 0
  placeMarkers.forEach((m) => m.remove()); placeMarkers.length = 0
  if (placePopup) { placePopup.remove(); placePopup = null }
}

// Popup proposant d'ouvrir le lieu sur Google Maps, comme les points de l'itinéraire
// (même format d'URL `maps?q=lat,lng`).
function showBakeryReviewsPopup(place: Place) {
  if (!_maplibregl || !mapInstance) return
  if (placePopup) { placePopup.remove(); placePopup = null }
  // Décalage de ~15 m : centrée pile sur le lieu, l'épingle rouge de Google masque
  // le POI boulangerie. On vise juste à côté pour le laisser visible/cliquable.
  const OFFSET = 0.00008
  const url = `https://www.google.com/maps?q=${place.lat + OFFSET},${place.lng + OFFSET}`
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  wrap.innerHTML = `
    <div class="place-popup-name">${escapeHtml(place.name)}</div>
    <a class="place-popup-link" href="${url}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>`
  placePopup = new _maplibregl.Popup({ offset: 18, closeButton: true, closeOnClick: true, className: 'place-popup-container' })
    .setLngLat([place.markerLng, place.markerLat])
    .setDOMContent(wrap)
    .addTo(mapInstance)
}

function escapeHtml(s: string) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

// Rend une icône persistante et cliquable pour chaque cimetière/boulangerie filtré.
// Réutilise le pattern des marqueurs de cols (observateur de scale au zoom).
function installPlaceMarkers() {
  if (!_maplibregl || !mapInstance) return
  clearPlaceMarkers()
  for (const place of placesStore.filteredPlaces.value) {
    if (place.type !== 'cemetery' && place.type !== 'bakery') continue
    const el = buildPlaceMarkerEl(place)
    const marker = new _maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([place.markerLng, place.markerLat])
      .addTo(mapInstance)
    placeMarkerObservers.push(attachClimbMarkerScaleObserver(el))
    placeMarkers.push(marker)
  }
}

function buildPlaceMarkerEl(place: Place) {
  const el = document.createElement('div')
  const icon = place.type === 'cemetery' ? 'fa-cross' : 'fa-bread-slice'
  el.className = `place-marker place-marker--${place.type}`
  el.title = place.name
  el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    emit('select-place', place)
    if (place.type === 'bakery') showBakeryReviewsPopup(place)
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

function showPlaceHoverMarker(lng: number, lat: number, distanceM: number) {
  if (!_maplibregl || !mapInstance) return
  if (!placeHoverMarker) {
    const el = document.createElement('div')
    el.className = 'place-hover-marker'
    placeHoverMarker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(mapInstance)
  } else {
    placeHoverMarker.setLngLat([lng, lat])
    placeHoverMarker.getElement().style.display = ''
  }
  placesStore.placeHoverKm = distanceM / 1000
}

function hidePlaceHoverMarker() {
  if (placeHoverMarker) placeHoverMarker.getElement().style.display = 'none'
  placesStore.placeHoverKm = null
}

function updateClimbHoverLayer(climb: Climb | null) {
  if (!_maplibregl || !mapInstance) return
  if (!climb) {
    if (climbHoverStartMarker) { climbHoverStartMarker.remove(); climbHoverStartMarker = null }
    if (climbHoverEndMarker) { climbHoverEndMarker.remove(); climbHoverEndMarker = null }
    return
  }
  const ptEnd = routeStore.geometry.value[climb.endIdx]
  if (!ptEnd) return
  function makeFlag(kind: 'start' | 'end') {
    const el = document.createElement('div')
    el.className = 'climb-hover-flag'
    el.style.cssText = 'width:28px;height:36px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));pointer-events:none'
    el.innerHTML = flagSvg(kind)
    return new _maplibregl.Marker({ element: el, anchor: 'bottom-left' })
  }
  if (climbHoverStartMarker) { climbHoverStartMarker.remove(); climbHoverStartMarker = null }
  if (climbHoverEndMarker) climbHoverEndMarker.remove()
  climbHoverEndMarker = makeFlag('end').setLngLat([ptEnd[0], ptEnd[1]]).addTo(mapInstance)
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
  waypointGeomIndices = wps.map((w) => {
    let best = 0, bestDist = Infinity
    for (let i = 0; i < geom.length; i++) {
      const dx = geom[i][0] - w.lng, dy = geom[i][1] - w.lat
      const d = dx * dx + dy * dy
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  })
}

function addWaypoint(lng: number, lat: number) {
  routeStore.waypoints.value = [...routeStore.waypoints.value, { lng, lat }]
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

function addReturnTo(idx: number) {
  const wps = routeStore.waypoints.value
  if (wps.length < 2 || idx >= wps.length - 1) return
  routeStore.waypoints.value = [...wps, { ...wps[idx] }]
  deselectAll()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function insertWaypointAtGeomIdx(geomIdx: number) {
  if (!waypointGeomIndices.length) return
  const pt = routeStore.geometry.value[geomIdx]
  if (!pt) return
  let insertAt = routeStore.waypoints.value.length
  for (let i = 0; i < waypointGeomIndices.length - 1; i++) {
    if (geomIdx >= waypointGeomIndices[i] && geomIdx <= waypointGeomIndices[i + 1]) { insertAt = i + 1; break }
  }
  const next = routeStore.waypoints.value.slice()
  next.splice(insertAt, 0, { lng: pt[0], lat: pt[1] })
  routeStore.waypoints.value = next
  hideHoverMarker()
  refreshWaypointMarkers()
  emit('waypoints-changed')
}

function nearestGeomIndexAt(point: { x: number; y: number }) {
  if (!mapInstance || !routeStore.geometry.value.length) return null
  const features = mapInstance.queryRenderedFeatures(
    [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]],
    { layers: ['builder-route-line'] },
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

function refreshWaypointMarkers() {
  if (!_maplibregl || !mapInstance) return
  waypointMarkers.forEach((m) => m.remove()); waypointMarkers.length = 0
  selectedWpIdx = -1
  if (!props.state.showWaypoints) return
  routeStore.waypoints.value.forEach((w, idx) => {
    const el = document.createElement('div')
    el.className = w.free ? 'wp-marker wp-marker--free' : 'wp-marker'
    const isLast = idx === routeStore.waypoints.value.length - 1
    const returnHtml = !isLast
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
    el.innerHTML = `
      <div class="wp-tooltip">
        <div class="wp-tooltip-header">
          <span class="wp-tooltip-title">Point&nbsp;<input type="number" class="wp-tooltip-num-input" min="1" max="${routeStore.waypoints.value.length}" value="${idx + 1}" title="${t('routes.reorder_waypoint')}" /></span>
          <button type="button" class="wp-tooltip-close" aria-label="Fermer">×</button>
        </div>
        <a class="wp-tooltip-action" href="https://www.google.com/maps?q=${w.lat},${w.lng}" target="_blank" rel="noopener noreferrer">
          <i class="fa-brands fa-google" aria-hidden="true"></i>
          <span>Google Maps</span>
        </a>
        <a class="wp-tooltip-action wp-tooltip-action--streetview" href="https://www.google.com/maps?q=&layer=c&cbll=${w.lat},${w.lng}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-street-view" aria-hidden="true"></i>
          <span>${t('routes.street_view')}</span>
        </a>
        <a class="wp-tooltip-action wp-tooltip-action--komoot" href="${komootUrl}" target="_blank" rel="noopener noreferrer">
          <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
          <span>Komoot</span>
        </a>
        ${returnHtml}
        <button type="button" class="wp-tooltip-action wp-tooltip-action--free">
          <i class="fa-solid fa-bezier-curve" aria-hidden="true"></i>
          <span>${w.free ? t('routes.anchor_to_road') : t('routes.make_free')}</span>
        </button>
        <button type="button" class="wp-tooltip-action wp-tooltip-action--delete">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
          <span>${t('routes.remove_waypoint')}</span>
        </button>
        <div class="wp-tooltip-arrow"></div>
      </div>
      <span class="wp-marker-num">${idx + 1}</span>
    `
    const marker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([w.lng, w.lat]).addTo(mapInstance)
    attachWaypointDrag(el, marker, idx)
    el.addEventListener('click', (ev: any) => {
      ev.stopPropagation()
      if (suppressNextWpClick) { suppressNextWpClick = false; return }
      if (ev.target.closest('.wp-tooltip')) return
      selectWaypoint(idx)
    })
    el.querySelector('.wp-tooltip-close')!.addEventListener('click', (ev: any) => { ev.stopPropagation(); deselectAll() })
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
    el.querySelectorAll('.wp-tooltip-action:not(.wp-tooltip-action--delete):not(.wp-tooltip-action--free)').forEach((a) => {
      a.addEventListener('click', (ev: any) => { ev.stopPropagation(); deselectAll() })
    })
    el.querySelector('.wp-tooltip-action--free')!.addEventListener('click', (ev: any) => {
      ev.stopPropagation(); ev.preventDefault(); toggleWaypointFree(idx)
    })
    el.querySelector('.wp-tooltip-action--return')?.addEventListener('click', (ev: any) => {
      ev.stopPropagation(); ev.preventDefault(); addReturnTo(idx)
    })
    el.querySelector('.wp-tooltip-action--delete')!.addEventListener('click', (ev: any) => {
      ev.stopPropagation(); ev.preventDefault(); removeWaypoint(idx)
    })
    el.addEventListener('contextmenu', (ev: any) => { ev.preventDefault(); ev.stopPropagation(); removeWaypoint(idx) })
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

function setMapStyle(id: string) {
  if (!mapInstance || id === props.state.mapStyleId) return
  props.state.mapStyleId = id
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  mapInstance.once('style.load', () => {
    installRouteLayer(); installPreviewLayer()
    updateRouteLayer(); updateDivergentLayer(); updateSelectionLayer(); installClimbMarkers(); installPlaceMarkers()
    if (locationVisible.value && lastLocationCoords) installLocationLayers(lastLocationCoords, lastLocationAccuracy)
    if (props.state.is3D) {
      if (!mapInstance.getSource('terrain-dem')) {
        mapInstance.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
      }
      mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    }
  })
}

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
}

function toggleClimbs() {
  props.state.showClimbs = !props.state.showClimbs
  installClimbMarkers()
}

function toggleGrade() {
  props.state.colorMode = props.state.colorMode === 'grade' ? 'none' : 'grade'
  applyColorMode()
}

// ─── Waymarked Trails preview ─────────────────────────────────────────────────

function installPreviewLayer() {
  if (!mapInstance || mapInstance.getSource('wt-preview')) return
  mapInstance.addSource('wt-preview', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
  mapInstance.addLayer({ id: 'wt-preview-border', type: 'line', source: 'wt-preview', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': 'rgba(0,0,0,0.25)', 'line-width': 8 } })
  mapInstance.addLayer({ id: 'wt-preview-line', type: 'line', source: 'wt-preview', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#a855f7', 'line-width': 5, 'line-dasharray': [2, 1.5] } })
}

function setPreviewCoords(coords: Array<[number, number]>) {
  if (!mapInstance) return
  const src = mapInstance.getSource('wt-preview') as any
  if (!src) return
  src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } })
}

function wtMercatorToLngLat(x: number, y: number): [number, number] {
  return [(x / 20037508.342) * 180, (Math.atan(Math.exp((y / 20037508.342) * Math.PI)) * 360) / Math.PI - 90]
}

function wtExtractCoords(node: any, out: Array<[number, number]>) {
  if (!node) return
  if (node.geometry?.type === 'LineString' && Array.isArray(node.geometry.coordinates)) {
    for (const c of node.geometry.coordinates) {
      if (Array.isArray(c) && c.length >= 2) out.push(wtMercatorToLngLat(c[0], c[1]))
    }
  }
  if (Array.isArray(node.ways)) node.ways.forEach((w: any) => wtExtractCoords(w, out))
  if (Array.isArray(node.main)) node.main.forEach((m: any) => wtExtractCoords(m, out))
}

async function wtSearch(url: string) {
  wtSearching.value = true; wtResults.value = []
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    wtResults.value = Array.isArray(data.results) ? data.results : []
  } catch { wtResults.value = [] }
  finally { wtSearching.value = false }
}

function wtSearchByQuery() {
  const q = wtQuery.value.trim()
  if (q.length < 2) return
  wtSearch(`${WT_BASE}/list/search?query=${encodeURIComponent(q)}&limit=15`)
}

function lngLatToMercator(lng: number, lat: number): [number, number] {
  return [(lng / 180) * 20037508.342, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 6378137]
}

function wtSearchByArea() {
  if (!mapInstance) return
  const b = mapInstance.getBounds()
  const [x1, y1] = lngLatToMercator(b.getWest(), b.getSouth())
  const [x2, y2] = lngLatToMercator(b.getEast(), b.getNorth())
  wtSearch(`${WT_BASE}/list/by_area?bbox=${x1.toFixed(0)},${y1.toFixed(0)},${x2.toFixed(0)},${y2.toFixed(0)}&limit=20`)
}

async function wtImport(route: { id: number; type: string; name: string }) {
  if (wtImportingId.value != null) return
  wtHidePreview()
  wtImportingId.value = route.id
  try {
    const res = await fetch(`${WT_BASE}/details/${route.type}/${route.id}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const pts: Array<[number, number]> = []
    wtExtractCoords(data.route, pts)
    if (pts.length < 2) throw new Error('Pas assez de points')
    const MAX = 25
    const step = pts.length / MAX
    const sampled: Array<[number, number]> = pts.length <= MAX ? pts.slice()
      : Array.from({ length: MAX }, (_, i) => pts[Math.floor(i * step)])
    sampled[0] = pts[0]; sampled[sampled.length - 1] = pts[pts.length - 1]
    if (!routeStore.name.value.trim()) routeStore.name.value = (data.name || route.name).slice(0, 80)
    routeStore.waypoints.value = sampled.map(([lng, lat]) => ({ lng, lat }))
    refreshWaypointMarkers()
    const lngs = sampled.map(([lng]) => lng)
    const lats = sampled.map(([, lat]) => lat)
    mapInstance?.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40, duration: 600 })
    emit('waypoints-changed')
    wtExpanded.value = false
  } catch (e: any) {
    routeStore.error.value = `Waymarked Trails : ${e.message}`
  } finally { wtImportingId.value = null }
}

async function wtShowPreview(route: { id: number; type: string; name: string }) {
  if (wtPreviewTimeout) { clearTimeout(wtPreviewTimeout); wtPreviewTimeout = null }
  wtPreviewTimeout = setTimeout(async () => {
    wtPreviewTimeout = null
    if (!mapInstance) return
    let pts = wtGeomCache.get(route.id)
    if (!pts) {
      try {
        const res = await fetch(`${WT_BASE}/details/${route.type}/${route.id}`)
        if (!res.ok) return
        const data = await res.json()
        pts = []
        wtExtractCoords(data.route, pts)
        if (pts!.length >= 2) wtGeomCache.set(route.id, pts!)
      } catch { return }
    }
    if (!pts || pts.length < 2) return
    setPreviewCoords(pts)
    const lngs = pts.map(([lng]) => lng), lats = pts.map(([, lat]) => lat)
    mapInstance.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, duration: 400, maxZoom: 14 })
  }, 300)
}

function wtHidePreview() {
  if (wtPreviewTimeout) { clearTimeout(wtPreviewTimeout); wtPreviewTimeout = null }
  setPreviewCoords([])
}

// ─── Search ───────────────────────────────────────────────────────────────────

function searchCountryPriority(cc: string): number {
  if (cc === 'ch') return 0
  if (cc === 'fr') return 1
  if (EU_COUNTRY_CODES.has(cc)) return 2
  return 3
}

async function searchPlaces(q: string) {
  searching.value = true
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=10&addressdetails=1`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const raw = await res.json()
    const data: any[] = Array.isArray(raw) ? raw : []
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

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onBeforeUnmount(() => {
  waypointMarkers.forEach((m) => m.remove()); waypointMarkers.length = 0
  divergentMarkers.forEach((m) => m.remove()); divergentMarkers.length = 0
  climbMarkerObservers.forEach((obs) => obs.disconnect()); climbMarkerObservers.length = 0
  climbMarkers.forEach((m) => m.remove()); climbMarkers.length = 0
  clearPlaceMarkers()
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
  refreshWaypointMarkers,
  recomputeWaypointGeomIndices,
  fitMapToRoute,
  fitMapToSelection,
  flyTo,
  fitBounds,
  showChartCrossMarker,
  hideChartCrossMarker,
  showPlaceHoverMarker,
  hidePlaceHoverMarker,
  updateClimbHoverLayer,
  setMapStyle,
  resize: () => mapInstance?.resize(),
  getMapInstance: () => mapInstance,
})
</script>

<template>
  <div class="map-wrap" :class="{ expanded: state.mapExpanded }">
    <div ref="mapEl" class="route-builder-map"></div>

    <div class="map-controls">
      <MapStyleDropdown :model-value="state.mapStyleId" @update:model-value="setMapStyle" />
      <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
        <button type="button" class="btn map-ctrl-btn"
          :class="state.showWaypoints ? 'btn-warning text-dark active' : 'btn-light'"
          @click="toggleWaypoints"
          :title="state.showWaypoints ? t('routes.hide_waypoints') : t('routes.show_waypoints')"
          :aria-pressed="state.showWaypoints">
          <i class="fa-solid fa-map-pin" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn map-ctrl-btn"
          :class="state.showClimbs ? 'btn-warning text-dark active' : 'btn-light'"
          @click="toggleClimbs"
          :title="state.showClimbs ? t('strava.hide_climbs') : t('strava.show_climbs')"
          :aria-pressed="state.showClimbs">
          <i class="fa-solid fa-mountain" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn map-ctrl-btn"
          :class="state.showGrade ? 'btn-warning text-dark active' : 'btn-light'"
          @click="toggleGrade"
          :title="state.showGrade ? t('strava.hide_grade') : t('strava.show_grade')"
          :aria-pressed="state.showGrade">
          <i class="fa-solid fa-palette" aria-hidden="true"></i>
        </button>
      </div>
      <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
        <button type="button" class="btn btn-light map-ctrl-btn"
          :disabled="!routeStore.hasGeometry.value"
          @click="fitMapToRoute"
          title="Recentrer sur le trajet">
          <i class="fa-solid fa-crosshairs" aria-hidden="true"></i>
        </button>
      </div>
      <div class="btn-group-vertical btn-group-sm shadow-sm d-none d-md-flex" role="group">
        <button type="button" class="btn map-ctrl-btn"
          :class="state.showStatsSidebar ? 'btn-warning text-dark active' : 'btn-light'"
          @click="state.showStatsSidebar = !state.showStatsSidebar"
          :title="state.showStatsSidebar ? t('routes.hide_stats_sidebar') : t('routes.show_stats_sidebar')"
          :aria-pressed="state.showStatsSidebar">
          <i class="fa-solid fa-chart-simple" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn map-ctrl-btn"
          :class="state.showElevationChart ? 'btn-warning text-dark active' : 'btn-light'"
          @click="$emit('toggle-chart')"
          :title="state.showElevationChart ? t('routes.hide_elevation_chart') : t('routes.show_elevation_chart')"
          :aria-pressed="state.showElevationChart">
          <i class="fa-solid fa-chart-area" aria-hidden="true"></i>
        </button>
      </div>
    </div>

    <div class="map-controls-right">
      <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
        <button type="button" class="btn map-ctrl-btn"
          :class="state.is3D ? 'btn-warning text-dark active' : 'btn-light'"
          @click="toggleMap3D"
          :title="state.is3D ? t('strava.map_2d') : t('strava.map_3d')"
          :aria-pressed="state.is3D">
          <i class="fa-solid fa-cube" aria-hidden="true"></i>
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
      <div class="btn-group-vertical btn-group-sm shadow-sm" role="group">
        <button type="button" class="btn map-ctrl-btn"
          :class="wtExpanded ? 'btn-primary active' : 'btn-light'"
          @click="wtExpanded = !wtExpanded"
          :title="t('routes.wt_title')"
          :aria-pressed="wtExpanded">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="map-search" :class="{ 'map-search--expanded': searchExpanded }">
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
    <div v-if="routeStore.isFetchingRoute.value || routeStore.isFetchingElevation.value" class="map-overlay-loading">
      <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
      <span v-if="routeStore.isFetchingRoute.value">{{ t('routes.computing_route') }}</span>
      <span v-else>{{ t('routes.computing_elevation') }}</span>
    </div>

    <!-- Mobile stats toggle -->
    <button type="button" class="btn btn-light btn-sm shadow-sm mobile-sheet-toggle" @click="$emit('toggle-mobile-sheet')">
      <i class="fa-solid fa-chart-area me-1" aria-hidden="true"></i>
      <span v-if="routeStore.hasGeometry.value">
        {{ routeStore.distanceM.value >= 1000 ? (routeStore.distanceM.value / 1000).toFixed(2) + ' km' : Math.round(routeStore.distanceM.value) + ' m' }}
        · +{{ Math.round(routeStore.elevGainM.value) }} m
      </span>
      <span v-else>Stats</span>
    </button>

    <!-- Waymarked Trails drawer -->
    <Transition name="wt-drawer">
      <div v-if="wtExpanded" class="wt-drawer">
        <div class="wt-drawer-header">
          <span class="wt-drawer-title">
            <i class="fa-solid fa-route" aria-hidden="true"></i>
            {{ t('routes.wt_title') }}
          </span>
          <button type="button" class="btn-close btn-close-sm" @click="wtExpanded = false; wtHidePreview()" aria-label="Fermer"></button>
        </div>
        <div class="wt-drawer-body">
          <div class="input-group input-group-sm mb-1">
            <input v-model="wtQuery" type="text" class="form-control" :placeholder="t('routes.wt_search_placeholder')" @keydown.enter="wtSearchByQuery" />
            <button class="btn btn-outline-secondary" type="button" @click="wtSearchByQuery" :disabled="wtSearching">
              <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            </button>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary w-100 d-flex align-items-center justify-content-center gap-1 mb-2" @click="wtSearchByArea" :disabled="wtSearching">
            <span v-if="wtSearching" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-expand" aria-hidden="true"></i>
            <span>{{ t('routes.wt_search_area') }}</span>
          </button>
          <div v-if="!wtSearching && wtResults.length === 0" class="wt-no-results">
            <span v-if="wtQuery">{{ t('routes.wt_no_results') }}</span>
            <span v-else class="text-muted" style="font-size:0.78rem">{{ t('routes.wt_search_placeholder') }}</span>
          </div>
          <div class="wt-results-list">
            <div
              v-for="r in wtResults"
              :key="r.id"
              class="wt-result-pill"
              :class="{ 'wt-result-pill--loading': wtImportingId === r.id }"
              :title="r.name || r.ref || `#${r.id}`"
              @mouseenter="wtShowPreview({ id: r.id, type: r.type, name: r.name || r.ref || `#${r.id}` })"
              @mouseleave="wtHidePreview()"
              @click="wtImport({ id: r.id, type: r.type, name: r.name || r.ref || `#${r.id}` })"
            >
              <span class="wt-result-name">{{ r.name || r.ref || `#${r.id}` }}</span>
              <span class="wt-result-meta">
                <span v-if="wtImportingId === r.id" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                <template v-else>
                  <span v-if="r.length">{{ (r.length / 1000).toFixed(0) }} km</span>
                  <span v-if="r.ascent">· +{{ Math.round(r.ascent) }} m</span>
                </template>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Transition>
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
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
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
.mobile-sheet-toggle {
  position: absolute;
  bottom: 14px;
  left: 14px;
  z-index: 6;
  white-space: nowrap;
  display: none;
}
@media (max-width: 767px), (max-height: 500px) { .mobile-sheet-toggle { display: flex; } }

.wt-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 280px;
  background: #fff;
  box-shadow: -4px 0 16px rgba(0,0,0,0.18);
  display: flex;
  flex-direction: column;
  z-index: 10;
}
.wt-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.75rem 0.5rem;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.wt-drawer-title { font-size: 0.82rem; font-weight: 600; color: #374151; display: flex; align-items: center; gap: 0.4rem; }
.wt-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
}
.wt-results-list { display: flex; flex-direction: column; gap: 0.25rem; overflow-y: auto; min-height: 0; }
.wt-no-results { color: #9ca3af; font-size: 0.78rem; padding: 0.4rem 0.2rem; }
.wt-result-pill {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.35rem 0.5rem;
  border-radius: 0.5rem;
  cursor: pointer;
  background: rgba(13,110,253,0.06);
  transition: background 0.15s;
}
.wt-result-pill:hover { background: rgba(13,110,253,0.15); }
.wt-result-pill--loading { opacity: 0.6; pointer-events: none; }
.wt-result-name { font-size: 0.78rem; font-weight: 500; color: #212529; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wt-result-meta { font-size: 0.72rem; color: #6b7280; display: flex; align-items: center; gap: 0.25rem; }
.wt-drawer-enter-active, .wt-drawer-leave-active { transition: transform 0.22s ease; }
.wt-drawer-enter-from, .wt-drawer-leave-to { transform: translateX(100%); }
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
.climb-hover-flag { pointer-events: none; }
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
.place-marker:hover { box-shadow: 0 6px 14px -3px rgba(0,0,0,0.5); }
.place-marker--cemetery { color: #6b7280; }
.place-marker--bakery   { color: #b45309; }
.place-popup-container .maplibregl-popup-content {
  padding: 0.55rem 0.7rem;
  border-radius: 0.6rem;
  box-shadow: 0 6px 18px -4px rgba(0,0,0,0.4);
}
.place-popup-name {
  font-weight: 600;
  font-size: 0.82rem;
  color: #1f2937;
  margin-bottom: 0.4rem;
  max-width: 14rem;
}
.place-popup-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #b45309;
  text-decoration: none;
}
.place-popup-link:hover { text-decoration: underline; }
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
.place-hover-marker {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #0d6efd;
  border: 3px solid #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  pointer-events: none;
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
</style>
