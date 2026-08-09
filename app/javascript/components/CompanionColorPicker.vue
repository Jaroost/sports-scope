<script setup lang="ts">
// Le réglage de couleur d'un composant du tableau de bord companion
// (CompanionBlockPicker) : un clic sur la case ouvre une dialogue avec les
// dernières couleurs utilisées ou personnalisées, plutôt que le sélecteur
// natif du système directement — au bout de quelques réglages, la couleur
// voulue est presque toujours déjà dans cette liste.
//
// Le sélecteur natif (`input[type=color]`) reste dans la dialogue pour une
// couleur inédite. `@input` continue de mettre à jour la valeur en direct,
// comme avant, pour que la vignette suive le glissé dans le sélecteur
// système ; seul `@change` — le choix final — entre dans l'historique, pour
// ne pas y verser une couleur par pixel survolé.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { recentColors, rememberColor } from '../companionColors'

const props = defineProps<{
  modelValue: string | null
  // La couleur affichée dans la case quand rien n'est réglé : purement
  // visuelle, elle ne pose jamais `modelValue`.
  fallback: string
  label: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()

const root = ref<HTMLElement | null>(null)
const open = ref(false)
const colors = ref<string[]>([])

function toggle() {
  if (open.value) {
    open.value = false
    return
  }
  colors.value = recentColors()
  open.value = true
}

function pick(hex: string) {
  emit('update:modelValue', hex)
  rememberColor(hex)
  open.value = false
}

function onCustomInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function onCustomChange(e: Event) {
  pick((e.target as HTMLInputElement).value)
}

function reset() {
  emit('update:modelValue', null)
  open.value = false
}

function onDocumentMousedown(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('mousedown', onDocumentMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMousedown))
</script>

<template>
  <div ref="root" class="ccp">
    <button
      type="button"
      class="ccp-swatch"
      :style="{ backgroundColor: modelValue || fallback }"
      :aria-label="label"
      @click="toggle"
    />

    <div v-if="open" class="ccp-popover shadow-sm">
      <div v-if="colors.length" class="ccp-recent">
        <button
          v-for="c in colors"
          :key="c"
          type="button"
          class="ccp-recent-swatch"
          :class="{ 'ccp-recent-swatch--current': c === modelValue }"
          :style="{ backgroundColor: c }"
          :aria-label="c"
          :title="c"
          @click="pick(c)"
        />
      </div>
      <p v-else class="ccp-empty small text-body-secondary mb-2">
        {{ t('companion.settings.no_recent_colors') }}
      </p>

      <label class="ccp-custom small">
        {{ t('companion.settings.custom_color') }}
        <input
          type="color"
          class="form-control form-control-color"
          :value="modelValue || fallback"
          @input="onCustomInput"
          @change="onCustomChange"
        >
      </label>

      <button v-if="modelValue" type="button" class="btn btn-sm btn-link p-0 ccp-reset" @click="reset">
        {{ t('companion.settings.reset_color') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ccp {
  position: relative;
  display: inline-flex;
}
.ccp-swatch {
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.35rem;
  cursor: pointer;
}
.ccp-popover {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  z-index: 2200;
  background: var(--bs-body-bg, #fff);
  border: 1px solid var(--bs-border-color);
  border-radius: 0.6rem;
  padding: 0.6rem;
  width: max-content;
  max-width: 14rem;
}
.ccp-recent {
  display: grid;
  grid-template-columns: repeat(6, 1.4rem);
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}
.ccp-recent-swatch {
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.3rem;
  cursor: pointer;
}
.ccp-recent-swatch--current {
  outline: 2px solid var(--bs-primary);
  outline-offset: 1px;
}
.ccp-empty {
  width: 9.5rem;
}
.ccp-custom {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.35rem;
  white-space: nowrap;
}
.ccp-custom input {
  width: 2.5rem;
  padding: 0.15rem;
}
.ccp-reset {
  display: block;
}
</style>
