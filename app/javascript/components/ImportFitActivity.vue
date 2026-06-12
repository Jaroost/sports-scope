<script setup>
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'
import { computeElevGain } from '../activityHelpers'

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const activities = ref([])
const loading = ref(true)
const error = ref(null)
const uploadStatus = ref('idle') // 'idle' | 'parsing' | 'uploading' | 'done'
const fileInputEl = ref(null)
const dragOver = ref(false)

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function fetchList() {
  loading.value = true
  try {
    const res = await fetch('/api/imported_activities', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    activities.value = Array.isArray(payload.activities) ? payload.activities : []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openPicker() {
  fileInputEl.value?.click()
}

function onFileChange(ev) {
  const file = ev.target.files?.[0]
  if (file) processFile(file)
  ev.target.value = '' // allow re-uploading the same filename
}

function onDrop(ev) {
  ev.preventDefault()
  dragOver.value = false
  const file = ev.dataTransfer?.files?.[0]
  if (file) processFile(file)
}

async function processFile(file) {
  error.value = null
  uploadStatus.value = 'parsing'
  try {
    const buf = await file.arrayBuffer()
    const FitParser = (await import('fit-file-parser')).default
    const parser = new FitParser({
      force: true,
      mode: 'list',
      speedUnit: 'm/s',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
    })
    const data = await new Promise((resolve, reject) => {
      parser.parse(buf, (err, parsed) => err ? reject(err) : resolve(parsed))
    })
    const payload = buildPayload(data, file.name)
    uploadStatus.value = 'uploading'
    const res = await fetch('/api/imported_activities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    })
    if (!res.ok && res.status !== 201) {
      const errBody = await res.text()
      throw new Error(`Upload failed (${res.status}): ${errBody}`)
    }
    uploadStatus.value = 'done'
    await fetchList()
    setTimeout(() => { uploadStatus.value = 'idle' }, 1500)
  } catch (e) {
    error.value = e.message
    uploadStatus.value = 'idle'
  }
}

// Transform fit-file-parser output into the Strava-shaped streams + summary
// our backend (and ActivityDetail.vue) already understand.
function buildPayload(data, filename) {
  const records = Array.isArray(data.records) ? data.records : []
  const session = Array.isArray(data.sessions) && data.sessions[0] ? data.sessions[0] : {}
  const activity = data.activity || {}

  // Build parallel arrays. Records without GPS still contribute to other
  // streams (HR/power/etc.), but a missing time field is dropped.
  const startTs = session.start_time
    ? new Date(session.start_time).getTime()
    : (records[0]?.timestamp ? new Date(records[0].timestamp).getTime() : null)

  const time = []
  const distance = []
  const latlng = []
  const altitude = []
  const velocity = []
  const heartrate = []
  const cadence = []
  const watts = []
  const temp = []

  for (const r of records) {
    let secs = null
    if (r.elapsed_time != null) secs = Math.round(Number(r.elapsed_time))
    else if (r.timestamp && startTs != null) secs = Math.round((new Date(r.timestamp).getTime() - startTs) / 1000)
    if (secs == null || !Number.isFinite(secs) || secs < 0) continue
    time.push(secs)
    distance.push(numericOrZero(r.distance))
    latlng.push((r.position_lat != null && r.position_long != null) ? [Number(r.position_lat), Number(r.position_long)] : null)
    altitude.push(numericOrNull(r.altitude ?? r.enhanced_altitude))
    velocity.push(numericOrNull(r.speed ?? r.enhanced_speed))
    heartrate.push(numericOrNull(r.heart_rate))
    cadence.push(numericOrNull(r.cadence))
    watts.push(numericOrNull(r.power))
    temp.push(numericOrNull(r.temperature))
  }

  // Drop streams that are entirely null (so the chart doesn't render them).
  const streams = {}
  streams.time = { data: time }
  if (distance.some((v) => v > 0)) streams.distance = { data: distance }
  // latlng filters out nulls but Strava preserves alignment — keep nulls as
  // placeholder pairs [0,0] would corrupt the map. Instead, drop the stream
  // entirely if too sparse.
  const llValid = latlng.filter((p) => p != null)
  if (llValid.length >= 2 && llValid.length >= latlng.length * 0.5) {
    streams.latlng = { data: latlng.map((p) => p ?? [0, 0]) }
  }
  if (altitude.some((v) => v != null)) streams.altitude = { data: altitude.map((v) => v ?? 0) }
  if (velocity.some((v) => v != null)) streams.velocity_smooth = { data: velocity.map((v) => v ?? 0) }
  if (heartrate.some((v) => v != null)) streams.heartrate = { data: heartrate.map((v) => v ?? 0) }
  if (cadence.some((v) => v != null)) streams.cadence = { data: cadence.map((v) => v ?? 0) }
  if (watts.some((v) => v != null)) streams.watts = { data: watts.map((v) => v ?? 0) }
  if (temp.some((v) => v != null)) streams.temp = { data: temp.map((v) => v ?? 0) }

  // Derive grade_smooth from altitude/distance if both present.
  if (streams.altitude && streams.distance) {
    const alt = streams.altitude.data
    const dist = streams.distance.data
    const grade = new Array(alt.length).fill(0)
    for (let i = 1; i < alt.length; i++) {
      const dd = dist[i] - dist[i - 1]
      const da = alt[i] - alt[i - 1]
      grade[i] = dd > 0 ? (da / dd) * 100 : grade[i - 1]
    }
    streams.grade_smooth = { data: grade }
  }

  const startLatLng = llValid.length ? llValid[0] : null
  const endLatLng = llValid.length ? llValid[llValid.length - 1] : null

  const name = (session.sport || activity.sport || 'Activité').toString()
  const nameClean = name.charAt(0).toUpperCase() + name.slice(1)
  const niceName = filename
    ? `${nameClean} · ${filename.replace(/\.fit$/i, '')}`
    : nameClean

  const startedAt = session.start_time
    ? new Date(session.start_time).toISOString()
    : (records[0]?.timestamp ? new Date(records[0].timestamp).toISOString() : null)

  return {
    source: 'fit',
    filename: filename || null,
    name: niceName.slice(0, 120),
    activity_type: session.sport || activity.sport || null,
    started_at: startedAt,
    distance_m: numericOrNull(session.total_distance) ?? (distance.length ? distance[distance.length - 1] : null),
    moving_time_s: integerOrNull(session.total_moving_time ?? session.total_timer_time),
    elapsed_time_s: integerOrNull(session.total_elapsed_time ?? session.total_timer_time),
    total_elevation_gain: altitude.some((v) => v != null)
      ? computeElevGain(altitude).gain
      : numericOrNull(session.total_ascent),
    average_speed: numericOrNull(session.avg_speed ?? session.enhanced_avg_speed),
    max_speed: numericOrNull(session.max_speed ?? session.enhanced_max_speed),
    average_heartrate: numericOrNull(session.avg_heart_rate),
    max_heartrate: numericOrNull(session.max_heart_rate),
    average_watts: numericOrNull(session.avg_power),
    max_watts: numericOrNull(session.max_power),
    average_cadence: numericOrNull(session.avg_cadence),
    max_cadence: numericOrNull(session.max_cadence),
    average_temp: numericOrNull(session.avg_temperature),
    start_latlng: startLatLng,
    end_latlng: endLatLng,
    streams,
  }
}

function numericOrNull(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function numericOrZero(v) {
  const n = numericOrNull(v)
  return n == null ? 0 : n
}

function integerOrNull(v) {
  const n = numericOrNull(v)
  return n == null ? null : Math.round(n)
}

function formatKm(m) {
  if (m == null) return '–'
  return `${(m / 1000).toFixed(1)} km`
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '–'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  if (h === 0) return `${m} min`
  return `${h} h ${String(m).padStart(2, '0')}`
}

async function removeActivity(a) {
  if (!window.confirm(t('fit.delete_confirm'))) return
  try {
    const res = await fetch(`/api/imported_activities/${a.id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    activities.value = activities.value.filter((x) => x.id !== a.id)
  } catch (e) {
    error.value = e.message
  }
}

onMounted(() => fetchList())
</script>

<template>
  <div class="card shadow-sm border-0 mt-4">
    <div class="card-header activity-card-header d-flex align-items-center gap-2">
      <i class="fa-solid fa-file-arrow-up text-warning" aria-hidden="true"></i>
      <h2 class="h6 mb-0 flex-grow-1">{{ t('fit.title') }}</h2>
    </div>
    <div class="card-body">
      <div
        class="fit-dropzone"
        :class="{ 'is-drag-over': dragOver, 'is-busy': uploadStatus !== 'idle' }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop="onDrop"
        @click="openPicker"
        role="button"
        tabindex="0"
        @keydown.enter="openPicker"
        @keydown.space.prevent="openPicker"
      >
        <input
          ref="fileInputEl"
          type="file"
          accept=".fit,application/octet-stream"
          class="d-none"
          @change="onFileChange"
        />
        <i class="fa-solid fa-cloud-arrow-up mb-2" aria-hidden="true"></i>
        <div v-if="uploadStatus === 'parsing'" class="text-muted">
          <span class="spinner-border spinner-border-sm me-2"></span>{{ t('fit.parsing') }}
        </div>
        <div v-else-if="uploadStatus === 'uploading'" class="text-muted">
          <span class="spinner-border spinner-border-sm me-2"></span>{{ t('fit.uploading') }}
        </div>
        <div v-else-if="uploadStatus === 'done'" class="text-success">
          <i class="fa-solid fa-circle-check me-1"></i>{{ t('fit.done') }}
        </div>
        <div v-else>
          <strong>{{ t('fit.dropzone_title') }}</strong>
          <div class="text-muted small">{{ t('fit.dropzone_hint') }}</div>
        </div>
      </div>

      <div v-if="error" class="alert alert-warning d-flex align-items-center gap-2 mt-3">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span class="flex-grow-1">{{ error }}</span>
        <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
      </div>

      <div v-if="loading" class="text-muted d-flex align-items-center gap-2 mt-3">
        <span class="spinner-border spinner-border-sm text-warning"></span>
        <span>{{ t('fit.loading_list') }}</span>
      </div>
      <ul v-else-if="activities.length" class="list-group list-group-flush mt-3">
        <li v-for="a in activities" :key="a.id" class="list-group-item d-flex align-items-center gap-2 px-0">
          <a :href="`${localePrefix}/imported_activities/${a.id}`" class="flex-grow-1 text-decoration-none text-reset d-flex flex-column min-width-0">
            <strong class="text-truncate">{{ a.name }}</strong>
            <small class="text-muted">
              <i class="fa-solid fa-route me-1"></i>{{ formatKm(a.distance) }}
              <span class="ms-2"><i class="fa-solid fa-clock me-1"></i>{{ formatDuration(a.moving_time) }}</span>
              <span v-if="a.total_elevation_gain != null" class="ms-2"><i class="fa-solid fa-arrow-trend-up text-success me-1"></i>{{ Math.round(a.total_elevation_gain) }} m</span>
              <span class="ms-2 text-muted">· {{ formatDate(a.start_date) }}</span>
              <span v-if="formatDaysAgo(a.start_date)" class="days-ago-badge ms-1">{{ formatDaysAgo(a.start_date) }}</span>
            </small>
          </a>
          <button type="button" class="btn btn-sm btn-outline-danger" :title="t('fit.delete')" @click="removeActivity(a)">
            <i class="fa-solid fa-trash"></i>
          </button>
        </li>
      </ul>
      <p v-else class="text-muted small mt-3 mb-0">
        <i class="fa-regular fa-folder-open me-1"></i>{{ t('fit.empty') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.fit-dropzone {
  border: 2px dashed rgba(252, 76, 2, 0.35);
  border-radius: 0.6rem;
  padding: 1.5rem 1rem;
  text-align: center;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  background: rgba(252, 76, 2, 0.03);
}
.fit-dropzone:hover,
.fit-dropzone.is-drag-over {
  background: rgba(252, 76, 2, 0.08);
  border-color: rgba(252, 76, 2, 0.65);
}
.fit-dropzone.is-busy {
  cursor: progress;
}
.fit-dropzone i.fa-cloud-arrow-up {
  font-size: 1.6rem;
  color: #fc4c02;
  display: block;
}
.min-width-0 { min-width: 0; }
</style>
