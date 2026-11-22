<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { profilesForSport } from '../brouter'
import { isLoggedIn } from '../userPreferences'
import type { Sport } from '../userPreferences'
import { isCustomizable, specBase } from '../routingProfile'
import {
  customProfileForSpec,
  customProfilesForSport,
  loadRoutingProfiles,
  profileDescription,
  profileLabel,
} from '../routingProfiles'
import RoutingProfileEditor from './RoutingProfileEditor.vue'

// Sélecteur de profil de routage : profils de base du sport, profils personnalisés du
// compte, et accès à l'éditeur (nouveau profil / réglages du profil courant). La valeur
// est un spec (cf. routingProfile.ts) — un nom de profil de base quand rien n'est réglé,
// donc ce composant remplace un <select> de profils sans rien changer au reste du code.
const props = defineProps<{
  modelValue: string
  sport: Sport
  id?: string
  selectClass?: string
  disabled?: boolean
  ariaLabel?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [spec: string] }>()

const NEW = '__new__'
const loggedIn = isLoggedIn()
const editorOpen = ref(false)
const editorNew = ref(false)

onMounted(loadRoutingProfiles)

const fixed = computed(() => profilesForSport(props.sport))
const customs = computed(() => customProfilesForSport(props.sport))
// Réglage jamais enregistré (« Appliquer sans enregistrer ») : affiché tel quel pour que
// le sélecteur ne montre pas un autre profil que celui qui route réellement.
const isUnsaved = computed(
  () => !fixed.value.includes(props.modelValue) && !customProfileForSpec(props.modelValue, props.sport),
)
const canCustomize = computed(() => loggedIn && isCustomizable(specBase(props.modelValue)))

function onChange(e: Event) {
  const el = e.target as HTMLSelectElement
  if (el.value === NEW) {
    el.value = props.modelValue // l'option « nouveau » n'est pas une valeur
    openEditor(true)
    return
  }
  emit('update:modelValue', el.value)
}

function openEditor(createNew: boolean) {
  editorNew.value = createNew
  editorOpen.value = true
}
</script>

<template>
  <div class="d-flex gap-1 align-items-stretch">
    <select
      :id="id"
      :class="['form-select', selectClass]"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :title="profileDescription(modelValue)"
      @change="onChange"
    >
      <option v-for="p in fixed" :key="p" :value="p" :title="t(`routes.brouter_profile.${p}_desc`)">
        {{ t(`routes.brouter_profile.${p}`) }}
      </option>
      <optgroup v-if="customs.length || isUnsaved" :label="t('routes.routing_profile.mine')">
        <option v-for="c in customs" :key="c.id" :value="c.spec" :title="t(`routes.brouter_profile.${specBase(c.spec)}_desc`)">
          {{ c.name }}
        </option>
        <option v-if="isUnsaved" :value="modelValue">{{ profileLabel(modelValue, sport) }}</option>
      </optgroup>
      <option v-if="loggedIn" :value="NEW">{{ t('routes.routing_profile.new') }}</option>
    </select>
    <button
      v-if="canCustomize"
      type="button"
      class="btn btn-outline-secondary btn-sm flex-shrink-0"
      :disabled="disabled"
      :title="t('routes.routing_profile.edit')"
      :aria-label="t('routes.routing_profile.edit')"
      @click="openEditor(false)"
    >
      <i class="fa-solid fa-sliders" aria-hidden="true"></i>
    </button>
    <RoutingProfileEditor
      :show="editorOpen"
      :sport="sport"
      :spec="modelValue"
      :create-new="editorNew"
      @close="editorOpen = false"
      @apply="emit('update:modelValue', $event)"
    />
  </div>
</template>
