<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { formatDaysAgo } from '../timeAgo'
import { activityIcon } from '../activityHelpers'
import ActivityThumb from './ActivityThumb.vue'

// Une ligne du fil des amis : mêmes lignes que la liste personnelle (HelloStrava) —
// vignette tracé/photos ou pastille du sport, nom, sport, date, distance, durée — avec
// l'ami en plus. Ni TSS ni « nouvelles routes » : ils dépendent des seuils et de
// l'historique de l'ami. Sert à l'accueil (FriendsFeedWidget) et à la page Amis.
export interface FeedItem {
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
  share_token?: string
  preview_segments?: { d: string; c: number }[] | null
  photo_thumbs?: { id?: string; url: string; caption?: string }[] | null
}

const props = defineProps<{ item: FeedItem; index: number }>()

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const isRoute = computed(() => props.item.kind === 'route')
const href = computed(() =>
  isRoute.value
    ? `${localePrefix}/routes/${props.item.share_token}`
    : `${localePrefix}/friends/${props.item.friend_id}/activities/${props.item.source}/${props.item.id}`,
)
const icon = computed(() => (isRoute.value ? 'fa-route' : activityIcon(props.item.type)))
const label = computed(() => (isRoute.value ? t('friends.feed_route') : props.item.type ?? ''))
const hasThumb = computed(() => (props.item.preview_segments?.length ?? 0) > 0 || (props.item.photo_thumbs?.length ?? 0) > 0)
const day = computed(() => (props.item.date ? new Date(props.item.date).toLocaleDateString(lang || undefined) : ''))

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}
</script>

<template>
  <a
    :href="href"
    class="activity-row d-flex justify-content-between align-items-center text-decoration-none text-reset"
  >
    <div class="activity-row__main d-flex align-items-center gap-3">
      <ActivityThumb
        v-if="hasThumb"
        :preview-segments="item.preview_segments"
        :photos="item.photo_thumbs"
        :icon-class="icon"
        :label="label"
        :index="index"
      />
      <span v-else class="activity-type-badge">
        <i :class="`fa-solid ${icon}`" aria-hidden="true"></i>
      </span>
      <div class="min-width-0">
        <div class="fw-semibold">{{ item.name }}</div>
        <small class="text-muted">
          <i class="fa-solid fa-user-group me-1" aria-hidden="true"></i>{{ item.friend_name }}
          <span class="mx-1">·</span>
          <i class="fa-solid fa-tag me-1" aria-hidden="true"></i>{{ label }}
          <span class="mx-1">·</span>
          <i class="fa-regular fa-calendar me-1" aria-hidden="true"></i>{{ day }}
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
