<script setup>
import { ref, onMounted, onBeforeUnmount, computed, useTemplateRef } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  activityId: { type: [String, Number], required: true },
})

const loading = ref(true)
const error = ref(null)
const activity = ref(null)
const mapEl = useTemplateRef('mapEl')

let mapInstance = null

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

onMounted(async () => {
  await fetchActivity()
  if (activity.value && hasRoute.value) {
    await renderMap()
  }
})

onBeforeUnmount(() => {
  if (mapInstance) {
    mapInstance.remove()
    mapInstance = null
  }
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

      <div class="card">
        <div class="card-body">
          <dl class="row mb-0">
            <template v-for="(s, i) in stats" :key="i">
              <dt class="col-sm-4 text-muted">{{ s.label }}</dt>
              <dd class="col-sm-8">{{ s.value }}</dd>
            </template>
          </dl>
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
</style>
