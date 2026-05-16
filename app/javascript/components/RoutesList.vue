<script setup>
import { ref, onMounted } from 'vue'
import { t } from '../i18n'

const routes = ref([])
const loading = ref(true)
const error = ref(null)
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

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
      <a :href="`${localePrefix}/routes/new`" class="btn btn-warning d-flex align-items-center gap-1">
        <i class="fa-solid fa-plus" aria-hidden="true"></i>
        <span>{{ t('routes.new') }}</span>
      </a>
    </div>

    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>Loading…</span>
    </div>
    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
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
        class="list-group-item d-flex justify-content-between align-items-center"
      >
        <a
          :href="`${localePrefix}/routes/${r.id}/edit`"
          class="flex-grow-1 text-decoration-none text-reset d-flex flex-column"
        >
          <strong>{{ r.name }}</strong>
          <small class="text-muted">
            <i class="fa-solid fa-route me-1" aria-hidden="true"></i>{{ formatKm(r.distance_m) }}
            <span v-if="r.elevation_gain_m != null" class="ms-2">
              <i class="fa-solid fa-arrow-trend-up text-success me-1" aria-hidden="true"></i>{{ Math.round(r.elevation_gain_m) }} m
            </span>
            <span class="ms-2 text-muted">· {{ formatDate(r.updated_at) }}</span>
          </small>
        </a>
        <i class="fa-solid fa-chevron-right text-muted" aria-hidden="true"></i>
      </li>
    </ul>
  </div>
</template>
