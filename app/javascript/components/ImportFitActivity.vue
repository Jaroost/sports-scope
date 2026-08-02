<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'
import { buildImportedActivityPayload, parseFitFile } from '../fitImport'
import { csrfToken } from '../csrf'

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const activities = ref([])
const loading = ref(true)
const error = ref(null)
const uploadStatus = ref('idle') // 'idle' | 'parsing' | 'uploading' | 'done'
const fileInputEl = ref(null)
const dragOver = ref(false)

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
    const data = await parseFitFile(await file.arrayBuffer())
    const payload = buildImportedActivityPayload(data, file.name)
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

// Aide du badge TSS selon la source du calcul (puissance / FC / estimation).
function tssHint(source) {
  const key = source === 'power' ? 'tss_hint_power' : source === 'hr' ? 'tss_hint_hr' : 'tss_hint_estimated'
  return t(`strava.${key}`)
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
          <span
            v-if="a.tss != null"
            class="tss-badge flex-shrink-0"
            :class="`tss-badge--${a.tss_source || 'estimated'}`"
            :title="tssHint(a.tss_source)"
          >
            <span class="tss-value">{{ Math.round(a.tss) }}</span>
            <span class="tss-unit">{{ t('strava.tss_label') }}</span>
          </span>
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
