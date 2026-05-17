<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { t } from '../i18n'

const routes = ref([])
const loading = ref(true)
const error = ref(null)
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const gpxInputEl = ref(null)
const importingGpx = ref(false)
// Cap waypoints handed to the builder. The controller enforces MAX_WAYPOINTS=50;
// 25 leaves the user headroom to drag-insert more once the route is loaded.
const GPX_IMPORT_MAX_WAYPOINTS = 25

// Inline rename state
const editingId = ref(null)
const editingName = ref('')
const savingId = ref(null)
const editInputs = ref({}) // { [routeId]: HTMLInputElement } — for autofocus

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function fetchRoutes() {
  loading.value = true
  try {
    const res = await fetch('/api/routes', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    routes.value = Array.isArray(payload.routes) ? payload.routes : []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function startEdit(route) {
  editingId.value = route.id
  editingName.value = route.name || ''
  nextTick(() => {
    const el = editInputs.value[route.id]
    if (el) { el.focus(); el.select() }
  })
}

function cancelEdit() {
  editingId.value = null
  editingName.value = ''
}

async function saveName(route) {
  const newName = editingName.value.trim()
  if (!newName || newName === route.name) { cancelEdit(); return }
  savingId.value = route.id
  try {
    const res = await fetch(`/api/routes/${route.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name: newName }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const updated = payload.route
    const idx = routes.value.findIndex((r) => r.id === route.id)
    if (idx >= 0 && updated) {
      routes.value[idx] = { ...routes.value[idx], name: updated.name }
    }
    cancelEdit()
  } catch (e) {
    error.value = e.message
  } finally {
    savingId.value = null
  }
}

async function removeRoute(route) {
  if (!window.confirm(t('routes.delete_confirm'))) return
  try {
    const res = await fetch(`/api/routes/${route.id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    routes.value = routes.value.filter((r) => r.id !== route.id)
  } catch (e) {
    error.value = e.message
  }
}

async function duplicateRoute(route) {
  const proposed = `${route.name} (copie)`.slice(0, 80)
  const raw = window.prompt(t('routes.duplicate_prompt'), proposed)
  if (raw == null) return
  const name = raw.trim().slice(0, 80) || proposed
  try {
    const res = await fetch(`/api/routes/${route.id}/duplicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    })
    if (!res.ok && res.status !== 201) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    if (payload.route) routes.value = [payload.route, ...routes.value]
  } catch (e) {
    error.value = e.message
  }
}

function createNew() {
  const raw = window.prompt(t('routes.name_prompt'), '')
  if (raw == null) return // user cancelled
  const name = raw.trim().slice(0, 80)
  if (!name) return
  const url = new URL(`${localePrefix}/routes/new`, window.location.origin)
  url.searchParams.set('name', name)
  window.location.href = url.toString()
}

// ─── GPX import ──────────────────────────────────────────────────────────────
// Parse client-side, hand the sampled waypoints + a default name to the
// builder via sessionStorage, then redirect to /routes/new?fromGpx=1. The
// builder reads the payload on mount and runs BRouter so the imported route
// gets road-snapping + elevation like a hand-drawn one.
function openGpxPicker() {
  gpxInputEl.value?.click()
}

function onGpxFileChange(ev) {
  const file = ev.target.files?.[0]
  if (file) processGpxFile(file)
  ev.target.value = ''
}

async function processGpxFile(file) {
  error.value = null
  importingGpx.value = true
  try {
    const text = await file.text()
    const points = parseGpxPoints(text)
    if (!points.length) throw new Error(t('routes.error_gpx_no_points'))
    const sampled = downsample(points, GPX_IMPORT_MAX_WAYPOINTS)
    // Pin original endpoints so they survive downsampling.
    if (sampled.length >= 2) {
      sampled[0] = points[0]
      sampled[sampled.length - 1] = points[points.length - 1]
    }
    const baseName = file.name.replace(/\.gpx$/i, '').trim().slice(0, 80)
    sessionStorage.setItem('sportsScope.gpxImport', JSON.stringify({
      name: baseName,
      waypoints: sampled.map((p) => ({ lng: p[0], lat: p[1] })),
    }))
    window.location.href = `${localePrefix}/routes/new?fromGpx=1`
  } catch (e) {
    error.value = `${t('routes.error_gpx_invalid')}: ${e.message}`
    importingGpx.value = false
  }
}

// [[lng, lat], ...] — <trkpt> first (device exports), then <rtept> (planned
// routes from tools like Komoot), then <wpt> as a last resort.
function parseGpxPoints(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(t('routes.error_gpx_invalid'))
  }
  const collect = (tag) => {
    const out = []
    const nodes = doc.getElementsByTagName(tag)
    for (let i = 0; i < nodes.length; i++) {
      const lat = parseFloat(nodes[i].getAttribute('lat'))
      const lng = parseFloat(nodes[i].getAttribute('lon'))
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        out.push([lng, lat])
      }
    }
    return out
  }
  return collect('trkpt').length ? collect('trkpt')
    : collect('rtept').length ? collect('rtept')
    : collect('wpt')
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr.slice()
  const step = arr.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)])
  return out
}

function setInputRef(id, el) {
  if (el) editInputs.value[id] = el
  else delete editInputs.value[id]
}

function formatKm(m) {
  if (m == null) return '–'
  return `${(m / 1000).toFixed(1)} km`
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

onMounted(() => fetchRoutes())
</script>

<template>
  <div>
    <div class="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-2">
      <h1 class="h3 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>
        {{ t('routes.list_title') }}
      </h1>
      <div class="d-flex align-items-center gap-2">
        <button
          type="button"
          class="btn btn-outline-secondary d-flex align-items-center gap-1"
          :disabled="importingGpx"
          :title="t('routes.import_gpx_title')"
          @click="openGpxPicker"
        >
          <span v-if="importingGpx" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          <i v-else class="fa-solid fa-file-arrow-up" aria-hidden="true"></i>
          <span>{{ t('routes.import_gpx') }}</span>
        </button>
        <button type="button" @click="createNew" class="btn btn-warning d-flex align-items-center gap-1">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
          <span>{{ t('routes.new') }}</span>
        </button>
      </div>
      <input
        ref="gpxInputEl"
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        class="d-none"
        @change="onGpxFileChange"
      />
    </div>

    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>Loading…</span>
    </div>
    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="flex-grow-1">{{ error }}</span>
      <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
    </div>
    <div v-else-if="routes.length === 0" class="card shadow-sm border-0">
      <div class="card-body text-muted d-flex align-items-center gap-2">
        <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
        <span>{{ t('routes.empty') }}</span>
      </div>
    </div>
    <ul v-else class="list-group shadow-sm">
      <li
        v-for="r in routes"
        :key="r.id"
        class="list-group-item d-flex align-items-center gap-2"
      >
        <template v-if="editingId === r.id">
          <input
            :ref="(el) => setInputRef(r.id, el)"
            v-model="editingName"
            type="text"
            class="form-control form-control-sm flex-grow-1"
            :maxlength="80"
            :disabled="savingId === r.id"
            @keydown.enter.prevent="saveName(r)"
            @keydown.escape.prevent="cancelEdit"
          />
          <button
            type="button"
            class="btn btn-sm btn-success"
            :title="t('routes.save_name')"
            :disabled="savingId === r.id || !editingName.trim()"
            @click="saveName(r)"
          >
            <span v-if="savingId === r.id" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-check" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :title="t('routes.cancel')"
            :disabled="savingId === r.id"
            @click="cancelEdit"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </template>
        <template v-else>
          <a
            :href="`${localePrefix}/routes/${r.id}/edit`"
            class="flex-grow-1 text-decoration-none text-reset d-flex flex-column min-width-0"
          >
            <strong class="text-truncate">{{ r.name }}</strong>
            <small class="text-muted">
              <i class="fa-solid fa-route me-1" aria-hidden="true"></i>{{ formatKm(r.distance_m) }}
              <span v-if="r.elevation_gain_m != null" class="ms-2">
                <i class="fa-solid fa-arrow-trend-up text-success me-1" aria-hidden="true"></i>{{ Math.round(r.elevation_gain_m) }} m
              </span>
              <span class="ms-2 text-muted">· {{ formatDate(r.updated_at) }}</span>
            </small>
          </a>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :title="t('routes.rename')"
            @click="startEdit(r)"
          >
            <i class="fa-solid fa-pen" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :title="t('routes.duplicate')"
            @click="duplicateRoute(r)"
          >
            <i class="fa-solid fa-copy" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-danger"
            :title="t('routes.delete')"
            @click="removeRoute(r)"
          >
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
          <a
            :href="`${localePrefix}/routes/${r.id}/edit`"
            class="text-muted ms-1"
            :aria-label="r.name"
          >
            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </a>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.min-width-0 {
  min-width: 0;
}
</style>
