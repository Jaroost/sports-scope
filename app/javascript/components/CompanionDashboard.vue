<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import CompanionBlockPicker from './CompanionBlockPicker.vue'
import CompanionBlockPreview from './CompanionBlockPreview.vue'
import {
  fitCells, maxSpan, occupancy,
  type Band, type Block, type Catalog, type Cell, type CompanionDocument,
  type Page, type Preset,
} from '../companionSettings'

// L'éditeur des profils de sortie de l'app compagnon.
//
// Ce qu'il compose est ce que le téléphone affichera pendant une sortie : les
// pages du tableau de bord, leur contenu, les jeux de valeurs du bandeau, les
// capteurs utilisés.
//
// **Le principe qui gouverne toute l'ergonomie : on ne doit pas pouvoir composer
// ce que l'application jettera.** Elle applique ses propres garanties (au plus une
// carte, quatre cases de bandeau, pas de cellules qui se recouvrent) mais en
// silence, sur la route. D'où trois choses ici : les étendues de cellules sont
// bornées à la place réellement libre (`maxSpan`), la carte ne s'ajoute plus quand
// il y en a déjà une, et l'enregistrement **réaffiche le document assaini** rendu
// par le serveur. Ce qu'on voit après « Enregistrer » est exactement ce que l'appli
// recevra.
//
// Pas de glisser-déposer : on compose ça une fois pour toutes, souvent sur un
// portable, parfois sur une tablette. Des boutons ↑ ↓ et une grille qu'on tape
// marchent au doigt comme à la souris, et coûtent le dixième du code.
//
// **Ce qu'on pose, on le voit** : le contenu des pages passe par une dialogue de
// choix à vignettes (`CompanionBlockPicker`), et chaque composant déjà posé est
// dessiné là où il est (`CompanionBlockPreview`) plutôt que nommé. Trois listes
// déroulantes demandaient de se figurer ce que « Jauge » ou « Aplat de zone »
// veulent dire, et la réponse n'arrivait qu'en pleine sortie — sur le seul écran
// qu'on ne peut plus modifier.

const props = defineProps<{ document: CompanionDocument; catalog: Catalog }>()

const presets = reactive<Preset[]>(structuredClone(props.document.presets))
const current = ref(0)
const openPage = ref<number | null>(null)
const selected = ref<Cell | null>(null)

// Où ira le composant que la dialogue va rendre. Quatre destinations et pas une
// seule : poser dans une case vide n'est pas remplacer une cellule, et ajouter à
// la fin d'une page qui défile n'est pas y modifier une ligne. Les distinguer
// ici évite un « si la cellule existe alors… » réparti sur quatre appelants.
type PickerTarget =
  | { at: 'cell'; cell: Cell }
  | { at: 'slot'; page: Page; row: number; col: number }
  | { at: 'block'; page: Page; index: number }
  | { at: 'append'; page: Page }

const picker = ref<PickerTarget | null>(null)

// Le composant que la dialogue doit montrer comme courant : celui qu'on
// modifie, ou rien du tout quand on en ajoute un.
const pickerBlock = computed<Block | null>(() => {
  const target = picker.value
  if (!target) return null
  if (target.at === 'cell') return target.cell.block
  if (target.at === 'block') return target.page.blocks?.[target.index] || null
  return null
})

const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | null = null

const preset = computed(() => presets[current.value])
const hasMap = computed(() => preset.value.pages.some((page) => page.kind === 'map'))

// ── les profils ─────────────────────────────────────────────────────────────

function select(index: number) {
  current.value = index
  openPage.value = null
  selected.value = null
}

function addPreset() {
  // Un profil neuf part avec une carte et une page d'effort : c'est le tableau de
  // bord intégré, celui que tout le monde reconnaît. Partir d'une page blanche
  // obligerait à tout reconstruire pour obtenir ce qu'on avait déjà.
  presets.push({
    name: t('companion.settings.new_preset'),
    pages: [
      { kind: 'map' },
      {
        kind: 'list',
        title: t('companion.settings.page_effort'),
        blocks: [
          { kind: 'recording', mode: 'full' },
          { kind: 'zones', source: 'hr', mode: 'bar' },
          { kind: 'averages', mode: 'cards' },
        ],
      },
    ],
    bands: [
      { metrics: ['duration', 'distance', 'speed', 'power'] },
      { metrics: ['heart_rate', 'hr_zone', 'power', 'power_zone'] },
    ],
  })
  select(presets.length - 1)
}

