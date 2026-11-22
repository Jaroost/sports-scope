<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'
import FriendsFeedRow, { type FeedItem } from './FriendsFeedRow.vue'

const MAX_ITEMS = 8
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const items = ref<FeedItem[]>([])

// Seulement les sorties (pas les itinéraires partagés) ; sans rien à montrer, le widget disparaît.
const activities = computed(() => items.value.filter((i) => i.kind === 'activity').slice(0, MAX_ITEMS))

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
    <ul class="list-unstyled mb-0 d-flex flex-column gap-1">
      <li v-for="(item, rowIndex) in activities" :key="`${item.source}-${item.id}`">
        <FriendsFeedRow :item="item" :index="rowIndex" />
      </li>
    </ul>
  </section>
</template>
