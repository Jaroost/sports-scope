<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import type { Block, Catalog } from '../companionSettings'

// Édite **un** composant : son genre, son mode, et le paramètre que ce genre
// réclame (la mesure pour `metric`, la source pour `zones`).
//
// Partagé par la grille et la page qui défile : ce sont deux dispositions du même
// catalogue, et deux panneaux d'édition finiraient par proposer deux jeux de modes
// différents pour le même composant.

const props = defineProps<{ block: Block; catalog: Catalog }>()
const emit = defineEmits<{ (e: 'update', block: Block): void }>()

// Le mode n'est pas une décoration : le même contenu ne se dessine pas pareil
// dans un quart d'écran et dans une bande de deux cellules. Un composant qui n'en
// propose qu'un (la cellule vide) n'affiche pas le sélecteur.
const modes = computed(() => props.catalog.blocks[props.block.kind] || [])

function change(patch: Partial<Block>) {
  const next: Block = { ...props.block, ...patch }

  // Changer de genre emporte les paramètres de l'ancien : garder `metric` sur un
  // bloc devenu `zones` laisserait une clé morte dans le document, que
  // l'assainisseur retirerait — donc une différence entre ce qu'on voit et ce qui
  // part.
  if (patch.kind && patch.kind !== props.block.kind) {
    const allowed = props.catalog.blocks[patch.kind] || []
    delete next.metric
    delete next.source
    next.mode = allowed[0]
    if (patch.kind === 'metric') next.metric = props.catalog.metrics[0]
    if (patch.kind === 'zones') next.source = props.catalog.zone_sources[0]
    if (allowed.length === 0) delete next.mode
  }

  emit('update', next)
}
</script>

<template>
  <div class="row g-2">
    <div class="col-12 col-sm">
      <label class="form-label small mb-1">{{ t('companion.settings.block') }}</label>
      <select class="form-select form-select-sm" :value="block.kind"
              @change="change({ kind: ($event.target as HTMLSelectElement).value })">
        <option v-for="kind in Object.keys(catalog.blocks)" :key="kind" :value="kind">
          {{ t(`companion.settings.blocks.${kind}`) }}
        </option>
      </select>
    </div>

    <div v-if="block.kind === 'metric'" class="col-12 col-sm">
      <label class="form-label small mb-1">{{ t('companion.settings.metric') }}</label>
      <select class="form-select form-select-sm" :value="block.metric"
              @change="change({ metric: ($event.target as HTMLSelectElement).value })">
        <option v-for="metric in catalog.metrics" :key="metric" :value="metric">
          {{ t(`companion.settings.metrics.${metric}`) }}
        </option>
      </select>
    </div>

    <div v-if="block.kind === 'zones'" class="col-12 col-sm">
      <label class="form-label small mb-1">{{ t('companion.settings.source') }}</label>
      <select class="form-select form-select-sm" :value="block.source"
              @change="change({ source: ($event.target as HTMLSelectElement).value })">
        <option v-for="source in catalog.zone_sources" :key="source" :value="source">
          {{ t(`companion.settings.sources.${source}`) }}
        </option>
      </select>
    </div>

    <div v-if="modes.length > 0" class="col-12 col-sm">
      <label class="form-label small mb-1">{{ t('companion.settings.mode') }}</label>
      <select class="form-select form-select-sm" :value="block.mode"
              @change="change({ mode: ($event.target as HTMLSelectElement).value })">
        <option v-for="mode in modes" :key="mode" :value="mode">
          {{ t(`companion.settings.modes.${mode}`) }}
        </option>
      </select>
    </div>
  </div>
</template>
