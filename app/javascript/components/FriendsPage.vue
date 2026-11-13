<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'

interface Friend { id: number; user_id: number; display_name: string; since?: string | null }
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
  share_token?: string
}

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const friends = ref<Friend[]>([])
const incoming = ref<Friend[]>([])
const outgoing = ref<Friend[]>([])
const inviteUrl = ref('')
const feed = ref<FeedItem[]>([])
const email = ref('')
const loading = ref(true)
const error = ref('')
const requestSent = ref(false)
const copied = ref(false)

const headers = () => ({ 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() })

async function load(): Promise<void> {
  try {
    const [list, feedRes] = await Promise.all([
      fetch('/api/friends', { headers: { Accept: 'application/json' } }),
      fetch('/api/friends/feed', { headers: { Accept: 'application/json' } }),
    ])
    if (!list.ok || !feedRes.ok) throw new Error('http')
    const data = await list.json()
    friends.value = data.friends
    incoming.value = data.incoming
    outgoing.value = data.outgoing
    inviteUrl.value = data.invite_url
    feed.value = (await feedRes.json()).items
    error.value = ''
  } catch {
    error.value = t('friends.error')
  } finally {
    loading.value = false
  }
}

async function send(): Promise<void> {
  if (!email.value.trim()) return
  const res = await fetch('/api/friends', { method: 'POST', headers: headers(), body: JSON.stringify({ email: email.value }) })
  if (!res.ok) { error.value = t('friends.error'); return }
  email.value = ''
  requestSent.value = true
  await load()
}

async function accept(f: Friend): Promise<void> {
  await fetch(`/api/friends/${f.id}`, { method: 'PATCH', headers: headers() })
  await load()
}

async function remove(f: Friend, confirmFirst = false): Promise<void> {
  if (confirmFirst && !window.confirm(t('friends.remove_confirm'))) return
  await fetch(`/api/friends/${f.id}`, { method: 'DELETE', headers: headers() })
  await load()
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch { /* presse-papiers indisponible : le lien reste sélectionnable */ }
}

function href(item: FeedItem): string {
  if (item.kind === 'route') return `${localePrefix}/routes/${item.share_token}`
  return `${localePrefix}/friends/${item.friend_id}/activities/${item.source}/${item.id}`
}

function km(m: number | null): string {
  return m == null ? '' : `${(m / 1000).toFixed(1)} km`
}

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(lang || undefined) : ''
}

onMounted(load)
</script>

<template>
  <div class="container py-3">
    <h1 class="h3 mb-3">{{ t('friends.title') }}</h1>
    <div v-if="error" class="alert alert-danger">{{ error }}</div>

    <div class="row g-4">
      <div class="col-lg-5">
        <section class="mb-4">
          <h2 class="h5">{{ t('friends.add_title') }}</h2>
          <form class="input-group mb-2" @submit.prevent="send">
            <input v-model="email" type="email" class="form-control" :placeholder="t('friends.email_placeholder')" />
            <button class="btn btn-primary" type="submit">{{ t('friends.send_request') }}</button>
          </form>
          <p v-if="requestSent" class="small text-muted">{{ t('friends.request_sent_hint') }}</p>
          <label class="form-label small fw-semibold mb-1" for="invite-link">{{ t('friends.invite_link') }}</label>
          <div class="input-group input-group-sm">
            <input id="invite-link" class="form-control" :value="inviteUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
            <button class="btn btn-outline-secondary" type="button" @click="copyLink">
              {{ copied ? t('friends.copied') : t('friends.copy_link') }}
            </button>
          </div>
          <p class="small text-muted mt-1">{{ t('friends.invite_link_hint') }}</p>
        </section>

        <section v-if="incoming.length" class="mb-4">
          <h2 class="h5">{{ t('friends.incoming') }}</h2>
          <ul class="list-group">
            <li v-for="f in incoming" :key="f.id" class="list-group-item d-flex align-items-center justify-content-between">
              <span>{{ f.display_name }}</span>
              <span class="btn-group btn-group-sm">
                <button class="btn btn-success" @click="accept(f)">{{ t('friends.accept') }}</button>
                <button class="btn btn-outline-secondary" @click="remove(f)">{{ t('friends.decline') }}</button>
              </span>
            </li>
          </ul>
        </section>

        <section v-if="outgoing.length" class="mb-4">
          <h2 class="h5">{{ t('friends.outgoing') }}</h2>
          <ul class="list-group">
            <li v-for="f in outgoing" :key="f.id" class="list-group-item d-flex align-items-center justify-content-between">
              <span>{{ f.display_name }}</span>
              <button class="btn btn-sm btn-outline-secondary" @click="remove(f)">{{ t('friends.cancel') }}</button>
            </li>
          </ul>
        </section>

        <section>
          <h2 class="h5">{{ t('friends.my_friends') }}</h2>
          <p v-if="!loading && !friends.length" class="text-muted">{{ t('friends.no_friends') }}</p>
          <ul v-else class="list-group">
            <li v-for="f in friends" :key="f.id" class="list-group-item d-flex align-items-center justify-content-between">
              <span>{{ f.display_name }}</span>
              <button class="btn btn-sm btn-outline-danger" @click="remove(f, true)">{{ t('friends.remove') }}</button>
            </li>
          </ul>
        </section>
      </div>

      <div class="col-lg-7">
        <h2 class="h5">{{ t('friends.feed') }}</h2>
        <p v-if="!loading && !feed.length" class="text-muted">{{ t('friends.feed_empty') }}</p>
        <ul v-else class="list-group">
          <li v-for="item in feed" :key="`${item.kind}-${item.source ?? ''}-${item.id}`" class="list-group-item">
            <a :href="href(item)" class="text-decoration-none">
              <div class="fw-semibold">{{ item.name }}</div>
              <div class="small text-muted">
                {{ item.friend_name }}
                <template v-if="item.kind === 'route'"> · {{ t('friends.feed_route') }}</template>
                · {{ day(item.date) }} · {{ km(item.distance_m) }}
                <template v-if="item.elevation_gain_m != null"> · {{ Math.round(item.elevation_gain_m) }} m ↑</template>
              </div>
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
