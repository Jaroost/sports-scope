<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { t } from '../i18n'

interface BackfillRun {
  id: number
  status: 'pending' | 'running' | 'rate_limited' | 'completed' | 'failed'
  total: number
  done: number
  pending: number
  rate_limited_until: string | null
  last_error: string | null
  updated_at: string | null
}

const ENDPOINT = '/strava/backfill'
const POLL_MS = 3000

const run = ref<BackfillRun | null>(null)
const pending = ref(0)
const loading = ref(true)
const starting = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

const isActive = computed(() => {
  const s = run.value?.status
  return s === 'pending' || s === 'running' || s === 'rate_limited'
})
const isRateLimited = computed(() => run.value?.status === 'rate_limited')
const isComplete = computed(() => run.value?.status === 'completed')
const isFailed = computed(() => run.value?.status === 'failed')
const pct = computed(() => {
  const r = run.value
  if (!r || r.total <= 0) return 0
  return Math.min(100, Math.round((r.done / r.total) * 100))
})

function resumeTime(): string {
  const iso = run.value?.rate_limited_until
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function scheduleNext() {
  if (timer) clearTimeout(timer)
  if (isActive.value) timer = setTimeout(fetchStatus, POLL_MS)
}

async function fetchStatus() {
  try {
    const res = await fetch(ENDPOINT, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    run.value = payload.run || null
    pending.value = payload.run ? payload.run.pending : (payload.pending ?? 0)
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
    scheduleNext()
  }
}

async function start() {
  starting.value = true
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    run.value = payload.run || null
    pending.value = payload.run ? payload.run.pending : pending.value
    error.value = null
    scheduleNext()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    starting.value = false
  }
}

onMounted(fetchStatus)
onUnmounted(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <div class="card shadow-sm border-0">
    <div class="card-header activity-card-header d-flex align-items-center gap-2">
      <i class="fa-solid fa-cloud-arrow-down text-warning" aria-hidden="true"></i>
      <h2 class="h5 mb-0">{{ t('strava.backfill_title') }}</h2>
    </div>
    <div class="card-body">
      <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
        <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
        <span>{{ t('strava.backfill_running') }}</span>
      </div>

      <template v-else>
        <p class="text-muted small mb-3">{{ t('strava.backfill_help') }}</p>

        <div v-if="error" class="alert alert-danger d-flex align-items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span>{{ error }}</span>
        </div>

        <!-- En cours -->
        <div v-if="isActive">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <span class="fw-semibold d-flex align-items-center gap-2">
              <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
              {{ t('strava.backfill_running') }}
            </span>
            <small class="text-muted">{{ t('strava.backfill_progress', { done: run?.done ?? 0, total: run?.total ?? 0 }) }}</small>
          </div>
          <div class="progress" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100">
            <div
              class="progress-bar progress-bar-striped progress-bar-animated bg-warning"
              :style="{ width: pct + '%' }"
            >{{ pct }}%</div>
          </div>
          <small v-if="isRateLimited" class="text-muted d-flex align-items-center gap-1 mt-2">
            <i class="fa-regular fa-clock" aria-hidden="true"></i>
            {{ t('strava.backfill_rate_limited', { time: resumeTime() }) }}
          </small>
        </div>

        <!-- Terminé, plus rien à faire -->
        <div v-else-if="isComplete && pending === 0" class="alert alert-success mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
          <span>{{ t('strava.backfill_complete') }}</span>
        </div>

        <!-- Rien à télécharger -->
        <div v-else-if="pending === 0" class="text-muted d-flex align-items-center gap-2">
          <i class="fa-solid fa-circle-check text-success" aria-hidden="true"></i>
          <span>{{ t('strava.backfill_up_to_date') }}</span>
        </div>

        <!-- Idle avec des activités à télécharger -->
        <div v-else class="d-flex align-items-center gap-3">
          <button
            type="button"
            class="btn btn-warning d-flex align-items-center gap-2"
            :disabled="starting"
            @click="start"
          >
            <span v-if="starting" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i>
            <span>{{ isFailed ? t('strava.backfill_start') : t('strava.backfill_button') }}</span>
          </button>
          <small class="text-muted">{{ t('strava.backfill_progress', { done: 0, total: pending }) }}</small>
        </div>
      </template>
    </div>
  </div>
</template>
