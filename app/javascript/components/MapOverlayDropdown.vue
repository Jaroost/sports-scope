<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { MAP_OVERLAYS } from '../mapStyles'

const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const open = ref(false)

const activeCount = computed(() => props.modelValue.length)

function isActive(id: string): boolean {
  return props.modelValue.includes(id)
}

function toggle(id: string) {
  const next = isActive(id)
    ? props.modelValue.filter(x => x !== id)
    : [...props.modelValue, id]
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="position-relative shadow-sm">
    <button
      type="button"
      class="btn btn-sm map-ctrl-btn d-flex align-items-center gap-1"
      :class="open || activeCount > 0 ? 'btn-warning text-dark' : 'btn-light'"
      :title="t('strava.overlay_label')"
      @click="open = !open"
    >
      <i class="fa-solid fa-layer-group" aria-hidden="true"></i>
      <span v-if="activeCount > 0" class="badge rounded-pill bg-dark">{{ activeCount }}</span>
      <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
    </button>
    <ul v-if="open" class="dropdown-menu show mt-1" style="min-width: 13rem; z-index: 10;">
      <li>
        <h6 class="dropdown-header">{{ t('strava.overlay_label') }}</h6>
      </li>
      <li v-for="o in MAP_OVERLAYS" :key="o.id">
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: isActive(o.id) }"
          @click="toggle(o.id)"
        >
          <i
            class="fa-solid"
            :class="isActive(o.id) ? 'fa-square-check' : 'fa-square'"
            aria-hidden="true"
          ></i>
          <i :class="`fa-solid ${o.icon}`" aria-hidden="true"></i>
          {{ t(`strava.overlay_${o.id}`) }}
        </button>
      </li>
    </ul>
  </div>
</template>
