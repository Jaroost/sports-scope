<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import { useDismissOnOutside } from '../composables/useDismissOnOutside'
import { t } from '../i18n'
import type { ActivityColorMode } from '../pageState'

const props = defineProps({
  modelValue: { type: String as () => ActivityColorMode, required: true },
  // Zones FC / puissance non fournies (activité sans capteur, ou seuil LTHR/FTP
  // absent) → les options correspondantes disparaissent du menu, comme le fait déjà
  // l'onglet Zones (ActivityZones.vue) pour les mêmes raisons.
  hasHr: { type: Boolean, default: false },
  hasPower: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const MODE_ICON: Record<ActivityColorMode, string> = {
  grade: 'fa-palette',
  hr: 'fa-heart-pulse',
  power: 'fa-bolt',
  none: 'fa-ban',
}

const currentIcon = computed(() => MODE_ICON[props.modelValue] ?? 'fa-palette')

const internalOpen = ref(false)

function select(mode: ActivityColorMode) {
  emit('update:modelValue', mode)
  internalOpen.value = false
}

const rootEl = useTemplateRef('rootEl')
useDismissOnOutside(() => rootEl.value, () => { internalOpen.value = false })
</script>

<template>
  <div ref="rootEl" class="position-relative shadow-sm">
    <button
      type="button"
      class="btn btn-sm map-ctrl-btn d-flex align-items-center gap-1"
      :class="internalOpen ? 'btn-warning text-dark' : 'btn-light'"
      :title="t('strava.color_mode_label')"
      @click="internalOpen = !internalOpen"
    >
      <i :class="`fa-solid ${currentIcon}`" aria-hidden="true"></i>
      <span class="d-none d-md-inline">{{ t('strava.color_mode_label') }}</span>
      <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
    </button>
    <ul v-if="internalOpen" class="dropdown-menu show mt-1" style="min-width: 13rem; z-index: 10;">
      <li>
        <h6 class="dropdown-header">{{ t('strava.color_mode_section') }}</h6>
      </li>
      <li>
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: modelValue === 'grade' }"
          @click="select('grade')"
        >
          <i class="fa-solid fa-palette" aria-hidden="true"></i>
          {{ t('strava.color_mode_grade') }}
        </button>
      </li>
      <li v-if="hasHr">
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: modelValue === 'hr' }"
          @click="select('hr')"
        >
          <i class="fa-solid fa-heart-pulse" aria-hidden="true"></i>
          {{ t('strava.color_mode_hr') }}
        </button>
      </li>
      <li v-if="hasPower">
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: modelValue === 'power' }"
          @click="select('power')"
        >
          <i class="fa-solid fa-bolt" aria-hidden="true"></i>
          {{ t('strava.color_mode_power') }}
        </button>
      </li>
      <li>
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: modelValue === 'none' }"
          @click="select('none')"
        >
          <i class="fa-solid fa-ban" aria-hidden="true"></i>
          {{ t('strava.color_mode_none') }}
        </button>
      </li>
    </ul>
  </div>
</template>
