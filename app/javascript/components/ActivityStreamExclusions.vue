<script setup lang="ts">
// Données de capteur écartées d'une activité : canaux entiers (cardio, puissance…) ou
// portions de temps choisies sur les graphiques. Les streams bruts restent en base ;
// le serveur applique le masque et recalcule NP, courbes, histogrammes et charge, puis
// rend les streams masqués — le parent les remplace d'un bloc (`updated`).
import { computed, ref, type PropType } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import { formatDuration } from '../activityHelpers'

type Range = { from: number; to: number; channels?: string[] }
type Exclusions = { channels?: string[]; ranges?: Range[] }

// Mêmes canaux que `StreamExclusions::CHANNELS` côté Rails.
const CHANNELS = ['heartrate', 'watts', 'cadence', 'temp', 'velocity_smooth']

const props = defineProps({
  url: { type: String, required: true },
  streams: { type: Object as PropType<Record<string, any> | null>, default: null },
  exclusions: { type: Object as PropType<Exclusions>, default: () => ({}) },
  selection: { type: Object as PropType<{ startIdx: number; endIdx: number } | null>, default: null },
})
const emit = defineEmits<{ (e: 'updated', payload: { streams: Record<string, any>; stream_exclusions: Exclusions }): void }>()

const saving = ref(false)
const error = ref<string | null>(null)
const picking = ref(false)
const pickedChannels = ref<string[]>([])

const excludedChannels = computed(() => props.exclusions.channels || [])
const ranges = computed(() => props.exclusions.ranges || [])
// Un canal se propose s'il est présent (non masqué) ou déjà écarté — sinon on ne pourrait
// pas le réintégrer, puisqu'il a disparu des streams servis.
const availableChannels = computed(() =>
  CHANNELS.filter((c) => excludedChannels.value.includes(c) || props.streams?.[c]?.data?.length),
)
const selectionRange = computed<Range | null>(() => {
  const time = props.streams?.time?.data
  const s = props.selection
  if (!s || !Array.isArray(time)) return null
  const from = time[s.startIdx]
  const to = time[s.endIdx]
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null
})
const pickable = computed(() =>
  availableChannels.value.filter((c) => !excludedChannels.value.includes(c)),
)

async function save(next: Exclusions) {
  saving.value = true
  error.value = null
  try {
    const res = await fetch(props.url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify(next),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    emit('updated', await res.json())
  } catch (e: any) {
    error.value = t('strava.exclusions.error', { message: e.message })
  } finally {
    saving.value = false
  }
}

function toggleChannel(channel: string) {
  const channels = excludedChannels.value.includes(channel)
    ? excludedChannels.value.filter((c) => c !== channel)
    : [...excludedChannels.value, channel]
  save({ channels, ranges: ranges.value })
}

function startPicking() {
  pickedChannels.value = [...pickable.value]
  picking.value = true
}

async function applyRange() {
  const range = selectionRange.value
  if (!range || !pickedChannels.value.length) return
  const entry: Range = { ...range }
  // Tous les canaux cochés = pas de liste (« tous les capteurs ») : plus compact, et la
  // plage vaut aussi pour un capteur branché plus tard.
  if (pickedChannels.value.length < pickable.value.length) entry.channels = pickedChannels.value
  await save({ channels: excludedChannels.value, ranges: [...ranges.value, entry] })
  if (!error.value) picking.value = false
}

function removeRange(index: number) {
  save({ channels: excludedChannels.value, ranges: ranges.value.filter((_, i) => i !== index) })
}

function rangeLabel(r: Range): string {
  const span = `${formatDuration(r.from)} – ${formatDuration(r.to)}`
  const names = (r.channels?.length ? r.channels : [])
    .map((c) => t(`strava.exclusions.channel.${c}`)).join(', ')
  return names ? `${span} · ${names}` : span
}
</script>

<template>
  <div v-if="availableChannels.length" class="stream-exclusions card mt-3 mb-3">
    <div class="card-body py-2">
      <div class="d-flex flex-wrap align-items-center gap-2">
        <strong class="me-1">
          <i class="fa-solid fa-eye-slash me-1" aria-hidden="true"></i>{{ t('strava.exclusions.title') }}
        </strong>
        <i class="fa-regular fa-circle-question text-muted" :title="t('strava.exclusions.hint')" tabindex="0"></i>
        <div class="btn-group btn-group-sm" role="group" :aria-label="t('strava.exclusions.channels')">
          <template v-for="c in availableChannels" :key="c">
            <input
              :id="`excl-${c}`" type="checkbox" class="btn-check" autocomplete="off"
              :checked="excludedChannels.includes(c)" :disabled="saving"
              @change="toggleChannel(c)"
            />
            <label class="btn btn-outline-secondary" :for="`excl-${c}`">
              {{ t(`strava.exclusions.channel.${c}`) }}
            </label>
          </template>
        </div>
        <button
          v-if="!picking" type="button" class="btn btn-sm btn-outline-warning ms-auto"
          :disabled="saving || !selectionRange || !pickable.length"
          :title="selectionRange ? '' : t('strava.exclusions.select_hint')"
          @click="startPicking"
        >
          <i class="fa-solid fa-scissors me-1" aria-hidden="true"></i>{{ t('strava.exclusions.ignore_selection') }}
        </button>
      </div>

      <div v-if="picking && selectionRange" class="d-flex flex-wrap align-items-center gap-2 mt-2">
        <span class="text-muted small">{{ formatDuration(selectionRange.from) }} – {{ formatDuration(selectionRange.to) }}</span>
        <label v-for="c in pickable" :key="c" class="form-check form-check-inline mb-0 small">
          <input v-model="pickedChannels" class="form-check-input" type="checkbox" :value="c" />
          {{ t(`strava.exclusions.channel.${c}`) }}
        </label>
        <button type="button" class="btn btn-sm btn-warning" :disabled="saving || !pickedChannels.length" @click="applyRange">
          {{ t('strava.exclusions.apply') }}
        </button>
        <button type="button" class="btn btn-sm btn-link" @click="picking = false">{{ t('strava.exclusions.cancel') }}</button>
      </div>

      <ul v-if="ranges.length" class="list-unstyled mb-0 mt-2 small">
        <li v-for="(r, i) in ranges" :key="i" class="d-flex align-items-center gap-2">
          <span class="text-muted">{{ t('strava.exclusions.ranges') }} :</span>
          <span>{{ rangeLabel(r) }}</span>
          <button
            type="button" class="btn btn-sm btn-link p-0" :disabled="saving"
            :title="t('strava.exclusions.remove')" :aria-label="t('strava.exclusions.remove')"
            @click="removeRange(i)"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </li>
      </ul>
      <div v-if="error" class="text-danger small mt-1">{{ error }}</div>
    </div>
  </div>
</template>
