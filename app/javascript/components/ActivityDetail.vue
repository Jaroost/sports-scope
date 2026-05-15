<script setup>
import { ref, onMounted, onBeforeUnmount, computed, useTemplateRef, watch } from 'vue'
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
const selection = ref(null) // { startIdx, endIdx } | null
const mapEl = useTemplateRef('mapEl')

let mapInstance = null
let markerA = null
let markerB = null
let isDragging = false
let dragRafPending = false
const chartInstances = new Map()

const stats = computed(() => {
  if (!activity.value) return []
  const a = activity.value
  return [
    { label: t('strava.distance'),       value: `${(a.distance / 1000).toFixed(2)} km`,             icon: 'fa-route' },
    { label: t('strava.duration'),       value: formatDuration(a.moving_time),                       icon: 'fa-stopwatch' },
    { label: t('strava.elapsed'),        value: formatDuration(a.elapsed_time),                      icon: 'fa-hourglass-half' },
    { label: t('strava.elevation_gain'), value: `${Math.round(a.total_elevation_gain || 0)} m`,      icon: 'fa-mountain' },
    { label: t('strava.avg_speed'),      value: `${((a.average_speed || 0) * 3.6).toFixed(1)} km/h`, icon: 'fa-gauge-high' },
    { label: t('strava.type'),           value: a.type,                                              icon: activityIcon(a.type) },
    { label: t('strava.start_date'),     value: new Date(a.start_date_local).toLocaleString(),       icon: 'fa-calendar-day' },
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
  const s = selection.value?.startIdx ?? 0
  const e = selection.value?.endIdx ?? data.length - 1
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
  const ref = streams.value?.distance?.data || streams.value?.time?.data || streams.value?.latlng?.data
  if (!ref || ref.length === 0) return null
  const maxIdx = ref.length - 1
  const s = Math.max(0, Math.min(selection.value?.startIdx ?? 0, maxIdx))
  const e = Math.max(s, Math.min(selection.value?.endIdx ?? maxIdx, maxIdx))
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

// Chart.js plugin: drag-to-select on the canvas + paint the shared selection.
const dragSelectPlugin = {
  id: 'dragSelect',
  beforeEvent(chart, args) {
    const e = args.event
    const native = e.native
    if (!native) return
    const st = chart.$drag || (chart.$drag = { dragging: false, x0: null, x1: null })

    if (native.type === 'mousedown' && native.button === 0) {
      const area = chart.chartArea
      if (e.x < area.left || e.x > area.right) return
      st.dragging = true
      st.x0 = e.x
      st.x1 = e.x
      chart.draw()
    } else if (native.type === 'mousemove' && st.dragging) {
      st.x1 = e.x
      chart.draw()
    } else if ((native.type === 'mouseup' || native.type === 'mouseout') && st.dragging) {
      st.dragging = false
      const area = chart.chartArea
      const x0 = Math.max(area.left, Math.min(area.right, st.x0))
      const x1 = Math.max(area.left, Math.min(area.right, st.x1))
      if (Math.abs(x1 - x0) >= 4) {
        const v0 = chart.scales.x.getValueForPixel(x0)
        const v1 = chart.scales.x.getValueForPixel(x1)
        chart.$onSelect?.(v0, v1)
      }
      st.x0 = null
      st.x1 = null
      chart.draw()
    }
  },
  afterDraw(chart) {
    const { ctx, chartArea } = chart
    const st = chart.$drag
    const selRange = chart.$selectionRange
    // Persistent selection highlight
    if (selRange && selRange.start != null && selRange.end != null) {
      const x1 = chart.scales.x.getPixelForValue(selRange.start)
      const x2 = chart.scales.x.getPixelForValue(selRange.end)
      ctx.save()
      ctx.fillStyle = 'rgba(13, 110, 253, 0.15)'
      ctx.fillRect(Math.min(x1, x2), chartArea.top, Math.abs(x2 - x1), chartArea.bottom - chartArea.top)
      ctx.strokeStyle = 'rgba(13, 110, 253, 0.6)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x1, chartArea.top); ctx.lineTo(x1, chartArea.bottom)
      ctx.moveTo(x2, chartArea.top); ctx.lineTo(x2, chartArea.bottom)
      ctx.stroke()
      ctx.restore()
    }
    // Live drag preview
    if (st && st.dragging && st.x0 != null && st.x1 != null) {
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
  const charts = availableCharts.value
  if (charts.length === 0) return

  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables, dragSelectPlugin)

  destroyCharts()

  const xStream = streams.value[xAxis.value]?.data || streams.value.time?.data || []
  const maxPoints = 600
  const xRaw = xStream

  charts.forEach((def) => {
    const canvas = document.getElementById(`chart-${def.key}`)
    if (!canvas) return
    const yRaw = streams.value[def.key].data
    const len = Math.min(xRaw.length, yRaw.length)
    const pairs = []
    for (let i = 0; i < len; i++) {
      pairs.push({ x: chartXFromRaw(xRaw[i]), y: def.transform(yRaw[i]) })
    }
    const data = downsample(pairs, maxPoints)

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        datasets: [{
          label: `${t('strava.stream.' + def.key)} (${def.unit})`,
          data,
          borderColor: def.color,
          backgroundColor: def.color + '22',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.2,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { intersect: false, mode: 'nearest' },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: xAxisLabel() },
            ticks: { maxTicksLimit: 8 },
          },
          y: {
            title: { display: true, text: def.unit },
            ticks: { maxTicksLimit: 6 },
          },
        },
      },
    })

    chart.$onSelect = (v0, v1) => {
      const r0 = chartXToRaw(Math.min(v0, v1))
      const r1 = chartXToRaw(Math.max(v0, v1))
      const sIdx = xValueToIndex(r0)
      const eIdx = xValueToIndex(r1)
      setSelection(sIdx, eIdx)
    }
    chartInstances.set(def.key, chart)
  })

  applySelectionToCharts()
}

