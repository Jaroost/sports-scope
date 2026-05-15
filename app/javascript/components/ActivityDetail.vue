<script setup>
import { ref, onMounted, onBeforeUnmount, computed, nextTick, useTemplateRef, watch } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  activityId: { type: [String, Number], required: true },
})

const loading = ref(true)
const error = ref(null)
const activity = ref(null)
const streams = ref(null)
const streamsLoading = ref(false)
const streamsError = ref(null)
const xAxis = ref('distance')
const timeUnit = ref('min')
const selection = ref(null) // { startIdx, endIdx } | null — immediate (drives map markers + chart band)
const selectionDisplay = ref(null) // debounced copy used for stats display
const mapEl = useTemplateRef('mapEl')

let mapInstance = null
let markerA = null
let markerB = null
let isDragging = false
let dragRafPending = false
const chartInstances = new Map()
const wheelHandlers = new Map()
const zoomRange = ref(null) // { xMin, xMax } | null — shared zoom across all charts
let xMinAll = 0
let xMaxAll = 0

const stats = computed(() => {
  if (!activity.value) return []
  const a = activity.value
  const startLocal = a.start_date_local ? new Date(a.start_date_local) : null
  const endLocal = startLocal && a.elapsed_time
    ? new Date(startLocal.getTime() + a.elapsed_time * 1000)
    : null
  return [
    { label: t('strava.distance'),       value: `${(a.distance / 1000).toFixed(2)} km`,             icon: 'fa-route' },
    { label: t('strava.duration'),       value: formatDuration(a.moving_time),                       icon: 'fa-stopwatch' },
    { label: t('strava.elapsed'),        value: formatDuration(a.elapsed_time),                      icon: 'fa-hourglass-half' },
    { label: t('strava.elevation_gain'), value: `${Math.round(a.total_elevation_gain || 0)} m`,      icon: 'fa-mountain' },
    { label: t('strava.avg_speed'),      value: `${((a.average_speed || 0) * 3.6).toFixed(1)} km/h`, icon: 'fa-gauge-high' },
    { label: t('strava.type'),           value: a.type,                                              icon: activityIcon(a.type) },
    { label: t('strava.start_date'),     value: startLocal ? startLocal.toLocaleString() : '–',      icon: 'fa-flag' },
    { label: t('strava.end_date'),       value: endLocal ? endLocal.toLocaleString() : '–',          icon: 'fa-flag-checkered' },
  ]
})

function activityIcon(type) {
  const t = (type || '').toLowerCase()
  if (t.includes('run')) return 'fa-person-running'
  if (t.includes('ride') || t.includes('cycl') || t.includes('bike') || t.includes('velo')) return 'fa-person-biking'
  if (t.includes('swim')) return 'fa-person-swimming'
  if (t.includes('walk') || t.includes('hike')) return 'fa-person-hiking'
  if (t.includes('ski')) return 'fa-person-skiing'
  if (t.includes('row')) return 'fa-water'
  if (t.includes('yoga')) return 'fa-spa'
  if (t.includes('workout') || t.includes('weight')) return 'fa-dumbbell'
  return 'fa-bolt'
}

const chartIcons = {
  altitude: 'fa-mountain',
  heartrate: 'fa-heart-pulse',
  velocity_smooth: 'fa-gauge-high',
  cadence: 'fa-rotate',
  watts: 'fa-bolt',
  temp: 'fa-temperature-half',
  grade_smooth: 'fa-slash',
}

const polyline = computed(() => activity.value?.map?.summary_polyline || activity.value?.map?.polyline || '')

// Prefer the high-resolution latlng stream when available (Strava stores it as [lat, lng] pairs).
const routeCoords = computed(() => {
  const latlng = streams.value?.latlng?.data
  if (Array.isArray(latlng) && latlng.length > 0) {
    return latlng.map(([lat, lng]) => [lng, lat])
  }
  if (polyline.value) return decodePolyline(polyline.value)
  return []
})

const hasRoute = computed(() => routeCoords.value.length > 0)
const hasLatLngStream = computed(() => Array.isArray(streams.value?.latlng?.data) && streams.value.latlng.data.length > 0)

const chartDefs = [
  { key: 'altitude', color: '#198754', unit: 'm', transform: (v) => v, digits: 0 },
  { key: 'heartrate', color: '#dc3545', unit: 'bpm', transform: (v) => v, digits: 0 },
  { key: 'velocity_smooth', color: '#0d6efd', unit: 'km/h', transform: (v) => v * 3.6, digits: 1 },
  { key: 'cadence', color: '#6f42c1', unit: 'rpm', transform: (v) => v, digits: 0 },
  { key: 'watts', color: '#fd7e14', unit: 'W', transform: (v) => v, digits: 0 },
  { key: 'temp', color: '#20c997', unit: '°C', transform: (v) => v, digits: 1 },
  { key: 'grade_smooth', color: '#6c757d', unit: '%', transform: (v) => v, digits: 1 },
]

const availableCharts = computed(() => {
  if (!streams.value) return []
  return chartDefs.filter((def) => Array.isArray(streams.value[def.key]?.data) && streams.value[def.key].data.length > 0)
})

function defaultLayout() {
  return chartDefs.map((def) => ({ id: def.key, streams: [def.key] }))
}

function defByKey(key) {
  return chartDefs.find((d) => d.key === key)
}

// Aligns chartLayout with the streams actually present on this activity:
// - drops streams that aren't available
// - drops empty groups
// - appends any present stream that wasn't referenced by the saved layout
// Always returns a fresh array if anything changed (so the watcher fires once).
function syncLayoutWithStreams() {
  if (!streams.value) return
  const present = new Set(
    chartDefs
      .filter((d) => Array.isArray(streams.value[d.key]?.data) && streams.value[d.key].data.length > 0)
      .map((d) => d.key),
  )
  const cleaned = chartLayout.value
    .map((g) => ({ id: g.id, streams: g.streams.filter((k) => present.has(k)) }))
    .filter((g) => g.streams.length > 0)
  const referenced = new Set(cleaned.flatMap((g) => g.streams))
  const missing = [...present].filter((k) => !referenced.has(k))
  const final = [...cleaned, ...missing.map((k) => ({ id: k, streams: [k] }))]
  if (JSON.stringify(final) === JSON.stringify(chartLayout.value)) return
  chartLayout.value = final
}

const chartLayout = ref(defaultLayout())
const layoutSaving = ref(false)
const layoutSavedAt = ref(null)
const layoutDirty = ref(false)
const dragSourceId = ref(null)
const dragOverGroupId = ref(null)
const dragOverSlotIndex = ref(null)

