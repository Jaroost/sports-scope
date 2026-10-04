<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
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
type StreamsRun = { status: string; total: number; done: number; pending: number }

// Les streams (puissance, FC, altitude…) se téléchargent en tâche de fond, activité par
// activité. Tant qu'ils manquent, une sortie est notée « au plus juste » (rouge/gris
// dans le calendrier) ; le TSS ne devient exact (vert) qu'une fois ses streams stockés.
// Les widgets ne rechargeant que sur l'événement, on suit donc le backfill et on
// ré-émet l'événement au fil de l'eau puis à la fin, sinon ils resteraient figés sur
// l'état d'avant le téléchargement.
const STREAMS_POLL_MS = 3000
const STREAMS_RATE_LIMITED_POLL_MS = 30000
const STREAMS_NOTIFY_EVERY_MS = 10000
let streamsTimer: ReturnType<typeof setTimeout> | null = null
let lastNotifiedPending: number | null = null
let lastNotifiedAt = 0

function isActiveStatus(status?: string) {
  return status === 'pending' || status === 'running' || status === 'rate_limited'
}

function notifyWidgets(detail: unknown) {
  window.dispatchEvent(new CustomEvent(STRAVA_REFRESHED_EVENT, { detail }))
}

function followStreams(run: StreamsRun | null | undefined) {
  if (streamsTimer) { clearTimeout(streamsTimer); streamsTimer = null }
  if (!run || !isActiveStatus(run.status)) return
  lastNotifiedPending = run.pending
  lastNotifiedAt = Date.now()
  streamsTimer = setTimeout(pollStreams, run.status === 'rate_limited' ? STREAMS_RATE_LIMITED_POLL_MS : STREAMS_POLL_MS)
}

async function pollStreams() {
  streamsTimer = null
  try {
    const res = await fetch('/strava/backfill', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) return
    const payload = (await res.json()) as { run: StreamsRun | null }
    const run = payload.run
    const active = !!run && isActiveStatus(run.status)
    const progressed = run != null && lastNotifiedPending != null && run.pending < lastNotifiedPending
    if (!active) {
      // Terminé : dernier rechargement, avec les TSS définitifs.
      notifyWidgets({ streams_done: true })
      msg.value = null
      return
    }
    if (progressed && Date.now() - lastNotifiedAt >= STREAMS_NOTIFY_EVERY_MS) {
      notifyWidgets({ streams_progress: true })
      lastNotifiedPending = run.pending
      lastNotifiedAt = Date.now()
    }
    if (run) showMessage(t('strava.refresh_all_streams', { done: run.total - run.pending, total: run.total }), 'info', true)
    streamsTimer = setTimeout(pollStreams, run.status === 'rate_limited' ? STREAMS_RATE_LIMITED_POLL_MS : STREAMS_POLL_MS)
  } catch {
    // Réseau coupé : on s'arrête, le prochain clic relancera le suivi.
  }
}

const activitiesSyncing = ref(false)
const statsSyncing = ref(false)
const msg = ref<string | null>(null)
// Tonalité du message : succès (données à jour / nouveautés), info (backfill du
// matériel d'enregistrement encore en cours en arrière-plan) ou erreur.
const tone = ref<'success' | 'info' | 'error'>('success')
let msgTimer: ReturnType<typeof setTimeout> | null = null

function showMessage(text: string, nextTone: 'success' | 'info' | 'error', sticky = false) {
  tone.value = nextTone
  msg.value = text
  if (msgTimer) clearTimeout(msgTimer)
  // Message de progression : remplacé / effacé par le suivi du téléchargement.
  if (sticky) return
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
    const payload = (await res.json()) as { created?: number; device_backfill?: DeviceBackfill | null; run?: StreamsRun | null }
    const created = payload.created ?? 0
    notifyWidgets(payload)
    followStreams(payload.run)
    // Le matériel d'enregistrement se récupère activité par activité (limité par le
    // rate limit Strava) : tant qu'il en reste, on le signale plutôt que d'annoncer
    // « données à jour », qui ne vaut que pour les résumés.
    const device = payload.device_backfill
    const streams = payload.run
    if (streams && isActiveStatus(streams.status)) {
      showMessage(t('strava.refresh_all_streams', { done: streams.total - streams.pending, total: streams.total }), 'info', true)
    } else if (device && device.pending > 0) {
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
    notifyWidgets(payload)
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

// Un téléchargement déjà en cours (page rechargée, autre onglet) : on le reprend.
onMounted(async () => {
  try {
    const res = await fetch('/strava/backfill', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) return
    const run = ((await res.json()) as { run: StreamsRun | null }).run
    if (run && isActiveStatus(run.status)) {
      showMessage(t('strava.refresh_all_streams', { done: run.total - run.pending, total: run.total }), 'info', true)
      followStreams(run)
    }
  } catch {
    // Pas de suivi : sans conséquence, le bouton reste utilisable.
  }
})

onUnmounted(() => {
  if (msgTimer) clearTimeout(msgTimer)
  if (streamsTimer) clearTimeout(streamsTimer)
})
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
    <div class="refresh-help text-muted small w-100 d-flex flex-column flex-md-row justify-content-center gap-1 gap-md-4">
      <span><strong>{{ t('strava.refresh_activities_button') }}</strong> : {{ t('strava.refresh_activities_help') }}</span>
      <span><strong>{{ t('strava.refresh_stats_button') }}</strong> : {{ t('strava.refresh_stats_help') }}</span>
    </div>
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