function duplicatePreset() {
  // Sans clé : le serveur en fabriquera une, suffixée pour ne pas écraser
  // l'original. La recopier ici ferait perdre l'un des deux profils.
  const copy = structuredClone({ ...preset.value, key: undefined }) as Preset
  copy.name = `${preset.value.name} (2)`
  presets.splice(current.value + 1, 0, copy)
  select(current.value + 1)
}

function removePreset() {
  presets.splice(current.value, 1)
  select(Math.max(0, current.value - 1))
}

// ── les pages ───────────────────────────────────────────────────────────────

function addPage(kind: string) {
  if (kind === 'map') preset.value.pages.push({ kind: 'map' })
  else if (kind === 'grid') {
    preset.value.pages.push({
      kind: 'grid', title: t('companion.settings.page_numbers'), rows: 2, cols: 2,
      cells: [{ row: 0, col: 0, row_span: 1, col_span: 1,
                block: { kind: 'metric', metric: 'speed', mode: 'big' } }],
    })
  } else {
    preset.value.pages.push({
      kind: 'list', title: t('companion.settings.page_effort'),
      blocks: [{ kind: 'recording', mode: 'full' }],
    })
  }
  openPage.value = preset.value.pages.length - 1
  selected.value = null
}

function movePage(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= preset.value.pages.length) return
  const [page] = preset.value.pages.splice(index, 1)
  preset.value.pages.splice(target, 0, page)
  openPage.value = target
}

function removePage(index: number) {
  preset.value.pages.splice(index, 1)
  openPage.value = null
  selected.value = null
}

function togglePage(index: number) {
  openPage.value = openPage.value === index ? null : index
  selected.value = null
}

// ── la grille ───────────────────────────────────────────────────────────────

function resize(page: Page, axis: 'rows' | 'cols', value: number) {
  const side = Math.min(Math.max(value, 1), props.catalog.max_grid_side)
  page[axis] = side
  page.cells = fitCells(page.cells || [], page.rows || 1, page.cols || 1)
  if (selected.value && !page.cells.includes(selected.value)) selected.value = null
}

// Ce qu'on dessine : une entrée par case de la grille, en sautant celles qu'une
// cellule fusionnée recouvre déjà.
function slots(page: Page) {
  const cells = page.cells || []
  const busy = occupancy(cells)
  const out: { key: string; row: number; col: number; cell: Cell | null }[] = []

  for (let row = 0; row < (page.rows || 1); row++) {
    for (let col = 0; col < (page.cols || 1); col++) {
      const cell = busy.get(`${row}:${col}`) || null
      // La case n'est rendue qu'à l'origine de la cellule qui l'occupe : les
      // suivantes sont sous la fusion, il n'y a rien à y afficher.
      if (cell && (cell.row !== row || cell.col !== col)) continue
      out.push({ key: `${row}:${col}`, row, col, cell })
    }
  }
  return out
}

function tapSlot(page: Page, row: number, col: number, cell: Cell | null) {
  if (cell) {
    selected.value = selected.value === cell ? null : cell
    return
  }
  // Une case vide ouvre la dialogue plutôt que de poser une mesure par défaut :
  // celle-ci demandait de deviner ce qu'on voulait, puis de la corriger dans un
  // panneau plus bas — deux gestes pour un choix qu'on n'avait pas fait.
  picker.value = { at: 'slot', page, row, col }
}

// Le composant sorti de la dialogue, posé là où on l'a demandée.
function applyPick(block: Block) {
  const target = picker.value
  picker.value = null
  if (!target) return

  switch (target.at) {
    case 'cell':
      target.cell.block = block
      break
    case 'slot': {
      const cells = [...(target.page.cells || []),
        { row: target.row, col: target.col, row_span: 1, col_span: 1, block }]
      target.page.cells = cells
      // On relit la cellule dans le tableau plutôt que de garder l'objet qu'on
      // vient d'écrire : `presets` est réactif, donc ce qui en ressort est un
      // proxy et non l'original. Les comparer par identité — ce que font le
      // liseré de sélection et la suppression — échouerait silencieusement, et
      // la cellule qu'on vient de poser deviendrait impossible à modifier.
      selected.value = target.page.cells![target.page.cells!.length - 1]
      break
    }
    case 'block':
      if (target.page.blocks) target.page.blocks[target.index] = block
      break
    case 'append':
      target.page.blocks = [...(target.page.blocks || []), block]
      break
  }
}

