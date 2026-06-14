<script setup lang="ts">
import { ref, reactive, watch, onMounted, onBeforeUnmount, useTemplateRef, nextTick } from 'vue'
import { t } from '../i18n'
import { mapStyleFor } from '../mapStyles'
import { RouteBuilderState } from '../pageState'
import { routeStore } from '../stores/routeStore'
import { selectionStore } from '../stores/selectionStore'
import { placesStore } from '../stores/placesStore'
import { haversine, buildDistancesM, downsample } from '../routeHelpers'
import RouteBuilderStats from './RouteBuilderStats.vue'
import RouteBuilderChart from './RouteBuilderChart.vue'
import RouteBuilderMap from './RouteBuilderMap.vue'

const props = defineProps({
  routeId: { type: [String, Number], default: null },
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const state = reactive(new RouteBuilderState())
const saving = ref(false)
const exporting = ref(false)
const showExportDialog = ref(false)
const exportStyleId = ref('')
const exportShowGrade = ref(false)
const exportShowClimbs = ref(false)
const exportShowStats = ref(true)
const exportScale = ref(2.5)

const mapFlex = ref(0.80)
const sidebarWidth = ref(195)
let resizing = false
let resizeStartY = 0
let resizeStartFlex = 0
let resizingH = false
let resizeStartX = 0
let resizeStartWidth = 0

const mobileSheetOpen = ref(false)
const isMobile = ref(typeof window !== 'undefined' && window.innerWidth < 768)
const SHEET_HEIGHT_DEFAULT = Math.round(window.innerHeight * 0.45)
const SHEET_HEIGHT_MIN = 140
const SHEET_HEIGHT_MAX = Math.round(window.innerHeight * 0.85)
const mobileSheetHeight = ref(SHEET_HEIGHT_DEFAULT)

const mapRef = useTemplateRef('mapRef')
const chartRef = useTemplateRef('chartRef')
const rightColEl = useTemplateRef('rightColEl')

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
  placesStore.isFetchingPlaces.value = true

  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity
  for (const [lng, lat] of geom) {
    if (lat < south) south = lat
    if (lat > north) north = lat
    if (lng < west) west = lng
    if (lng > east) east = lng
  }
  const BUFFER = 0.02
  south -= BUFFER; north += BUFFER; west -= BUFFER; east += BUFFER

  try {
    const res = await fetch(`/api/geocode/places?south=${south}&west=${west}&north=${north}&east=${east}`)
    if (token !== placesStore.token) return
    if (!res.ok) { placesStore.isFetchingPlaces.value = false; return }

    const nodes = await res.json()
    if (token !== placesStore.token) return

    const distancesM = buildDistancesM(geom)
    const THRESHOLD_M = 2000
    const seen = new Set<string>()
    const results: any[] = []

    for (const node of nodes) {
      const seenKey = node.type === 'cemetery'
        ? `cemetery:${node.lat.toFixed(3)}:${node.lng.toFixed(3)}`
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
      const threshold = node.type === 'cemetery' ? 1500 : THRESHOLD_M
      const dist = haversine(geom[nearestIdx], [node.lng, node.lat])
      if (dist > threshold) continue
      seen.add(seenKey)
      const isCemetery = node.type === 'cemetery'
      results.push({
        name: node.name,
        type: node.type,
        distanceM: distancesM[nearestIdx],
        distFromRouteM: isCemetery ? dist : 0,
        lng: node.lng,
        lat: node.lat,
        markerLng: isCemetery ? node.lng : geom[nearestIdx][0],
        markerLat: isCemetery ? node.lat : geom[nearestIdx][1],
      })
    }
    results.sort((a, b) => a.distanceM - b.distanceM)
    if (token !== placesStore.token) return
    placesStore.importantPlaces.value = results
  } catch { /* leave list empty */ }

  if (token !== placesStore.token) return
  placesStore.isFetchingPlaces.value = false
}

// ─── Route computation ────────────────────────────────────────────────────────

async function recomputeRoute() {
  const token = ++recomputeToken
  selectionStore.clear()

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
    const lonlats = routeStore.waypoints.value.map((w) => `${w.lng},${w.lat}`).join('|')
    const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=trekking&alternativeidx=0&format=geojson`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`)
    const data = await res.json()
    if (token !== recomputeToken) return
    const feature = data?.features?.[0]
    const coords = feature?.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) throw new Error('Routing impossible (no route)')
    const trackLen = parseFloat(feature.properties?.['track-length'] || '0')
    routeStore.distanceM.value = Number.isFinite(trackLen) && trackLen > 0 ? trackLen : 0
    routeStore.geometry.value = coords.map((c: number[]) => [c[0], c[1], c.length > 2 ? c[2] : null])

    mapRef.value?.updateRouteLayer()
    mapRef.value?.installClimbMarkers()
    mapRef.value?.recomputeWaypointGeomIndices()

    const hasInlineElevation = routeStore.geometry.value.some((c) => c[2] != null)
    if (hasInlineElevation) {
      routeStore.recomputeGain()
      await nextTick()
      chartRef.value?.render()
    } else {
      await fetchElevation(token)
    }
  } catch (e: any) {
    if (token === recomputeToken) routeStore.error.value = `${t('routes.error_routing')}: ${e.message}`
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
    await nextTick()
    chartRef.value?.render()
  } catch (e: any) {
    if (token === recomputeToken) routeStore.error.value = `${t('routes.error_elevation')}: ${e.message}`
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
    routeStore.name.value = r.name || ''
    routeStore.waypoints.value = Array.isArray(r.waypoints) ? r.waypoints : []
    routeStore.geometry.value = Array.isArray(r.geometry) ? r.geometry : []
    routeStore.distanceM.value = r.distance_m || 0
    routeStore.elevGainM.value = r.elevation_gain_m || 0
    routeStore.elevLossM.value = r.elevation_loss_m || 0
    if (routeStore.geometry.value.length >= 2) {
      const lngs = routeStore.geometry.value.map((c) => c[0])
      const lats = routeStore.geometry.value.map((c) => c[1])
      mapRef.value?.fitBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)], { padding: 40, duration: 0 })
    }
    mapRef.value?.refreshWaypointMarkers()
    mapRef.value?.updateRouteLayer()
    mapRef.value?.recomputeWaypointGeomIndices()
    await nextTick()
    chartRef.value?.render()
    if (routeStore.waypoints.value.length >= 2) recomputeRoute()
  } catch (e: any) {
    routeStore.error.value = e.message
  }
}

