<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { STRAVA_REFRESHED_EVENT } from '../stravaRefresh'
import { csrfToken } from '../csrf'

// Suivi d'usure des pièces hors chaîne (pneu, roue, pédalier, cassette, frein
// hydraulique, types custom) — le cirage de chaîne reste géré par ChainWax.vue.
// Chaque type groupe les pièces d'un vélo qui en portent ; une pièce non montée
// reste affichée (c'est l'historique : « montée / démontée et jetée »).

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

// Groupe les pièces d'un vélo (hors chaîne) par type de pièce.
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

function mountedPart(group: { parts: any[] }) {
  return group.parts.find((p: any) => p.mounted) || null
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

// ── Ajout d'une pièce (+ éventuellement d'un nouveau type custom) ──────────────
const openAdd = ref<number | null>(null)
const addTypeId = ref<string>('')
const addName = ref('')
const newTypeName = ref('')
const newTypeThreshold = ref(3000)

function startAdd(bike: any) {
  openAdd.value = bike.id
  addTypeId.value = selectableTypes.value[0] ? String(selectableTypes.value[0].id) : NEW_TYPE_VALUE
  addName.value = ''
  newTypeName.value = ''
  newTypeThreshold.value = 3000
}
function cancelAdd() {
  openAdd.value = null
}
async function submitAdd(bike: any) {
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
  openAdd.value = null
  await run(() =>
    api(`/api/bikes/${bike.id}/parts`, 'POST', {
      part_type_id: Number(partTypeId),
      name: addName.value.trim() || undefined,
    }),
  )
}

// ── Montage ─────────────────────────────────────────────────────────────────────
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

      <div class="card-body d-flex flex-column gap-3">
        <p v-if="!groupsFor(bike).length && openAdd !== bike.id" class="text-muted mb-0">
          {{ t('parts.empty') }}
        </p>

        <div v-for="group in groupsFor(bike)" :key="group.partType.id" class="part-group">
          <h3 class="h6 d-flex align-items-center gap-2">
            <i :class="`fa-solid ${group.partType.icon}`" aria-hidden="true"></i>
            {{ typeLabel(group.partType) }}
          </h3>

          <div v-for="part in group.parts" :key="part.id" class="part-row">
            <div class="d-flex justify-content-between align-items-baseline mb-1 flex-wrap gap-2">
              <span class="fw-semibold d-flex align-items-center gap-2">
                {{ part.name }}
                <span v-if="part.mounted" class="badge bg-success-subtle text-success">
                  <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('parts.mounted') }}
                </span>
              </span>
              <small class="text-muted">
                {{ part.km_since_mount }} / {{ part.wear_threshold_km }} km
                · <i class="fa-regular fa-calendar" aria-hidden="true"></i>
                {{ formatDate(part.mounted_at) }}
              </small>
            </div>

            <div class="progress mb-2" role="progressbar">
              <div
                class="progress-bar"
                :class="barClass(part)"
                :style="{ width: Math.min(100, part.wear_progress_percent) + '%' }"
              >{{ part.wear_progress_percent }}%</div>
            </div>

            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button
                v-if="!part.mounted"
                type="button"
                class="btn btn-sm btn-outline-primary"
                @click="startMount(part)"
              >
                <i class="fa-solid fa-rotate me-1" aria-hidden="true"></i>{{ t('parts.mount') }}
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="startSeuil(part)">
                <i class="fa-solid fa-sliders me-1" aria-hidden="true"></i>{{ t('parts.threshold') }}
              </button>
              <button type="button" class="btn btn-sm btn-outline-danger" @click="removePart(bike, part)">
                <i class="fa-solid fa-trash" aria-hidden="true"></i>
              </button>
            </div>

            <div v-if="openMount === part.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
              <input v-model="mountDate" type="datetime-local" class="form-control form-control-sm" style="width: auto" />
              <button type="button" class="btn btn-sm btn-success" @click="submitMount(bike, part)">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="openMount = null">
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
          </div>
        </div>

        <!-- Formulaire d'ajout -->
        <div v-if="openAdd === bike.id" class="d-flex flex-column gap-2 border-top pt-3">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <select v-model="addTypeId" class="form-select form-select-sm" style="width: auto">
              <option v-for="pt in selectableTypes" :key="pt.id" :value="String(pt.id)">
                {{ typeLabel(pt) }}
              </option>
              <option :value="NEW_TYPE_VALUE">{{ t('parts.new_type') }}</option>
            </select>
            <input
              v-model="addName"
              type="text"
              class="form-control form-control-sm"
              style="width: auto"
              :placeholder="t('parts.name_placeholder')"
            />
          </div>
          <div v-if="addTypeId === NEW_TYPE_VALUE" class="d-flex align-items-center gap-2 flex-wrap">
            <input
              v-model="newTypeName"
              type="text"
              class="form-control form-control-sm"
              style="width: auto"
              :placeholder="t('parts.new_type_name')"
            />
            <input
              v-model.number="newTypeThreshold"
              type="number"
              min="1"
              class="form-control form-control-sm"
              style="width: 7rem"
            />
            <span class="small text-muted">km</span>
          </div>
          <div class="d-flex align-items-center gap-2">
            <button type="button" class="btn btn-sm btn-success" @click="submitAdd(bike)">
              <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('parts.add_confirm') }}
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="cancelAdd">
              {{ t('parts.cancel') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.part-row + .part-row {
  border-top: 1px solid var(--bs-border-color, #dee2e6);
  padding-top: 0.75rem;
  margin-top: 0.75rem;
}
.part-group + .part-group {
  border-top: 1px dashed var(--bs-border-color, #dee2e6);
  padding-top: 1rem;
  margin-top: 0.5rem;
}
.progress {
  height: 1.25rem;
}
</style>