// All visible groups are kept in chartLayout (kept in sync via syncLayoutWithStreams),
// so the displayed layout is just chartLayout itself — no virtual groups.
const availableLayout = computed(() => (streams.value ? chartLayout.value : []))

function timeFactor() {
  return timeUnit.value === 'h' ? 3600 : timeUnit.value === 'min' ? 60 : 1
}

function autoTimeUnit(elapsed) {
  if (!elapsed) return 'min'
  if (elapsed <= 120) return 's'
  if (elapsed <= 7200) return 'min'
  return 'h'
}

function formatDuration(seconds) {
  if (!seconds) return '–'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}min` : (m > 0 ? `${m}min ${s}s` : `${s}s`)
}

function decodePolyline(str) {
  let index = 0
  let lat = 0
  let lng = 0
  const coords = []
  while (index < str.length) {
    let b
    let shift = 0
    let result = 0
    do {
      b = str.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1)
    lat += dlat

    shift = 0
    result = 0
    do {
      b = str.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1)
    lng += dlng

    coords.push([lng / 1e5, lat / 1e5])
  }
  return coords
}

// Binary search the x stream (raw units: meters or seconds) for the closest index to `target`.
function xValueToIndex(target) {
  const stream = streams.value?.[xAxis.value]?.data
  if (!stream || stream.length === 0) return 0
  let lo = 0
  let hi = stream.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stream[mid] < target) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(stream[lo - 1] - target) < Math.abs(stream[lo] - target)) return lo - 1
  return lo
}

function latLngToIndex(lng, lat) {
  const arr = streams.value?.latlng?.data
  if (!arr || arr.length === 0) return 0
  let bestIdx = 0
  let bestD = Infinity
  for (let i = 0; i < arr.length; i++) {
    const dLat = arr[i][0] - lat
    const dLng = arr[i][1] - lng
    const d = dLat * dLat + dLng * dLng
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

function setSelection(startIdx, endIdx) {
  if (startIdx == null || endIdx == null) {
    selection.value = null
    return
  }
  let s = Math.max(0, Math.min(startIdx, endIdx))
  let e = Math.max(startIdx, endIdx)
  const maxIdx = (streams.value?.[xAxis.value]?.data?.length || streams.value?.time?.data?.length || 1) - 1
  e = Math.min(maxIdx, e)
  selection.value = { startIdx: s, endIdx: e }
}

function clearSelection() {
  selection.value = null
  if (markerA && markerB && hasLatLngStream.value) {
    const data = streams.value.latlng.data
    markerA.setLngLat([data[0][1], data[0][0]])
    markerB.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
    applyMarkerRoles()
  }
}

function chartStats(def) {
  const data = streams.value?.[def.key]?.data
  if (!data || data.length === 0) return null
  const s = selectionDisplay.value?.startIdx ?? 0
  const e = selectionDisplay.value?.endIdx ?? data.length - 1
  let count = 0
  let sum = 0
  let mn = Infinity
  let mx = -Infinity
  for (let i = s; i <= e && i < data.length; i++) {
    const v = def.transform(data[i])
    if (v == null || Number.isNaN(v)) continue
    count++
    sum += v
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  if (count === 0) return null
  return { count, mean: sum / count, min: mn, max: mx }
}

function fmt(v, digits) {
  if (v == null || Number.isNaN(v)) return '–'
  return v.toFixed(digits)
}

function rangeBounds() {
  const refStream = streams.value?.distance?.data || streams.value?.time?.data || streams.value?.latlng?.data
  if (!refStream || refStream.length === 0) return null
  const maxIdx = refStream.length - 1
  const s = Math.max(0, Math.min(selectionDisplay.value?.startIdx ?? 0, maxIdx))
  const e = Math.max(s, Math.min(selectionDisplay.value?.endIdx ?? maxIdx, maxIdx))
  return { startIdx: s, endIdx: e }
}

function rangeDuration() {
  const b = rangeBounds()
  const time = streams.value?.time?.data
  if (!b || !time || time.length === 0) return null
  const t0 = time[Math.min(b.startIdx, time.length - 1)]
  const t1 = time[Math.min(b.endIdx, time.length - 1)]
  return Math.max(0, t1 - t0)
}

function rangeDistance() {
  const b = rangeBounds()
  const dist = streams.value?.distance?.data
  if (!b || !dist || dist.length === 0) return null
  const d0 = dist[Math.min(b.startIdx, dist.length - 1)]
  const d1 = dist[Math.min(b.endIdx, dist.length - 1)]
  return Math.max(0, d1 - d0)
}

function rangeElevation() {
  const b = rangeBounds()
  const alt = streams.value?.altitude?.data
  if (!b || !alt || alt.length < 2) return null
  const start = Math.max(b.startIdx, 0)
  const end = Math.min(b.endIdx, alt.length - 1)
  let up = 0
  let down = 0
  for (let i = start + 1; i <= end; i++) {
    const d = alt[i] - alt[i - 1]
    if (d > 0) up += d
    else down += d
  }
  return { up, down: Math.abs(down) }
}

function rangePointCount() {
  const b = rangeBounds()
  if (!b) return null
  return b.endIdx - b.startIdx + 1
}

function rangeGrade() {
  const b = rangeBounds()
  if (!b) return null
  const grade = streams.value?.grade_smooth?.data
  if (grade && grade.length > 0) {
    let sum = 0
    let count = 0
    const end = Math.min(b.endIdx, grade.length - 1)
    for (let i = b.startIdx; i <= end; i++) {
      const v = grade[i]
      if (v == null || Number.isNaN(v)) continue
      sum += v
      count++
    }
    if (count === 0) return null
    return sum / count
  }
  const alt = streams.value?.altitude?.data
  const dist = streams.value?.distance?.data
  if (!alt || !dist || alt.length === 0 || dist.length === 0) return null
  const d0 = dist[Math.min(b.startIdx, dist.length - 1)]
  const d1 = dist[Math.min(b.endIdx, dist.length - 1)]
  if (d1 - d0 <= 0) return null
  const a0 = alt[Math.min(b.startIdx, alt.length - 1)]
  const a1 = alt[Math.min(b.endIdx, alt.length - 1)]
  return ((a1 - a0) / (d1 - d0)) * 100
}

function formatHMS(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '–'
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function formatKm(meters) {
  if (meters == null || Number.isNaN(meters)) return '–'
  return `${(meters / 1000).toFixed(2)} km`
}

async function fetchActivity() {
  try {
    const res = await fetch(`/strava/activities/${props.activityId}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (res.status === 404) {
      error.value = t('strava.activity_not_found')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    activity.value = payload.activity
    timeUnit.value = autoTimeUnit(activity.value?.elapsed_time)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function fetchStreams() {
  streamsLoading.value = true
  streamsError.value = null
  try {
    const res = await fetch(`/strava/activities/${props.activityId}/streams`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    streams.value = payload.streams || {}
  } catch (e) {
    streamsError.value = e.message
  } finally {
    streamsLoading.value = false
  }
}

const HANDLE_TOL = 8 // pixels around a flag pole that count as a "grab"

function drawChartFlag(ctx, area, x, kind) {
  const fw = 12
  const fh = 9
  const headTop = Math.max(0, area.top - fh)
  ctx.save()
  // pole
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x, area.top)
  ctx.lineTo(x, area.bottom)
  ctx.stroke()
  // flag head
  if (kind === 'start') {
    ctx.fillStyle = '#22c55e'
    ctx.fillRect(x, headTop, fw, fh)
    ctx.strokeStyle = '#15803d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  } else {
    const cell = 3
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ef4444' : '#ffffff'
        ctx.fillRect(x + c * cell, headTop + r * cell, cell, cell)
      }
    }
    ctx.strokeStyle = '#7f1d1d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  }
  // anchor dot at pole top
  ctx.fillStyle = '#1f2937'
  ctx.beginPath()
  ctx.arc(x, area.top, 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function detectChartHandle(chart, px) {
  const sel = chart.$selectionRange
  if (!sel || sel.start == null || sel.end == null) return null
  const area = chart.chartArea
  const px1 = Math.max(area.left, Math.min(area.right, chart.scales.x.getPixelForValue(sel.start)))
  const px2 = Math.max(area.left, Math.min(area.right, chart.scales.x.getPixelForValue(sel.end)))
  const startVal = sel.start
  const endVal = sel.end
  const dStart = Math.abs(px - px1)
  const dEnd = Math.abs(px - px2)
  if (dStart <= HANDLE_TOL && dStart <= dEnd) return { fixedValue: endVal }
  if (dEnd <= HANDLE_TOL) return { fixedValue: startVal }
  return null
}

// Chart.js plugin: drag-to-select on the canvas, draggable flag handles, and selection highlight.
const dragSelectPlugin = {
  id: 'dragSelect',
  beforeEvent(chart, args) {
    const e = args.event
    const native = e.native
    if (!native) return
    const st = chart.$drag || (chart.$drag = { mode: null, x0: null, x1: null, fixedValue: null })

    const isStart = (native.type === 'mousedown' && native.button === 0) || native.type === 'touchstart'
    const isMove = native.type === 'mousemove' || native.type === 'touchmove'
    const isEnd = native.type === 'mouseup' || native.type === 'mouseout' || native.type === 'touchend' || native.type === 'touchcancel'

    if (isStart) {
      const area = chart.chartArea
      if (e.x < area.left - HANDLE_TOL || e.x > area.right + HANDLE_TOL) return
      const handle = detectChartHandle(chart, e.x)
      if (handle) {
        st.mode = 'handle'
        st.fixedValue = handle.fixedValue
        chart.canvas.style.cursor = 'ew-resize'
      } else {
        st.mode = 'select'
        st.x0 = e.x
        st.x1 = e.x
        chart.canvas.style.cursor = 'crosshair'
      }
      if (native.type === 'touchstart' && native.cancelable) native.preventDefault()
      chart.draw()
    } else if (isMove && st.mode === 'handle') {
      const v = chart.scales.x.getValueForPixel(e.x)
      if (v != null && !Number.isNaN(v)) {
        chart.$onSelect?.(st.fixedValue, v)
      }
      if (native.type === 'touchmove' && native.cancelable) native.preventDefault()
    } else if (isMove && st.mode === 'select') {
      st.x1 = e.x
      if (native.type === 'touchmove' && native.cancelable) native.preventDefault()
      chart.draw()
    } else if (isMove && !st.mode) {
      const handle = detectChartHandle(chart, e.x)
      chart.canvas.style.cursor = handle ? 'ew-resize' : 'crosshair'
    } else if (isEnd && st.mode) {
      if (st.mode === 'select') {
        const area = chart.chartArea
        const x0 = Math.max(area.left, Math.min(area.right, st.x0))
        const x1 = Math.max(area.left, Math.min(area.right, st.x1))
        if (Math.abs(x1 - x0) >= 4) {
          const v0 = chart.scales.x.getValueForPixel(x0)
          const v1 = chart.scales.x.getValueForPixel(x1)
          chart.$onSelect?.(v0, v1)
        }
      }
      st.mode = null
      st.x0 = null
      st.x1 = null
      st.fixedValue = null
      chart.canvas.style.cursor = 'crosshair'
      chart.draw()
    }
  },
  afterDraw(chart) {
    const { ctx, chartArea } = chart
    const st = chart.$drag
    const sel = chart.$selectionRange
    if (sel && sel.start != null && sel.end != null) {
      const px1 = chart.scales.x.getPixelForValue(sel.start)
      const px2 = chart.scales.x.getPixelForValue(sel.end)
      const lo = Math.min(px1, px2)
      const hi = Math.max(px1, px2)
      if (!chart.$noSelection) {
        const clipLo = Math.max(chartArea.left, lo)
        const clipHi = Math.min(chartArea.right, hi)
        if (clipHi > clipLo) {
          ctx.save()
          ctx.fillStyle = 'rgba(13, 110, 253, 0.15)'
          ctx.fillRect(clipLo, chartArea.top, clipHi - clipLo, chartArea.bottom - chartArea.top)
          ctx.restore()
        }
      }
      const drawLo = Math.max(chartArea.left, Math.min(chartArea.right, lo))
      const drawHi = Math.max(chartArea.left, Math.min(chartArea.right, hi))
      drawChartFlag(ctx, chartArea, drawLo, 'start')
      drawChartFlag(ctx, chartArea, drawHi, 'end')
    }
    if (st && st.mode === 'select' && st.x0 != null && st.x1 != null) {
      ctx.save()
      ctx.fillStyle = 'rgba(13, 110, 253, 0.25)'
      ctx.fillRect(Math.min(st.x0, st.x1), chartArea.top, Math.abs(st.x1 - st.x0), chartArea.bottom - chartArea.top)
      ctx.restore()
    }
  },
}

async function renderMap() {
  if (!hasRoute.value || !mapEl.value) return

  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  const coords = routeCoords.value
  const bounds = coords.reduce(
    (b, c) => [
      [Math.min(b[0][0], c[0]), Math.min(b[0][1], c[1])],
      [Math.max(b[1][0], c[0]), Math.max(b[1][1], c[1])],
    ],
    [[coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]],
  )

  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    bounds,
    fitBoundsOptions: { padding: 40 },
  })

  mapInstance.on('load', () => {
    mapInstance.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fc4c02', 'line-width': 4 },
    })

    mapInstance.addImage('route-arrow', buildArrowIcon())
    mapInstance.addLayer({
      id: 'route-direction',
      type: 'symbol',
      source: 'route',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 90,
        'icon-image': 'route-arrow',
        'icon-size': 1,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
      },
    })

    mapInstance.addSource('selected-route', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    mapInstance.addLayer({
      id: 'selected-route-line',
      type: 'line',
      source: 'selected-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#0d6efd', 'line-width': 6 },
    })

    if (hasLatLngStream.value) {
      installMapHandles(maplibregl)
    }
    refreshSelectedRoute()
  })
}

