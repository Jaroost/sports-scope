<script setup lang="ts">
// Bouton « carte hors-ligne » du panneau de navigation. Autonome : il pilote lui-même
// le téléchargement du corridor (fond swisstopo gris) en archive PMTiles dans l'OPFS,
// et prévient le parent quand une archive devient disponible/supprimée pour qu'il bascule
// le fond de carte vers la version locale en cas de perte réseau.
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'
import {
  offlineSupported, hasOfflineArchive, deleteOfflineArchive,
  downloadOfflineArchive, estimateOffline, type DownloadProgress,
} from '../offline/offlineMaps'

const props = defineProps<{ shareToken: string; coords: [number, number][] }>()
const emit = defineEmits<{ (e: 'available'): void; (e: 'removed'): void }>()

const supported = offlineSupported()
const open = ref(false)
const ready = ref(false)          // une archive existe déjà pour ce trajet
const downloading = ref(false)
const progress = ref<DownloadProgress>({ done: 0, total: 0, failed: 0 })
const errored = ref(false)
let abort: AbortController | null = null

const est = computed(() => estimateOffline(props.coords))
const pct = computed(() => (progress.value.total ? Math.round((progress.value.done / progress.value.total) * 100) : 0))

onMounted(async () => {
  if (supported) ready.value = await hasOfflineArchive(props.shareToken)
})

async function start() {
  if (downloading.value) return
  errored.value = false
  downloading.value = true
  progress.value = { done: 0, total: 0, failed: 0 }
  abort = new AbortController()
  try {
    await downloadOfflineArchive(
      props.shareToken, props.coords, undefined,
      (p) => { progress.value = p }, abort.signal,
    )
    ready.value = true
    emit('available')
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) errored.value = true
  } finally {
    downloading.value = false
    abort = null
  }
}

function cancel() { abort?.abort() }

async function remove() {
  await deleteOfflineArchive(props.shareToken)
  ready.value = false
  emit('removed')
}
</script>

<template>
  <div v-if="supported" class="position-relative">
    <button
      type="button"
      class="btn btn-sm btn-light shadow-sm"
      :class="{ active: open || ready, 'text-success': ready && !downloading }"
      :title="t('routes.offline_title')"
      :aria-label="t('routes.offline_title')"
      @click="open = !open"
    >
      <i
        class="fa-solid"
        :class="downloading ? 'fa-spinner fa-spin' : ready ? 'fa-circle-check' : 'fa-cloud-arrow-down'"
        aria-hidden="true"
      ></i>
    </button>

    <div v-if="open" class="nav-cam-panel shadow">
      <div class="nav-cam-label mb-2">{{ t('routes.offline_title') }}</div>

      <template v-if="downloading">
        <div class="nav-offline-progress">
          <div class="nav-offline-bar"><div class="nav-offline-bar-fill" :style="{ width: pct + '%' }"></div></div>
          <span class="nav-cam-val">{{ pct }}%</span>
        </div>
        <button type="button" class="nav-cam-savezoom" @click="cancel">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i> {{ t('routes.offline_cancel') }}
        </button>
      </template>

      <template v-else-if="ready">
        <div class="nav-cam-label text-success mb-2">
          <i class="fa-solid fa-circle-check me-1" aria-hidden="true"></i>{{ t('routes.offline_ready') }}
        </div>
        <button type="button" class="nav-cam-savezoom" @click="remove">
          <i class="fa-solid fa-trash" aria-hidden="true"></i> {{ t('routes.offline_delete') }}
        </button>
      </template>

      <template v-else>
        <div class="nav-cam-label mb-2">{{ t('routes.offline_estimate', { mb: est.mb.toFixed(0), tiles: est.tiles }) }}</div>
        <button type="button" class="nav-cam-savezoom" @click="start">
          <i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i> {{ t('routes.offline_download') }}
        </button>
        <div v-if="errored" class="nav-cam-label text-danger mt-2">
          <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ t('routes.offline_error') }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Popover : mêmes styles que les panneaux de NavControlsPanel (caméra/POI), mais
   redéclarés ici car le `<style scoped>` du parent ne traverse pas la frontière de
   ce composant ni le contenu de slot. */
.nav-cam-panel {
  position: absolute; top: calc(100% + 0.4rem); right: 0; left: auto;
  z-index: 5; width: 16rem;
  background: #fff; border-radius: 0.7rem; padding: 0.9rem 1rem;
}
.nav-cam-label { font-size: 0.95rem; font-weight: 600; color: #495057; }
.nav-cam-val { font-size: 0.95rem; font-weight: 700; }
.nav-cam-savezoom {
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  width: 100%; padding: 0.5rem 0.75rem;
  border: 1px solid #7c3aed; border-radius: 0.5rem;
  background: #fff; color: #7c3aed; font-size: 0.9rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s ease, color 0.12s ease;
}
.nav-cam-savezoom:hover { background: #f3effd; }

.nav-offline-progress { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.nav-offline-bar { flex: 1; height: 6px; border-radius: 3px; background: rgba(0, 0, 0, 0.12); overflow: hidden; }
.nav-offline-bar-fill { height: 100%; background: #7c3aed; transition: width 0.2s linear; }
</style>
