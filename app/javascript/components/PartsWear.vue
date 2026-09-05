<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { Modal } from 'bootstrap'
import { t } from '../i18n'
import { STRAVA_REFRESHED_EVENT } from '../stravaRefresh'
import { csrfToken } from '../csrf'

// Suivi d'usure des pièces hors chaîne (pneu, roue, pédalier, cassette, frein
// hydraulique, types custom) — le cirage de chaîne reste géré par ChainWax.vue.
// Chaque type groupe les pièces d'un vélo qui en portent, en cartes. Certains
// types (pneu, roue, plaquette/disque de frein) autorisent plusieurs pièces
// montées en même temps (avant/arrière) : cf. part_type.allow_multiple_mounted,
// qui décide côté serveur si monter une pièce en démonte une autre du même type.
// Une pièce mise au rebut n'est plus montable mais reste visible (repliée) avec
// son historique — « Supprimer » l'efface définitivement.

const bikes = ref<any[]>([])
const partTypes = ref<any[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const NEW_TYPE_VALUE = '__new__'

function nowStr() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16)
}

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken(),
    },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    let msg = `HTTP ${res.status}`
    try { const p = await res.json(); if (p.error) msg = p.error } catch { /* noop */ }
    throw new Error(msg)
  }
  return res.status === 204 ? null : res.json()
}

async function fetchAll() {
  loading.value = true
  error.value = null
  try {
    const [bikesRes, typesRes] = await Promise.all([
      fetch('/api/bikes', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }),
      fetch('/api/part_types', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }),
    ])
    if (!bikesRes.ok) throw new Error(`HTTP ${bikesRes.status}`)
    if (!typesRes.ok) throw new Error(`HTTP ${typesRes.status}`)
    const bikesPayload = await bikesRes.json()
    const typesPayload = await typesRes.json()
    bikes.value = Array.isArray(bikesPayload.bikes) ? bikesPayload.bikes : []
    partTypes.value = Array.isArray(typesPayload.part_types) ? typesPayload.part_types : []
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function replaceBike(bike: any) {
  if (!bike) return
  const i = bikes.value.findIndex((b) => b.id === bike.id)
  if (i >= 0) bikes.value[i] = bike
  else bikes.value.push(bike)
}

async function run(fn: () => Promise<any>) {
  error.value = null
  try {
    const payload = await fn()
    if (payload?.bike) replaceBike(payload.bike)
    return payload
  } catch (e: any) {
    error.value = e.message
    return null
  }
}

function typeLabel(partType: any) {
  return partType.key ? t(`parts.types.${partType.key}`) : partType.name
}

// Types custom sélectionnables (hors chaîne, gérée par ChainWax.vue).
const selectableTypes = computed(() => partTypes.value.filter((pt) => pt.key !== 'chain'))

// Groupe les pièces d'un vélo (hors chaîne, actives ET au rebut) par type de pièce.
function groupsFor(bike: any) {
  const byType = new Map<number, { partType: any; parts: any[] }>()
  for (const part of bike.parts || []) {
    if (part.part_type.key === 'chain') continue
    const entry = byType.get(part.part_type.id) || { partType: part.part_type, parts: [] }
    entry.parts.push(part)
    byType.set(part.part_type.id, entry)
  }
  return [...byType.values()].sort((a, b) => typeLabel(a.partType).localeCompare(typeLabel(b.partType)))
}
function activeParts(group: { parts: any[] }) {
  return group.parts.filter((p: any) => !p.discarded_at)
}
function discardedParts(group: { parts: any[] }) {
  return group.parts.filter((p: any) => p.discarded_at)
}

const expandedDiscarded = reactive<Record<number, boolean>>({})
function toggleDiscarded(typeId: number) {
  expandedDiscarded[typeId] = !expandedDiscarded[typeId]
}

function barClass(part: any) {
  if (part.wear_progress_percent >= 100) return 'bg-danger'
  if (part.wear_progress_percent >= 80) return 'bg-warning'
  return 'bg-success'
}

function formatDate(iso: string | null) {
  if (!iso) return t('parts.never_mounted')
  return new Date(iso).toLocaleDateString()
}

// ── Ajout d'une pièce (+ éventuellement d'un nouveau type custom), en dialogue ──
const addBike = ref<any>(null)
const addTypeId = ref<string>('')
const addName = ref('')
const newTypeName = ref('')
const newTypeThreshold = ref(3000)
const addModalEl = ref<HTMLElement | null>(null)
let addModal: Modal | null = null

