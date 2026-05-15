<script setup>
import { ref, onMounted, computed } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  endpoint: { type: String, default: '/strava/activities' },
})

const loading = ref(true)
const error = ref(null)
const activities = ref([])

const title = computed(() => t('strava.recent_activities'))
const emptyText = computed(() => t('strava.no_activities'))

onMounted(async () => {
  try {
    const res = await fetch(props.endpoint, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    activities.value = await res.json()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(2)} km`
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}
</script>

<template>
  <div class="card">
    <div class="card-header bg-warning-subtle">
      <h2 class="h5 mb-0">{{ title }}</h2>
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
          class="list-group-item d-flex justify-content-between align-items-start px-0"
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
        </li>
      </ul>
    </div>
  </div>
</template>
