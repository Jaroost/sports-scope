<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { t } from '../i18n'
import { speedForSport } from '../userPreferences'
import type { Sport } from '../userPreferences'
import { buildNewRouteUrl } from '../routeHelpers'
import { parseGpxWaypoints, GpxImportError } from '../gpxImport'
import NewRouteModal from './NewRouteModal.vue'

// canDense : réservé aux admins (can :manage, :all). Débloque l'export d'un GPX
// densifié (1 point / 5 m) — utile pour les simulateurs de position GPS, à éviter
// pour les vraies montres (limite de points). Voir routes_controller#gpx (?step).
const props = defineProps<{ canDense?: boolean }>()

const routes = ref([])
const loading = ref(true)
const error = ref(null)
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const gpxInputEl = ref(null)
const importingGpx = ref(false)

// Estimation du temps de parcours et icône de la liste : pilotées par la catégorie
// d'activité enregistrée avec chaque itinéraire (cycling | mtb | hiking). La vitesse
// moyenne correspondante vient du profil utilisateur.
function activityOf(r): Sport {
  return r?.activity === 'mtb' || r?.activity === 'hiking' ? r.activity : 'cycling'
}

function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// Share feedback: holds the id of the route whose link was just copied, so the
// button can flash a checkmark for a couple of seconds.
const sharedId = ref(null)
// Même mécanique pour le partage du lien « vue en lecture seule » (créateur).
const sharedViewId = ref(null)
// Share GPX file state: holds the id of the route currently being fetched/shared.
const sharingGpxId = ref(null)

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

// Partage le lien « vue en lecture seule » : ouvre l'itinéraire dans le créateur,
// non modifiable, accessible sans compte (page + API publiques par jeton).
async function shareViewRoute(route) {
  const url = `${window.location.origin}${localePrefix}/routes/${route.share_token}/view`
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
    sharedViewId.value = route.id
    setTimeout(() => { if (sharedViewId.value === route.id) sharedViewId.value = null }, 2000)
  } catch {
    window.prompt(t('routes.share_view'), url)
  }
}

// Share a public GPX download URL via the Web Share API (Level 1 — works on
// all mobile browsers without file-type restrictions or user-gesture issues).
// Falls back to clipboard copy, then a prompt on desktop.
async function shareGpxFile(route) {
  const url = `${window.location.origin}/api/routes/shared/${route.share_token}/gpx`
  try {
    if (navigator.share) {
      await navigator.share({ title: route.name, url })
      return
    }
  } catch (e) {
    if (e?.name === 'AbortError') return
  }
  try {
    await navigator.clipboard.writeText(url)
    sharingGpxId.value = route.id
    setTimeout(() => { if (sharingGpxId.value === route.id) sharingGpxId.value = null }, 2000)
  } catch {
    window.prompt(t('routes.share_gpx'), url)
  }
}

// ─── Modale « nouvel itinéraire » ─────────────────────────────────────────────
// Partagée entre la création vierge (bouton « Nouveau ») et l'import GPX :
// récupère le nom + le type avant d'ouvrir le créateur. Quand `pendingGpx`
// porte des waypoints, la confirmation finalise plutôt l'import.
const showNewRouteModal = ref(false)
const newRouteName = ref('')
const pendingGpx = ref<{ waypoints: unknown[] } | null>(null)

function createNew() {
  pendingGpx.value = null
  newRouteName.value = ''
  showNewRouteModal.value = true
}

function onNewRouteConfirm({ name, sport, profile }: { name: string; sport: Sport; profile: string }) {
  showNewRouteModal.value = false
  if (pendingGpx.value) {
    sessionStorage.setItem('sportsScope.gpxImport', JSON.stringify({
      name,
      activity: sport,
      profile,
      waypoints: pendingGpx.value.waypoints,
    }))
    pendingGpx.value = null
    window.location.href = `${localePrefix}/routes/new?fromGpx=1`
    return
  }
  window.location.href = buildNewRouteUrl({ name, sport, profile })
}

