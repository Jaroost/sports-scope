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
let startMarker = null
let endMarker = null
let dragRafPending = false
const chartInstances = new Map()

const stats = computed(() => {
  if (!activity.value) return []
  const a = activity.value
  return [
    { label: t('strava.distance'), value: `${(a.distance / 1000).toFixed(2)} km` },
    { label: t('strava.duration'), value: formatDuration(a.moving_time) },
    { label: t('strava.elapsed'), value: formatDuration(a.elapsed_time) },
    { label: t('strava.elevation_gain'), value: `${Math.round(a.total_elevation_gain || 0)} m` },
    { label: t('strava.avg_speed'), value: `${((a.average_speed || 0) * 3.6).toFixed(1)} km/h` },
    { label: t('strava.type'), value: a.type },
    { label: t('strava.start_date'), value: new Date(a.start_date_local).toLocaleString() },
  ]
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
  if (s === e) {
    selection.value = null
    return
  }
  selection.value = { startIdx: s, endIdx: e }
}

function clearSelection() {
  selection.value = null
  // Snap map handles back to route endpoints
  if (startMarker && endMarker && hasLatLngStream.value) {
    const data = streams.value.latlng.data
    startMarker.setLngLat([data[0][1], data[0][0]])
    endMarker.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
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

function installMapHandles(maplibregl) {
  const data = streams.value.latlng.data
  if (data.length < 2) return
  const start = data[0]
  const end = data[data.length - 1]

  startMarker = new maplibregl.Marker({ color: '#198754', draggable: true })
    .setLngLat([start[1], start[0]])
    .addTo(mapInstance)
  endMarker = new maplibregl.Marker({ color: '#dc3545', draggable: true })
    .setLngLat([end[1], end[0]])
    .addTo(mapInstance)

  startMarker.on('drag', () => scheduleMarkerSync('start'))
  endMarker.on('drag', () => scheduleMarkerSync('end'))
  startMarker.on('dragend', () => syncFromMarkers())
  endMarker.on('dragend', () => syncFromMarkers())
}

function scheduleMarkerSync(which) {
  if (dragRafPending) return
  dragRafPending = true
  requestAnimationFrame(() => {
    dragRafPending = false
    syncFromMarkers(which)
  })
}

function syncFromMarkers() {
  if (!startMarker || !endMarker) return
  const s = startMarker.getLngLat()
  const e = endMarker.getLngLat()
  const sIdx = latLngToIndex(s.lng, s.lat)
  const eIdx = latLngToIndex(e.lng, e.lat)
  const maxIdx = streams.value.latlng.data.length - 1
  const isFullRange = Math.min(sIdx, eIdx) === 0 && Math.max(sIdx, eIdx) === maxIdx
  if (isFullRange) {
    selection.value = null
  } else {
    setSelection(sIdx, eIdx)
  }
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
  if (!startMarker || !endMarker || !hasLatLngStream.value) return
  const data = streams.value.latlng.data
  if (!selection.value) {
    startMarker.setLngLat([data[0][1], data[0][0]])
    endMarker.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
    return
  }
  const { startIdx, endIdx } = selection.value
  startMarker.setLngLat([data[startIdx][1], data[startIdx][0]])
  endMarker.setLngLat([data[endIdx][1], data[endIdx][0]])
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
    <div v-if="loading" class="text-muted">Loading…</div>
    <div v-else-if="error" class="alert alert-danger">{{ error }}</div>
    <div v-else-if="activity">
      <div class="card mb-3">
        <div class="card-header bg-warning-subtle">
          <h2 class="h5 mb-0">{{ activity.name }}</h2>
        </div>
        <div class="card-body p-0">
          <div v-if="hasRoute" ref="mapEl" class="activity-map"></div>
          <div v-else class="alert alert-info m-3 mb-0">
            {{ t('strava.no_route_data') }}
          </div>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-body">
          <dl class="row mb-0">
            <template v-for="(s, i) in stats" :key="i">
              <dt class="col-sm-4 text-muted">{{ s.label }}</dt>
              <dd class="col-sm-8">{{ s.value }}</dd>
            </template>
          </dl>
        </div>
      </div>

      <div class="card">
        <div class="card-header d-flex flex-wrap gap-2 justify-content-between align-items-center">
          <h3 class="h6 mb-0">{{ t('strava.charts') }}</h3>
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <button
              v-if="selection"
              type="button"
              class="btn btn-sm btn-outline-primary"
              @click="clearSelection"
            >
              {{ t('strava.clear_selection') }}
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
          <div v-if="streamsLoading" class="text-muted">{{ t('strava.loading_streams') }}</div>
          <div v-else-if="streamsError" class="alert alert-danger mb-0">{{ streamsError }}</div>
          <div v-else-if="availableCharts.length === 0" class="text-muted">{{ t('strava.no_stream_data') }}</div>
          <div v-else>
            <div
              v-for="def in availableCharts"
              :key="def.key"
              class="chart-row mb-3"
            >
              <div class="d-flex justify-content-between align-items-baseline mb-1">
                <div class="text-muted small">{{ t('strava.stream.' + def.key) }} ({{ def.unit }})</div>
                <div class="text-muted small">
                  {{ selection ? t('strava.selection') : t('strava.whole_activity') }}
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
                    <dt class="text-muted">{{ t('strava.range_stats.mean') }}</dt>
                    <dd>{{ fmt(chartStats(def).mean, def.digits) }} {{ def.unit }}</dd>
                    <dt class="text-muted">{{ t('strava.range_stats.min') }}</dt>
                    <dd>{{ fmt(chartStats(def).min, def.digits) }} {{ def.unit }}</dd>
                    <dt class="text-muted">{{ t('strava.range_stats.max') }}</dt>
                    <dd>{{ fmt(chartStats(def).max, def.digits) }} {{ def.unit }}</dd>
                    <dt class="text-muted">{{ t('strava.range_stats.count') }}</dt>
                    <dd>{{ chartStats(def).count }}</dd>
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
