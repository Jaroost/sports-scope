<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'
import { activityIcon } from '../activityHelpers'
import ActivityThumb from './ActivityThumb.vue'

interface FeedItem {
  kind: 'activity' | 'route'
  source?: 'strava' | 'imported'
  id: number
  friend_id: number
  friend_name: string
  name: string
  type?: string | null
  date: string | null
  distance_m: number | null
  moving_time_s?: number | null
  elevation_gain_m: number | null
  preview_segments?: { d: string; c: number }[] | null
  photo_thumbs?: { id?: string; url: string; caption?: string }[] | null
}

const MAX_ITEMS = 8
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const items = ref<FeedItem[]>([])

// Seulement les sorties (pas les itinéraires partagés) ; sans rien à montrer, le widget disparaît.
const activities = computed(() => items.value.filter((i) => i.kind === 'activity').slice(0, MAX_ITEMS))

const href = (i: FeedItem) => `${localePrefix}/friends/${i.friend_id}/activities/${i.source}/${i.id}`
const hasThumb = (i: FeedItem) => (i.preview_segments?.length ?? 0) > 0 || (i.photo_thumbs?.length ?? 0) > 0

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}

onMounted(async () => {
  try {
    const res = await fetch('/api/friends/feed', { headers: { Accept: 'application/json' } })
    if (res.ok) items.value = (await res.json()).items
  } catch { /* widget facultatif */ }
})
</script>

<template>
  <section v-if="activities.length" class="text-start">
    <h2 class="h5">
      <a :href="`${localePrefix}/friends`" class="text-decoration-none">{{ t('friends.home_feed') }}</a>
    </h2>
    <!-- Mêmes lignes que la liste personnelle (HelloStrava) : vignette tracé/photos ou
         pastille du sport, nom, sport, date, distance, durée. L'ami s'ajoute en plus.
         Ni TSS ni « nouvelles routes » : ils dépendent des seuils et de l'historique de l'ami. -->
    <ul class="list-unstyled mb-0 d-flex flex-column gap-1">
      <li v-for="(item, rowIndex) in activities" :key="`${item.source}-${item.id}`">
        <a
          :href="href(item)"
          class="activity-row d-flex justify-content-between align-items-center text-decoration-none text-reset"
        >
          <div class="activity-row__main d-flex align-items-center gap-3">
            <ActivityThumb
              v-if="hasThumb(item)"
              :preview-segments="item.preview_segments"
              :photos="item.photo_thumbs"
              :icon-class="activityIcon(item.type)"
              :label="item.type ?? ''"
              :index="rowIndex"
            />
            <span v-else class="activity-type-badge">
              <i :class="`fa-solid ${activityIcon(item.type)}`" aria-hidden="true"></i>
            </span>
            <div class="min-width-0">
              <div class="fw-semibold">{{ item.name }}</div>
              <small class="text-muted">
                <i class="fa-solid fa-user-group me-1" aria-hidden="true"></i>{{ item.friend_name }}
                <span class="mx-1">·</span>
                <i class="fa-solid fa-tag me-1" aria-hidden="true"></i>{{ item.type }}
                <span class="mx-1">·</span>
                <i class="fa-regular fa-calendar me-1" aria-hidden="true"></i>{{ item.date ? new Date(item.date).toLocaleDateString(lang || undefined) : '' }}
                <span v-if="item.date && formatDaysAgo(item.date)" class="days-ago-badge ms-1">{{ formatDaysAgo(item.date) }}</span>
              </small>
            </div>
          </div>
          <div class="activity-row__stats d-flex align-items-center gap-3">
            <div class="text-start activity-metrics">
              <div v-if="item.distance_m" class="fw-semibold">
                <i class="fa-solid fa-route me-1 text-warning" aria-hidden="true"></i>{{ formatDistance(item.distance_m) }}
              </div>
              <small v-if="item.moving_time_s != null" class="text-muted">
                <i class="fa-regular fa-clock me-1" aria-hidden="true"></i>{{ formatDuration(item.moving_time_s) }}
              </small>
              <small v-if="item.elevation_gain_m" class="text-muted">
                <i class="fa-solid fa-mountain me-1" aria-hidden="true"></i>{{ Math.round(item.elevation_gain_m) }} m
              </small>
            </div>
          </div>
        </a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.activity-metrics {
  min-width: 6.5rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  flex-shrink: 0;
}

.min-width-0 {
  min-width: 0;
}

@media (max-width: 575.98px) {
  .activity-row {
    flex-wrap: wrap;
    row-gap: 0.5rem;
  }
  .activity-row__main {
    width: 100%;
  }
  .activity-row__stats {
    width: 100%;
    justify-content: flex-start;
  }
  .activity-row__stats .activity-metrics {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
    min-width: 0;
  }
}
</style>
