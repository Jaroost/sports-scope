<script setup lang="ts">
// Couleur de fond conditionnelle d'une case de bandeau ou d'encoche
// (`BandColoredSlot.gauge_thresholds`/`gauge_threshold_colors`) — même
// mécanisme que le fond par tranches d'un composant de grille
// (`CompanionBlockPicker.vue`, section « Fond par tranches »), extrait ici en
// composant propre : contrairement au bloc de grille (une case éditée à la
// fois dans sa dialogue), une case de bandeau ou d'encoche s'édite en place,
// plusieurs à la fois (jusqu'à 4 par bandeau, 2 par jeu d'encoche) — dupliquer
// les refs/fonctions de `CompanionBlockPicker.vue` à chaque case aurait été
// bien plus lourd que ce composant.
//
// Pas de valeur de test ici (contrairement à `CompanionBlockPicker.vue`) :
// une case de bandeau reste minuscule, l'espace ne s'y prête pas — la
// pastille de chaque tranche suffit à voir la règle composée.
import { ref, watch } from 'vue'
import { t } from '../i18n'
import {
  GAUGE_THRESHOLD_COUNT_RANGE, METRIC_RANGE_DEFAULTS, RANGE_GAUGE_COLOR, defaultGaugeThresholds,
} from '../companionSettings'
import CompanionColorPicker from './CompanionColorPicker.vue'

const props = defineProps<{
  metric: string
  modelValue: { thresholds: number[]; colors: string[] } | null | undefined
}>()
const emit = defineEmits<{
  'update:modelValue': [value: { thresholds: number[]; colors: string[] } | null]
}>()

function initial(): { thresholds: number[]; colors: string[] } {
  const current = props.modelValue
  if (current?.thresholds?.length && current.colors.length === current.thresholds.length + 1) {
    return { thresholds: [...current.thresholds], colors: [...current.colors] }
  }
  return defaultGaugeThresholds(props.metric)
}

const enabled = ref<boolean>(!!props.modelValue)
const thresholds = ref<number[]>(initial().thresholds)
const colors = ref<string[]>(initial().colors)

// `deep: true` sur les deux tableaux : `v-model.number` sur un jalon et
// `setColor` sur une tranche mutent en place aussi bien qu'ils remplacent.
watch([enabled, thresholds, colors], () => {
  emit('update:modelValue', enabled.value ? { thresholds: thresholds.value, colors: colors.value } : null)
}, { deep: true })

function addThreshold() {
  if (thresholds.value.length >= GAUGE_THRESHOLD_COUNT_RANGE.max) return
  const { min: rMin, max: rMax } = METRIC_RANGE_DEFAULTS[props.metric] || { min: 0, max: 100 }
  const last = thresholds.value[thresholds.value.length - 1]
  const next = last != null ? last + (rMax - rMin) / 10 : (rMin + rMax) / 2
  thresholds.value = [...thresholds.value, next]
  // Fusionne la nouvelle tranche dans la couleur de la dernière plutôt que
  // d'en inventer une : on affine ensuite au lieu de composer une couleur au
  // hasard — même geste que `CompanionBlockPicker.vue`.
  colors.value = [...colors.value, colors.value[colors.value.length - 1]]
}

function removeThreshold(index: number) {
  if (thresholds.value.length <= GAUGE_THRESHOLD_COUNT_RANGE.min) return
  thresholds.value = thresholds.value.filter((_, i) => i !== index)
  colors.value = colors.value.filter((_, i) => i !== index + 1)
}

function setColor(index: number, value: string | null) {
  const next = [...colors.value]
  next[index] = value || RANGE_GAUGE_COLOR
  colors.value = next
}
</script>

<template>
  <div class="cte">
    <label class="cte-toggle small">
      <input v-model="enabled" type="checkbox" class="form-check-input">
      {{ t('companion.settings.gauge_thresholds_enable') }}
    </label>

    <div v-if="enabled" class="cte-rows">
      <div class="cte-row">
        <CompanionColorPicker
          :model-value="colors[0]" :fallback="RANGE_GAUGE_COLOR"
          :label="t('companion.settings.gauge_threshold_band_color')"
          @update:model-value="(v) => setColor(0, v)"
        />
      </div>
      <div v-for="(_, i) in thresholds" :key="i" class="cte-row">
        <input
          v-model.number="thresholds[i]" type="number"
          class="form-control form-control-sm cte-threshold-input"
          :aria-label="t('companion.settings.gauge_threshold_value')"
        >
        <button
          v-if="thresholds.length > GAUGE_THRESHOLD_COUNT_RANGE.min"
          type="button" class="btn btn-sm btn-outline-danger cte-threshold-remove"
          :aria-label="t('companion.settings.gauge_threshold_remove')"
          @click="removeThreshold(i)"
        >
          &times;
        </button>
        <CompanionColorPicker
          :model-value="colors[i + 1]" :fallback="RANGE_GAUGE_COLOR"
          :label="t('companion.settings.gauge_threshold_band_color')"
          @update:model-value="(v) => setColor(i + 1, v)"
        />
      </div>
      <button
        type="button" class="btn btn-sm btn-outline-secondary"
        :disabled="thresholds.length >= GAUGE_THRESHOLD_COUNT_RANGE.max"
        @click="addThreshold"
      >
        {{ t('companion.settings.gauge_threshold_add') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.cte {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.25rem;
}
.cte-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  color: var(--bs-secondary-color);
}
.cte-toggle .form-check-input {
  width: 1.1rem;
  height: 1.1rem;
  margin: 0;
}
.cte-rows {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.cte-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.cte-threshold-input {
  width: 5.5rem;
}
.cte-threshold-remove {
  line-height: 1;
  padding: 0.15rem 0.5rem;
}
</style>
