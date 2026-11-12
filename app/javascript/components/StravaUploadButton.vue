<script setup lang="ts">
// Envoi d'une activité importée (.fit) vers Strava. Le serveur reconstruit un TCX
// depuis les streams et le poste en tâche de fond ; on relit la fiche tant que
// l'état est « pending ».
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'

const props = defineProps<{
  activityId: string | number
  status: string | null
  stravaActivityId: number | string | null
  uploadError: string | null
  canUpload: boolean
  stravaLinked: boolean
}>()
const emit = defineEmits<{ (e: 'refresh'): void }>()

const busy = ref(false)
const localError = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

const pending = computed(() => busy.value || props.status === 'pending')
const done = computed(() => props.status === 'done' || props.status === 'duplicate')
const stravaUrl = computed(() => props.stravaActivityId
  ? `https://www.strava.com/activities/${props.stravaActivityId}` : null)

async function upload() {
  busy.value = true
  localError.value = null
  try {
    const res = await fetch(`/api/imported_activities/${props.activityId}/strava_upload`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      localError.value = body.error === 'no_track_data' ? t('strava.upload_no_track') : t('strava.upload_error')
      return
    }
    emit('refresh')
  } catch {
    localError.value = t('strava.upload_error')
  } finally {
    busy.value = false
  }
}

// Tant que Strava traite le fichier, on relit la fiche toutes les 5 s.
function schedule() {
  if (timer) clearTimeout(timer)
  timer = null
  if (props.status === 'pending') timer = setTimeout(() => emit('refresh'), 5000)
}
watch(() => props.status, schedule, { immediate: true })
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <div class="d-flex align-items-center flex-wrap gap-2 mt-3 small">
    <template v-if="done">
      <span class="text-success">
        <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
        {{ props.status === 'duplicate' ? t('strava.upload_duplicate') : t('strava.upload_done') }}
      </span>
      <a v-if="stravaUrl" :href="stravaUrl" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary">
        {{ t('strava.upload_open') }}
      </a>
    </template>
    <span v-else-if="pending" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      {{ t('strava.upload_pending') }}
    </span>
    <span v-else-if="!stravaLinked" class="text-muted">{{ t('strava.upload_not_linked') }}</span>
    <span v-else-if="!canUpload" class="text-muted">{{ t('strava.upload_scope_missing') }}</span>
    <template v-else>
      <button type="button" class="btn btn-sm btn-outline-warning" @click="upload">
        <i class="fa-brands fa-strava" aria-hidden="true"></i>
        {{ props.status === 'error' ? t('strava.upload_retry') : t('strava.upload_to_strava') }}
      </button>
      <span v-if="props.status === 'error' || localError" class="text-danger">
        {{ localError || t('strava.upload_error') }}<template v-if="props.uploadError && !localError"> ({{ props.uploadError }})</template>
      </span>
    </template>
  </div>
</template>
