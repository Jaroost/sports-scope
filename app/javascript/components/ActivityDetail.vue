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
const mapEl = useTemplateRef('mapEl')

let mapInstance = null
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
const hasRoute = computed(() => polyline.value.length > 0)

const chartDefs = [
  { key: 'altitude', color: '#198754', unit: 'm', transform: (v) => v },
  { key: 'heartrate', color: '#dc3545', unit: 'bpm', transform: (v) => v },
  { key: 'velocity_smooth', color: '#0d6efd', unit: 'km/h', transform: (v) => v * 3.6 },
  { key: 'cadence', color: '#6f42c1', unit: 'rpm', transform: (v) => v },
  { key: 'watts', color: '#fd7e14', unit: 'W', transform: (v) => v },
  { key: 'temp', color: '#20c997', unit: '°C', transform: (v) => v },
  { key: 'grade_smooth', color: '#6c757d', unit: '%', transform: (v) => v },
]

const availableCharts = computed(() => {
  if (!streams.value) return []
  return chartDefs.filter((def) => Array.isArray(streams.value[def.key]?.data) && streams.value[def.key].data.length > 0)
})

function formatDuration(seconds) {
  if (!seconds) return '–'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}min` : (m > 0 ? `${m}min ${s}s` : `${s}s`)
}

// Google polyline algorithm (precision 5) — used by Strava's summary_polyline.
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

async function renderMap() {
  if (!hasRoute.value || !mapEl.value) return

  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  const coords = decodePolyline(polyline.value)
  if (coords.length === 0) return

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
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
      },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fc4c02', 'line-width': 4 },
    })
  })
}

// Downsample to keep charts responsive (Strava streams can be 5k+ points).
function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr
  const step = arr.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.floor(i * step)])
  }
  return out
}

async function renderCharts() {
  const charts = availableCharts.value
  if (charts.length === 0) return

  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  destroyCharts()

  const xStream = streams.value[xAxis.value]?.data || streams.value.time?.data || []
  const maxPoints = 600
  const xRaw = xStream
  const xLabel = xAxis.value === 'distance' ? t('strava.distance_km') : t('strava.time_label')

  charts.forEach((def) => {
    const canvas = document.getElementById(`chart-${def.key}`)
    if (!canvas) return
    const yRaw = streams.value[def.key].data
    const len = Math.min(xRaw.length, yRaw.length)
    const pairs = []
    for (let i = 0; i < len; i++) {
      const x = xAxis.value === 'distance' ? xRaw[i] / 1000 : xRaw[i]
      pairs.push({ x, y: def.transform(yRaw[i]) })
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
        plugins: { legend: { display: false } },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: xLabel },
            ticks: { maxTicksLimit: 8 },
          },
          y: {
            title: { display: true, text: def.unit },
            ticks: { maxTicksLimit: 6 },
          },
        },
      },
    })
    chartInstances.set(def.key, chart)
  })
}

function destroyCharts() {
  chartInstances.forEach((c) => c.destroy())
  chartInstances.clear()
}

watch(xAxis, () => {
  if (streams.value) renderCharts()
})

onMounted(async () => {
  await fetchActivity()
  if (!activity.value) return
  if (hasRoute.value) {
    await renderMap()
  }
  await fetchStreams()
  if (streams.value && availableCharts.value.length > 0) {
    // Wait for the DOM to render the canvas elements
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
        <div class="card-header d-flex justify-content-between align-items-center">
          <h3 class="h6 mb-0">{{ t('strava.charts') }}</h3>
          <div v-if="availableCharts.length > 0" class="btn-group btn-group-sm" role="group">
            <input
              type="radio"
              class="btn-check"
              name="xAxis"
              id="xAxis-distance"
              autocomplete="off"
              value="distance"
              v-model="xAxis"
              :disabled="!streams || !streams.distance"
            />
            <label class="btn btn-outline-secondary" for="xAxis-distance">{{ t('strava.x_distance') }}</label>
            <input
              type="radio"
              class="btn-check"
              name="xAxis"
              id="xAxis-time"
              autocomplete="off"
              value="time"
              v-model="xAxis"
              :disabled="!streams || !streams.time"
            />
            <label class="btn btn-outline-secondary" for="xAxis-time">{{ t('strava.x_time') }}</label>
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
              <div class="text-muted small mb-1">{{ t('strava.stream.' + def.key) }} ({{ def.unit }})</div>
              <div class="chart-canvas-wrap">
                <canvas :id="`chart-${def.key}`"></canvas>
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
</style>
