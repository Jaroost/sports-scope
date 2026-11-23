<script setup lang="ts">
// Sorties qui ressemblent à celle affichée (même sport, tracé qui se recouvre), avec un
// lien vers la comparaison côte à côte (`ActivityCompare`). Chargé à l'affichage de
// l'onglet : la recherche balaie l'historique proche.
import { ref, watch, computed } from 'vue'
import { t } from '../i18n'
import { formatKm } from '../activityHelpers'

interface Similar {
  source: string; id: string; name: string; started_at: string | null
  distance_m: number | null; similarity: number
}

const props = defineProps({
  activityId: { type: [String, Number], required: true },
  source: { type: String, default: 'strava' },
  active: { type: Boolean, default: false },
})

const loading = ref(false)
const fetched = ref(false)
const error = ref(false)
const items = ref<Similar[]>([])

const ownRef = computed(() => `${props.source}:${props.activityId}`)
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || undefined

function dateOf(s: Similar): string {
  return s.started_at ? new Date(s.started_at).toLocaleDateString(lang, { day: '2-digit', month: 'short', year: 'numeric' }) : ''
}
function compareUrl(s: Similar): string {
  return `/compare?a=${encodeURIComponent(ownRef.value)}&b=${encodeURIComponent(`${s.source}:${s.id}`)}`
}

async function load() {
  loading.value = true
  error.value = false
  try {
    const res = await fetch(`/api/activity_comparison/similar?ref=${encodeURIComponent(ownRef.value)}`,
      { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(String(res.status))
    items.value = (await res.json()).activities
    fetched.value = true
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

watch(() => props.active, (on) => { if (on && !fetched.value && !loading.value) load() }, { immediate: true })
watch(ownRef, () => { fetched.value = false; items.value = []; if (props.active) load() })
</script>

<template>
  <div class="card shadow-sm border-0 mt-3 mb-3">
    <div class="card-header activity-card-header">
      <h3 class="h6 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-code-compare text-warning" aria-hidden="true"></i>
        <span>{{ t('compare.similar.title') }}</span>
      </h3>
    </div>
    <div class="card-body">
      <p class="small text-body-secondary">{{ t('compare.similar.intro') }}</p>
      <div v-if="loading" class="text-body-secondary">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ t('compare.similar.loading') }}
      </div>
      <div v-else-if="error" class="text-danger">{{ t('compare.error') }}</div>
      <div v-else-if="!items.length" class="text-body-secondary">{{ t('compare.similar.none') }}</div>
      <ul v-else class="list-group list-group-flush">
        <li v-for="s in items" :key="`${s.source}:${s.id}`"
            class="list-group-item px-0 d-flex align-items-center gap-2">
          <div class="flex-grow-1 min-w-0">
            <div class="fw-semibold text-truncate">{{ s.name }}</div>
            <div class="small text-body-secondary">
              {{ dateOf(s) }} · {{ formatKm(s.distance_m) }} · {{ t('compare.similar.match', { pct: Math.round(s.similarity * 100) }) }}
            </div>
          </div>
          <a :href="compareUrl(s)" class="btn btn-sm btn-outline-primary">
            <i class="fa-solid fa-code-compare me-1" aria-hidden="true"></i>{{ t('compare.similar.compare') }}
          </a>
        </li>
      </ul>
    </div>
  </div>
</template>
