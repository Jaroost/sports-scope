<script setup>
import { ref, onMounted, computed } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'

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

function activityIcon(type) {
  const t = (type || '').toLowerCase()
  if (t.includes('run')) return 'fa-person-running'
  if (t.includes('ride') || t.includes('cycl') || t.includes('bike') || t.includes('velo')) return 'fa-person-biking'
  if (t.includes('swim')) return 'fa-person-swimming'
  if (t.includes('walk') || t.includes('hike')) return 'fa-person-hiking'
  if (t.includes('ski')) return 'fa-person-skiing'
  if (t.includes('row')) return 'fa-water'
  if (t.includes('yoga')) return 'fa-spa'
  if (t.includes('workout') || t.includes('weight')) return 'fa-dumbbell'
  return 'fa-bolt'
}
</script>

<template>
  <div class="card shadow-sm border-0">
    <div class="card-header activity-card-header d-flex justify-content-between align-items-center">
      <h2 class="h5 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
        <span>{{ title }}</span>
      </h2>
      <div class="d-flex align-items-center gap-2">
        <small v-if="cachedAt" class="text-muted d-flex align-items-center gap-1">
          <i class="fa-regular fa-clock" aria-hidden="true"></i>
          {{ t('strava.last_updated') }} {{ formatCachedAt(cachedAt) }}
        </small>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          :disabled="loading || refreshing"
          @click="fetchActivities({ refresh: true })"
        >
          <span v-if="refreshing" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          <i v-else class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>
          <span>{{ refreshLabel }}</span>
        </button>
      </div>
    </div>
    <div class="card-body">
      <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
        <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
        <span>Loading…</span>
      </div>
      <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>{{ error }}</span>
      </div>
      <div v-else-if="activities.length === 0" class="text-muted d-flex align-items-center gap-2">
        <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
        <span>{{ emptyText }}</span>
      </div>
      <ul v-else class="list-unstyled mb-0 d-flex flex-column gap-1">
        <li
          v-for="activity in activities"
          :key="activity.id"
        >
          <a
            :href="`${localePrefix}/activities/${activity.id}`"
            class="activity-row d-flex justify-content-between align-items-center text-decoration-none text-reset"
          >
            <div class="d-flex align-items-center gap-3">
              <span class="activity-type-badge">
                <i :class="`fa-solid ${activityIcon(activity.type)}`" aria-hidden="true"></i>
              </span>
              <div>
                <div class="fw-semibold">{{ activity.name }}</div>
                <small class="text-muted">
                  <i class="fa-solid fa-tag me-1" aria-hidden="true"></i>{{ activity.type }}
                  <span class="mx-1">·</span>
                  <i class="fa-regular fa-calendar me-1" aria-hidden="true"></i>{{ new Date(activity.start_date_local).toLocaleDateString() }}
                  <span v-if="formatDaysAgo(activity.start_date_local)" class="days-ago-badge ms-1">{{ formatDaysAgo(activity.start_date_local) }}</span>
                </small>
              </div>
            </div>
            <div class="text-end">
              <div class="fw-semibold">
                <i class="fa-solid fa-route me-1 text-warning" aria-hidden="true"></i>{{ formatDistance(activity.distance) }}
              </div>
              <small class="text-muted">
                <i class="fa-regular fa-clock me-1" aria-hidden="true"></i>{{ formatDuration(activity.moving_time) }}
              </small>
            </div>
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
