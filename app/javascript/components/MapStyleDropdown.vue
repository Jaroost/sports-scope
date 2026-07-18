<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES, MAP_STYLE_GROUPS } from '../mapStyles'

const groupedStyles = computed(() =>
  MAP_STYLE_GROUPS
    .map(group => ({ group, styles: MAP_STYLES.filter(s => s.group === group) }))
    .filter(g => g.styles.length > 0),
)

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
      <span class="d-none d-md-inline">{{ t('strava.map_style_label') }}</span>
      <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
    </button>
    <ul v-if="open" class="dropdown-menu show mt-1" style="min-width: 9rem; z-index: 10;">
      <template v-for="(g, gi) in groupedStyles" :key="g.group">
        <li v-if="gi > 0"><hr class="dropdown-divider" /></li>
        <li>
          <h6 class="dropdown-header">{{ t(`strava.map_style_group_${g.group}`) }}</h6>
        </li>
        <li v-for="s in g.styles" :key="s.id">
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
      </template>
    </ul>
  </div>
</template>
