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
//
// **La vignette a la taille de la case**, et pas celle de la tuile qui la porte.
// Une case de six colonnes fait 48 × 93 px sur le téléphone : dessinée dans un
// carré de 11 rem, elle montrait un chiffre confortable là où il n'y aura la
// place que d'un chiffre serré, et la seule chose qu'on venait vérifier — est-ce
// que ça tient ? — était justement ce qu'elle ne montrait pas. Le rapport de la
// case et le facteur d'échelle sont donc les mêmes que dans la grille de
// l'éditeur (`styleFor`), à un budget de tuile près.
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import CompanionBlockPreview from './CompanionBlockPreview.vue'
import {
  blockChoices, blockFor, isChoiceOf, isDurationMetric, isRangeGaugeMetric, METRIC_RANGE_DEFAULTS,
  metricDropdownLabel, NATURAL_LINE_SIZE, previewScale,
  type Block, type BlockChoice, type Catalog, type CellSize,
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
  // Les séries de tours déjà posées ailleurs dans le profil (pages `laps`,
  // autres boutons `mark_lap`) — suggérées, pas imposées : la clé reste un
  // texte libre, mais un bouton et sa page de tours doivent porter la même
  // clé pour se répondre, et une suggestion évite l'écart d'orthographe.
  knownSeries?: string[]
}>()

const emit = defineEmits<{ close: []; choose: [block: Block] }>()

const metric = ref(props.block?.metric || props.catalog.metrics[0])
const source = ref(props.block?.source || props.catalog.zone_sources[0])
const series = ref(props.block?.series || 'default')
const format = ref(props.block?.format || 'hm')

// La couleur de fond et de texte : contrairement à la mesure ou à la source,
// elle vaut pour n'importe quel genre choisi dans cette dialogue, pas pour un
// seul groupe — d'où un réglage unique, en tête, plutôt que répété dans
// chaque `cbpk-group-head`. `null` tant que rien n'est réglé : l'appli garde
// alors son calcul habituel (couleur de zone, ou gris des cartes) plutôt que
// de recevoir une couleur qu'on n'a pas choisie.
const color = ref<string | null>(props.block?.color || null)
const textColor = ref<string | null>(props.block?.text_color || null)

// Le min/max de la jauge à plage libre : ceux du composant en cours d'édition
// pour sa propre mesure, sinon le repli de `METRIC_RANGE_DEFAULTS` — un point
// de départ plausible plutôt que des champs vides. Recalculés à chaque
// changement de mesure (`watch` plus bas) : le 0–60 km/h de la vitesse n'a
// aucun sens sur la cadence.
function rangeDefaultsFor(m: string): { min: number; max: number } {
  return METRIC_RANGE_DEFAULTS[m] || { min: 0, max: 100 }
}
function initialRangeFor(m: string): { min: number; max: number } {
  if (props.block?.metric === m && props.block?.min != null && props.block?.max != null) {
    return { min: props.block.min, max: props.block.max }
  }
  return rangeDefaultsFor(m)
}
const min = ref(initialRangeFor(metric.value).min)
const max = ref(initialRangeFor(metric.value).max)
watch(metric, (value) => {
  const range = initialRangeFor(value)
  min.value = range.min
  max.value = range.max
})

// Le libellé de liste déroulante (préfixe Di2, raccourcis de durée) est
// partagé avec le bandeau du bas (`CompanionDashboard.vue`) — voir
// `metricDropdownLabel` dans `companionSettings.ts`.
function metricLabel(metric: string): string {
  return metricDropdownLabel(metric, t)
}

// Le catalogue liste les mesures dans l'ordre du serveur ; la dialogue les
// propose triées par libellé affiché, pour qu'on les retrouve sans connaître
// cet ordre-là par cœur.
const sortedMetrics = computed(() => (
  [...props.catalog.metrics].sort((a, b) => metricLabel(a).localeCompare(metricLabel(b)))
))

// Le nom d'une vignette : celui du mode, ou celui du genre quand il n'en a pas.
function labelOf(choice: BlockChoice): string {
  return choice.mode
    ? t(`companion.settings.modes.${choice.mode}`)
    : t(`companion.settings.blocks.${choice.kind}`)
}

interface Tile {
  key: string
  block: Block
  label: string
}

// Les vignettes, regroupées par genre — l'ordre est celui du catalogue, donc
// celui du serveur, qui est aussi l'ordre d'affichage des libellés.
const groups = computed(() => {
  const choices = blockChoices(props.catalog)

  return Object.keys(props.catalog.blocks).map((kind) => {
    const tiles = choices
      .filter((choice) => choice.kind === kind)
      .map((choice) => ({
        key: `${choice.kind}:${choice.mode || ''}`,
        block: blockFor(choice, {
          metric: metric.value, source: source.value, series: series.value, format: format.value,
          min: min.value, max: max.value, color: color.value, textColor: textColor.value,
        }),
        label: labelOf(choice),
      })) as Tile[]

    return { kind, tiles }
  })
})