function startAdd(bike: any) {
  addBike.value = bike
  addTypeId.value = selectableTypes.value[0] ? String(selectableTypes.value[0].id) : NEW_TYPE_VALUE
  addName.value = ''
  newTypeName.value = ''
  newTypeThreshold.value = 3000
  if (!addModalEl.value) return
  if (!addModal) {
    // Le composant vit dans une carte : on déplace la modale sous <body> pour
    // qu'elle ne soit ni rognée ni recentrée par ses ancêtres.
    document.body.appendChild(addModalEl.value)
    addModal = new Modal(addModalEl.value)
  }
  addModal.show()
}
async function submitAdd() {
  const bike = addBike.value
  if (!bike) return
  let partTypeId = addTypeId.value
  if (partTypeId === NEW_TYPE_VALUE) {
    const name = newTypeName.value.trim()
    if (!name) return
    const created = await run(() =>
      api('/api/part_types', 'POST', {
        name,
        default_wear_threshold_km: Math.max(1, Math.round(Number(newTypeThreshold.value) || 0)),
      }),
    )
    if (!created?.part_type) return
    partTypes.value.push(created.part_type)
    partTypeId = String(created.part_type.id)
  }
  addModal?.hide()
  await run(() =>
    api(`/api/bikes/${bike.id}/parts`, 'POST', {
      part_type_id: Number(partTypeId),
      name: addName.value.trim() || undefined,
    }),
  )
}

// ── Montage / démontage ─────────────────────────────────────────────────────────
const openMount = ref<number | null>(null)
const mountDate = ref(nowStr())
function startMount(part: any) {
  openMount.value = part.id
  mountDate.value = nowStr()
}
function submitMount(bike: any, part: any) {
  const date = mountDate.value
  openMount.value = null
  run(() => api(`/api/bikes/${bike.id}/mount`, 'POST', { part_id: part.id, mounted_at: date }))
}

const openUnmount = ref<number | null>(null)
const unmountDate = ref(nowStr())
function startUnmount(part: any) {
  openUnmount.value = part.id
  unmountDate.value = nowStr()
}
function submitUnmount(part: any) {
  const date = unmountDate.value
  openUnmount.value = null
  run(() => api(`/api/parts/${part.id}/unmount`, 'POST', { unmounted_at: date }))
}

// ── Seuil ───────────────────────────────────────────────────────────────────────
const editSeuil = ref<number | null>(null)
const seuilValue = ref(0)
function startSeuil(part: any) {
  editSeuil.value = part.id
  seuilValue.value = part.wear_threshold_km
}
function submitSeuil(part: any) {
  const km = Math.max(1, Math.round(Number(seuilValue.value) || 0))
  editSeuil.value = null
  run(() => api(`/api/parts/${part.id}`, 'PATCH', { wear_threshold_km: km }))
}

// ── Notes ───────────────────────────────────────────────────────────────────────
const openNotes = ref<number | null>(null)
const notesValue = ref('')
function startNotes(part: any) {
  openNotes.value = part.id
  notesValue.value = part.notes || ''
}
function submitNotes(part: any) {
  const notes = notesValue.value.trim()
  openNotes.value = null
  run(() => api(`/api/parts/${part.id}`, 'PATCH', { notes }))
}

// ── Rebut ───────────────────────────────────────────────────────────────────────
function discardPart(part: any) {
  if (!window.confirm(t('parts.discard_confirm'))) return
  run(() => api(`/api/parts/${part.id}/discard`, 'POST'))
}
function restorePart(part: any) {
  run(() => api(`/api/parts/${part.id}/restore`, 'POST'))
}
async function removePart(bike: any, part: any) {
  if (!window.confirm(t('parts.delete_confirm'))) return
  error.value = null
  try {
    await api(`/api/parts/${part.id}`, 'DELETE')
    const b = bikes.value.find((x) => x.id === bike.id)
    if (b) b.parts = b.parts.filter((p: any) => p.id !== part.id)
  } catch (e: any) {
    error.value = e.message
  }
}

function onStravaRefreshed() { fetchAll() }

onMounted(() => {
  fetchAll()
  window.addEventListener(STRAVA_REFRESHED_EVENT, onStravaRefreshed)
})
onBeforeUnmount(() => {
  addModal?.dispose()
  window.removeEventListener(STRAVA_REFRESHED_EVENT, onStravaRefreshed)
})
</script>