function onNewRouteClose() {
  showNewRouteModal.value = false
  pendingGpx.value = null
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
    const waypoints = parseGpxWaypoints(await file.text())
    const baseName = file.name.replace(/\.gpx$/i, '').trim().slice(0, 80)
    // On laisse l'utilisateur confirmer/ajuster le nom (pré-rempli avec le nom
    // du fichier) et choisir le type avant d'ouvrir le créateur.
    pendingGpx.value = { waypoints }
    newRouteName.value = baseName
    showNewRouteModal.value = true
  } catch (e) {
    const key = e instanceof GpxImportError && e.code === 'no_points'
      ? 'routes.error_gpx_no_points'
      : 'routes.error_gpx_invalid'
    error.value = t(key)
  } finally {
    importingGpx.value = false
  }
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
  const v = speedForSport(activityOf(r))
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
                <span class="activity-type-badge" :title="t(`routes.wt_sport_${activityOf(r)}`)">
                  <i :class="`fa-solid ${sportIcon(activityOf(r))}`" aria-hidden="true"></i>
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

                <div class="dropdown">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary"
                    data-bs-toggle="dropdown"
                    data-bs-auto-close="true"
                    aria-expanded="false"
                    :aria-label="t('routes.more_actions')"
                  >
                    <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
                  </button>
                  <ul class="dropdown-menu dropdown-menu-end">
                    <li><h6 class="dropdown-header">{{ t('routes.group_share') }}</h6></li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareRoute(r)">
                        <i class="" :class="sharedId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-location-arrow'" aria-hidden="true"></i>
                        <span>{{ sharedId === r.id ? t('routes.share_copied') : t('routes.share') }}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareViewRoute(r)">
                        <i :class="sharedViewId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-eye'" aria-hidden="true"></i>
                        <span>{{ sharedViewId === r.id ? t('routes.share_copied') : t('routes.share_view') }}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="shareGpxFile(r)">
                        <i :class="sharingGpxId === r.id ? 'fa-solid fa-check text-success' : 'fa-solid fa-file-export'" aria-hidden="true"></i>
                        <span>{{ sharingGpxId === r.id ? t('routes.share_copied') : t('routes.share_gpx') }}</span>
                      </button>
                    </li>
                    <li><hr class="dropdown-divider"></li>
                    <li><h6 class="dropdown-header">{{ t('routes.group_export') }}</h6></li>
                    <li>
                      <a :href="`/api/routes/${r.id}/gpx`" class="dropdown-item d-flex align-items-center gap-2" download>
                        <i class="fa-solid fa-download" aria-hidden="true"></i>
                        <span>{{ t('routes.export_gpx') }}</span>
                      </a>
                    </li>
                    <li v-if="props.canDense">
                      <a :href="`/api/routes/${r.id}/gpx?step=5`" class="dropdown-item d-flex align-items-center gap-2" download>
                        <i class="fa-solid fa-download" aria-hidden="true"></i>
                        <span>{{ t('routes.export_gpx_dense') }}</span>
                      </a>
                    </li>
                    <li><hr class="dropdown-divider"></li>
                    <li><h6 class="dropdown-header">{{ t('routes.group_edit') }}</h6></li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="startEdit(r)">
                        <i class="fa-solid fa-pen" aria-hidden="true"></i>
                        <span>{{ t('routes.rename') }}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" class="dropdown-item d-flex align-items-center gap-2" @click="duplicateRoute(r)">
                        <i class="fa-solid fa-copy" aria-hidden="true"></i>
                        <span>{{ t('routes.duplicate') }}</span>
                      </button>
                    </li>
                  </ul>
                </div>

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

    <NewRouteModal
      :show="showNewRouteModal"
      :initial-name="newRouteName"
      @confirm="onNewRouteConfirm"
      @close="onNewRouteClose"
    />
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
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
  .route-row-actions > .btn,
  .route-row-actions > .dropdown > .btn {
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
  }
}
</style>
