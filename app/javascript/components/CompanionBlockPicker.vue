<script setup lang="ts">
// La dialogue de choix d'un composant de page.
//
// Elle remplace trois listes déroulantes côte à côte (genre, mesure, mode) qui
// demandaient de connaître par cœur ce que chaque mot désigne : « Jauge »,
// « Aplat de zone » et « Barre seule » ne se figurent pas, et on découvrait le
// résultat en pleine sortie, sur le seul écran qu'on ne peut plus modifier.
// Ici **chaque façon de dessiner a sa vignette**, et on choisit ce qu'on voit.
//
// Une vignette par couple genre × mode, et non par genre : c'est le mode qui
// décide du dessin. Le paramètre que le genre réclame — la mesure pour
// `metric`, la source pour `zones` — se règle en tête de son groupe, et les
// vignettes du groupe s'y mettent aussitôt : on choisit *sa* mesure dessinée,
// pas une mesure d'exemple.
//
// Un tap pose le composant et referme. Pas de bouton « Choisir » à la suite :
// le paramètre est déjà réglé au-dessus, et un aller-retour de plus pour poser
// une case sur une grille de six se paierait à chaque case.
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { t } from '../i18n'
import CompanionBlockPreview from './CompanionBlockPreview.vue'
import {
  blockChoices, blockFor, isChoiceOf,
  type Block, type Catalog, type CellSize,
} from '../companionSettings'

const props = defineProps<{
  // Le composant en cours de modification, `null` quand on en ajoute un : c'est
  // ce qui décide du liseré de la vignette courante et du pré-réglage des
  // paramètres.
  block: Block | null
  catalog: Catalog
  // La place qu'aura le composant une fois posé, quand la destination est une
  // case de grille. Les vignettes montrent alors ce que **cette case-là**
  // dessinera — une légende de zones qu'elle ne portera pas ne s'y propose pas
  // en grand. Absente pour une page qui défile, où la hauteur est libre.
  cell?: CellSize
}>()

const emit = defineEmits<{ close: []; choose: [block: Block] }>()

const metric = ref(props.block?.metric || props.catalog.metrics[0])
const source = ref(props.block?.source || props.catalog.zone_sources[0])

// Les vignettes, regroupées par genre — l'ordre est celui du catalogue, donc
// celui du serveur, qui est aussi l'ordre d'affichage des libellés.
const groups = computed(() => {
  const choices = blockChoices(props.catalog)
  return Object.keys(props.catalog.blocks).map((kind) => ({
    kind,
    choices: choices.filter((choice) => choice.kind === kind),
  }))
})

function preview(kind: string, mode?: string): Block {
  return blockFor({ kind, mode }, { metric: metric.value, source: source.value })
}

function choose(kind: string, mode?: string) {
  emit('choose', preview(kind, mode))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="cbpk-backdrop" @click.self="emit('close')">
    <div class="cbpk-dialog shadow-lg">
      <div class="cbpk-header">
        <span class="cbpk-title">{{ t('companion.settings.pick_block') }}</span>
        <button
          type="button"
          class="cbpk-close"
          :aria-label="t('companion.settings.cancel')"
          @click="emit('close')"
        >
          ×
        </button>
      </div>

      <div class="cbpk-body">
        <p class="text-body-secondary small">{{ t('companion.settings.pick_block_help') }}</p>

        <section v-for="group in groups" :key="group.kind" class="cbpk-group">
          <div class="cbpk-group-head">
            <h3 class="h6 mb-0">{{ t(`companion.settings.blocks.${group.kind}`) }}</h3>

            <!-- Le paramètre du genre, en tête de son groupe : les vignettes
                 en dessous le dessinent aussitôt. -->
            <label v-if="group.kind === 'metric'" class="cbpk-param small">
              {{ t('companion.settings.metric') }}
              <select v-model="metric" class="form-select form-select-sm">
                <option v-for="m in catalog.metrics" :key="m" :value="m">
                  {{ t(`companion.settings.metrics.${m}`) }}
                </option>
              </select>
            </label>

            <label v-else-if="group.kind === 'zones'" class="cbpk-param small">
              {{ t('companion.settings.source') }}
              <select v-model="source" class="form-select form-select-sm">
                <option v-for="s in catalog.zone_sources" :key="s" :value="s">
                  {{ t(`companion.settings.sources.${s}`) }}
                </option>
              </select>
            </label>
          </div>

          <div class="cbpk-tiles">
            <button
              v-for="choice in group.choices"
              :key="`${choice.kind}:${choice.mode || ''}`"
              type="button"
              class="cbpk-tile"
              :class="{ 'cbpk-tile--current': isChoiceOf(block, choice) }"
              @click="choose(choice.kind, choice.mode)"
            >
              <div class="cbpk-preview">
                <CompanionBlockPreview :block="preview(choice.kind, choice.mode)" :cell="cell" />
              </div>
              <span class="cbpk-tile-label">
                {{ choice.mode
                  ? t(`companion.settings.modes.${choice.mode}`)
                  : t(`companion.settings.blocks.${choice.kind}`) }}
              </span>
            </button>
          </div>
        </section>
      </div>

      <div class="cbpk-footer">
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="emit('close')">
          {{ t('companion.settings.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cbpk-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.cbpk-dialog {
  background: var(--bs-body-bg, #fff);
  border-radius: 0.75rem;
  width: min(920px, 96vw);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.cbpk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid var(--bs-border-color);
  flex: none;
}
.cbpk-title {
  font-weight: 600;
}
.cbpk-close {
  border: none;
  background: transparent;
  font-size: 1.5rem;
  line-height: 1;
  color: #6b7280;
  cursor: pointer;
  padding: 0 0.25rem;
}
.cbpk-body {
  padding: 0.9rem 1.1rem;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.cbpk-footer {
  flex: none;
  display: flex;
  justify-content: flex-end;
  padding: 0.7rem 1.1rem;
  border-top: 1px solid var(--bs-border-color);
}

.cbpk-group + .cbpk-group {
  margin-top: 1.2rem;
}
.cbpk-group-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.cbpk-param {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: auto;
  color: var(--bs-secondary-color);
}
.cbpk-param select {
  width: auto;
}

/* Des vignettes de même taille : on compare des dessins, et deux tailles
   différentes se liraient comme deux importances différentes. */
.cbpk-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.6rem;
}
.cbpk-tile {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.4rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.6rem;
  background: transparent;
  text-align: center;
  cursor: pointer;
}
.cbpk-tile:hover {
  border-color: var(--bs-primary);
}
.cbpk-tile--current {
  outline: 2px solid var(--bs-primary);
  outline-offset: -2px;
}
/* Assez haut pour que le plus grand des composants — la barre des zones **et**
   sa légende de cinq lignes — tienne en entier : une vignette qui coupe sa
   dernière ligne se lit comme un bogue d'affichage, pas comme un composant plus
   grand que sa case. */
.cbpk-preview {
  height: 11rem;
}
.cbpk-tile-label {
  font-size: 0.85rem;
}

@media (max-width: 640px) {
  .cbpk-backdrop {
    padding: 0;
  }
  .cbpk-dialog {
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
  /* Le sélecteur passe sous le titre du groupe : la ligne serait sinon trop
     serrée pour viser au doigt. */
  .cbpk-param {
    margin-left: 0;
    width: 100%;
  }
  .cbpk-param select {
    flex: 1;
  }
}
</style>
