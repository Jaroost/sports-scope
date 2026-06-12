<script setup>
import { ref } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES } from '../mapStyles'

const props = defineProps({
  modelValue: { type: String, required: true },
})

const emit = defineEmits(['update:modelValue'])

const open = ref(false)

function select(id) {
  emit('update:modelValue', id)
  open.value = false
}
</script>

<template>
  <div class="position-relative shadow-sm">
    <button
      type="button"
      class="btn btn-sm map-ctrl-btn d-flex align-items-center gap-1"
      :class="open ? 'btn-warning text-dark' : 'btn-light'"
      :title="t('strava.map_style_label')"
      @click="open = !open"
    >
      <i :class="`fa-solid ${MAP_STYLES.find(s => s.id === modelValue)?.icon ?? 'fa-map'}`" aria-hidden="true"></i>
      <span class="d-none d-md-inline">{{ t(`strava.map_style_${modelValue}`) }}</span>
      <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
    </button>
    <ul v-if="open" class="dropdown-menu show mt-1" style="min-width: 9rem; z-index: 10;">
      <li v-for="s in MAP_STYLES" :key="s.id">
        <button
          type="button"
          class="dropdown-item d-flex align-items-center gap-2"
          :class="{ active: modelValue === s.id }"
          @click="select(s.id)"
        >
          <i :class="`fa-solid ${s.icon}`" aria-hidden="true"></i>
          {{ t(`strava.map_style_${s.id}`) }}
        </button>
      </li>
    </ul>
  </div>
</template>
