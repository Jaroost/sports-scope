<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { t } from '../i18n'
import { STRAVA_REFRESHED_EVENT } from '../stravaRefresh'

// Bouton unique « Tout rafraîchir » de la page d'accueil. Déclenche le refresh
// unifié (résumés + vélos + téléchargement des streams en tâche de fond) puis
// notifie les widgets d'accueil — îlots Vue séparés, sans état partagé — via un
// événement `window` pour qu'ils rechargent leurs données.

type DeviceBackfill = { status: string; total: number; done: number; pending: number }

const syncing = ref(false)
const msg = ref<string | null>(null)
// Tonalité du message : succès (données à jour / nouveautés), info (backfill du
// matériel d'enregistrement encore en cours en arrière-plan) ou erreur.
const tone = ref<'success' | 'info' | 'error'>('success')
let msgTimer: ReturnType<typeof setTimeout> | null = null

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function refreshAll() {
  if (syncing.value) return
  syncing.value = true
  msg.value = null
  tone.value = 'success'
  try {
    const res = await fetch('/strava/refresh', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = (await res.json()) as { created?: number; device_backfill?: DeviceBackfill | null }
    const created = payload.created ?? 0
    window.dispatchEvent(new CustomEvent(STRAVA_REFRESHED_EVENT, { detail: payload }))
    // Le matériel d'enregistrement se récupère activité par activité (limité par le
    // rate limit Strava) : tant qu'il en reste, on le signale plutôt que d'annoncer
    // « données à jour », qui ne vaut que pour les résumés.
    const device = payload.device_backfill
    if (device && device.pending > 0) {
      tone.value = 'info'
      msg.value = t('strava.refresh_all_device', { done: device.done, total: device.total })
    } else {
      tone.value = 'success'
      msg.value = created > 0 ? t('strava.refresh_all_new', { count: created }) : t('strava.refresh_all_synced')
    }
  } catch {
    tone.value = 'error'
    msg.value = t('strava.refresh_all_error')
  } finally {
    syncing.value = false
    if (msgTimer) clearTimeout(msgTimer)
    // Le message « en cours » reste un peu plus longtemps : le backfill dure.
    msgTimer = setTimeout(() => { msg.value = null }, tone.value === 'info' ? 12000 : 6000)
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
    <small
      v-if="msg"
      class="d-flex align-items-center gap-1"
      :class="tone === 'error' ? 'text-danger' : tone === 'info' ? 'text-info' : 'text-success'"
    >
      <i
        :class="tone === 'error' ? 'fa-solid fa-triangle-exclamation' : tone === 'info' ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-circle-check'"
        aria-hidden="true"
      ></i>
      <span>{{ msg }}</span>
    </small>
  </div>
</template>