// Ce que la case fait comme place dans la tuile.
//
// La vignette garde **le rapport de la case et sa taille l'une par rapport à
// l'autre** : une case de six colonnes se dessine dans un timbre, une case de
// deux remplit la tuile. C'est ce qu'on venait voir — la même vignette étalée sur
// toute la tuile disait de tout composant qu'il y a la place.
//
// L'échelle n'est pourtant pas celle de la tuile mais celle du texte : on rend
// une ligne à `TILE_FONT` px quelle que soit la case, et la boîte suit. Mettre
// chaque case à la taille de la tuile aurait **inversé le repère** — la grande
// case, réduite pour tenir, aurait montré un texte plus petit que la petite case
// agrandie, et on aurait lu l'inverse de la vérité. Le rapport à la tuile ne
// revient qu'en plafond, pour les grilles si grossières qu'une case ne tiendrait
// plus dedans (une page d'une seule case fait tout l'écran).
//
// Sans case — une page qui défile — la vignette reste à la taille de la tuile :
// la hauteur y est libre sur le téléphone aussi, rien ne s'y retire.
// La place qu'une tuile laisse à sa vignette : sa colonne (11 rem au moins) moins
// ses marges intérieures, et la hauteur de `.cbpk-preview`. Une case plus large
// que ça — une bande de six colonnes — est réduite pour tenir.
const TILE_WIDTH = 250
const TILE_HEIGHT = 260
const TILE_FONT = 26

const tileStyle = computed(() => {
  const cell = props.cell
  if (!cell) return undefined

  // `lineSize` est ce qu'une ligne mesure sur le téléphone, réduite par
  // `previewScale` comme le fait `ScaleToFit` côté appli, et la vignette écrit
  // ses lignes en 1,15 em — le même rapport que `--cbp-em` dans la grille de
  // l'éditeur, en pixels plutôt qu'en `cqw` parce qu'ici la place est connue.
  const lineSize = NATURAL_LINE_SIZE * previewScale(cell)
  const scale = Math.min(
    (TILE_FONT * 1.15) / lineSize,
    TILE_WIDTH / cell.width,
    TILE_HEIGHT / cell.height,
  )

  return {
    width: `${Math.round(cell.width * scale)}px`,
    height: `${Math.round(cell.height * scale)}px`,
    fontSize: `${((lineSize / 1.15) * scale).toFixed(2)}px`,
  }
})

// La taille de la case, dite en toutes lettres : c'est elle qui explique tout ce
// qui suit — pourquoi la vignette est si petite, pourquoi deux modes se
// ressemblent. Une phrase neutre, parce que la dialogue ne sait pas d'où vient la
// grille : c'est la page qui distingue le téléphone mesuré du téléphone supposé.
const cellNote = computed(() => {
  const cell = props.cell
  if (!cell) return null
  return t('companion.settings.pick_block_cell', {
    width: Math.round(cell.width),
    height: Math.round(cell.height),
  })
})

