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
const climbMarkers = []
let _maplibregl = null // cached after first import so toggles can re-install markers
const mapStyleId = ref('cyclosm')
const showClimbs = ref(true)
const mapExpanded = ref(false)
const chartInstances = new Map()
const wheelHandlers = new Map()
const zoomRange = ref(null) // { xMin, xMax } | null — shared zoom across all charts
let xMinAll = 0
let xMaxAll = 0

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

const startEndDisplay = computed(() => {
  const a = activity.value
  if (!a?.start_date_local) return null
  // Strava ships start_date_local as a wall-clock local time but with a "Z"
  // suffix — strip it so JS doesn't shift it by the browser's UTC offset.
  const startMs = new Date(a.start_date_local.replace(/Z$/, '')).getTime()
  if (Number.isNaN(startMs)) return null
  const elapsed = a.elapsed_time
  const endMs = elapsed ? startMs + elapsed * 1000 : null
  const fmtFull = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  const fmtHM = { hour: '2-digit', minute: '2-digit' }
  const start = new Date(startMs)
  const end = endMs != null ? new Date(endMs) : null
  if (!end) return { start: start.toLocaleString(undefined, fmtFull), end: null, duration: null }
  const sameDay = start.toDateString() === end.toDateString()
  return {
    start: start.toLocaleString(undefined, fmtFull),
    end: sameDay ? end.toLocaleTimeString(undefined, fmtHM) : end.toLocaleString(undefined, fmtFull),
    duration: formatDuration(elapsed),
  }
})

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
  return chartDefs.map((def) => ({ id: def.key, streams: [def.key], collapsed: false }))
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
    .map((g) => ({ id: g.id, streams: g.streams.filter((k) => present.has(k)), collapsed: !!g.collapsed }))
    .filter((g) => g.streams.length > 0)
  const referenced = new Set(cleaned.flatMap((g) => g.streams))
  const missing = [...present].filter((k) => !referenced.has(k))
  const final = [...cleaned, ...missing.map((k) => ({ id: k, streams: [k], collapsed: false }))]
  if (JSON.stringify(final) === JSON.stringify(chartLayout.value)) return
  chartLayout.value = final
}

const chartLayout = ref(defaultLayout())
const layoutSaving = ref(false)
const layoutDirty = ref(false)
const savedLayouts = ref([]) // [{ id, name, layout }]
const selectedLayoutId = ref(null)
const lastUsedId = ref(null) // persisted on the server
const dragSourceId = ref(null)
const dragOverGroupId = ref(null)
const dragOverSlotIndex = ref(null)
const isCopyMode = ref(false) // true while Ctrl/Cmd is held during a drag
// groupId -> Set<datasetIndex> — which curves are currently hidden via the
// custom legend pills (Chart.js's built-in legend click was unreliable in
// our multi-axis setup).
const hiddenDatasets = ref(new Map())
const is3D = ref(false)

// All visible groups are kept in chartLayout (kept in sync via syncLayoutWithStreams),
// so the displayed layout is just chartLayout itself — no virtual groups.
const availableLayout = computed(() => (streams.value ? chartLayout.value : []))

// Deduplicated list of streams currently displayed somewhere — used to
// render mean chips in the sticky header.
const visibleStreams = computed(() => {
  const seen = new Set()
  const result = []
  for (const group of availableLayout.value) {
    for (const s of group.streams) {
      if (!seen.has(s)) {
        seen.add(s)
        result.push(s)
      }
    }
  }
  return result
})

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
      // Bail out for clicks outside the plotting area (legend at the top, axis
      // labels at the bottom/sides) — otherwise we'd start a drag-select and
      // swallow the legend's own click handler.
      if (e.x < area.left - HANDLE_TOL || e.x > area.right + HANDLE_TOL) return
      if (e.y < area.top || e.y > area.bottom) return
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
  _maplibregl = maplibregl
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
    style: mapStyleFor(mapStyleId.value),
    bounds,
    fitBoundsOptions: { padding: 40 },
    maxPitch: 75,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')

  mapInstance.on('load', () => {
    installRouteLayers(coords)
    if (hasLatLngStream.value) installMapHandles(maplibregl)
    installClimbMarkers(maplibregl)
  })
}

// Adds the route geometry / arrows / selection overlay to the current style.
// Safe to call after a setStyle() swap because all of these layers/sources
// belong to the style and are wiped when the style changes.
function installRouteLayers(coords) {
  if (!mapInstance) return
  const altitudes = streams.value?.altitude?.data
  const distances = streams.value?.distance?.data
  const grades = streams.value?.grade_smooth?.data
  const segments = buildGradedSegments(coords, grades, altitudes, distances)
  const hasGrades = segments.length > 0 && (grades?.length || (altitudes && distances))

  // Single LineString kept around so the direction-arrow symbol layer has a
  // continuous geometry to follow even when the visible route is split into
  // many graded segments.
  mapInstance.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
  })

  if (hasGrades) {
    mapInstance.addSource('route-graded', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: segments },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route-graded',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': [
          'match', ['get', 'bucket'],
          0, GRADE_BUCKETS[0].color,
          1, GRADE_BUCKETS[1].color,
          2, GRADE_BUCKETS[2].color,
          3, GRADE_BUCKETS[3].color,
          4, GRADE_BUCKETS[4].color,
          5, GRADE_BUCKETS[5].color,
          6, GRADE_BUCKETS[6].color,
          '#fc4c02',
        ],
        'line-width': 5,
      },
    })
  } else {
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fc4c02', 'line-width': 4 },
    })
  }

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

  // Re-apply the 3D terrain if it was on before the style switch.
  if (is3D.value) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
  }

  refreshSelectedRoute()
}

const THUNDERFOREST_KEY = (
  document.querySelector('meta[name="thunderforest-api-key"]')?.getAttribute('content') || ''
).trim()

function mapStyleFor(id) {
  if (id === 'liberty') return 'https://tiles.openfreemap.org/styles/liberty'
  if (id === 'topo') return openTopoMapStyle()
  if (id === 'cycle' && THUNDERFOREST_KEY) return openCycleMapStyle(THUNDERFOREST_KEY)
  return cyclOsmStyle()
}

function openTopoMapStyle() {
  return {
    version: 8,
    sources: {
      'topo-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution:
          'Map: © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>) · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM',
      },
    },
    layers: [
      { id: 'topo-base', type: 'raster', source: 'topo-raster' },
    ],
  }
}