function removeCell(page: Page) {
  page.cells = (page.cells || []).filter((cell) => cell !== selected.value)
  selected.value = null
}

// L'étendue proposée ne dépasse jamais la place libre : c'est ce qui garantit
// qu'on ne compose pas une cellule que l'assainisseur retirera.
function spanLimit(page: Page, axis: 'row' | 'col'): number {
  if (!selected.value) return 1
  return maxSpan(selected.value, page.cells || [], page.rows || 1, page.cols || 1, axis)
}

// Bornée **à la saisie** et pas seulement par l'attribut `max` : celui-ci n'empêche
// pas de taper 6 dans un champ qui n'en accepte que 2, et la cellule voisine
// disparaîtrait alors à l'enregistrement — exactement ce qu'on cherche à rendre
// impossible.
function setSpan(page: Page, axis: 'row' | 'col', value: number) {
  if (!selected.value) return
  const span = Math.min(Math.max(value || 1, 1), spanLimit(page, axis))
  if (axis === 'row') selected.value.row_span = span
  else selected.value.col_span = span
}

function styleFor(cell: Cell | null, row: number, col: number) {
  const rowSpan = cell?.row_span || 1
  const colSpan = cell?.col_span || 1
  return {
    gridRow: `${row + 1} / span ${rowSpan}`,
    gridColumn: `${col + 1} / span ${colSpan}`,
  }
}

// Le nom de ce qui est posé : le genre, son paramètre, son mode. La vignette
// dit déjà à quoi ça ressemble — ce libellé sert à le **nommer**, ce qu'un
// dessin ne fait pas : c'est lui qu'on relit pour vérifier qu'on a bien mis la
// puissance normalisée et non la puissance moyenne.
function labelFor(block: Block): string {
  const parts = [t(`companion.settings.blocks.${block.kind}`)]
  if (block.kind === 'metric') parts.push(t(`companion.settings.metrics.${block.metric}`))
  if (block.kind === 'zones') parts.push(t(`companion.settings.sources.${block.source}`))
  if (block.mode) parts.push(t(`companion.settings.modes.${block.mode}`))
  return parts.join(' · ')
}

// ── la page qui défile ──────────────────────────────────────────────────────

function addBlock(page: Page) {
  picker.value = { at: 'append', page }
}

function moveBlock(page: Page, index: number, delta: number) {
  const blocks = page.blocks || []
  const target = index + delta
  if (target < 0 || target >= blocks.length) return
  const [block] = blocks.splice(index, 1)
  blocks.splice(target, 0, block)
}

// ── le bandeau ──────────────────────────────────────────────────────────────

function addBand() {
  preset.value.bands.push({ metrics: ['duration', 'distance', 'speed', 'power'] })
}

function setBandMetric(band: Band, index: number, value: string) {
  // La chaîne vide vide la case : un jeu peut porter moins de quatre mesures, et
  // c'est le seul moyen d'en retirer une du milieu.
  if (value === '') band.metrics.splice(index, 1)
  else band.metrics[index] = value
}

// ── les capteurs et les réglages ────────────────────────────────────────────

// Absent vaut activé : on ne stocke que les coupures. Une case décochée écrit
// donc `false`, une case cochée efface la clé.
function sensorOn(name: string): boolean {
  return preset.value.sensors?.[name] !== false
}

function setSensor(name: string, on: boolean) {
  const sensors = { ...(preset.value.sensors || {}) }
  if (on) delete sensors[name]
  else sensors[name] = false
  preset.value.sensors = Object.keys(sensors).length > 0 ? sensors : undefined
}

function radarValue(key: string, fallback: number): number {
  const value = preset.value.radar?.[key]
  return typeof value === 'number' ? value : fallback
}

function setRadar(key: string, value: number | boolean) {
  preset.value.radar = { ...(preset.value.radar || {}), [key]: value }
}

// ── enregistrer ─────────────────────────────────────────────────────────────