<template>
  <div class="parts-wear d-flex flex-column gap-4">
    <div v-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="flex-grow-1">{{ error }}</span>
      <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
    </div>

    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('parts.loading') }}</span>
    </div>

    <div v-for="bike in bikes" v-else :key="bike.id" class="card shadow-sm border-0">
      <div class="card-header activity-card-header d-flex align-items-center gap-2">
        <h2 class="h6 mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-gears text-warning" aria-hidden="true"></i>
          <span>{{ bike.name }}</span>
        </h2>
        <button type="button" class="btn btn-sm btn-outline-secondary ms-auto" @click="startAdd(bike)">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('parts.add') }}
        </button>
      </div>

      <div class="card-body d-flex flex-column gap-4">
        <p v-if="!groupsFor(bike).length" class="text-muted mb-0">
          {{ t('parts.empty') }}
        </p>

        <div v-for="group in groupsFor(bike)" :key="group.partType.id" class="part-group">
          <h3 class="h6 d-flex align-items-center gap-2 mb-2">
            <i :class="`fa-solid ${group.partType.icon}`" aria-hidden="true"></i>
            {{ typeLabel(group.partType) }}
          </h3>

          <div class="row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3">
            <div v-for="part in activeParts(group)" :key="part.id" class="col">
              <div class="card h-100 part-card" :class="{ 'border-success': part.mounted }">
                <div class="card-body d-flex flex-column">
                  <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                    <h4 class="h6 mb-0 text-break">{{ part.name }}</h4>
                    <span v-if="part.mounted" class="badge bg-success-subtle text-success flex-shrink-0">
                      <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('parts.mounted') }}
                    </span>
                  </div>

                  <div class="progress mb-1" role="progressbar">
                    <div
                      class="progress-bar"
                      :class="barClass(part)"
                      :style="{ width: Math.min(100, part.wear_progress_percent) + '%' }"
                    >{{ part.wear_progress_percent }}%</div>
                  </div>
                  <small class="text-muted mb-2">
                    {{ part.km_since_mount }} / {{ part.wear_threshold_km }} km
                    · <i class="fa-regular fa-calendar" aria-hidden="true"></i>
                    {{ formatDate(part.mounted_at) }}
                  </small>

                  <p v-if="part.notes && openNotes !== part.id" class="text-muted small mb-2 text-break">
                    <i class="fa-regular fa-note-sticky me-1" aria-hidden="true"></i>{{ part.notes }}
                  </p>

                  <div class="d-flex flex-wrap gap-2 mt-auto pt-2">
                    <button
                      v-if="!part.mounted"
                      type="button"
                      class="btn btn-sm btn-outline-primary"
                      :title="t('parts.mount')"
                      @click="startMount(part)"
                    >
                      <i class="fa-solid fa-rotate" aria-hidden="true"></i>
                    </button>
                    <button
                      v-else
                      type="button"
                      class="btn btn-sm btn-outline-secondary"
                      :title="t('parts.unmount')"
                      @click="startUnmount(part)"
                    >
                      <i class="fa-solid fa-eject" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-outline-secondary"
                      :title="t('parts.threshold')"
                      @click="startSeuil(part)"
                    >
                      <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-outline-secondary"
                      :title="t('parts.notes')"
                      @click="startNotes(part)"
                    >
                      <i class="fa-solid fa-note-sticky" aria-hidden="true"></i>
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-outline-warning ms-auto"
                      :title="t('parts.discard')"
                      @click="discardPart(part)"
                    >
                      <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
                    </button>
                  </div>

                  <div v-if="openMount === part.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
                    <input v-model="mountDate" type="datetime-local" class="form-control form-control-sm" />
                    <button type="button" class="btn btn-sm btn-success" @click="submitMount(bike, part)">
                      <i class="fa-solid fa-check" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" @click="openMount = null">
                      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                  </div>

                  <div v-if="openUnmount === part.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
                    <input v-model="unmountDate" type="datetime-local" class="form-control form-control-sm" />
                    <button type="button" class="btn btn-sm btn-success" @click="submitUnmount(part)">
                      <i class="fa-solid fa-check" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" @click="openUnmount = null">
                      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                  </div>

                  <div v-if="editSeuil === part.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
                    <input
                      v-model.number="seuilValue"
                      type="number"
                      min="1"
                      class="form-control form-control-sm"
                      style="width: 7rem"
                    />
                    <span class="small text-muted">km</span>
                    <button type="button" class="btn btn-sm btn-success" @click="submitSeuil(part)">
                      <i class="fa-solid fa-check" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" @click="editSeuil = null">
                      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                  </div>

                  <div v-if="openNotes === part.id" class="d-flex flex-column gap-2 mt-2">
                    <textarea
                      v-model="notesValue"
                      class="form-control form-control-sm"
                      rows="2"
                      :placeholder="t('parts.notes_placeholder')"
                    ></textarea>
                    <div class="d-flex align-items-center gap-2">
                      <button type="button" class="btn btn-sm btn-success" @click="submitNotes(part)">
                        <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('parts.save') }}
                      </button>
                      <button type="button" class="btn btn-sm btn-outline-secondary" @click="openNotes = null">
                        {{ t('parts.cancel') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="discardedParts(group).length" class="mt-2">
            <button
              type="button"
              class="btn btn-sm btn-link text-muted text-decoration-none ps-0"
              @click="toggleDiscarded(group.partType.id)"
            >
              <i
                class="fa-solid me-1"
                :class="expandedDiscarded[group.partType.id] ? 'fa-chevron-down' : 'fa-chevron-right'"
                aria-hidden="true"
              ></i>
              {{ t('parts.discarded_section') }} ({{ discardedParts(group).length }})
            </button>

            <div v-if="expandedDiscarded[group.partType.id]" class="d-flex flex-column gap-2 mt-2">
              <div
                v-for="part in discardedParts(group)"
                :key="part.id"
                class="discarded-row d-flex justify-content-between align-items-center gap-2 flex-wrap"
              >
                <div class="min-width-0">
                  <span class="text-muted text-decoration-line-through">{{ part.name }}</span>
                  <small class="text-muted d-block">
                    {{ part.km_since_mount }} km · {{ t('parts.discarded_on') }} {{ formatDate(part.discarded_at) }}
                  </small>
                  <small v-if="part.notes" class="text-muted d-block text-break">
                    <i class="fa-regular fa-note-sticky me-1" aria-hidden="true"></i>{{ part.notes }}
                  </small>
                </div>
                <div class="d-flex gap-2 flex-shrink-0">
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-success"
                    :title="t('parts.restore')"
                    @click="restorePart(part)"
                  >
                    <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger"
                    :title="t('parts.delete')"
                    @click="removePart(bike, part)"
                  >
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ── Dialogue « ajouter un composant » ── -->
    <div ref="addModalEl" class="modal fade" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title d-flex align-items-center gap-2">
              <i class="fa-solid fa-plus" aria-hidden="true"></i>
              {{ t('parts.add') }}
              <span v-if="addBike" class="text-muted fw-normal">— {{ addBike.name }}</span>
            </h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="t('parts.cancel')"></button>
          </div>
          <div class="modal-body d-flex flex-column gap-3">
            <div>
              <label for="add-part-type" class="form-label">{{ t('parts.type_label') }}</label>
              <select id="add-part-type" v-model="addTypeId" class="form-select">
                <option v-for="pt in selectableTypes" :key="pt.id" :value="String(pt.id)">
                  {{ typeLabel(pt) }}
                </option>
                <option :value="NEW_TYPE_VALUE">{{ t('parts.new_type') }}</option>
              </select>
            </div>
            <div v-if="addTypeId === NEW_TYPE_VALUE" class="d-flex align-items-center gap-2 flex-wrap">
              <input
                v-model="newTypeName"
                type="text"
                class="form-control"
                style="flex: 2 1 auto"
                :placeholder="t('parts.new_type_name')"
              />
              <input
                v-model.number="newTypeThreshold"
                type="number"
                min="1"
                class="form-control"
                style="width: 7rem"
              />
              <span class="small text-muted">km</span>
            </div>
            <div>
              <label for="add-part-name" class="form-label">{{ t('parts.name_placeholder') }}</label>
              <input id="add-part-name" v-model="addName" type="text" class="form-control" />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">
              {{ t('parts.cancel') }}
            </button>
            <button type="button" class="btn btn-primary" @click="submitAdd">
              <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('parts.add_confirm') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.part-group + .part-group {
  border-top: 1px dashed var(--bs-border-color, #dee2e6);
  padding-top: 1rem;
  margin-top: 0.5rem;
}
.part-card {
  background-color: var(--bs-tertiary-bg, #f8f9fa);
}
.progress {
  height: 1.25rem;
}
.discarded-row {
  padding: 0.5rem 0;
  border-top: 1px solid var(--bs-border-color, #dee2e6);
}
.min-width-0 {
  min-width: 0;
}
</style>
