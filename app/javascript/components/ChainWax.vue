<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'

// compact : sur le tableau de bord on n'affiche que la chaîne montée de chaque vélo
// + un lien vers la page dédiée. En mode complet (/chains) on gère tout.
const props = defineProps<{ compact?: boolean }>()

const bikes = ref<any[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

// État des petits formulaires inline (indexés par id de chaîne / vélo)
const openWax = ref<number | null>(null)
const waxDate = ref(todayStr())
const waxAll = ref(true)
const openMount = ref<number | null>(null)
const mountDate = ref(todayStr())
const editSeuil = ref<number | null>(null)
const seuilValue = ref(300)

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

function todayStr() {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

async function fetchBikes() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/bikes', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const p = await res.json(); if (p.error) msg = p.error } catch { /* noop */ }
      throw new Error(msg)
    }
    const payload = await res.json()
    bikes.value = Array.isArray(payload.bikes) ? payload.bikes : []
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
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
  } catch (e: any) {
    error.value = e.message
  }
}

// ── Cirage ────────────────────────────────────────────────────────────────────
function startWax(chain: any) {
  openWax.value = chain.id
  waxDate.value = todayStr()
  waxAll.value = true
}
function submitWax(chain: any) {
  const date = waxDate.value
  const scope = waxAll.value ? 'bike' : 'chain'
  openWax.value = null
  run(() => api(`/api/chains/${chain.id}/wax`, 'POST', { waxed_at: date, scope }))
}

// ── Montage (rotation) ──────────────────────────────────────────────────────────
function startMount(chain: any) {
  openMount.value = chain.id
  mountDate.value = todayStr()
}
function submitMount(bike: any, chain: any) {
  const date = mountDate.value
  openMount.value = null
  run(() => api(`/api/bikes/${bike.id}/mount`, 'POST', { chain_id: chain.id, mounted_at: date }))
}

// ── Seuil ───────────────────────────────────────────────────────────────────────
function startSeuil(chain: any) {
  editSeuil.value = chain.id
  seuilValue.value = chain.wax_threshold_km
}
function submitSeuil(chain: any) {
  const km = Math.max(1, Math.round(Number(seuilValue.value) || 0))
  editSeuil.value = null
  run(() => api(`/api/chains/${chain.id}`, 'PATCH', { wax_threshold_km: km }))
}

function addChain(bike: any) {
  run(() => api(`/api/bikes/${bike.id}/chains`, 'POST'))
}
function removeChain(bike: any, chain: any) {
  if (bike.chains.length <= 1) return
  if (!window.confirm(t('chains.delete_confirm'))) return
  run(() => api(`/api/chains/${chain.id}`, 'DELETE'))
}
function setDefault(bike: any) {
  run(() => api(`/api/bikes/${bike.id}`, 'PATCH', { is_default: true }))
}
function toggleWax(bike: any) {
  run(() => api(`/api/bikes/${bike.id}`, 'PATCH', { uses_wax: bike.uses_wax === false }))
}

// Tableau de bord : seulement les vélos avec de la cire ET une chaîne montée.
const compactBikes = computed(() =>
  bikes.value.filter((b) => b.uses_wax !== false && b.mounted_chain_id),
)

// Page /chains : vélos par défaut d'abord, puis ceux avec chaîne cirée.
const rank = (b: any) => (b.is_default ? 0 : 2) + (b.uses_wax !== false ? 0 : 1)
const sortedBikes = computed(() => [...bikes.value].sort((a, b) => rank(a) - rank(b)))

function mountedChain(bike: any) {
  return bike.chains.find((c: any) => c.id === bike.mounted_chain_id) || bike.chains[0]
}
function barClass(pct: number) {
  if (pct >= 100) return 'bg-danger'
  if (pct >= 80) return 'bg-warning'
  return 'bg-success'
}
function formatDate(iso: string | null) {
  if (!iso) return t('chains.never_waxed')
  return new Date(iso).toLocaleDateString()
}

onMounted(() => fetchBikes())
</script>