function applySelectionToCharts() {
  chartInstances.forEach((chart, key) => {
    if (!selection.value) {
      chart.$selectionRange = null
    } else {
      const xs = streams.value?.[xAxis.value]?.data
      if (xs) {
        const x0 = chartXFromRaw(xs[selection.value.startIdx])
        const x1 = chartXFromRaw(xs[selection.value.endIdx])
        chart.$selectionRange = { start: x0, end: x1 }
      }
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
  chartInstances.forEach((c) => c.destroy())
  chartInstances.clear()
}

watch([xAxis, timeUnit], () => {
  if (streams.value) renderCharts()
})

watch(selection, () => {
  applySelectionToCharts()
  refreshSelectedRoute()
  syncMarkersFromSelection()
})

onMounted(async () => {
  await fetchActivity()
  if (!activity.value) return
  await fetchStreams()
  if (hasRoute.value) {
    await renderMap()
  }
  if (streams.value && availableCharts.value.length > 0) {
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
        <div class="card-header activity-card-header d-flex flex-wrap gap-2 justify-content-between align-items-center">
          <h3 class="h6 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-chart-line text-warning" aria-hidden="true"></i>
            <span>{{ t('strava.charts') }}</span>
          </h3>
          <div class="d-flex flex-wrap gap-2 align-items-center">
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
        <div class="card-body">
          <div v-if="streamsLoading" class="text-muted d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
            <span>{{ t('strava.loading_streams') }}</span>
          </div>
          <div v-else-if="streamsError" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <span>{{ streamsError }}</span>
          </div>
          <div v-else-if="availableCharts.length === 0" class="text-muted d-flex align-items-center gap-2">
            <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
            <span>{{ t('strava.no_stream_data') }}</span>
          </div>
          <div v-else>
            <div
              v-for="def in availableCharts"
              :key="def.key"
              class="chart-row mb-3"
            >
              <div class="d-flex justify-content-between align-items-baseline mb-1">
                <div class="text-muted small d-flex align-items-center gap-1">
                  <i :class="`fa-solid ${chartIcons[def.key] || 'fa-chart-line'}`" :style="{ color: def.color }" aria-hidden="true"></i>
                  <span>{{ t('strava.stream.' + def.key) }} ({{ def.unit }})</span>
                </div>
                <div class="text-muted small d-flex align-items-center gap-1">
                  <i :class="`fa-solid ${selection ? 'fa-crop-simple' : 'fa-bars-staggered'}`" aria-hidden="true"></i>
                  <span>{{ selection ? t('strava.selection') : t('strava.whole_activity') }}</span>
                </div>
              </div>
              <div class="row g-2 align-items-stretch">
                <div class="col-lg-9">
                  <div class="chart-canvas-wrap">
                    <canvas :id="`chart-${def.key}`"></canvas>
                  </div>
                </div>
                <div class="col-lg-3">
                  <dl class="small mb-0 stats-grid" v-if="chartStats(def)">
                    <dt class="text-muted">
                      <i class="fa-solid fa-equals stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.mean') }}
                    </dt>
                    <dd>{{ fmt(chartStats(def).mean, def.digits) }} {{ def.unit }}</dd>
                    <dt class="text-muted">
                      <i class="fa-solid fa-arrow-down-short-wide stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.min') }}
                    </dt>
                    <dd>{{ fmt(chartStats(def).min, def.digits) }} {{ def.unit }}</dd>
                    <dt class="text-muted">
                      <i class="fa-solid fa-arrow-up-wide-short stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.max') }}
                    </dt>
                    <dd>{{ fmt(chartStats(def).max, def.digits) }} {{ def.unit }}</dd>
                    <template v-if="def.key === 'altitude' && rangeElevation()">
                      <dt class="text-muted">
                        <i class="fa-solid fa-arrow-trend-up stats-grid-icon text-success" aria-hidden="true"></i>{{ t('strava.range_stats.elev_gain') }}
                      </dt>
                      <dd>{{ Math.round(rangeElevation().up) }} m</dd>
                      <dt class="text-muted">
                        <i class="fa-solid fa-arrow-trend-down stats-grid-icon text-danger" aria-hidden="true"></i>{{ t('strava.range_stats.elev_loss') }}
                      </dt>
                      <dd>{{ Math.round(rangeElevation().down) }} m</dd>
                    </template>
                    <dt class="text-muted">
                      <i class="fa-solid fa-hashtag stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.count') }}
                    </dt>
                    <dd>{{ chartStats(def).count }}</dd>
                    <template v-if="rangeDuration() != null">
                      <dt class="text-muted">
                        <i class="fa-regular fa-clock stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.duration') }}
                      </dt>
                      <dd>{{ formatHMS(rangeDuration()) }}</dd>
                    </template>
                    <template v-if="rangeDistance() != null">
                      <dt class="text-muted">
                        <i class="fa-solid fa-route stats-grid-icon" aria-hidden="true"></i>{{ t('strava.range_stats.distance') }}
                      </dt>
                      <dd>{{ formatKm(rangeDistance()) }}</dd>
                    </template>
                  </dl>
                </div>
              </div>
            </div>
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
</style>
