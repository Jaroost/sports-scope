<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { t } from '../i18n'
import { STRAVA_REFRESHED_EVENT } from '../stravaRefresh'

// Bouton unique « Tout rafraîchir » de la page d'accueil. Déclenche le refresh
// unifié (résumés + vélos + téléchargement des streams en tâche de fond) puis
// notifie les widgets d'accueil — îlots Vue séparés, sans état partagé — via un
// événement `window` pour qu'ils rechargent leurs données.

const syncing = ref(false)
const msg = ref<string | null>(null)
const isError = ref(false)
let msgTimer: ReturnType<typeof setTimeout> | null = null

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function refreshAll() {
  if (syncing.value) return
  syncing.value = true
  msg.value = null
  isError.value = false
  try {
    const res = await fetch('/strava/refresh', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = (await res.json()) as { created?: number }
    const created = payload.created ?? 0
    window.dispatchEvent(new CustomEvent(STRAVA_REFRESHED_EVENT, { detail: payload }))
    isError.value = false
    msg.value = created > 0 ? t('strava.refresh_all_new', { count: created }) : t('strava.refresh_all_synced')
  } catch {
    isError.value = true
    msg.value = t('strava.refresh_all_error')
  } finally {
    syncing.value = false
    if (msgTimer) clearTimeout(msgTimer)
    msgTimer = setTimeout(() => { msg.value = null }, 6000)
  }
}

onUnmounted(() => { if (msgTimer) clearTimeout(msgTimer) })
</script>

<template>
  <div class="d-flex align-items-center justify-content-center gap-2 flex-wrap">
    <button
      type="button"
      class="btn btn-outline-warning d-flex align-items-center gap-2"
      :disabled="syncing"
      @click="refreshAll"
    >
      <span v-if="syncing" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      <i v-else class="fa-solid fa-rotate" aria-hidden="true"></i>
      <span>{{ syncing ? t('strava.refresh_all_syncing') : t('strava.refresh_all_button') }}</span>
    </button>
    <small v-if="msg" class="d-flex align-items-center gap-1" :class="isError ? 'text-danger' : 'text-success'">
      <i :class="isError ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-check'" aria-hidden="true"></i>
      <span>{{ msg }}</span>
    </small>
  </div>
</template>
