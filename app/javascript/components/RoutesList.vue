<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue'
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

// Average riding speed in km/h — shared with the RouteBuilder via the same
// localStorage key, so editing it in either place keeps both in sync.
const SPEED_KEY = 'sportsScope.routeBuilderAvgSpeed'
function loadSpeed() {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    const v = raw != null ? parseFloat(raw) : NaN
    return Number.isFinite(v) && v >= 3 && v <= 80 ? v : 18
  } catch { return 18 }
}
const avgSpeedKmh = ref(loadSpeed())
watch(avgSpeedKmh, (v) => {
  if (!Number.isFinite(v) || v < 3 || v > 80) return
  try { localStorage.setItem(SPEED_KEY, String(v)) } catch { /* ignore */ }
})

// Share feedback: holds the id of the route whose link was just copied, so the
// button can flash a checkmark for a couple of seconds.
const sharedId = ref(null)

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

// Share the navigation link (works for signed-out recipients — the navigate
// page and its API are public). Uses the native share sheet on mobile, falling
// back to clipboard copy (then a prompt) on desktop.
async function shareRoute(route) {
  const url = `${window.location.origin}${localePrefix}/routes/${route.share_token}/navigate`
  try {
    if (navigator.share) {
      await navigator.share({ title: route.name, url })
      return
    }
  } catch (e) {
    if (e?.name === 'AbortError') return // user dismissed the share sheet
  }
  try {
    await navigator.clipboard.writeText(url)
    sharedId.value = route.id
    setTimeout(() => { if (sharedId.value === route.id) sharedId.value = null }, 2000)
  } catch {
    window.prompt(t('routes.share'), url)
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

// Estimated ride time: distance / speed. Mirrors the builder — the chosen
// avg speed already accounts for terrain, so no climb penalty is added.
function estimatedSecondsFor(r) {
  const d = r?.distance_m
  const v = avgSpeedKmh.value
  if (!d || !Number.isFinite(v) || v <= 0) return 0
  return Math.round(((d / 1000) / v) * 3600)
}

function formatDuration(totalSec) {
  if (!totalSec || totalSec < 0) return '–'
  const h = Math.floor(totalSec / 3600)
  const m = Math.round((totalSec - h * 3600) / 60)
  if (h === 0) return `${m} min`
  return `${h} h ${String(m).padStart(2, '0')}`
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

    <div class="card shadow-sm border-0">
      <div class="card-header activity-card-header d-flex align-items-center gap-2 flex-wrap">
        <h2 class="h5 mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
          <span>{{ t('routes.list_title') }}</span>
        </h2>
        <span v-if="!loading && !error" class="badge bg-light text-muted ms-1">{{ routes.length }}</span>
        <label class="ms-auto d-inline-flex align-items-center gap-1 text-muted mb-0 small">
          <i class="fa-solid fa-gauge-high" aria-hidden="true"></i>
          <input
            v-model.number="avgSpeedKmh"
            type="number"
            min="3"
            max="80"
            step="1"
            class="form-control form-control-sm speed-input"
            :title="t('routes.avg_speed_hint')"
            :aria-label="t('routes.avg_speed_hint')"
          />
          <span>km/h</span>
        </label>
      </div>
      <div class="card-body">
        <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
          <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
          <span>Loading…</span>
        </div>
        <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span class="flex-grow-1">{{ error }}</span>
          <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
        </div>
        <div v-else-if="routes.length === 0" class="text-muted d-flex align-items-center gap-2">
          <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
          <span>{{ t('routes.empty') }}</span>
        </div>
        <ul v-else class="list-unstyled mb-0 d-flex flex-column gap-1">
          <li v-for="r in routes" :key="r.id">
            <div v-if="editingId === r.id" class="activity-row d-flex align-items-center gap-2">
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
            </div>
            <div v-else class="activity-row d-flex align-items-center gap-3">
              <a
                :href="`${localePrefix}/routes/${r.id}/edit`"
                class="flex-grow-1 d-flex align-items-center gap-3 text-decoration-none text-reset min-width-0"
              >
                <span class="activity-type-badge">
                  <i class="fa-solid fa-route" aria-hidden="true"></i>
                </span>
                <div class="min-width-0 flex-grow-1">
                  <div class="fw-semibold text-truncate">{{ r.name }}</div>
                  <small class="text-muted d-flex flex-wrap align-items-center gap-x-3 gap-y-1">
                    <span class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>{{ formatKm(r.distance_m) }}
                    </span>
                    <span v-if="r.elevation_gain_m != null" class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>+{{ Math.round(r.elevation_gain_m) }} m
                    </span>
                    <span
                      v-if="estimatedSecondsFor(r) > 0"
                      class="d-inline-flex align-items-center gap-1"
                      :title="t('routes.estimated_time_hint')"
                    >
                      <i class="fa-regular fa-clock" aria-hidden="true"></i>{{ formatDuration(estimatedSecondsFor(r)) }}
                    </span>
                    <span class="d-inline-flex align-items-center gap-1">
                      <i class="fa-regular fa-calendar" aria-hidden="true"></i>{{ formatDate(r.updated_at) }}
                    </span>
                  </small>
                </div>
              </a>
              <div class="d-flex align-items-center gap-1 route-row-actions">
                <a
                  :href="`${localePrefix}/routes/${r.share_token}/navigate`"
                  class="btn btn-sm btn-outline-primary"
                  :title="t('routes.navigate')"
                  :aria-label="t('routes.navigate')"
                >
                  <i class="fa-solid fa-location-arrow" aria-hidden="true"></i>
                </a>
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary"
                  :title="sharedId === r.id ? t('routes.share_copied') : t('routes.share')"
                  :aria-label="t('routes.share')"
                  @click="shareRoute(r)"
                >
                  <i
                    :class="sharedId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-share-nodes'"
                    aria-hidden="true"
                  ></i>
                </button>
                <a
                  :href="`/api/routes/${r.id}/gpx`"
                  class="btn btn-sm btn-outline-secondary"
                  :title="t('routes.export_gpx')"
                  download
                >
                  <i class="fa-solid fa-download" aria-hidden="true"></i>
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
              </div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.min-width-0 {
  min-width: 0;
}

/* Tighter horizontal/vertical gaps for the meta line under each route name —
   bootstrap doesn't ship gap-x/gap-y utilities for inline gaps. */
.gap-x-3 { column-gap: 0.75rem; }
.gap-y-1 { row-gap: 0.25rem; }

/* Compact km/h input — same shape as the one in the route builder's stats. */
.speed-input {
  width: 3.5rem;
  text-align: right;
  padding: 0.1rem 0.35rem;
  font-variant-numeric: tabular-nums;
}

/* Action button cluster stays at fixed size; only the row's anchor area
   gets the translateX hover bump from .activity-row in application.scss. */
.route-row-actions {
  flex-shrink: 0;
}

/* On phones the row is too cramped to keep the name + 5 actions on one line,
   so the action cluster wraps onto its own full-width line below the name and
   spreads the buttons out for easier tapping. */
@media (max-width: 575.98px) {
  .activity-row {
    flex-wrap: wrap;
  }
  .route-row-actions {
    width: 100%;
    justify-content: space-between;
    margin-top: 0.5rem;
  }
  .route-row-actions .btn {
    flex: 1;
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
  }
}
</style>