async function save() {
  saving.value = true
  error.value = null
  try {
    const res = await fetch('/api/companion_settings', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ presets }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    // On se réaligne sur ce que le serveur a réellement gardé. C'est le point :
    // l'appli appliquerait les mêmes corrections en silence et sur la route ;
    // les montrer ici est la seule occasion de s'en apercevoir.
    const payload = (await res.json()) as CompanionDocument
    presets.splice(0, presets.length, ...payload.presets)
    current.value = Math.min(current.value, presets.length - 1)
    openPage.value = null
    selected.value = null

    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { saved.value = false }, 2500)
  } catch (e) {
    error.value = (e as Error).message || 'error'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="companion-editor">
    <!-- Les profils -->
    <ul class="nav nav-pills gap-1 mb-3 align-items-center">
      <li v-for="(item, index) in presets" :key="index" class="nav-item">
        <button class="nav-link" :class="{ active: index === current }"
                type="button" @click="select(index)">
          {{ item.name }}
        </button>
      </li>
      <li class="nav-item">
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="addPreset">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('companion.settings.add_preset') }}
        </button>
      </li>
    </ul>

    <div v-if="preset" class="card mb-3">
      <div class="card-body">
        <div class="row g-2 align-items-end mb-3">
          <div class="col">
            <label class="form-label small mb-1">{{ t('companion.settings.name') }}</label>
            <input v-model="preset.name" class="form-control" type="text">
          </div>
          <div class="col-auto">
            <button class="btn btn-outline-secondary" type="button" @click="duplicatePreset">
              <i class="fa-regular fa-copy me-1" aria-hidden="true"></i>{{ t('companion.settings.duplicate') }}
            </button>
          </div>
          <div class="col-auto">
            <button class="btn btn-outline-danger" type="button"
                    :disabled="presets.length <= 1" @click="removePreset">
              <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <!-- Les pages -->
        <h2 class="h6">{{ t('companion.settings.pages') }}</h2>
        <p class="text-body-secondary small">{{ t('companion.settings.pages_help') }}</p>

        <div v-for="(page, index) in preset.pages" :key="index" class="border rounded mb-2">
          <div class="d-flex align-items-center gap-2 p-2">
            <span class="badge text-bg-secondary">{{ t(`companion.settings.page_kinds.${page.kind}`) }}</span>
            <span class="flex-grow-1 text-truncate">{{ page.title || t('companion.settings.page_kinds.map') }}</span>
            <button class="btn btn-sm btn-link p-1" type="button"
                    :disabled="index === 0" @click="movePage(index, -1)">
              <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
            </button>
            <button class="btn btn-sm btn-link p-1" type="button"
                    :disabled="index === preset.pages.length - 1" @click="movePage(index, 1)">
              <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
            </button>
            <button v-if="page.kind !== 'map'" class="btn btn-sm btn-outline-secondary"
                    type="button" @click="togglePage(index)">
              {{ t('companion.settings.edit') }}
            </button>
            <button class="btn btn-sm btn-link text-danger p-1" type="button"
                    @click="removePage(index)">
              <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
            </button>
          </div>

          <div v-if="openPage === index" class="border-top p-2">
            <input v-model="page.title" class="form-control form-control-sm mb-2"
                   :placeholder="t('companion.settings.page_title')">

            <!-- Une grille -->
            <template v-if="page.kind === 'grid'">
              <div class="d-flex align-items-center gap-3 mb-2">
                <label class="small mb-0">{{ t('companion.settings.rows') }}
                  <input class="form-control form-control-sm d-inline-block ms-1"
                         style="width: 5rem" type="number" min="1"
                         :max="catalog.max_grid_side" :value="page.rows"
                         @input="resize(page, 'rows', Number(($event.target as HTMLInputElement).value))">
                </label>
                <label class="small mb-0">{{ t('companion.settings.cols') }}
                  <input class="form-control form-control-sm d-inline-block ms-1"
                         style="width: 5rem" type="number" min="1"
                         :max="catalog.max_grid_side" :value="page.cols"
                         @input="resize(page, 'cols', Number(($event.target as HTMLInputElement).value))">
                </label>
              </div>

              <p class="text-body-secondary small">{{ t('companion.settings.grid_help') }}</p>

              <div class="companion-grid mb-2"
                   :style="{ gridTemplateColumns: `repeat(${page.cols}, 1fr)`,
                             gridTemplateRows: `repeat(${page.rows}, 1fr)` }">
                <button v-for="slot in slots(page)" :key="slot.key" type="button"
                        class="companion-cell"
                        :class="{ filled: !!slot.cell, selected: slot.cell === selected }"
                        :style="styleFor(slot.cell, slot.row, slot.col)"
                        :title="slot.cell ? labelFor(slot.cell.block) : t('companion.settings.add_block')"
                        @click="tapSlot(page, slot.row, slot.col, slot.cell)">
                  <CompanionBlockPreview v-if="slot.cell" :block="slot.cell.block" />
                  <i v-else class="fa-solid fa-plus text-body-secondary" aria-hidden="true"></i>
                </button>
              </div>

              <div v-if="selected" class="border rounded p-2 bg-body-tertiary">
                <div class="d-flex align-items-center gap-2">
                  <span class="flex-grow-1 text-truncate small">{{ labelFor(selected.block) }}</span>
                  <button class="btn btn-sm btn-outline-secondary" type="button"
                          @click="picker = { at: 'cell', cell: selected }">
                    {{ t('companion.settings.change_block') }}
                  </button>
                </div>
                <div class="d-flex align-items-end gap-3 mt-2">
                  <label class="small mb-0">{{ t('companion.settings.row_span') }}
                    <input class="form-control form-control-sm d-inline-block ms-1"
                           style="width: 4.5rem" type="number" min="1"
                           :max="spanLimit(page, 'row')" :value="selected.row_span"
                           @input="setSpan(page, 'row', Number(($event.target as HTMLInputElement).value))">
                  </label>
                  <label class="small mb-0">{{ t('companion.settings.col_span') }}
                    <input class="form-control form-control-sm d-inline-block ms-1"
                           style="width: 4.5rem" type="number" min="1"
                           :max="spanLimit(page, 'col')" :value="selected.col_span"
                           @input="setSpan(page, 'col', Number(($event.target as HTMLInputElement).value))">
                  </label>
                  <button class="btn btn-sm btn-outline-danger ms-auto" type="button"
                          @click="removeCell(page)">
                    {{ t('companion.settings.remove_cell') }}
                  </button>
                </div>
              </div>
            </template>

            <!-- Une page qui défile : les composants dans l'ordre où elle les
                 empile, chacun dessiné tel qu'il paraîtra. -->
            <template v-else>
              <div v-for="(block, i) in page.blocks" :key="i"
                   class="d-flex align-items-center gap-2 mb-2">
                <div class="companion-block-preview flex-shrink-0">
                  <CompanionBlockPreview :block="block" />
                </div>
                <span class="flex-grow-1 text-truncate small">{{ labelFor(block) }}</span>
                <button class="btn btn-sm btn-outline-secondary" type="button"
                        @click="picker = { at: 'block', page, index: i }">
                  {{ t('companion.settings.change_block') }}
                </button>
                <div class="d-flex flex-column">
                  <button class="btn btn-sm btn-link p-0" type="button"
                          :disabled="i === 0" @click="moveBlock(page, i, -1)">
                    <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
                  </button>
                  <button class="btn btn-sm btn-link p-0" type="button"
                          :disabled="i === (page.blocks?.length || 0) - 1"
                          @click="moveBlock(page, i, 1)">
                    <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
                  </button>
                </div>
                <button class="btn btn-sm btn-link text-danger p-0" type="button"
                        @click="page.blocks!.splice(i, 1)">
                  <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
                </button>
              </div>
              <button class="btn btn-sm btn-outline-secondary" type="button"
                      @click="addBlock(page)">
                <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('companion.settings.add_block') }}
              </button>
            </template>
          </div>
        </div>

        <div class="d-flex gap-2 mb-4">
          <button v-for="kind in catalog.page_kinds" :key="kind"
                  class="btn btn-sm btn-outline-secondary" type="button"
                  :disabled="kind === 'map' && hasMap" @click="addPage(kind)">
            <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t(`companion.settings.page_kinds.${kind}`) }}
          </button>
        </div>

        <!-- Le bandeau -->
        <h2 class="h6">{{ t('companion.settings.bands') }}</h2>
        <p class="text-body-secondary small">{{ t('companion.settings.bands_help') }}</p>

        <div v-for="(band, index) in preset.bands" :key="index"
             class="d-flex align-items-center gap-2 mb-2">
          <div class="row g-1 flex-grow-1">
            <div v-for="slot in catalog.max_band_metrics" :key="slot" class="col-6 col-sm-3">
              <select class="form-select form-select-sm"
                      :value="band.metrics[slot - 1] || ''"
                      @change="setBandMetric(band, slot - 1, ($event.target as HTMLSelectElement).value)">
                <option value="">—</option>
                <option v-for="metric in catalog.metrics" :key="metric" :value="metric">
                  {{ t(`companion.settings.metrics.${metric}`) }}
                </option>
              </select>
            </div>
          </div>
          <button class="btn btn-sm btn-link text-danger p-1" type="button"
                  :disabled="preset.bands.length <= 1" @click="preset.bands.splice(index, 1)">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
        <button class="btn btn-sm btn-outline-secondary mb-4" type="button" @click="addBand">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('companion.settings.add_band') }}
        </button>

        <!-- Les capteurs -->
        <h2 class="h6">{{ t('companion.settings.sensors_title') }}</h2>
        <p class="text-body-secondary small">{{ t('companion.settings.sensors_help') }}</p>

        <div class="row g-2 mb-4">
          <div v-for="sensor in catalog.sensors" :key="sensor" class="col-6 col-md-4">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" :id="`sensor-${sensor}`"
                     :checked="sensorOn(sensor)"
                     @change="setSensor(sensor, ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" :for="`sensor-${sensor}`">
                {{ t(`companion.settings.sensors.${sensor}`) }}
              </label>
            </div>
          </div>
        </div>

        <!-- Le radar -->
        <h2 class="h6">{{ t('companion.settings.radar_title') }}</h2>
        <div class="row g-2 align-items-end">
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">{{ t('companion.settings.close_m') }}</label>
            <input class="form-control form-control-sm" type="number" min="1"
                   :value="radarValue('close_m', 40)"
                   @input="setRadar('close_m', Number(($event.target as HTMLInputElement).value))">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">{{ t('companion.settings.range_m') }}</label>
            <input class="form-control form-control-sm" type="number" min="1"
                   :value="radarValue('range_m', 140)"
                   @input="setRadar('range_m', Number(($event.target as HTMLInputElement).value))">
          </div>
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="radar-sounds"
                     :checked="preset.radar?.sounds !== false"
                     @change="setRadar('sounds', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="radar-sounds">
                {{ t('companion.settings.radar_sounds') }}
              </label>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="radar-wake"
                     :checked="preset.radar?.wake_screen !== false"
                     @change="setRadar('wake_screen', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="radar-wake">
                {{ t('companion.settings.radar_wake') }}
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Enregistrer -->
    <div class="d-flex align-items-center gap-3">
      <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
        <span v-if="saving" class="spinner-border spinner-border-sm me-2" role="status"></span>
        {{ t('companion.settings.save') }}
      </button>
      <span v-if="saved" class="text-success small">
        <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('companion.settings.saved') }}
      </span>
      <span v-if="error" class="text-danger small">{{ t('companion.settings.error') }} ({{ error }})</span>
    </div>

    <p class="text-body-secondary small mt-2">{{ t('companion.settings.save_help') }}</p>

    <!-- Montée par `v-if` : la dialogue pose son écouteur clavier au montage, et
         une dialogue toujours montée mangerait la touche Échap de l'éditeur. -->
    <CompanionBlockPicker v-if="picker" :block="pickerBlock" :catalog="catalog"
                          @choose="applyPick" @close="picker = null" />
  </div>