async function save() {
  if (!routeStore.name.value.trim()) { routeStore.error.value = t('routes.error_name_required'); return }
  if (routeStore.waypoints.value.length < 2) { routeStore.error.value = t('routes.error_min_points'); return }
  saving.value = true
  routeStore.error.value = null
  try {
    const body = JSON.stringify({
      name: routeStore.name.value.trim(),
      waypoints: routeStore.waypoints.value,
      geometry: routeStore.geometry.value,
      distance_m: routeStore.distanceM.value,
      elevation_gain_m: routeStore.elevGainM.value,
      elevation_loss_m: routeStore.elevLossM.value,
      profile: 'cycling',
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
    if (!isEditMode() && r?.id) {
      routeStore.currentId.value = r.id
      window.history.replaceState({}, '', `${localePrefix}/routes/${r.id}/edit`)
    }
  } catch (e: any) {
    routeStore.error.value = e.message
  } finally {
    saving.value = false
  }
}

function exportGpx() {
  if (!isEditMode()) return
  window.location.href = `/api/routes/${routeStore.currentId.value}/gpx`
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
  mapRef.value?.updateSelectionLayer()
  chartRef.value?.update()
  mapRef.value?.fitMapToSelection()
}

function onHoverClimb(climb: any) {
  mapRef.value?.updateClimbHoverLayer(climb)
}

function onSelectPlace(place: any) {
  mapRef.value?.flyTo(place.lng, place.lat)
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

function openExportDialog() {
  exportStyleId.value = state.mapStyleId
  exportShowGrade.value = state.colorMode === 'grade'
  exportShowClimbs.value = state.showClimbs
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

function drawClimbMarkersOnCanvas(ctx: CanvasRenderingContext2D, mapOffsetY: number, s: number) {
  const mapInst = mapRef.value?.getMapInstance()
  if (!mapInst) return
  routeStore.detectedClimbs.value.forEach((climb) => {
    const pt = routeStore.geometry.value[climb.startIdx]
    if (!pt) return
    const sp = mapInst.project([pt[0], pt[1]])
    const cx = sp.x * s, cy = sp.y * s + mapOffsetY
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
  ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, ctx.canvas.width, h)
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.round(18 * s)}px system-ui,sans-serif`
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  ctx.fillText((routeStore.name.value ?? '').trim() || 'Itinéraire', Math.round(20 * s), h / 2)
  ctx.textBaseline = 'alphabetic'
}

function drawStatsOnCanvas(ctx: CanvasRenderingContext2D, offsetY: number, h: number, s: number) {
  const items = [
    { icon: '↔', label: routeStore.distanceM.value >= 1000 ? `${(routeStore.distanceM.value / 1000).toFixed(1)} km` : `${Math.round(routeStore.distanceM.value)} m`, sub: 'Distance' },
    { icon: '↑', label: `+${Math.round(routeStore.elevGainM.value)} m`, sub: 'D+' },
    { icon: '↓', label: `-${Math.round(routeStore.elevLossM.value)} m`, sub: 'D-' },
  ]
  ctx.fillStyle = '#f9fafb'; ctx.fillRect(0, offsetY, ctx.canvas.width, h)
  const cellW = ctx.canvas.width / items.length
  items.forEach((item, i) => {
    const cx = cellW * i + cellW / 2, cy = offsetY + h / 2
    ctx.fillStyle = '#111827'
    ctx.font = `bold ${Math.round(15 * s)}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(item.label, cx, cy + 2 * s)
    ctx.fillStyle = '#6b7280'
    ctx.font = `${Math.round(10 * s)}px system-ui,sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText(item.sub, cx, cy + 4 * s)
  })
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

async function exportImage() {
  const mapInst = mapRef.value?.getMapInstance()
  if (!mapInst || !routeStore.geometry.value.length) return
  exporting.value = true
  showExportDialog.value = false
  const savedStyleId = state.mapStyleId
  const savedColorMode = state.colorMode
  const savedShowClimbs = state.showClimbs

  try {
    await applyStyleForExport(exportStyleId.value)
    const targetColorMode = exportShowGrade.value ? 'grade' : 'none'
    if (state.colorMode !== targetColorMode) { state.colorMode = targetColorMode; mapRef.value?.applyColorMode() }
    const lngs = routeStore.geometry.value.map((c) => c[0])
    const lats = routeStore.geometry.value.map((c) => c[1])
    mapInst.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, duration: 0 })
    await new Promise<void>((resolve) => mapInst.once('idle', resolve))

    const dpr = window.devicePixelRatio || 1
    const UPSCALE = exportScale.value
    const s = dpr * UPSCALE
    const mapCanvas = mapInst.getCanvas()
    const srcW = mapCanvas.width, srcH = mapCanvas.height
    const outW = Math.round(srcW * UPSCALE)
    const mapOutH = Math.round(srcH * UPSCALE)
    const chartOutH = Math.round(mapOutH * 0.40)
    const titleH = Math.round(52 * s)
    const statsH = exportShowStats.value ? Math.round(80 * s) : 0
    const out = document.createElement('canvas')
    out.width = outW; out.height = titleH + mapOutH + chartOutH + statsH
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height)

    const chartInst = chartRef.value?.getChartInstance()
    if (chartInst) {
      const o = chartInst.options as any
      const fs = (base: number) => ({ size: Math.round(base * UPSCALE) })
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
    if (exportShowClimbs.value) drawClimbMarkersOnCanvas(ctx, mapOffsetY, s)
    const chartEl = chartRef.value?.getChartEl()
    if (chartEl) ctx.drawImage(chartEl, 0, mapOffsetY + mapOutH, outW, chartOutH)

    const link = document.createElement('a')
    link.download = `${(routeStore.name.value ?? 'itineraire').trim() || 'itineraire'}.png`
    link.href = out.toDataURL('image/png')
    link.click()
  } finally {
    const chartInst = chartRef.value?.getChartInstance()
    if (chartInst) {
      const o = chartInst.options as any
      o.scales.x.ticks.font = undefined; o.scales.y.ticks.font = undefined
      o.scales.x.title.font = undefined; o.scales.y.title.font = undefined
      chartInst.update('none'); chartInst.resize()
    }
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

function applyPendingGpxImport() {
  try {
    const u = new URL(window.location.href)
    if (u.searchParams.get('fromGpx') !== '1') return
    u.searchParams.delete('fromGpx'); window.history.replaceState({}, '', u.toString())
    const raw = sessionStorage.getItem('sportsScope.gpxImport')
    sessionStorage.removeItem('sportsScope.gpxImport')
    if (!raw) return
    const payload = JSON.parse(raw)
    const wps = Array.isArray(payload?.waypoints) ? payload.waypoints : []
    if (wps.length < 2) return
    if (payload.name && !routeStore.name.value.trim()) routeStore.name.value = String(payload.name).slice(0, 80)
    routeStore.waypoints.value = wps
    mapRef.value?.refreshWaypointMarkers()
    const lngs = wps.map((w: any) => w.lng), lats = wps.map((w: any) => w.lat)
    mapRef.value?.fitBounds([Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)], { padding: 60, duration: 600, maxZoom: 14 })
    recomputeRoute()
  } catch { /* stale payload */ }
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

watch(state, () => state.save(), { deep: true })

watch(() => state.showElevationChart, async () => {
  await nextTick()
  mapRef.value?.resize()
  if (state.showElevationChart && routeStore.hasGeometry.value) {
    chartRef.value?.resize()
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
watch(routeStore.geometry, (newGeom) => {
  if (newGeom.length < 2) {
    placesStore.token++
    placesStore.importantPlaces.value = []
    placesStore.isFetchingPlaces.value = false
    return
  }
  fetchImportantPlaces()
}, { deep: false })

function onWindowResize() {
  const mobile = window.innerWidth < 768
  if (mobile !== isMobile.value) isMobile.value = mobile
  setTimeout(() => mapRef.value?.resize(), 100)
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  state.load()
  routeStore.reset()
  routeStore.currentId.value = props.routeId ? Number(props.routeId) : null
  window.addEventListener('resize', onWindowResize)
  document.getElementById('navbar-route-save-btn')?.addEventListener('click', save)
  if (!routeStore.currentId.value) {
    try {
      const u = new URL(window.location.href)
      const presetName = u.searchParams.get('name')
      if (presetName) {
        routeStore.name.value = presetName.slice(0, 80)
        u.searchParams.delete('name')
        window.history.replaceState({}, '', u.toString())
      }
    } catch { /* ignore */ }
  }
  await mapRef.value?.initMap()
  if (routeStore.currentId.value) await fetchRoute(routeStore.currentId.value)
  else applyPendingGpxImport()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onResize); document.removeEventListener('mouseup', stopResize)
  document.removeEventListener('mousemove', onResizeH); document.removeEventListener('mouseup', stopResizeH)
  window.removeEventListener('resize', onWindowResize)
  document.getElementById('navbar-route-save-btn')?.removeEventListener('click', save)
  placesStore.reset()
  selectionStore.clear()
})
</script>

<template>
  <div class="route-builder-page">
    <!-- Desktop header -->
    <div class="card shadow-sm border-0 d-none d-md-block route-builder-header-card">
      <div class="card-body d-flex align-items-center gap-2 py-1 px-3">
        <a :href="`${localePrefix}/routes`" class="btn btn-sm btn-link p-0 me-1 d-inline-flex align-items-center gap-1 flex-shrink-0">
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
          <span>{{ t('routes.back') }}</span>
        </a>
        <input
          v-model="routeStore.name.value"
          type="text"
          class="form-control route-name-input flex-grow-1"
          :placeholder="t('routes.name_placeholder')"
          :maxlength="80"
        />
        <div class="d-flex gap-2 flex-shrink-0">
          <button type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="!routeStore.hasGeometry.value" @click="undoLast" :title="t('routes.undo')">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="!routeStore.hasGeometry.value" @click="clearAll" :title="t('routes.clear')">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            @click="openExportDialog" :disabled="!routeStore.hasGeometry.value || exporting" title="Exporter en image">
            <span v-if="exporting" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-image" aria-hidden="true"></i>
            <span class="d-none d-lg-inline">Image</span>
          </button>
          <button v-if="isEditMode()" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            @click="exportGpx" :title="t('routes.export_gpx')">
            <i class="fa-solid fa-download" aria-hidden="true"></i>
            <span class="d-none d-lg-inline">GPX</span>
          </button>
          <button v-if="routeStore.waypoints.value.length >= 2" type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            @click="openInKomoot" :title="t('routes.open_in_komoot')">
            <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
            <span class="d-none d-lg-inline">Komoot</span>
          </button>
          <button type="button" class="btn btn-sm btn-warning d-flex align-items-center gap-1"
            @click="save" :disabled="saving || routeStore.waypoints.value.length < 2 || !routeStore.name.value.trim()">
            <span v-if="saving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
            <span>{{ t('routes.save') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Error -->
    <div v-if="routeStore.error.value" class="alert alert-warning d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="flex-grow-1">{{ routeStore.error.value }}</span>
      <button type="button" class="btn-close" @click="routeStore.error.value = null" aria-label="dismiss"></button>
    </div>

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
            @waypoints-changed="recomputeRoute"
            @toggle-chart="state.showElevationChart = !state.showElevationChart; nextTick(() => mapRef?.resize())"
            @toggle-mobile-sheet="mobileSheetOpen = !mobileSheetOpen"
          />
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
            @hover-end="onChartHoverEnd"
            @fit-to-selection="onChartFitToSelection"
            @open-selection-in-komoot="openSelectionInKomoot"
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
            @hover-end="onChartHoverEnd"
            @fit-to-selection="onChartFitToSelection"
            @open-selection-in-komoot="openSelectionInKomoot"
            @collapse="mobileSheetOpen = false"
          />
          </div>
        </div>
      </div>
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
              <label class="form-label small fw-semibold">{{ t('routes.export_style') }}</label>
              <div class="d-flex gap-2 flex-wrap">
                <button
                  v-for="sid in ['streets', 'satellite', 'outdoors', 'topo']"
                  :key="sid"
                  type="button"
                  class="btn btn-sm"
                  :class="exportStyleId === sid ? 'btn-primary' : 'btn-outline-secondary'"
                  @click="exportStyleId = sid"
                >{{ sid }}</button>
              </div>
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
            <div>
              <label class="form-label small fw-semibold">{{ t('routes.export_scale') }} ({{ exportScale }}×)</label>
              <input v-model.number="exportScale" type="range" class="form-range" min="1" max="4" step="0.5" />
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
  height: calc(100vh - 4rem);
  height: calc(100dvh - 4rem);
  padding: 0.5rem 0.75rem 0;
  gap: 0.5rem;
  overflow: hidden;
}
@media (max-width: 767px), (max-height: 500px) {
  .route-builder-page { padding: 0; gap: 0; }
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
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
