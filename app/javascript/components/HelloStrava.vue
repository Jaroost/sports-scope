<script setup>
import { ref, onMounted, computed } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  endpoint: { type: String, default: '/strava/activities' },
})

const loading = ref(true)
const refreshing = ref(false)
const error = ref(null)
const activities = ref([])
const cachedAt = ref(null)

const title = computed(() => t('strava.recent_activities'))
const emptyText = computed(() => t('strava.no_activities'))
const refreshLabel = computed(() => (refreshing.value ? t('strava.refreshing') : t('strava.refresh')))

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

async function fetchActivities({ refresh = false } = {}) {
  if (refresh) refreshing.value = true
  try {
    const url = refresh ? `${props.endpoint}?refresh=1` : props.endpoint
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    activities.value = payload.activities || []
    cachedAt.value = payload.cached_at || null
    error.value = null
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

onMounted(() => fetchActivities())

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(2)} km`
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}

function formatCachedAt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="card">
    <div class="card-header bg-warning-subtle d-flex justify-content-between align-items-center">
      <h2 class="h5 mb-0">{{ title }}</h2>
      <div class="d-flex align-items-center gap-2">
        <small v-if="cachedAt" class="text-muted">
          {{ t('strava.last_updated') }} {{ formatCachedAt(cachedAt) }}
        </small>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="loading || refreshing"
          @click="fetchActivities({ refresh: true })"
        >
          <span v-if="refreshing" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
          {{ refreshLabel }}
        </button>
      </div>
    </div>
    <div class="card-body">
      <div v-if="loading" class="text-muted">Loading…</div>
      <div v-else-if="error" class="alert alert-danger mb-0">
        {{ error }}
      </div>
      <div v-else-if="activities.length === 0" class="text-muted">
        {{ emptyText }}
      </div>
      <ul v-else class="list-group list-group-flush">
        <li
          v-for="activity in activities"
          :key="activity.id"
          class="list-group-item px-0"
        >
          <a
            :href="`${localePrefix}/activities/${activity.id}`"
            class="d-flex justify-content-between align-items-start text-decoration-none text-reset"
          >
            <div>
              <div class="fw-semibold">{{ activity.name }}</div>
              <small class="text-muted">
                {{ activity.type }} · {{ new Date(activity.start_date_local).toLocaleDateString() }}
              </small>
            </div>
            <div class="text-end">
              <div>{{ formatDistance(activity.distance) }}</div>
              <small class="text-muted">{{ formatDuration(activity.moving_time) }}</small>
            </div>
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