</template>

<style scoped>
/* Aux proportions de l'écran du téléphone, et non à la largeur de la page :
   étalée sur 60 rem, une grille de 2 × 2 donnait des cases en bandeau là où le
   cycliste en aura des carrés debout — on composait donc pour une mise en page
   qui n'existe nulle part. La hauteur est fixe et les lignes se partagent la
   place (`1fr`) : ajouter une ligne resserre les cases, exactement comme sur
   l'écran, plutôt que d'allonger un écran qui ne s'allonge pas. */
.companion-grid {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  max-width: 16rem;
  height: 27rem;
}

/* Les cases posées portent la vignette du composant : la disposition est exacte,
   et le dessin l'est autant que la page HTML peut l'être (cf.
   `CompanionBlockPreview`). Rien n'est écrit dessus — le nom est sur la ligne du
   panneau d'édition, et deux textes superposés à cette taille ne se liraient ni
   l'un ni l'autre. */
.companion-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.5rem;
  background: transparent;
  padding: 0;
  text-align: center;
  overflow: hidden;
}

.companion-cell.filled {
  border-style: solid;
}

/* La vignette se met à l'échelle par sa `font-size` : dans une case de grille,
   la taille de la dialogue de choix déborderait de partout. */
.companion-cell :deep(.cbp) {
  font-size: 0.5rem;
  border-radius: 0.5rem;
  width: 100%;
}

/* Sur une page qui défile, le composant occupe toute la largeur de l'écran du
   téléphone : la vignette garde donc ses proportions, en plus petit. */
.companion-block-preview {
  width: 7.5rem;
  height: 4.5rem;
}
.companion-block-preview :deep(.cbp) {
  font-size: 0.42rem;
}

.companion-cell.selected {
  outline: 2px solid var(--bs-primary);
  outline-offset: -2px;
}
</style>