function openCycleMapStyle(apiKey) {
  return {
    version: 8,
    sources: {
      'thunderforest-cycle': {
        type: 'raster',
        tiles: [
          `https://a.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
          `https://b.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
          `https://c.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
        ],
        tileSize: 256,
        maxzoom: 22,
        attribution:
          'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'cycle-base', type: 'raster', source: 'thunderforest-cycle' },
    ],
  }
}

function setMapStyle(id) {
  if (!mapInstance || id === mapStyleId.value) return
  mapStyleId.value = id
  // `diff: false` forces a full wipe of the previous style (including any
  // images/sources/layers we added on top). Without it, maplibre tries to
  // preserve custom items across the swap and our subsequent addImage()
  // call throws "An image named route-arrow already exists".
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  // HTML markers (climbs, drag flags) and NavigationControl survive — they
  // live in the map's container, not in the style.
  mapInstance.once('style.load', () => {
    installRouteLayers(routeCoords.value)
  })
}

function cyclOsmStyle() {
  return {
    version: 8,
    sources: {
      'cyclosm-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution:
          '© <a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: 'cyclosm-base',
        type: 'raster',
        source: 'cyclosm-raster',
        // Pulled back so the gradient-colored route stays the visual focal
        // point. Doesn't affect any layer drawn on top.
        paint: {
          'raster-saturation': -0.55,
          'raster-contrast': -0.1,
          'raster-opacity': 0.85,
        },
      },
    ],
  }
}

function installClimbMarkers(maplibregl) {
  // Always start clean: re-rendering the map shouldn't pile markers up.
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  if (!showClimbs.value) return
  const latlng = streams.value?.latlng?.data
  const altitudes = streams.value?.altitude?.data
  const distances = streams.value?.distance?.data
  const grades = streams.value?.grade_smooth?.data
  if (!latlng || !altitudes || !distances) return
  const climbs = detectClimbs(grades, altitudes, distances)
  climbs.forEach((climb) => {
    const pt = latlng[climb.startIdx]
    if (!pt) return
    const el = buildClimbMarkerEl(climb)
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' })
      .setLngLat([pt[1], pt[0]])
      .addTo(mapInstance)
    climbMarkers.push(marker)
  })
}

function toggleClimbs() {
  showClimbs.value = !showClimbs.value
  if (!showClimbs.value) {
    climbMarkers.forEach((m) => m.remove())
    climbMarkers.length = 0
  } else if (_maplibregl) {
    installClimbMarkers(_maplibregl)
  }
}

async function toggleMapSize() {
  mapExpanded.value = !mapExpanded.value
  // .map-wrap toggles to/from position:fixed full-screen — the layout change
  // is instant, so a single resize() after the DOM tick is enough for
  // maplibre to re-measure and re-project all markers (climbs, drag flags).
  await nextTick()
  if (mapInstance) mapInstance.resize()
}

function buildClimbMarkerEl(climb) {
  const el = document.createElement('div')
  const catClass = climb.category ? `climb-cat-${climb.category}` : 'climb-cat-uncat'
  el.className = `climb-marker ${catClass}`
  const lengthStr = climb.lengthM >= 1000
    ? `${(climb.lengthM / 1000).toFixed(1)} km`
    : `${Math.round(climb.lengthM)} m`
  el.innerHTML = `
    <i class="fa-solid fa-mountain" aria-hidden="true"></i>
    <span class="climb-marker-stats">+${Math.round(climb.gain)}m&nbsp;·&nbsp;${climb.avgGrade.toFixed(1)}%</span>
    ${climb.category ? `<span class="climb-marker-cat">${climb.category}</span>` : ''}
  `
  el.title = `${t('strava.click_to_select_climb')}\n${climb.category ? 'Cat ' + climb.category + ' · ' : ''}${lengthStr} · +${Math.round(climb.gain)} m · ${climb.avgGrade.toFixed(1)} %`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    setSelection(climb.startIdx, climb.endIdx)
  })
  // Make sure mousedown doesn't initiate a map pan when the user clicks the badge.
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return el
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

// ─── Cycling helpers: grade-colored route + climb detection ──────────────────

const GRADE_BUCKETS = [
  { max: -8,       color: '#1e3a8a' }, // very steep descent
  { max: -3,       color: '#3b82f6' }, // descent
  { max:  3,       color: '#22c55e' }, // flat / rolling
  { max:  6,       color: '#eab308' }, // easy climb
  { max: 10,       color: '#f97316' }, // medium climb
  { max: 15,       color: '#dc2626' }, // hard climb
  { max: Infinity, color: '#7f1d1d' }, // very hard climb
]

function bucketGrade(g) {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return i
  }
  return GRADE_BUCKETS.length - 1
}

function gradeForIndex(i, grades, altitudes, distances) {
  if (grades && grades[i] != null && !Number.isNaN(grades[i])) return grades[i]
  if (!altitudes || !distances || i + 1 >= altitudes.length || i + 1 >= distances.length) return 0
  const da = altitudes[i + 1] - altitudes[i]
  const dd = distances[i + 1] - distances[i]
  return dd > 0 ? (da / dd) * 100 : 0
}

function buildGradedSegments(coords, grades, altitudes, distances) {
  if (!coords || coords.length < 2) return []
  const features = []
  let current = [coords[0]]
  let curBucket = bucketGrade(gradeForIndex(0, grades, altitudes, distances))
  for (let i = 1; i < coords.length; i++) {
    const g = gradeForIndex(Math.min(i, coords.length - 2), grades, altitudes, distances)
    const b = bucketGrade(g)
    current.push(coords[i])
    if (b !== curBucket && current.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: current.slice() },
        properties: { bucket: curBucket },
      })
      current = [coords[i]]
      curBucket = b
    }
  }
  if (current.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: current },
      properties: { bucket: curBucket },
    })
  }
  return features
}

function climbCategory(lengthKm, avgGrade) {
  const score = lengthKm * Math.pow(Math.max(0, avgGrade), 2)
  if (score >= 400) return 'HC'
  if (score >= 200) return '1'
  if (score >= 100) return '2'
  if (score >= 60) return '3'
  if (score >= 25) return '4'
  return null
}

function detectClimbs(grades, altitudes, distances) {
  if (!altitudes || !distances || altitudes.length === 0 || distances.length === 0) return []
  const MIN_GRADE = 2
  const MIN_GAIN_M = 60
  const MIN_LENGTH_M = 500
  const MERGE_GAP_M = 250
  const len = Math.min(altitudes.length, distances.length, grades?.length ?? altitudes.length)
  const raw = []
  let startIdx = -1
  for (let i = 0; i < len; i++) {
    const g = gradeForIndex(i, grades, altitudes, distances)
    if (g >= MIN_GRADE) {
      if (startIdx < 0) startIdx = i
    } else if (startIdx >= 0) {
      raw.push({ startIdx, endIdx: i })
      startIdx = -1
    }
  }
  if (startIdx >= 0) raw.push({ startIdx, endIdx: len - 1 })
  const merged = []
  for (const r of raw) {
    if (!merged.length) { merged.push(r); continue }
    const prev = merged[merged.length - 1]
    const gap = distances[r.startIdx] - distances[prev.endIdx]
    if (gap <= MERGE_GAP_M) prev.endIdx = r.endIdx
    else merged.push(r)
  }
  return merged
    .map((r) => {
      const gain = altitudes[r.endIdx] - altitudes[r.startIdx]
      const lengthM = distances[r.endIdx] - distances[r.startIdx]
      const avgGrade = lengthM > 0 ? (gain / lengthM) * 100 : 0
      return { ...r, gain, lengthM, avgGrade, category: climbCategory(lengthM / 1000, avgGrade) }
    })
    .filter((c) => c.gain >= MIN_GAIN_M && c.lengthM >= MIN_LENGTH_M && c.avgGrade >= MIN_GRADE)
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
    if (group.collapsed) return
    const canvas = document.getElementById(`chart-${group.id}`)
    if (!canvas) return

    // Count occurrences so we can label duplicates (Altitude #2, etc.).
    const occurrences = new Map()
    const datasets = group.streams.map((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return null
      const count = (occurrences.get(streamKey) || 0) + 1
      occurrences.set(streamKey, count)
      const totalForKey = group.streams.filter((s) => s === streamKey).length
      const label = totalForKey > 1
        ? `${t('strava.stream.' + def.key)} #${count} (${def.unit})`
        : `${t('strava.stream.' + def.key)} (${def.unit})`
      const yRaw = streams.value[streamKey].data
      const len = Math.min(xRaw.length, yRaw.length)
      const pairs = []
      for (let i = 0; i < len; i++) {
        pairs.push({ x: chartXFromRaw(xRaw[i]), y: def.transform(yRaw[i]) })
      }
      const data = downsample(pairs, maxPoints)
      return {
        label,
        data,
        borderColor: def.color,
        backgroundColor: def.color + '33',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: true,
        yAxisID: `y-${idx}`,
        $streamKey: streamKey,
      }
    }).filter(Boolean)

    const yScales = {}
    group.streams.forEach((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return
      yScales[`y-${idx}`] = {
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
        interaction: { intersect: false, mode: 'index', axis: 'x' },
        events: ['mousedown', 'mousemove', 'mouseup', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'],
        plugins: {
          // Built-in legend disabled in favor of the custom Vue legend pills
          // above each chart — gives reliable click-to-toggle behavior.
          legend: { display: false },
          tooltip: {
            // Custom HTML tooltip aggregating the hovered chart + all the
            // other charts' values at the same x — see externalTooltipHandler.
            enabled: false,
            mode: 'index',
            intersect: false,
            external: externalTooltipHandler,
          },
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
  // Remove any external tooltip DOM nodes before destroying their charts.
  chartInstances.forEach((c) => {
    c.canvas.parentNode?.querySelector('.chart-tooltip')?.remove()
  })
  chartInstances.forEach((c) => c.destroy())
  chartInstances.clear()
  hiddenDatasets.value = new Map()
}

function externalTooltipHandler(context) {
  const { chart, tooltip } = context
  const parent = chart.canvas.parentNode
  if (!parent) return
  let el = parent.querySelector('.chart-tooltip')
  if (!el) {
    el = document.createElement('div')
    el.className = 'chart-tooltip'
    parent.appendChild(el)
  }
  if (tooltip.opacity === 0 || chart.$drag?.mode) {
    el.style.opacity = '0'
    return
  }
  const xv = tooltip.dataPoints?.[0]?.parsed?.x
  if (xv == null || Number.isNaN(xv)) {
    el.style.opacity = '0'
    return
  }
  // Build a two-line title: primary in the current axis unit, secondary in the other.
  const rawX = chartXToRaw(xv)
  const idx = xValueToIndex(rawX)
  const titleLines = []
  if (xAxis.value === 'distance') {
    titleLines.push({ main: true, text: `${xv.toFixed(2)} km` })
    const t0 = streams.value?.time?.data?.[idx]
    if (t0 != null) titleLines.push({ main: false, text: formatHMS(t0) })
  } else {
    titleLines.push({ main: true, text: formatHMS(xv * timeFactor()) })
    const dm = streams.value?.distance?.data?.[idx]
    if (dm != null) titleLines.push({ main: false, text: `${(dm / 1000).toFixed(2)} km` })
  }
  // Absolute datetime of this point = activity start + elapsed seconds.
  // Strava's start_date_local already is wall-clock time at the activity
  // location, but it's serialized with a trailing "Z" — parsing it as UTC
  // would then shift it by the browser's offset. Strip the Z so the Date is
  // built as local time in the browser's locale.
  const startIso = activity.value?.start_date_local
  const tSec = streams.value?.time?.data?.[idx]
  if (startIso && tSec != null) {
    const localBase = new Date(startIso.replace(/Z$/, '')).getTime()
    const dt = new Date(localBase + tSec * 1000)
    const stamp = dt.toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    titleLines.push({ main: false, text: stamp })
  }

  const rows = []
  const seen = new Set()
  // Current chart datasets (auto-filtered to visible by Chart.js).
  tooltip.dataPoints.forEach((item) => {
    const ds = chart.data.datasets[item.datasetIndex]
    const sk = ds.$streamKey
    if (sk && seen.has(sk)) return
    if (sk) seen.add(sk)
    rows.push(formatTooltipRow(ds, item.parsed.y))
  })
  // Other charts: nearest x-index, skip hidden datasets and streams we've
  // already shown (a stream may appear in several groups via copy).
  chartInstances.forEach((other) => {
    if (other === chart) return
    const first = other.data?.datasets?.[0]?.data
    if (!first || first.length === 0) return
    let idx = 0
    let bestDiff = Infinity
    for (let i = 0; i < first.length; i++) {
      const d = Math.abs(first[i].x - xv)
      if (d < bestDiff) {
        bestDiff = d
        idx = i
      }
    }
    other.data.datasets.forEach((ds, di) => {
      const meta = other.getDatasetMeta(di)
      if (meta?.hidden) return
      const sk = ds.$streamKey
      if (sk && seen.has(sk)) return
      const point = ds.data[idx]
      if (!point) return
      if (sk) seen.add(sk)
      rows.push(formatTooltipRow(ds, point.y))
    })
  })

  let html = '<div class="chart-tooltip-title">'
  for (const line of titleLines) {
    const cls = line.main ? 'chart-tooltip-title-main' : 'chart-tooltip-title-sub'
    html += `<div class="${cls}">${escapeHtml(line.text)}</div>`
  }
  html += '</div>'
  for (const r of rows) {
    html += `<div class="chart-tooltip-row">
      <span class="chart-tooltip-swatch" style="background:${r.color}"></span>
      <span class="chart-tooltip-name">${escapeHtml(r.name)}</span>
      <span class="chart-tooltip-value">${escapeHtml(r.value)} ${escapeHtml(r.unit)}</span>
    </div>`
  }
  el.innerHTML = html
  el.style.opacity = '1'

  // Place the tooltip to the side of the cursor (not on top) so the data
  // point being read stays visible. Side flip near the right edge.
  const cw = chart.canvas.clientWidth
  const ch = chart.canvas.clientHeight
  const tipRect = el.getBoundingClientRect()
  const OFFSET = 16
  const placeOnRight = tooltip.caretX + OFFSET + tipRect.width < cw - 4
  if (placeOnRight) {
    el.style.left = `${tooltip.caretX + OFFSET}px`
    el.style.transform = 'translate(0, -50%)'
  } else {
    el.style.left = `${tooltip.caretX - OFFSET}px`
    el.style.transform = 'translate(-100%, -50%)'
  }
  // Vertically center on the cursor, clamp to the canvas so it stays readable.
  let topPos = tooltip.caretY
  const halfH = tipRect.height / 2
  if (topPos - halfH < 4) topPos = halfH + 4
  if (topPos + halfH > ch - 4) topPos = ch - halfH - 4
  el.style.top = `${topPos}px`
}

function formatTooltipRow(ds, y) {
  const sk = ds.$streamKey
  const def = sk ? defByKey(sk) : null
  const digits = def?.digits ?? 1
  const value = (y != null && !Number.isNaN(y)) ? y.toFixed(digits) : '–'
  const unit = def?.unit || ''
  const name = sk ? t('strava.stream.' + sk) : (ds.label || '').replace(/ \(.+\)$/, '')
  return { color: ds.borderColor, name, value, unit }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function isDatasetHidden(groupId, idx) {
  return hiddenDatasets.value.get(groupId)?.has(idx) || false
}

function toggleDataset(groupId, idx) {
  const chart = chartInstances.get(groupId)
  if (!chart) return
  const prev = hiddenDatasets.value.get(groupId) || new Set()
  const next = new Set(prev)
  if (next.has(idx)) {
    next.delete(idx)
    chart.show(idx)
  } else {
    next.add(idx)
    chart.hide(idx)
  }
  const newMap = new Map(hiddenDatasets.value)
  newMap.set(groupId, next)
  hiddenDatasets.value = newMap
}

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

function toggleMap3D() {
  if (!mapInstance) return
  is3D.value = !is3D.value
  if (is3D.value) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    mapInstance.easeTo({ pitch: 60, bearing: -20, duration: 700 })
  } else {
    mapInstance.setTerrain(null)
    mapInstance.easeTo({ pitch: 0, bearing: 0, duration: 700 })
  }
}

function mergeGroups(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const merged = {
    id: target.id,
    streams: [...target.streams, ...source.streams.filter((s) => !target.streams.includes(s))],
    collapsed: !!target.collapsed,
  }
  chartLayout.value = chartLayout.value
    .filter((g) => g.id !== sourceId)
    .map((g) => (g.id === targetId ? merged : g))
  layoutDirty.value = true
}

// Copy: add source's streams to target without removing source and without dedup.
// Lets users overlay the same curve multiple times.
function copyToGroup(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const updated = {
    id: target.id,
    streams: [...target.streams, ...source.streams],
    collapsed: !!target.collapsed,
  }
  chartLayout.value = chartLayout.value.map((g) => (g.id === targetId ? updated : g))
  layoutDirty.value = true
}

function toggleCollapsed(group) {
  const next = chartLayout.value.map((g) =>
    g.id === group.id ? { ...g, collapsed: !g.collapsed } : g,
  )
  chartLayout.value = next
  layoutDirty.value = true
}

function splitGroup(group) {
  if (!group || group.streams.length <= 1) return
  const idx = chartLayout.value.findIndex((g) => g.id === group.id)
  if (idx < 0) return
  const otherGroups = chartLayout.value.filter((g) => g.id !== group.id)
  const used = new Set(otherGroups.map((g) => g.id))
  const replacements = []
  for (const s of group.streams) {
    // Skip if a solo group with this exact stream already exists somewhere.
    if (otherGroups.some((g) => g.streams.length === 1 && g.streams[0] === s)) continue
    // Skip if we already added a solo group for this stream during this split
    // (group may contain duplicates from prior copy operations).
    if (replacements.some((r) => r.streams[0] === s)) continue
    let candidate = s
    let suffix = 1
    while (used.has(candidate)) {
      suffix++
      candidate = `${s}-${suffix}`
    }
    used.add(candidate)
    replacements.push({ id: candidate, streams: [s], collapsed: false })
  }
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

function resetLayout() {
  chartLayout.value = defaultLayout()
  selectedLayoutId.value = null
  layoutDirty.value = true
  syncLayoutWithStreams()
  setLastUsed(null)
}

async function fetchSavedLayouts() {
  try {
    const res = await fetch('/preferences/chart_layouts', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    if (Array.isArray(payload.chart_layouts)) {
      savedLayouts.value = payload.chart_layouts
    }
    lastUsedId.value = payload.last_used_id ?? null
  } catch {
    // ignore
  }
}

// Apply a preset locally without persisting it as the new "last used" — used
// on mount when we restore the previously selected preset from the server.
function applyPresetById(id) {
  if (id == null) return false
  const preset = savedLayouts.value.find((p) => p.id === id)
  if (!preset) return false
  selectedLayoutId.value = id
  chartLayout.value = (preset.layout || []).map((g) => ({
    id: String(g.id),
    streams: Array.isArray(g.streams) ? g.streams.map(String) : [],
    collapsed: !!g.collapsed,
  }))
  layoutDirty.value = false
  return true
}

function loadPreset(rawId) {
  const id = typeof rawId === 'number' ? rawId : parseInt(rawId, 10)
  if (Number.isNaN(id)) {
    selectedLayoutId.value = null
    setLastUsed(null)
    return
  }
  if (!applyPresetById(id)) return
  syncLayoutWithStreams()
  setLastUsed(id)
}

async function setLastUsed(id) {
  try {
    await fetch('/preferences/chart_layouts/last_used', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id == null ? null : id }),
    })
    lastUsedId.value = id
  } catch {
    // fire-and-forget
  }
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function savePresetAs() {
  const current = selectedLayoutId.value
    ? savedLayouts.value.find((p) => p.id === selectedLayoutId.value)
    : null
  const proposed = current?.name || ''
  const name = window.prompt(t('strava.layout.save_as_prompt'), proposed)
  if (name == null) return
  const trimmed = name.trim()
  if (!trimmed) return
  layoutSaving.value = true
  try {
    const res = await fetch('/preferences/chart_layouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name: trimmed, layout: chartLayout.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const saved = payload.chart_layout
    if (saved) {
      const existing = savedLayouts.value.findIndex((p) => p.id === saved.id)
      if (existing >= 0) savedLayouts.value.splice(existing, 1, saved)
      else savedLayouts.value.push(saved)
      savedLayouts.value = [...savedLayouts.value].sort((a, b) => a.name.localeCompare(b.name))
      selectedLayoutId.value = saved.id
      layoutDirty.value = false
      setLastUsed(saved.id)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    layoutSaving.value = false
  }
}

async function deletePreset() {
  const id = selectedLayoutId.value
  if (!id) return
  const preset = savedLayouts.value.find((p) => p.id === id)
  if (!preset) return
  const confirmed = window.confirm(`${t('strava.layout.delete_confirm')} « ${preset.name} » ?`)
  if (!confirmed) return
  try {
    const res = await fetch(`/preferences/chart_layouts/${id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    savedLayouts.value = savedLayouts.value.filter((p) => p.id !== id)
    selectedLayoutId.value = null
    if (lastUsedId.value === id) lastUsedId.value = null
  } catch (e) {
    error.value = e.message
  }
}

function onPresetChange(ev) {
  const v = ev.target.value
  if (v === '') {
    selectedLayoutId.value = null
  } else {
    loadPreset(v)
  }
}

// Pointer-events based drag instead of HTML5 native drag — gives us full control
// and avoids browser quirks around draggable attributes, drop event registration,
// and document-level listener wiring.
const DRAG_THRESHOLD_PX = 6
let pdStartX = 0
let pdStartY = 0
let pdInitialized = false
let pdMoveListener = null
let pdUpListener = null

function onChartPointerDown(group, e) {
  if (e.button !== undefined && e.button !== 0) return // left mouse only
  // Don't initiate drag from controls inside the header (e.g., the Split button).
  if (e.target.closest && e.target.closest('button')) return
  pdStartX = e.clientX
  pdStartY = e.clientY
  pdInitialized = false
  dragSourceId.value = group.id
  pdMoveListener = (ev) => onPointerMove(ev)
  pdUpListener = (ev) => onPointerUp(ev)
  window.addEventListener('mousemove', pdMoveListener)
  window.addEventListener('mouseup', pdUpListener)
}

function onPointerMove(e) {
  if (!pdInitialized) {
    const dx = e.clientX - pdStartX
    const dy = e.clientY - pdStartY
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    pdInitialized = true
  }
  pointerHitTest(e.clientX, e.clientY)
  document.body.style.cursor = dragOverGroupId.value
    ? (isCopyMode.value ? 'copy' : 'alias')
    : 'grabbing'
}

function pointerHitTest(clientX, clientY) {
  const elem = document.elementFromPoint(clientX, clientY)
  if (!elem) {
    dragOverGroupId.value = null
    dragOverSlotIndex.value = null
    isCopyMode.value = false
    return
  }
  let node = elem
  while (node && node !== document.body) {
    if (node.classList?.contains('chart-drop-slot')) {
      const idx = parseInt(node.dataset?.slotIdx ?? '', 10)
      if (!Number.isNaN(idx)) {
        dragOverSlotIndex.value = idx
        dragOverGroupId.value = null
        isCopyMode.value = false
      }
      return
    }
    if (node.classList?.contains('chart-group')) {
      const id = node.dataset?.groupId
      if (id && id !== dragSourceId.value) {
        // Left half → merge ; right half → copy.
        const rect = node.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        isCopyMode.value = clientX > midX
        dragOverGroupId.value = id
        dragOverSlotIndex.value = null
      } else {
        dragOverGroupId.value = null
        dragOverSlotIndex.value = null
        isCopyMode.value = false
      }
      return
    }
    node = node.parentElement
  }
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
  isCopyMode.value = false
}

function onPointerUp() {
  if (pdMoveListener) {
    window.removeEventListener('mousemove', pdMoveListener)
    pdMoveListener = null
  }
  if (pdUpListener) {
    window.removeEventListener('mouseup', pdUpListener)
    pdUpListener = null
  }
  document.body.style.cursor = ''

  if (pdInitialized && dragSourceId.value) {
    if (dragOverGroupId.value && dragOverGroupId.value !== dragSourceId.value) {
      // isCopyMode was set by pointerHitTest based on cursor position over the target.
      if (isCopyMode.value) {
        copyToGroup(dragSourceId.value, dragOverGroupId.value)
      } else {
        mergeGroups(dragSourceId.value, dragOverGroupId.value)
      }
    } else if (dragOverSlotIndex.value != null) {
      moveGroupToIndex(dragSourceId.value, dragOverSlotIndex.value)
    }
  }

  dragSourceId.value = null
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
  isCopyMode.value = false
  pdInitialized = false
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

function zoomToSelection() {
  if (!selection.value) return
  const xs = streams.value?.[xAxis.value]?.data || streams.value?.time?.data
  if (!xs || xs.length === 0) return
  const a = xs[selection.value.startIdx]
  const b = xs[selection.value.endIdx]
  if (a == null || b == null) return
  const x0 = chartXFromRaw(a)
  const x1 = chartXFromRaw(b)
  if (Number.isNaN(x0) || Number.isNaN(x1) || x0 === x1) return
  setZoom(Math.min(x0, x1), Math.max(x0, x1))
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
  const savedLayoutsPromise = fetchSavedLayouts()
  await fetchActivity()
  if (!activity.value) return
  await fetchStreams()
  await savedLayoutsPromise
  // Auto-apply the user's last-used preset if any. applyPresetById is a no-op
  // if the id no longer exists (e.g., was deleted from another tab).
  if (lastUsedId.value != null) applyPresetById(lastUsedId.value)
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
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
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
          <div class="flex-grow-1 min-width-0">
            <h2 class="h5 mb-0 text-truncate">{{ activity.name }}</h2>
            <div v-if="startEndDisplay" class="activity-times d-flex flex-wrap align-items-center gap-2 mt-1">
              <span class="d-inline-flex align-items-center gap-1">
                <i class="fa-solid fa-flag text-success" aria-hidden="true"></i>
                <span>{{ startEndDisplay.start }}</span>
              </span>
              <i v-if="startEndDisplay.end" class="fa-solid fa-arrow-right text-muted" aria-hidden="true"></i>
              <span v-if="startEndDisplay.end" class="d-inline-flex align-items-center gap-1">
                <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>
                <span>{{ startEndDisplay.end }}</span>
              </span>
              <span
                v-if="startEndDisplay.duration"
                class="activity-duration-pill d-inline-flex align-items-center gap-1"
              >
                <i class="fa-solid fa-stopwatch" aria-hidden="true"></i>
                <span>{{ startEndDisplay.duration }}</span>
              </span>
              <span
                v-if="activity.calories"
                class="activity-cal-pill d-inline-flex align-items-center gap-1"
              >
                <i class="fa-solid fa-fire" aria-hidden="true"></i>
                <span>{{ Math.round(activity.calories) }} kcal</span>
              </span>
            </div>
          </div>
        </div>
        <div class="card-body p-0">
          <div v-if="hasRoute" class="map-wrap" :class="{ expanded: mapExpanded }">
            <div ref="mapEl" class="activity-map"></div>
            <div class="map-controls">
              <!-- Groupe 1 : style de fond (radio) -->
              <div class="btn-group btn-group-sm shadow-sm" role="group" :aria-label="t('strava.map_style_label')">
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapStyleId === 'cyclosm' ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="setMapStyle('cyclosm')"
                  :title="t('strava.map_style_cyclo')"
                >
                  <i class="fa-solid fa-bicycle" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_cyclo') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapStyleId === 'liberty' ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="setMapStyle('liberty')"
                  :title="t('strava.map_style_standard')"
                >
                  <i class="fa-solid fa-map" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_standard') }}</span>
                </button>
              </div>

              <!-- Groupe 2 : overlays et vue (toggles indépendants) -->
              <div class="btn-group btn-group-sm shadow-sm" role="group">
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="showClimbs ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleClimbs"
                  :title="showClimbs ? t('strava.hide_climbs') : t('strava.show_climbs')"
                  :aria-pressed="showClimbs"
                >
                  <i class="fa-solid fa-mountain" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.climbs_label') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="is3D ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleMap3D"
                  :title="is3D ? t('strava.map_2d') : t('strava.map_3d')"
                  :aria-pressed="is3D"
                >
                  <i class="fa-solid fa-cube" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">3D</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapExpanded ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleMapSize"
                  :title="mapExpanded ? t('strava.shrink_map') : t('strava.expand_map')"
                  :aria-pressed="mapExpanded"
                >
                  <i :class="mapExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ mapExpanded ? t('strava.shrink_map') : t('strava.expand_map') }}</span>
                </button>
              </div>
            </div>
          </div>
          <div v-else class="alert alert-info m-3 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-map-location-dot" aria-hidden="true"></i>
            <span>{{ t('strava.no_route_data') }}</span>
          </div>
        </div>
      </div>

      <div class="card shadow-sm border-0 mt-3">
        <div class="card-header activity-card-header charts-sticky-header">
          <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-chart-line text-warning" aria-hidden="true"></i>
              <span>{{ t('strava.charts') }}</span>
            </h3>
            <div class="d-flex flex-wrap gap-3 align-items-center">

              <!-- GROUPE 1 : Préférence (preset nommé) -->
              <div class="control-group" :title="t('strava.layout.title')">
                <span class="control-group-label">{{ t('strava.layout.preset_label') }}</span>
                <select
                  class="form-select form-select-sm preset-select"
                  :value="selectedLayoutId ?? ''"
                  @change="onPresetChange"
                  :title="t('strava.layout.select_preset')"
                >
                  <option value="">— {{ t('strava.layout.no_preset') }} —</option>
                  <option v-for="p in savedLayouts" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
                <div class="btn-group btn-group-sm">
                  <button
                    type="button"
                    class="btn btn-outline-primary"
                    @click="savePresetAs"
                    :disabled="layoutSaving"
                    :title="t('strava.layout.save_as')"
                  >
                    <span v-if="layoutSaving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                    <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    class="btn btn-outline-danger"
                    @click="deletePreset"
                    :disabled="!selectedLayoutId || layoutSaving"
                    :title="t('strava.layout.delete')"
                  >
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    class="btn btn-outline-secondary"
                    @click="resetLayout"
                    :title="t('strava.layout.reset')"
                  >
                    <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
                  </button>
                </div>
              </div>

              <!-- GROUPE 2 : Axe X (toujours visible) -->
              <div class="control-group" v-if="availableLayout.length > 0">
                <span class="control-group-label">{{ t('strava.x_axis_label') }}</span>
                <div class="btn-group btn-group-sm" role="group">
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

              <!-- GROUPE 3 : Actions ponctuelles (visibles si applicables) -->
              <div class="control-group" v-if="selection || zoomRange">
                <button
                  v-if="selection"
                  type="button"
                  class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                  @click="zoomToSelection"
                  :title="t('strava.zoom_to_selection')"
                >
                  <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
                  <span>{{ t('strava.zoom_to_selection') }}</span>
                </button>
                <button
                  v-if="selection"
                  type="button"
                  class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                  @click="clearSelection"
                  :title="t('strava.clear_selection')"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                  <span>{{ t('strava.clear_selection') }}</span>
                </button>
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
              </div>

            </div>
          </div>
          <div v-if="availableLayout.length > 0" class="range-chips d-flex flex-wrap gap-2 align-items-center mt-2">
            <span v-if="rangePointCount() != null" class="range-chip">
              <i class="fa-solid fa-hashtag" aria-hidden="true"></i>
              <strong>{{ rangePointCount() }}</strong>
            </span>
            <span v-if="rangeDuration() != null" class="range-chip">
              <i class="fa-regular fa-clock" aria-hidden="true"></i>
              <strong>{{ formatHMS(rangeDuration()) }}</strong>
            </span>
            <span v-if="rangeDistance() != null" class="range-chip">
              <i class="fa-solid fa-route" aria-hidden="true"></i>
              <strong>{{ formatKm(rangeDistance()) }}</strong>
            </span>
            <span v-if="rangeElevation()" class="range-chip range-chip-success">
              <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
              <strong>{{ Math.round(rangeElevation().up) }} m</strong>
            </span>
            <span v-if="rangeElevation()" class="range-chip range-chip-danger">
              <i class="fa-solid fa-arrow-trend-down" aria-hidden="true"></i>
              <strong>{{ Math.round(rangeElevation().down) }} m</strong>
            </span>
            <span v-if="rangeGrade() != null && !visibleStreams.includes('grade_smooth')" class="range-chip">
              <i class="fa-solid fa-percent" aria-hidden="true"></i>
              <strong>{{ rangeGrade().toFixed(1) }} %</strong>
            </span>
            <template v-for="streamKey in visibleStreams" :key="`mean-${streamKey}`">
              <span
                v-if="streamKey !== 'altitude'"
                class="range-chip range-chip-stream"
                :style="{ background: defByKey(streamKey)?.color + '1f', color: defByKey(streamKey)?.color }"
              >
                <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
                <strong v-if="chartStats(defByKey(streamKey))">{{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</strong>
                <strong v-else>–</strong>
              </span>
            </template>
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
                :data-slot-idx="gIdx"
              ></div>
              <div
                class="chart-group"
                :class="{
                  'merge-target': dragOverGroupId === group.id && dragSourceId !== group.id,
                  dragging: dragSourceId === group.id,
                }"
                :data-group-id="group.id"
              >
                <div
                  v-if="dragOverGroupId === group.id && dragSourceId !== group.id"
                  class="chart-group-zones"
                >
                  <div class="chart-zone chart-zone-merge" :class="{ active: !isCopyMode }">
                    <span>{{ t('strava.layout.merge_here') }}</span>
                  </div>
                  <div class="chart-zone chart-zone-copy" :class="{ active: isCopyMode }">
                    <span>{{ t('strava.layout.copy_here') }}</span>
                  </div>
                </div>
                <div
                  class="chart-group-header"
                  @mousedown="onChartPointerDown(group, $event)"
                  :title="t('strava.layout.drag_hint')"
                >
                  <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                    <div class="d-flex align-items-center gap-2 flex-wrap">
                      <span class="drag-handle">
                        <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                      </span>
                      <template v-if="!group.collapsed">
                        <button
                          v-for="(streamKey, sIdx) in group.streams"
                          :key="`legend-${group.id}-${sIdx}`"
                          type="button"
                          class="legend-pill"
                          :class="{ hidden: isDatasetHidden(group.id, sIdx) }"
                          @click="toggleDataset(group.id, sIdx)"
                          @mousedown.stop
                          :title="isDatasetHidden(group.id, sIdx) ? t('strava.layout.show_curve') : t('strava.layout.hide_curve')"
                        >
                          <span class="legend-swatch" :style="{ background: defByKey(streamKey)?.color }"></span>
                          <span>{{ t('strava.stream.' + streamKey) }}</span>
                        </button>
                      </template>
                      <template v-else>
                        <span
                          v-for="streamKey in group.streams"
                          :key="streamKey"
                          class="legend-pill legend-pill-static"
                        >
                          <span class="legend-swatch" :style="{ background: defByKey(streamKey)?.color }"></span>
                          <span>{{ t('strava.stream.' + streamKey) }}</span>
                        </span>
                      </template>
                    </div>
                    <div class="d-flex gap-1">
                      <button
                        v-if="group.streams.length > 1 && !group.collapsed"
                        type="button"
                        class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                        @click="splitGroup(group)"
                        @mousedown.stop
                        :title="t('strava.layout.split')"
                      >
                        <i class="fa-solid fa-object-ungroup" aria-hidden="true"></i>
                        <span>{{ t('strava.layout.split') }}</span>
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                        @click="toggleCollapsed(group)"
                        @mousedown.stop
                        :title="group.collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
                      >
                        <i :class="group.collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-if="!group.collapsed" class="row g-2 align-items-stretch">
                  <div class="col-lg-10">
                    <div class="chart-canvas-wrap">
                      <canvas :id="`chart-${group.id}`"></canvas>
                    </div>
                  </div>
                  <div class="col-lg-2">
                    <div
                      v-for="streamKey in group.streams"
                      :key="streamKey"
                      class="stream-stats-row"
                    >
                      <span
                        v-if="group.streams.length > 1"
                        class="stream-stats-id"
                        :style="{ color: defByKey(streamKey)?.color }"
                        :title="t('strava.stream.' + streamKey)"
                      >
                        <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
                      </span>
                      <template v-if="chartStats(defByKey(streamKey))">
                        <span :title="t('strava.range_stats.min')">
                          <i class="fa-solid fa-arrow-down-short-wide" aria-hidden="true"></i>
                          {{ fmt(chartStats(defByKey(streamKey)).min, defByKey(streamKey).digits) }}
                        </span>
                        <span :title="t('strava.range_stats.mean')">
                          <i class="fa-solid fa-equals" aria-hidden="true"></i>
                          {{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }}
                        </span>
                        <span :title="t('strava.range_stats.max')">
                          <i class="fa-solid fa-arrow-up-wide-short" aria-hidden="true"></i>
                          {{ fmt(chartStats(defByKey(streamKey)).max, defByKey(streamKey).digits) }}
                        </span>
                      </template>
                    </div>
                  </div>
                </div>
              </div>
            </template>
            <div
              class="chart-drop-slot"
              :class="{ active: dragOverSlotIndex === availableLayout.length, hinting: dragSourceId }"
              :data-slot-idx="availableLayout.length"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
}
.map-wrap.expanded {
  position: fixed;
  /* Sits below the fixed-top navbar (z-index 1030 in Bootstrap) and above
     anything else. left=0/right=0 makes it span the full viewport width. */
  top: 4rem;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1020;
  background: #fff;
  box-shadow: 0 -2px 20px rgba(0, 0, 0, 0.2);
}
.min-width-0 {
  min-width: 0;
}
.activity-times {
  font-size: 0.82rem;
  color: #495057;
  font-variant-numeric: tabular-nums;
}
.activity-duration-pill {
  background: rgba(252, 76, 2, 0.12);
  color: #fc4c02;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
.activity-cal-pill {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
.activity-map {
  height: 520px;
  width: 100%;
}
.map-wrap.expanded .activity-map {
  height: 100%;
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
  pointer-events: none; /* let the map handle drags outside the buttons */
}
.map-controls > * { pointer-events: auto; }
.map-ctrl-btn {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  font-weight: 500;
}
.map-ctrl-btn.active {
  border-color: rgba(252, 76, 2, 0.6);
}

.custom-legend {
  margin: 0.35rem 0 0.4rem;
  font-size: 0.72rem;
}
.legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: #495057;
  font-size: 0.72rem;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, color 0.12s;
  user-select: none;
  line-height: 1.5;
}
.legend-pill:hover {
  background: rgba(0, 0, 0, 0.07);
}
.legend-pill.hidden {
  opacity: 0.45;
  text-decoration: line-through;
}
.legend-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.1);
}
.legend-pill.hidden .legend-swatch {
  background: #adb5bd !important;
}
.legend-pill-static {
  cursor: default;
  background: rgba(0, 0, 0, 0.02);
  border-style: dashed;
}
.legend-pill-static:hover {
  background: rgba(0, 0, 0, 0.02);
}
.chart-canvas-wrap {
  position: relative;
  height: 240px;
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
  outline: 3px solid rgba(13, 110, 253, 0.45);
  outline-offset: -3px;
  box-shadow: 0 0 0 4px rgba(13, 110, 253, 0.08);
}
.chart-group-zones {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: none;
  z-index: 4;
  border-radius: 0.5rem;
  overflow: hidden;
}
.chart-zone {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: 0.02em;
  transition: background 0.12s, color 0.12s;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
}
.chart-zone-merge {
  background: linear-gradient(to right, rgba(13, 110, 253, 0.22), rgba(13, 110, 253, 0.06));
  color: #0a58ca;
  border-right: 2px dashed rgba(0, 0, 0, 0.15);
}
.chart-zone-copy {
  background: linear-gradient(to left, rgba(25, 135, 84, 0.22), rgba(25, 135, 84, 0.06));
  color: #146c43;
}
.chart-zone.active {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
.chart-zone-merge.active {
  background: linear-gradient(to right, rgba(13, 110, 253, 0.65), rgba(13, 110, 253, 0.35));
}
.chart-zone-copy.active {
  background: linear-gradient(to left, rgba(25, 135, 84, 0.65), rgba(25, 135, 84, 0.35));
}
.chart-zone span {
  background: rgba(255, 255, 255, 0.85);
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  box-shadow: 0 4px 12px -4px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
}
.chart-zone.active span {
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
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
.stream-stats-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding: 0.2rem 0;
  color: #495057;
}
.stream-stats-row + .stream-stats-row {
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
}
.stream-stats-row > span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.stream-stats-row > span i {
  color: #adb5bd;
  font-size: 0.75rem;
}
.stream-stats-id i {
  color: inherit !important;
  font-size: 0.95rem !important;
}

.preset-select {
  width: auto;
  max-width: 220px;
  min-width: 140px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.55rem 0.25rem 0.6rem;
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 0.5rem;
  position: relative;
}
.control-group-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6c757d;
  user-select: none;
  padding-right: 0.15rem;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  margin-right: 0.25rem;
  line-height: 1.6;
}

.range-chip-stream {
  font-weight: 500;
}
.range-chip-stream strong {
  color: inherit;
}
</style>

<!-- Non-scoped: the tooltip DOM is created via document.createElement and
     therefore doesn't carry Vue's scoped data attribute, so its styles must
     be global. -->
<style>
.chart-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(33, 37, 41, 0.94);
  color: #fff;
  padding: 0.5rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  z-index: 30;
  white-space: nowrap;
  transition: opacity 0.1s ease;
  opacity: 0;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.45);
  max-width: 360px;
  left: 0;
  top: 0;
}
.chart-tooltip-title {
  margin-bottom: 0.35rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18);
}
.chart-tooltip-title-main {
  font-weight: 600;
  font-size: 0.85rem;
}
.chart-tooltip-title-sub {
  font-weight: 400;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 0.1rem;
}
.chart-tooltip-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  line-height: 1.65;
}
.chart-tooltip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
.chart-tooltip-name {
  color: rgba(255, 255, 255, 0.78);
  margin-right: 0.4rem;
}
.chart-tooltip-value {
  margin-left: auto;
  font-weight: 600;
  padding-left: 0.55rem;
}

.climb-marker {
  display: inline-flex;
  align-items: center;
  gap: 0.22rem;
  background: rgba(255, 255, 255, 0.96);
  padding: 0.1rem 0.35rem 0.1rem 0.32rem;
  border-radius: 12px;
  font-size: 0.66rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  border: 1.5px solid currentColor;
  box-shadow: 0 3px 8px -3px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transform: translateY(-4px);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
  user-select: none;
  line-height: 1.4;
}
.climb-marker:hover {
  transform: translateY(-6px) scale(1.06);
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.45);
}
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
.climb-marker .climb-marker-cat::first-letter { text-transform: uppercase; }
/* Force the badge's inner text to be white via a child trick — the `currentColor`
   trick above colours background; the children inherit current text colour. */
.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }
</style>