function buildArrowIcon() {
  const size = 18
  const cnv = document.createElement('canvas')
  cnv.width = size
  cnv.height = size
  const ctx = cnv.getContext('2d')
  ctx.translate(size / 2, size / 2)
  ctx.beginPath()
  ctx.moveTo(6, 0)
  ctx.lineTo(-5, -5)
  ctx.lineTo(-5, 5)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#7a2400'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  const imgData = ctx.getImageData(0, 0, size, size)
  return { width: size, height: size, data: new Uint8Array(imgData.data.buffer) }
}

function createFlagElement(kind) {
  const el = document.createElement('div')
  el.dataset.kind = kind
  el.style.cursor = 'grab'
  el.style.width = '28px'
  el.style.height = '36px'
  el.innerHTML = flagSvg(kind)
  return el
}

function flagSvg(kind) {
  if (kind === 'start') {
    return `
      <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
        <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
        <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
        <path d="M4 4 L24 4 L24 18 L4 18 Z" fill="#22c55e" stroke="#15803d" stroke-width="1"/>
      </svg>`
  }
  // checkered flag
  const cells = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = 4 + col * 5
      const y = 4 + row * 5
      const dark = (row + col) % 2 === 0
      cells.push(`<rect x="${x}" y="${y}" width="5" height="5" fill="${dark ? '#ef4444' : '#ffffff'}"/>`)
    }
  }
  return `
    <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
      <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
      <rect x="4" y="4" width="20" height="15" fill="none" stroke="#7f1d1d" stroke-width="1"/>
      ${cells.join('')}
    </svg>`
}