function choose(block: Block) {
  emit('choose', block)
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
        <p class="text-body-secondary small mb-2">{{ t('companion.settings.pick_block_help') }}</p>
        <p v-if="cellNote" class="text-body-secondary small">{{ cellNote }}</p>

        <!-- Le fond et le texte : un seul réglage pour toute la dialogue, quel que
             soit le genre choisi ensuite — contrairement à la mesure ou à la
             source, qui sont propres à un groupe. Les vignettes ci-dessous se
             redessinent aussitôt, comme pour n'importe quel autre réglage ici. -->
        <div class="cbpk-colors mb-3">
          <label class="cbpk-color-field small">
            {{ t('companion.settings.block_color') }}
            <input type="color" class="form-control form-control-color"
                   :value="color || '#1f2226'"
                   @input="color = ($event.target as HTMLInputElement).value">
          </label>
          <button v-if="color" type="button" class="btn btn-sm btn-link p-0"
                  @click="color = null">
            {{ t('companion.settings.reset_color') }}
          </button>
          <label class="cbpk-color-field small">
            {{ t('companion.settings.block_text_color') }}
            <input type="color" class="form-control form-control-color"
                   :value="textColor || '#ffffff'"
                   @input="textColor = ($event.target as HTMLInputElement).value">
          </label>
          <button v-if="textColor" type="button" class="btn btn-sm btn-link p-0"
                  @click="textColor = null">
            {{ t('companion.settings.reset_color') }}
          </button>
        </div>

        <section v-for="group in groups" :key="group.kind" class="cbpk-group">
          <div class="cbpk-group-head">
            <h3 class="h6 mb-0">{{ t(`companion.settings.blocks.${group.kind}`) }}</h3>

            <!-- Le paramètre du genre, en tête de son groupe : les vignettes
                 en dessous le dessinent aussitôt. -->
            <label v-if="group.kind === 'metric'" class="cbpk-param small">
              {{ t('companion.settings.metric') }}
              <select v-model="metric" class="form-select form-select-sm">
                <option v-for="m in sortedMetrics" :key="m" :value="m">
                  {{ metricLabel(m) }}
                </option>
              </select>
            </label>

            <label v-if="group.kind === 'metric' && isDurationMetric(metric)" class="cbpk-param small">
              {{ t('companion.settings.duration_format') }}
              <select v-model="format" class="form-select form-select-sm">
                <option value="hm">{{ t('companion.settings.duration_formats.hm') }}</option>
                <option value="hms">{{ t('companion.settings.duration_formats.hms') }}</option>
              </select>
            </label>

            <div
              v-else-if="group.kind === 'metric' && isRangeGaugeMetric(metric)"
              class="cbpk-param small cbpk-param-range"
            >
              <label class="cbpk-range-field">
                {{ t('companion.settings.range_min') }}
                <input v-model.number="min" type="number" class="form-control form-control-sm">
              </label>
              <label class="cbpk-range-field">
                {{ t('companion.settings.range_max') }}
                <input v-model.number="max" type="number" class="form-control form-control-sm">
              </label>
            </div>

            <label v-else-if="group.kind === 'zones' || group.kind === 'lap_zones'" class="cbpk-param small">
              {{ t('companion.settings.source') }}
              <select v-model="source" class="form-select form-select-sm">
                <option v-for="s in catalog.zone_sources" :key="s" :value="s">
                  {{ t(`companion.settings.sources.${s}`) }}
                </option>
              </select>
            </label>

            <label v-else-if="group.kind === 'mark_lap'" class="cbpk-param small">
              {{ t('companion.settings.lap_series') }}
              <input
                v-model="series"
                type="text"
                list="cbpk-series-list"
                class="form-control form-control-sm"
              >
            </label>
          </div>

          <p v-if="group.kind === 'mark_lap'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.lap_series_cols_hint') }}
          </p>

          <div class="cbpk-tiles">
            <button
              v-for="tile in group.tiles"
              :key="tile.key"
              type="button"
              class="cbpk-tile"
              :class="{ 'cbpk-tile--current': isChoiceOf(block, tile.block) }"
              @click="choose(tile.block)"
            >
              <!-- La boîte extérieure garde la place d'une tuile pleine, celle de
                   dedans a le rapport de la case : les tuiles restent alignées
                   quand les vignettes, elles, n'ont plus la même forme. -->
              <div class="cbpk-preview">
                <div class="cbpk-cell" :style="tileStyle">
                  <CompanionBlockPreview :block="tile.block" />
                </div>
              </div>
              <span class="cbpk-tile-label">{{ tile.label }}</span>
            </button>
          </div>
        </section>

        <datalist id="cbpk-series-list">
          <option v-for="s in knownSeries" :key="s" :value="s" />
        </datalist>
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
  width: min(1100px, 96vw);
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
/* Deux champs plutôt qu'un select : chacun garde son propre libellé au lieu
   de se disputer celui du conteneur. */
.cbpk-param-range {
  gap: 0.75rem;
}
.cbpk-range-field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.cbpk-range-field input {
  width: 4.5rem;
}

.cbpk-colors {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.cbpk-color-field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0;
}
.cbpk-color-field input {
  width: 2.5rem;
  padding: 0.15rem;
}

/* Des vignettes de même taille : on compare des dessins, et deux tailles
   différentes se liraient comme deux importances différentes. */
.cbpk-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
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
   grand que sa case.

   C'est aussi le budget dans lequel `tileStyle` fait tenir la case : les deux
   valeurs sont les mêmes des deux côtés (`TILE_WIDTH`, `TILE_HEIGHT`). */
.cbpk-preview {
  height: 16.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* La vignette elle-même. Sans case (une page qui défile) elle prend toute la
   tuile : `tileStyle` ne pose alors ni taille ni échelle, et c'est la
   `font-size` de repli qui vaut — celle d'avant, où la hauteur était libre. */
.cbpk-cell {
  width: 100%;
  height: 100%;
  font-size: 1.15rem;
}
.cbpk-cell :deep(.cbp) {
  font-size: inherit;
}

.cbpk-tile-label {
  font-size: 0.95rem;
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
