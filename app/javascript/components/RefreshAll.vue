<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { t } from '../i18n'
import { STRAVA_REFRESHED_EVENT } from '../stravaRefresh'
import { csrfToken } from '../csrf'

// Deux boutons de la page d'accueil, issus de la scission de « Tout rafraîchir » :
//   • « Rafraîchir les activités » → POST /strava/refresh (résumés + vélos +
//     téléchargement des streams / matériel / photos en tâche de fond)
//   • « Recalculer stats & seuils » → POST /strava/recompute (FTP, records &
//     volumes, charge — recalcul à partir des données déjà téléchargées)
// Chacun notifie ensuite les widgets d'accueil — îlots Vue séparés, sans état
// partagé — via un événement `window` pour qu'ils rechargent leurs données.

type DeviceBackfill = { status: string; total: number; done: number; pending: number }

const activitiesSyncing = ref(false)
const statsSyncing = ref(false)
const msg = ref<string | null>(null)
// Tonalité du message : succès (données à jour / nouveautés), info (backfill du
// matériel d'enregistrement encore en cours en arrière-plan) ou erreur.
const tone = ref<'success' | 'info' | 'error'>('success')
let msgTimer: ReturnType<typeof setTimeout> | null = null

function showMessage(text: string, nextTone: 'success' | 'info' | 'error') {
  tone.value = nextTone
  msg.value = text
  if (msgTimer) clearTimeout(msgTimer)
  // Le message « en cours » (backfill du matériel) reste un peu plus longtemps.
  msgTimer = setTimeout(() => { msg.value = null }, nextTone === 'info' ? 12000 : 6000)
}

async function refreshActivities() {
  if (activitiesSyncing.value) return
  activitiesSyncing.value = true
  msg.value = null
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
      showMessage(t('strava.refresh_all_device', { done: device.done, total: device.total }), 'info')
    } else {
      showMessage(created > 0 ? t('strava.refresh_all_new', { count: created }) : t('strava.refresh_all_synced'), 'success')
    }
  } catch {
    showMessage(t('strava.refresh_all_error'), 'error')
  } finally {
    activitiesSyncing.value = false
  }
}

async function recomputeStats() {
  if (statsSyncing.value) return
  statsSyncing.value = true
  msg.value = null
  try {
    const res = await fetch('/strava/recompute', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = (await res.json()) as { recomputed?: number }
    const changed = payload.recomputed ?? 0
    window.dispatchEvent(new CustomEvent(STRAVA_REFRESHED_EVENT, { detail: payload }))
    showMessage(
      changed > 0 ? t('strava.refresh_stats_changed', { count: changed }) : t('strava.refresh_stats_unchanged'),
      'success',
    )
  } catch {
    showMessage(t('strava.refresh_stats_error'), 'error')
  } finally {
    statsSyncing.value = false
  }
}

onUnmounted(() => { if (msgTimer) clearTimeout(msgTimer) })
</script>

<template>
  <div class="d-flex align-items-center justify-content-center gap-2 flex-wrap">
    <button
      type="button"
      class="btn btn-outline-warning d-flex align-items-center gap-2"
      :disabled="activitiesSyncing"
      @click="refreshActivities"
    >
      <span v-if="activitiesSyncing" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      <i v-else class="fa-solid fa-rotate" aria-hidden="true"></i>
      <span>{{ activitiesSyncing ? t('strava.refresh_all_syncing') : t('strava.refresh_activities_button') }}</span>
    </button>
    <button
      type="button"
      class="btn btn-outline-warning d-flex align-items-center gap-2"
      :disabled="statsSyncing"
      :title="t('strava.refresh_stats_help')"
      @click="recomputeStats"
    >
      <span v-if="statsSyncing" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      <i v-else class="fa-solid fa-calculator" aria-hidden="true"></i>
      <span>{{ statsSyncing ? t('strava.refresh_stats_syncing') : t('strava.refresh_stats_button') }}</span>
    </button>
    <small
      v-if="msg"
      class="d-flex align-items-center gap-1 w-100 justify-content-center"
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