function setFlagKind(el, kind) {
  if (el.dataset.kind === kind) return
  el.dataset.kind = kind
  el.innerHTML = flagSvg(kind)
}

function applyMarkerRoles() {
  if (!markerA || !markerB || !hasLatLngStream.value) return
  const a = markerA.getLngLat()
  const b = markerB.getLngLat()
  const aIdx = latLngToIndex(a.lng, a.lat)
  const bIdx = latLngToIndex(b.lng, b.lat)
  const aIsStart = aIdx <= bIdx
  setFlagKind(markerA.getElement(), aIsStart ? 'start' : 'end')
  setFlagKind(markerB.getElement(), aIsStart ? 'end' : 'start')
}

function installMapHandles(maplibregl) {
  const data = streams.value.latlng.data
  if (data.length < 2) return
  const start = data[0]
  const end = data[data.length - 1]

  const elA = createFlagElement('start')
  const elB = createFlagElement('end')
  markerA = new maplibregl.Marker({ element: elA, draggable: true, anchor: 'bottom-left' })
    .setLngLat([start[1], start[0]])
    .addTo(mapInstance)
  markerB = new maplibregl.Marker({ element: elB, draggable: true, anchor: 'bottom-left' })
    .setLngLat([end[1], end[0]])
    .addTo(mapInstance)

  markerA.on('dragstart', () => { isDragging = true })
  markerB.on('dragstart', () => { isDragging = true })
  markerA.on('drag', () => scheduleMarkerSync())
  markerB.on('drag', () => scheduleMarkerSync())
  markerA.on('dragend', () => { isDragging = false; syncFromMarkers() })
  markerB.on('dragend', () => { isDragging = false; syncFromMarkers() })

  applyMarkerRoles()
}

function scheduleMarkerSync() {
  if (dragRafPending) return
  dragRafPending = true
  requestAnimationFrame(() => {
    dragRafPending = false
    syncFromMarkers()
  })
}

function syncFromMarkers() {
  if (!markerA || !markerB) return
  const a = markerA.getLngLat()
  const b = markerB.getLngLat()
  const aIdx = latLngToIndex(a.lng, a.lat)
  const bIdx = latLngToIndex(b.lng, b.lat)
  const maxIdx = streams.value.latlng.data.length - 1
  const lo = Math.min(aIdx, bIdx)
  const hi = Math.max(aIdx, bIdx)
  const isFullRange = lo === 0 && hi === maxIdx
  if (isFullRange) {
    selection.value = null
  } else {
    setSelection(lo, hi)
  }
  applyMarkerRoles()
}

function refreshSelectedRoute() {
  if (!mapInstance || !mapInstance.getSource('selected-route')) return
  if (!hasLatLngStream.value || !selection.value) {
    mapInstance.getSource('selected-route').setData({ type: 'FeatureCollection', features: [] })
    return
  }
  const data = streams.value.latlng.data
  const { startIdx, endIdx } = selection.value
  const coords = data.slice(startIdx, endIdx + 1).map(([lat, lng]) => [lng, lat])
  mapInstance.getSource('selected-route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
  })
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr
  const step = arr.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.floor(i * step)])
  }
  return out
}

function chartXFromRaw(rawX) {
  if (xAxis.value === 'distance') return rawX / 1000
  return rawX / timeFactor()
}

function chartXToRaw(x) {
  if (xAxis.value === 'distance') return x * 1000
  return x * timeFactor()
}

function xAxisLabel() {
  if (xAxis.value === 'distance') return t('strava.distance_km')
  return t('strava.time_label_' + timeUnit.value)
}

