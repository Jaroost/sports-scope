<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'
import FriendsFeedRow, { type FeedItem } from './FriendsFeedRow.vue'

// Fil d'activité des amis, un seul composant pour l'accueil et la page Amis.
// - `compact` (accueil) : sorties seulement, 8 lignes, titre vers la page Amis, et le
//   bloc disparaît tant qu'il n'y a rien à montrer.
// - sinon (page Amis) : sorties et itinéraires partagés, tout le fil. La page possède déjà
//   les données (elle les recharge après chaque action) et les passe via `items` ;
//   sans `items`, le composant les charge lui-même.
const props = withDefaults(defineProps<{
  compact?: boolean
  items?: FeedItem[]
  loading?: boolean
}>(), { compact: false, items: undefined, loading: false })

const MAX_COMPACT = 8
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const fetched = ref<FeedItem[]>([])
const sportFilter = ref('')
const friendFilter = ref('')
const showFilters = ref(false)

const all = computed(() => {
  const list = props.items ?? fetched.value
  return props.compact ? list.filter((i) => i.kind === 'activity') : list
})

// Choix proposés = ce que le fil contient, pas un catalogue : jamais d'option vide.
const sportOptions = computed(() =>
  [...new Set(all.value.map((i) => i.type).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b)),
)
const friendOptions = computed(() => {
  const byId = new Map<number, string>()
  all.value.forEach((i) => byId.set(i.friend_id, i.friend_name))
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
})

// Un itinéraire n'a pas de sport : un filtre de sport l'écarte.
const shown = computed(() => {
  const list = all.value.filter((i) =>
    (!sportFilter.value || i.type === sportFilter.value) &&
    (!friendFilter.value || String(i.friend_id) === friendFilter.value),
  )
  return props.compact ? list.slice(0, MAX_COMPACT) : list
})

const visible = computed(() => !props.compact || all.value.length > 0)
const activeFilterCount = computed(() => (sportFilter.value ? 1 : 0) + (friendFilter.value ? 1 : 0))
function clearFilters() {
  sportFilter.value = ''
  friendFilter.value = ''
}
const hasFilters = computed(() => sportOptions.value.length > 1 || friendOptions.value.length > 1)

onMounted(async () => {
  if (props.items) return
  try {
    const res = await fetch('/api/friends/feed', { headers: { Accept: 'application/json' } })
    if (res.ok) fetched.value = (await res.json()).items
  } catch { /* widget facultatif */ }
})
</script>

<template>
  <div v-if="visible" class="card border-0 shadow-sm text-start">
    <div class="card-header activity-card-header d-flex align-items-center flex-wrap gap-2">
      <h2 class="h5 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-user-group text-warning" aria-hidden="true"></i>
        <a v-if="compact" :href="`${localePrefix}/friends`" class="text-reset text-decoration-none">{{ t('friends.home_feed') }}</a>
        <span v-else>{{ t('friends.home_feed') }}</span>
      </h2>
      <div v-if="hasFilters" class="ms-auto btn-group btn-group-sm">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
          :class="{ active: showFilters }"
          :aria-expanded="showFilters"
          @click="showFilters = !showFilters"
        >
          <i class="fa-solid fa-filter" aria-hidden="true"></i>
          <span>{{ t('friends.filter_toggle') }}</span>
          <span v-if="activeFilterCount" class="badge rounded-pill text-bg-warning">{{ activeFilterCount }}</span>
        </button>
        <button
          v-if="activeFilterCount"
          type="button"
          class="btn btn-sm btn-danger d-flex align-items-center"
          :title="t('friends.filter_reset')"
          :aria-label="t('friends.filter_reset')"
          @click="clearFilters"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <div v-if="hasFilters && showFilters" class="w-100 d-flex flex-wrap gap-2">
        <select v-if="sportOptions.length > 1" v-model="sportFilter" class="form-select form-select-sm w-auto" :aria-label="t('friends.filter_sport')">
          <option value="">{{ t('friends.filter_all_sports') }}</option>
          <option v-for="s in sportOptions" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-if="friendOptions.length > 1" v-model="friendFilter" class="form-select form-select-sm w-auto" :aria-label="t('friends.filter_friend')">
          <option value="">{{ t('friends.filter_all_friends') }}</option>
          <option v-for="f in friendOptions" :key="f.id" :value="String(f.id)">{{ f.name }}</option>
        </select>
      </div>
    </div>
    <div class="card-body">
      <p v-if="loading" class="text-muted mb-0">…</p>
      <p v-else-if="!all.length" class="text-muted mb-0">{{ t('friends.feed_empty') }}</p>
      <p v-else-if="!shown.length" class="text-muted mb-0">{{ t('friends.filter_none') }}</p>
      <ul v-else class="list-unstyled mb-0 d-flex flex-column gap-1">
        <li v-for="(item, i) in shown" :key="`${item.kind}-${item.source ?? ''}-${item.id}`">
          <FriendsFeedRow :item="item" :index="i" />
        </li>
      </ul>
    </div>
  </div>
</template>