<template>
  <div class="chain-wax">
    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('chains.loading') }}</span>
    </div>

    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span class="flex-grow-1">{{ error }}</span>
      <button type="button" class="btn-close" @click="error = null" aria-label="dismiss"></button>
    </div>

    <!-- ── Mode compact (tableau de bord) : vélos avec cire + chaîne montée ── -->
    <div v-else-if="compact && compactBikes.length" class="card shadow-sm border-0">
      <div class="card-header activity-card-header d-flex align-items-center gap-2">
        <h2 class="h5 mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-link text-warning" aria-hidden="true"></i>
          <span>{{ t('chains.title') }}</span>
        </h2>
        <a :href="`${localePrefix}/chains`" class="btn btn-sm btn-outline-secondary ms-auto">
          {{ t('chains.manage') }}
        </a>
      </div>
      <div class="card-body d-flex flex-column gap-3">
        <div v-for="bike in compactBikes" :key="bike.id">
          <div class="d-flex justify-content-between align-items-baseline mb-1 gap-2">
            <span class="fw-semibold d-flex align-items-center gap-2 min-width-0">
              <span class="text-truncate">{{ bike.name }}</span>
              <span v-if="bike.chains.length > 1" class="badge bg-success-subtle text-success flex-shrink-0">
                <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ mountedChain(bike).name }}
              </span>
            </span>
            <small class="text-muted flex-shrink-0">
              {{ mountedChain(bike).km_since_wax }} / {{ mountedChain(bike).wax_threshold_km }} km
            </small>
          </div>
          <div class="progress" role="progressbar">
            <div
              class="progress-bar"
              :class="barClass(mountedChain(bike).progress_percent)"
              :style="{ width: Math.min(100, mountedChain(bike).progress_percent) + '%' }"
            >{{ mountedChain(bike).progress_percent }}%</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Mode complet (page /chains) ── -->
    <div v-else-if="!compact" class="d-flex flex-column gap-4">
      <div v-for="bike in sortedBikes" :key="bike.id" class="card shadow-sm border-0">
        <div class="card-header activity-card-header d-flex align-items-center gap-2 flex-wrap">
          <h2 class="h5 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-bicycle text-warning" aria-hidden="true"></i>
            <span>{{ bike.name }}</span>
          </h2>
          <span v-if="bike.is_default" class="badge bg-primary-subtle text-primary">
            {{ t('chains.default_bike') }}
          </span>
          <div class="ms-auto d-flex align-items-center gap-3">
            <button
              v-if="!bike.is_default"
              type="button"
              class="btn btn-sm btn-outline-secondary"
              @click="setDefault(bike)"
            >{{ t('chains.set_default') }}</button>
            <div class="form-check form-switch mb-0">
              <input
                :id="`wax-${bike.id}`"
                class="form-check-input"
                type="checkbox"
                :checked="bike.uses_wax !== false"
                @change="toggleWax(bike)"
              />
              <label :for="`wax-${bike.id}`" class="form-check-label small">{{ t('chains.uses_wax') }}</label>
            </div>
          </div>
        </div>

        <div class="card-body d-flex flex-column gap-3">
          <p v-if="bike.uses_wax === false" class="text-muted mb-0 d-flex align-items-center gap-2">
            <i class="fa-regular fa-circle-xmark" aria-hidden="true"></i>{{ t('chains.no_wax_note') }}
          </p>
          <template v-else>
          <div v-for="chain in bike.chains" :key="chain.id" class="chain-row">
            <div class="d-flex justify-content-between align-items-baseline mb-1 flex-wrap gap-2">
              <span class="fw-semibold d-flex align-items-center gap-2">
                {{ chain.name }}
                <span v-if="chain.id === bike.mounted_chain_id" class="badge bg-success-subtle text-success">
                  <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('chains.mounted') }}
                </span>
              </span>
              <small class="text-muted">
                {{ chain.km_since_wax }} / {{ chain.wax_threshold_km }} km
                · <i class="fa-regular fa-calendar" aria-hidden="true"></i>
                {{ t('chains.last_waxed') }} {{ formatDate(chain.last_waxed_at) }}
              </small>
            </div>

            <div class="progress mb-2" role="progressbar">
              <div
                class="progress-bar"
                :class="barClass(chain.progress_percent)"
                :style="{ width: Math.min(100, chain.progress_percent) + '%' }"
              >{{ chain.progress_percent }}%</div>
            </div>

            <!-- Actions -->
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-warning" @click="startWax(chain)">
                <i class="fa-solid fa-droplet me-1" aria-hidden="true"></i>{{ t('chains.wax') }}
              </button>
              <button
                v-if="chain.id !== bike.mounted_chain_id"
                type="button"
                class="btn btn-sm btn-outline-primary"
                @click="startMount(chain)"
              >
                <i class="fa-solid fa-rotate me-1" aria-hidden="true"></i>{{ t('chains.mount') }}
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="startSeuil(chain)">
                <i class="fa-solid fa-sliders me-1" aria-hidden="true"></i>{{ t('chains.threshold') }}
              </button>
              <button
                v-if="bike.chains.length > 1"
                type="button"
                class="btn btn-sm btn-outline-danger"
                @click="removeChain(bike, chain)"
              >
                <i class="fa-solid fa-trash" aria-hidden="true"></i>
              </button>
            </div>

            <!-- Formulaire cirage -->
            <div v-if="openWax === chain.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
              <input v-model="waxDate" type="date" class="form-control form-control-sm" style="width: auto" />
              <div class="form-check">
                <input :id="`waxall-${chain.id}`" v-model="waxAll" class="form-check-input" type="checkbox" />
                <label :for="`waxall-${chain.id}`" class="form-check-label small">{{ t('chains.wax_all') }}</label>
              </div>
              <button type="button" class="btn btn-sm btn-success" @click="submitWax(chain)">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="openWax = null">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>

            <!-- Formulaire montage -->
            <div v-if="openMount === chain.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
              <input v-model="mountDate" type="date" class="form-control form-control-sm" style="width: auto" />
              <button type="button" class="btn btn-sm btn-success" @click="submitMount(bike, chain)">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="openMount = null">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>

            <!-- Formulaire seuil -->
            <div v-if="editSeuil === chain.id" class="d-flex align-items-center gap-2 flex-wrap mt-2">
              <input
                v-model.number="seuilValue"
                type="number"
                min="1"
                class="form-control form-control-sm"
                style="width: 7rem"
              />
              <span class="small text-muted">km</span>
              <button type="button" class="btn btn-sm btn-success" @click="submitSeuil(chain)">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" @click="editSeuil = null">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
            </div>
          </div>

          <div>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="addChain(bike)">
              <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('chains.add_chain') }}
            </button>
          </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chain-row + .chain-row {
  border-top: 1px solid var(--bs-border-color, #dee2e6);
  padding-top: 0.75rem;
}
.progress {
  height: 1.25rem;
}
.min-width-0 {
  min-width: 0;
}
</style>