async function renderCharts() {
  const groups = availableLayout.value
  if (groups.length === 0) return

  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables, dragSelectPlugin)

  destroyCharts()

  const xStream = streams.value[xAxis.value]?.data || streams.value.time?.data || []
  const maxPoints = 600
  const xRaw = xStream
  xMinAll = xRaw.length > 0 ? chartXFromRaw(xRaw[0]) : 0
  xMaxAll = xRaw.length > 0 ? chartXFromRaw(xRaw[xRaw.length - 1]) : 0

  groups.forEach((group) => {
    const canvas = document.getElementById(`chart-${group.id}`)
    if (!canvas) return

    const datasets = group.streams.map((streamKey) => {
      const def = defByKey(streamKey)
      if (!def) return null
      const yRaw = streams.value[streamKey].data
      const len = Math.min(xRaw.length, yRaw.length)
      const pairs = []
      for (let i = 0; i < len; i++) {
        pairs.push({ x: chartXFromRaw(xRaw[i]), y: def.transform(yRaw[i]) })
      }
      const data = downsample(pairs, maxPoints)
      return {
        label: `${t('strava.stream.' + def.key)} (${def.unit})`,
        data,
        borderColor: def.color,
        backgroundColor: def.color + '22',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: group.streams.length === 1,
        yAxisID: `y-${streamKey}`,
      }
    }).filter(Boolean)

    const yScales = {}
    group.streams.forEach((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return
      yScales[`y-${streamKey}`] = {
        type: 'linear',
        position: idx % 2 === 0 ? 'left' : 'right',
        title: { display: true, text: def.unit, color: def.color },
        ticks: { maxTicksLimit: 6, color: def.color },
        grid: { drawOnChartArea: idx === 0 },
      }
    })

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { intersect: false, mode: 'nearest' },
        events: ['mousedown', 'mousemove', 'mouseup', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'],
        plugins: {
          legend: { display: group.streams.length > 1, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: xAxisLabel() },
            ticks: { maxTicksLimit: 8 },
            min: zoomRange.value?.xMin,
            max: zoomRange.value?.xMax,
          },
          ...yScales,
        },
      },
    })

    chart.$onSelect = (v0, v1) => {
      const r0 = chartXToRaw(Math.min(v0, v1))
      const r1 = chartXToRaw(Math.max(v0, v1))
      const sIdx = xValueToIndex(r0)
      const eIdx = xValueToIndex(r1)
      const xs = streams.value?.[xAxis.value]?.data || streams.value?.time?.data
      const maxIdx = (xs?.length || 1) - 1
      if (sIdx <= 0 && eIdx >= maxIdx) {
        selection.value = null
      } else {
        setSelection(sIdx, eIdx)
      }
    }

    const wheelHandler = (e) => handleZoomWheel(chart, e)
    canvas.addEventListener('wheel', wheelHandler, { passive: false })
    wheelHandlers.set(group.id, { canvas, handler: wheelHandler })

    chartInstances.set(group.id, chart)
  })

  applySelectionToCharts()
}

function applySelectionToCharts() {
  const xs = streams.value?.[xAxis.value]?.data
  if (!xs || xs.length === 0) return
  const fullStart = chartXFromRaw(xs[0])
  const fullEnd = chartXFromRaw(xs[xs.length - 1])
  chartInstances.forEach((chart) => {
    if (!selection.value) {
      chart.$selectionRange = { start: fullStart, end: fullEnd }
      chart.$noSelection = true
    } else {
      const x0 = chartXFromRaw(xs[selection.value.startIdx])
      const x1 = chartXFromRaw(xs[selection.value.endIdx])
      chart.$selectionRange = { start: x0, end: x1 }
      chart.$noSelection = false
    }
    chart.draw()
  })
}

function syncMarkersFromSelection() {
  if (isDragging) return
  if (!markerA || !markerB || !hasLatLngStream.value) return
  const data = streams.value.latlng.data
  if (!selection.value) {
    markerA.setLngLat([data[0][1], data[0][0]])
    markerB.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
  } else {
    const { startIdx, endIdx } = selection.value
    markerA.setLngLat([data[startIdx][1], data[startIdx][0]])
    markerB.setLngLat([data[endIdx][1], data[endIdx][0]])
  }
  applyMarkerRoles()
}

function destroyCharts() {
  wheelHandlers.forEach(({ canvas, handler }) => canvas.removeEventListener('wheel', handler))
  wheelHandlers.clear()
  chartInstances.forEach((c) => c.destroy())
  chartInstances.clear()
}

function mergeGroups(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const merged = {
    id: target.id,
    streams: [...target.streams, ...source.streams.filter((s) => !target.streams.includes(s))],
  }
  chartLayout.value = chartLayout.value
    .filter((g) => g.id !== sourceId)
    .map((g) => (g.id === targetId ? merged : g))
  layoutDirty.value = true
}

function splitGroup(group) {
  if (!group || group.streams.length <= 1) return
  const idx = chartLayout.value.findIndex((g) => g.id === group.id)
  if (idx < 0) return
  const replacements = group.streams.map((s) => ({ id: s, streams: [s] }))
  const newLayout = [...chartLayout.value]
  newLayout.splice(idx, 1, ...replacements)
  chartLayout.value = newLayout
  layoutDirty.value = true
}

function moveGroupToIndex(groupId, targetIndex) {
  const idx = chartLayout.value.findIndex((g) => g.id === groupId)
  if (idx < 0) return
  const arr = [...chartLayout.value]
  const [moved] = arr.splice(idx, 1)
  const clamped = Math.max(0, Math.min(targetIndex > idx ? targetIndex - 1 : targetIndex, arr.length))
  arr.splice(clamped, 0, moved)
  if (arr.every((g, i) => g.id === chartLayout.value[i]?.id)) return
  chartLayout.value = arr
  layoutDirty.value = true
}

function resetLayoutLocal() {
  chartLayout.value = defaultLayout()
  layoutDirty.value = true
}

