<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES, MAP_STYLE_GROUPS, MAP_STYLE_COMBOS } from '../mapStyles'

const props = defineProps({
  modelValue: { type: String, required: true },
  // Overlays actuellement actifs chez l'appelant. Non fourni (null) → les entrées
  // composées « fond + couche » sont masquées : seul le créateur d'itinéraire sait
  // les honorer, les autres cartes n'ont pas de machinerie d'overlays.
  activeOverlays: { type: Array, default: null },
  // Libellé court affiché sur mobile (ex. « Carte »). Absent → aucun libellé sur
  // mobile (icône seule), comportement d'origine conservé pour les autres vues.
  mobileLabel: { type: String, default: '' },
  // Contrôle optionnel de l'ouverture (v-model:open) : permet à un parent de
  // coordonner plusieurs dropdowns (fermer celui-ci quand un autre s'ouvre).
  // Absent (null) → le composant gère son ouverture en interne, comme avant.
  open: { type: [Boolean], default: null },
})

const emit = defineEmits(['update:modelValue', 'update:open'])

const combos = computed(() => (props.activeOverlays === null ? [] : MAP_STYLE_COMBOS))

function comboActive(c) {
  return props.modelValue === c.style && (props.activeOverlays ?? []).includes(c.overlay)
}

// Un fond dont une entrée composée est active ne doit pas s'afficher actif lui aussi.
function styleActive(id) {
  return props.modelValue === id && !combos.value.some(c => c.style === id && comboActive(c))
}

// Entrées d'un groupe : les fonds, puis ses entrées composées (le satellite étant en fin
// de groupe, « Satellite + chemins » se retrouve juste dessous).
const groupedStyles = computed(() =>
  MAP_STYLE_GROUPS
    .map(group => ({
      group,
      styles: MAP_STYLES.filter(s => s.group === group),
      combos: combos.value.filter(c => c.group === group),
    }))
    .filter(g => g.styles.length > 0 || g.combos.length > 0),
)

const currentIcon = computed(() =>
  combos.value.find(comboActive)?.icon
    ?? MAP_STYLES.find(s => s.id === props.modelValue)?.icon
    ?? 'fa-map',
)

const internalOpen = ref(false)
const controlled = computed(() => props.open !== null)
const isOpen = computed({
  get: () => (controlled.value ? props.open : internalOpen.value),
  set: (v) => { if (controlled.value) emit('update:open', v); else internalOpen.value = v },
})

function select(id) {
  emit('update:modelValue', id)
  isOpen.value = false
}
</script>

<template>
  <div class="position-relative shadow-sm">
    <button
      type="button"
      class="btn btn-sm map-ctrl-btn d-flex align-items-center gap-1"
      :class="isOpen ? 'btn-warning text-dark' : 'btn-light'"
      :title="t('strava.map_style_label')"
      @click="isOpen = !isOpen"
    >
      <i :class="`fa-solid ${currentIcon}`" aria-hidden="true"></i>
      <span v-if="mobileLabel" class="d-md-none">{{ mobileLabel }}</span>
      <span class="d-none d-md-inline">{{ t('strava.map_style_label') }}</span>
      <i class="fa-solid fa-caret-down" aria-hidden="true"></i>
    </button>
    <ul v-if="isOpen" class="dropdown-menu show mt-1" style="min-width: 9rem; z-index: 10;">
      <template v-for="(g, gi) in groupedStyles" :key="g.group">
        <li v-if="gi > 0"><hr class="dropdown-divider" /></li>
        <li>
          <h6 class="dropdown-header">{{ t(`strava.map_style_group_${g.group}`) }}</h6>
        </li>
        <li v-for="s in g.styles" :key="s.id">
          <button
            type="button"
            class="dropdown-item d-flex align-items-center gap-2"
            :class="{ active: styleActive(s.id) }"
            @click="select(s.id)"
          >
            <i :class="`fa-solid ${s.icon}`" aria-hidden="true"></i>
            {{ t(`strava.map_style_${s.id}`) }}
          </button>
        </li>
        <li v-for="c in g.combos" :key="c.id">
          <button
            type="button"
            class="dropdown-item d-flex align-items-center gap-2"
            :class="{ active: comboActive(c) }"
            @click="select(c.id)"
          >
            <i :class="`fa-solid ${c.icon}`" aria-hidden="true"></i>
            {{ t(`strava.map_style_${c.id}`) }}
          </button>
        </li>
      </template>
    </ul>
  </div>
</template>