async function fetchSavedLayout() {
  try {
    const res = await fetch('/preferences/chart_layout', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    const list = payload.chart_layout
    if (Array.isArray(list) && list.length > 0) {
      chartLayout.value = list.map((g) => ({
        id: String(g.id),
        streams: Array.isArray(g.streams) ? g.streams.map(String) : [],
      }))
      layoutDirty.value = false
    }
  } catch {
    // ignore — keep default layout
  }
  syncLayoutWithStreams()
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function saveLayout() {
  if (layoutSaving.value) return
  layoutSaving.value = true
  try {
    const res = await fetch('/preferences/chart_layout', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ chart_layout: chartLayout.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    layoutSavedAt.value = new Date()
    layoutDirty.value = false
  } catch (e) {
    error.value = e.message
  } finally {
    layoutSaving.value = false
  }
}

async function resetLayout() {
  resetLayoutLocal()
  try {
    await fetch('/preferences/chart_layout', {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    layoutDirty.value = false
  } catch {
    // ignore
  }
}

function onChartDragStart(group, e) {
  dragSourceId.value = group.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', group.id)
    // Use the whole card as the drag image so the user sees what they're moving.
    const card = e.currentTarget?.closest?.('.chart-group')
    if (card) {
      try { e.dataTransfer.setDragImage(card, 20, 20) } catch {}
    }
  }
}

function onChartDragEnd() {
  dragSourceId.value = null
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
}

function onGroupDragOver(group, e) {
  if (!dragSourceId.value || dragSourceId.value === group.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'link'
  dragOverGroupId.value = group.id
}

function onGroupDragLeave(group) {
  if (dragOverGroupId.value === group.id) dragOverGroupId.value = null
}

function onGroupDrop(group, e) {
  e.preventDefault()
  if (!dragSourceId.value || dragSourceId.value === group.id) return
  mergeGroups(dragSourceId.value, group.id)
  dragOverGroupId.value = null
  dragSourceId.value = null
}

function onSlotDragOver(idx, e) {
  if (!dragSourceId.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverSlotIndex.value = idx
}

function onSlotDragLeave(idx) {
  if (dragOverSlotIndex.value === idx) dragOverSlotIndex.value = null
}

function onSlotDrop(idx, e) {
  e.preventDefault()
  if (!dragSourceId.value) return
  moveGroupToIndex(dragSourceId.value, idx)
  dragOverSlotIndex.value = null
  dragSourceId.value = null
}

function setZoom(min, max) {
  const natural = xMaxAll - xMinAll
  if (natural <= 0) return
  const minSpan = natural * 0.005
  let lo = Math.max(min, xMinAll)
  let hi = Math.min(max, xMaxAll)
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2
    lo = Math.max(xMinAll, mid - minSpan / 2)
    hi = Math.min(xMaxAll, mid + minSpan / 2)
  }
  if (lo <= xMinAll && hi >= xMaxAll) {
    zoomRange.value = null
  } else {
    zoomRange.value = { xMin: lo, xMax: hi }
  }
}

function resetZoom() {
  zoomRange.value = null
}

function applyZoomToCharts() {
  chartInstances.forEach((chart) => {
    chart.options.scales.x.min = zoomRange.value?.xMin
    chart.options.scales.x.max = zoomRange.value?.xMax
    chart.update('none')
  })
}

let wheelRafPending = false
let pendingWheel = null

function handleZoomWheel(chart, e) {
  e.preventDefault()
  const rect = chart.canvas.getBoundingClientRect()
  const px = e.clientX - rect.left
  // Latest event wins per frame — older pending events are dropped.
  pendingWheel = { chart, px, deltaY: e.deltaY }
  if (wheelRafPending) return
  wheelRafPending = true
  requestAnimationFrame(() => {
    wheelRafPending = false
    if (!pendingWheel) return
    const { chart: c, px: p, deltaY } = pendingWheel
    pendingWheel = null
    applyZoomStep(c, p, deltaY)
  })
}

function applyZoomStep(chart, px, deltaY) {
  const xScale = chart.scales.x
  const cursorVal = xScale.getValueForPixel(px)
  const currentMin = zoomRange.value?.xMin ?? xMinAll
  const currentMax = zoomRange.value?.xMax ?? xMaxAll
  const range = currentMax - currentMin
  if (range <= 0 || cursorVal == null || Number.isNaN(cursorVal)) return
  const factor = deltaY > 0 ? 1.25 : 0.8
  const naturalRange = xMaxAll - xMinAll
  const newRange = range * factor
  if (newRange >= naturalRange) {
    resetZoom()
    return
  }
  const leftFrac = (cursorVal - currentMin) / range
  let newMin = cursorVal - leftFrac * newRange
  let newMax = newMin + newRange
  if (newMin < xMinAll) {
    newMax += xMinAll - newMin
    newMin = xMinAll
  }
  if (newMax > xMaxAll) {
    newMin -= newMax - xMaxAll
    newMax = xMaxAll
  }
  setZoom(newMin, newMax)
}

watch([xAxis, timeUnit], () => {
  zoomRange.value = null
  if (streams.value) renderCharts()
})

watch(chartLayout, async () => {
  if (!streams.value) return
  await nextTick()
  renderCharts()
}, { deep: true })

watch(zoomRange, applyZoomToCharts)

watch(selection, () => {
  applySelectionToCharts()
  refreshSelectedRoute()
  syncMarkersFromSelection()
})

let displayDebounceTimer = null
const DISPLAY_DEBOUNCE_MS = 60
watch(selection, (val) => {
  if (displayDebounceTimer) clearTimeout(displayDebounceTimer)
  displayDebounceTimer = setTimeout(() => {
    displayDebounceTimer = null
    selectionDisplay.value = val ? { ...val } : null
  }, DISPLAY_DEBOUNCE_MS)
})

onMounted(async () => {
  const savedLayoutPromise = fetchSavedLayout()
  await fetchActivity()
  if (!activity.value) return
  await fetchStreams()
  await savedLayoutPromise
  syncLayoutWithStreams()
  if (hasRoute.value) {
    await renderMap()
  }
  if (streams.value && availableLayout.value.length > 0) {
    await new Promise((r) => requestAnimationFrame(r))
    await renderCharts()
  }
})

onBeforeUnmount(() => {
  if (mapInstance) {
    mapInstance.remove()
    mapInstance = null
  }
  destroyCharts()
})
</script>

<template>
  <div>
    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>Loading…</span>
    </div>
    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>
    <div v-else-if="activity">
      <div class="card mb-3 shadow-sm border-0">
        <div class="card-header activity-card-header d-flex align-items-center gap-2">
          <span class="activity-type-badge">
            <i :class="`fa-solid ${activityIcon(activity.type)}`" aria-hidden="true"></i>
          </span>
          <h2 class="h5 mb-0">{{ activity.name }}</h2>
        </div>
        <div class="card-body p-0">
          <div v-if="hasRoute" ref="mapEl" class="activity-map"></div>
          <div v-else class="alert alert-info m-3 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-map-location-dot" aria-hidden="true"></i>
            <span>{{ t('strava.no_route_data') }}</span>
          </div>
        </div>
      </div>

      <div class="row g-2 mb-3">
        <div
          v-for="(s, i) in stats"
          :key="i"
          class="col-6 col-md-4 col-lg-3"
        >
          <div class="stat-card">
            <span class="stat-icon">
              <i :class="`fa-solid ${s.icon}`" aria-hidden="true"></i>
            </span>
            <div>
              <div class="stat-label">{{ s.label }}</div>
              <div class="stat-value">{{ s.value }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card shadow-sm border-0">
        <div class="card-header activity-card-header charts-sticky-header">
          <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-chart-line text-warning" aria-hidden="true"></i>
              <span>{{ t('strava.charts') }}</span>
            </h3>
            <div class="d-flex flex-wrap gap-2 align-items-center">
              <button
                v-if="zoomRange"
                type="button"
                class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                @click="resetZoom"
                :title="t('strava.reset_zoom')"
              >
                <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
                <span>{{ t('strava.reset_zoom') }}</span>
              </button>
              <div class="btn-group btn-group-sm" role="group" :title="t('strava.layout.title')">
                <button
                  type="button"
                  class="btn btn-outline-secondary d-flex align-items-center gap-1"
                  @click="resetLayout"
                  :disabled="layoutSaving"
                >
                  <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
                  <span class="d-none d-md-inline">{{ t('strava.layout.reset') }}</span>
                </button>
                <button
                  type="button"
                  class="btn btn-outline-primary d-flex align-items-center gap-1"
                  @click="saveLayout"
                  :disabled="layoutSaving || !layoutDirty"
                >
                  <span v-if="layoutSaving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                  <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                  <span class="d-none d-md-inline">{{ layoutDirty ? t('strava.layout.save') : t('strava.layout.saved') }}</span>
                </button>
              </div>
              <button
                v-if="selection"
                type="button"
                class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                @click="clearSelection"
              >
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                <span>{{ t('strava.clear_selection') }}</span>
              </button>
              <div v-if="availableCharts.length > 0" class="btn-group btn-group-sm" role="group">
                <input type="radio" class="btn-check" name="xAxis" id="xAxis-distance" autocomplete="off" value="distance" v-model="xAxis" :disabled="!streams || !streams.distance" />
                <label class="btn btn-outline-secondary" for="xAxis-distance">{{ t('strava.x_distance') }}</label>
                <input type="radio" class="btn-check" name="xAxis" id="xAxis-time" autocomplete="off" value="time" v-model="xAxis" :disabled="!streams || !streams.time" />
                <label class="btn btn-outline-secondary" for="xAxis-time">{{ t('strava.x_time') }}</label>
              </div>
              <div v-if="xAxis === 'time'" class="btn-group btn-group-sm" role="group">
                <input type="radio" class="btn-check" name="timeUnit" id="timeUnit-s" autocomplete="off" value="s" v-model="timeUnit" />
                <label class="btn btn-outline-secondary" for="timeUnit-s">{{ t('strava.unit_s') }}</label>
                <input type="radio" class="btn-check" name="timeUnit" id="timeUnit-min" autocomplete="off" value="min" v-model="timeUnit" />
                <label class="btn btn-outline-secondary" for="timeUnit-min">{{ t('strava.unit_min') }}</label>
                <input type="radio" class="btn-check" name="timeUnit" id="timeUnit-h" autocomplete="off" value="h" v-model="timeUnit" />
                <label class="btn btn-outline-secondary" for="timeUnit-h">{{ t('strava.unit_h') }}</label>
              </div>
            </div>
          </div>
          <div v-if="availableCharts.length > 0" class="range-chips d-flex flex-wrap gap-2 align-items-center mt-2">
            <span class="range-chip" :class="selection ? 'range-chip-accent' : 'range-chip-muted'">
              <i :class="`fa-solid ${selection ? 'fa-crop-simple' : 'fa-bars-staggered'}`" aria-hidden="true"></i>
              <span>{{ selection ? t('strava.selection') : t('strava.whole_activity') }}</span>
            </span>
            <span v-if="rangePointCount() != null" class="range-chip">
              <i class="fa-solid fa-hashtag" aria-hidden="true"></i>
              <span class="range-chip-label">{{ t('strava.range_stats.count') }}</span>
              <strong>{{ rangePointCount() }}</strong>
            </span>
            <span v-if="rangeDuration() != null" class="range-chip">
              <i class="fa-regular fa-clock" aria-hidden="true"></i>
              <span class="range-chip-label">{{ t('strava.range_stats.duration') }}</span>
              <strong>{{ formatHMS(rangeDuration()) }}</strong>
            </span>
            <span v-if="rangeDistance() != null" class="range-chip">
              <i class="fa-solid fa-route" aria-hidden="true"></i>
              <span class="range-chip-label">{{ t('strava.range_stats.distance') }}</span>
              <strong>{{ formatKm(rangeDistance()) }}</strong>
            </span>
            <span v-if="rangeElevation()" class="range-chip range-chip-success">
              <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
              <span class="range-chip-label">{{ t('strava.range_stats.elev_gain') }}</span>
              <strong>{{ Math.round(rangeElevation().up) }} m</strong>
            </span>
            <span v-if="rangeElevation()" class="range-chip range-chip-danger">
              <i class="fa-solid fa-arrow-trend-down" aria-hidden="true"></i>
              <span class="range-chip-label">{{ t('strava.range_stats.elev_loss') }}</span>
              <strong>{{ Math.round(rangeElevation().down) }} m</strong>
            </span>
            <span v-if="rangeGrade() != null" class="range-chip">
              <i class="fa-solid fa-percent" aria-hidden="true"></i>
              <span class="range-chip-label">{{ t('strava.range_stats.avg_grade') }}</span>
              <strong>{{ rangeGrade().toFixed(1) }} %</strong>
            </span>
          </div>
        </div>
        <div class="card-body">
          <div v-if="streamsLoading" class="text-muted d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
            <span>{{ t('strava.loading_streams') }}</span>
          </div>
          <div v-else-if="streamsError" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <span>{{ streamsError }}</span>
          </div>
          <div v-else-if="availableLayout.length === 0" class="text-muted d-flex align-items-center gap-2">
            <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
            <span>{{ t('strava.no_stream_data') }}</span>
          </div>
          <div v-else class="chart-layout">
            <template v-for="(group, gIdx) in availableLayout" :key="group.id">
              <div
                class="chart-drop-slot"
                :class="{ active: dragOverSlotIndex === gIdx, hinting: dragSourceId }"
                @dragover="onSlotDragOver(gIdx, $event)"
                @dragleave="onSlotDragLeave(gIdx)"
                @drop="onSlotDrop(gIdx, $event)"
              ></div>
              <div
                class="chart-group"
                :class="{ 'merge-target': dragOverGroupId === group.id && dragSourceId !== group.id, dragging: dragSourceId === group.id }"
                :data-merge-label="t('strava.layout.merge_here')"
                @dragover="onGroupDragOver(group, $event)"
                @dragleave="onGroupDragLeave(group)"
                @drop="onGroupDrop(group, $event)"
              >
                <div
                  class="chart-group-header"
                  draggable="true"
                  @dragstart="onChartDragStart(group, $event)"
                  @dragend="onChartDragEnd"
                  :title="t('strava.layout.drag_hint')"
                >
                  <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                    <div class="d-flex align-items-center gap-2 flex-wrap">
                      <span class="drag-handle">
                        <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                      </span>
                      <span
                        v-for="streamKey in group.streams"
                        :key="streamKey"
                        class="text-muted small d-flex align-items-center gap-1"
                      >
                        <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" :style="{ color: defByKey(streamKey)?.color }" aria-hidden="true"></i>
                        <span>{{ t('strava.stream.' + streamKey) }} ({{ defByKey(streamKey)?.unit }})</span>
                      </span>
                    </div>
                    <button
                      v-if="group.streams.length > 1"
                      type="button"
                      class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                      draggable="false"
                      @click="splitGroup(group)"
                      @mousedown.stop
                      :title="t('strava.layout.split')"
                    >
                      <i class="fa-solid fa-object-ungroup" aria-hidden="true"></i>
                      <span>{{ t('strava.layout.split') }}</span>
                    </button>
                  </div>
                </div>
                <div class="row g-2 align-items-stretch">
                  <div class="col-lg-9">
                    <div class="chart-canvas-wrap">
                      <canvas :id="`chart-${group.id}`"></canvas>
                    </div>
                  </div>
                  <div class="col-lg-3">
                    <div
                      v-for="streamKey in group.streams"
                      :key="streamKey"
                      class="mb-2 stream-stats"
                    >
                      <div
                        v-if="group.streams.length > 1"
                        class="text-muted small fw-semibold mb-1 d-flex align-items-center gap-1"
                        :style="{ color: defByKey(streamKey)?.color }"
                      >
                        <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
                        <span>{{ t('strava.stream.' + streamKey) }}</span>
                      </div>
                      <dl class="small mb-0 stats-grid" v-if="chartStats(defByKey(streamKey))">
                        <dt class="text-muted">
                          <i class="fa-solid fa-equals stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.mean') }}
                        </dt>
                        <dd>{{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</dd>
                        <dt class="text-muted">
                          <i class="fa-solid fa-arrow-down-short-wide stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.min') }}
                        </dt>
                        <dd>{{ fmt(chartStats(defByKey(streamKey)).min, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</dd>
                        <dt class="text-muted">
                          <i class="fa-solid fa-arrow-up-wide-short stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.max') }}
                        </dt>
                        <dd>{{ fmt(chartStats(defByKey(streamKey)).max, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</dd>
                      </dl>
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <div
              class="chart-drop-slot"
              :class="{ active: dragOverSlotIndex === availableLayout.length, hinting: dragSourceId }"
              @dragover="onSlotDragOver(availableLayout.length, $event)"
              @dragleave="onSlotDragLeave(availableLayout.length)"
              @drop="onSlotDrop(availableLayout.length, $event)"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity-map {
  height: 420px;
  width: 100%;
}
.chart-canvas-wrap {
  position: relative;
  height: 180px;
  width: 100%;
}
.chart-canvas-wrap canvas {
  cursor: crosshair;
  touch-action: pan-y;
}
.stats-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  row-gap: 0.1rem;
}
.stats-grid dt {
  font-weight: 400;
}
.stats-grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.charts-sticky-header {
  position: sticky;
  top: 4rem;
  z-index: 5;
  background: #ffffff;
  backdrop-filter: saturate(140%);
  border-bottom: 1px solid rgba(252, 76, 2, 0.22);
  box-shadow: 0 6px 14px -10px rgba(0, 0, 0, 0.18);
}

.range-chips {
  font-size: 0.85rem;
}

.range-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: rgba(108, 117, 125, 0.1);
  color: #495057;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.range-chip strong {
  font-weight: 600;
  color: #212529;
}
.range-chip .range-chip-label {
  color: #6c757d;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.range-chip-accent {
  background: rgba(13, 110, 253, 0.12);
  color: #0a58ca;
}
.range-chip-muted {
  background: rgba(108, 117, 125, 0.12);
  color: #495057;
}
.range-chip-success {
  background: rgba(25, 135, 84, 0.12);
  color: #198754;
}
.range-chip-success strong { color: #146c43; }
.range-chip-danger {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
}
.range-chip-danger strong { color: #842029; }

.chart-layout {
  position: relative;
}
.chart-group {
  border-radius: 0.5rem;
  padding: 0.5rem;
  border: 1px solid transparent;
  position: relative;
  transition: outline 0.12s, background-color 0.12s, opacity 0.12s, box-shadow 0.12s;
}
.chart-group.dragging {
  opacity: 0.45;
}
.chart-group.merge-target {
  outline: 3px dashed #0d6efd;
  outline-offset: -3px;
  background: rgba(13, 110, 253, 0.08);
  box-shadow: 0 0 0 4px rgba(13, 110, 253, 0.12);
}
.chart-group.merge-target::after {
  content: "⤵ " attr(data-merge-label);
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: #0d6efd;
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  pointer-events: none;
  box-shadow: 0 6px 16px -4px rgba(13, 110, 253, 0.5);
  z-index: 4;
  white-space: nowrap;
}
.chart-group-header {
  cursor: grab;
  padding: 0.35rem 0.5rem;
  margin-bottom: 0.4rem;
  border-radius: 0.4rem;
  background: rgba(108, 117, 125, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.05);
  transition: background-color 0.12s, border-color 0.12s;
  user-select: none;
}
.chart-group-header:hover {
  background: rgba(252, 76, 2, 0.06);
  border-color: rgba(252, 76, 2, 0.25);
}
.chart-group.dragging .chart-group-header {
  cursor: grabbing;
}
.drag-handle {
  color: #adb5bd;
  font-size: 0.95rem;
  pointer-events: none;
}
.chart-group-header:hover .drag-handle {
  color: #fc4c02;
}
.chart-drop-slot {
  height: 6px;
  margin: 0;
  border-radius: 4px;
  background: transparent;
  transition: background-color 0.12s, height 0.12s, margin 0.12s, box-shadow 0.12s;
  position: relative;
}
.chart-drop-slot.hinting {
  height: 24px;
  margin: 6px 0;
  background: repeating-linear-gradient(
    45deg,
    rgba(108, 117, 125, 0.14),
    rgba(108, 117, 125, 0.14) 6px,
    rgba(108, 117, 125, 0.05) 6px,
    rgba(108, 117, 125, 0.05) 12px
  );
  border: 1px dashed rgba(108, 117, 125, 0.4);
}
.chart-drop-slot.hinting::before {
  content: "↕";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(108, 117, 125, 0.6);
  font-size: 0.95rem;
  pointer-events: none;
}
.chart-drop-slot.active {
  background: rgba(13, 110, 253, 0.35);
  border-color: #0d6efd;
  box-shadow: 0 0 0 2px rgba(13, 110, 253, 0.25);
  height: 28px;
  margin: 6px 0;
}
.chart-drop-slot.active::before {
  color: #0d6efd;
  font-weight: bold;
}
.stream-stats + .stream-stats {
  padding-top: 0.4rem;
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
}
</style>
