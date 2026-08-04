<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import CompanionBlockPicker from './CompanionBlockPicker.vue'
import CompanionBlockPreview from './CompanionBlockPreview.vue'
import {
  canHideBehindMenu, fitCells, gridSideOf, maxSpan, NATURAL_LINE_SIZE,
  occupancy, phoneCell, previewScale, PHONE_GRID,
  type Band, type Block, type Catalog, type Cell, type CellSize,
  type CompanionDocument, type Page, type Preset, type Viewport,
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

const props = defineProps<{
  document: CompanionDocument
  catalog: Catalog
  // La grille du téléphone, telle que l'appli l'a mesurée en posant une page —
  // `null` tant qu'elle n'a rien dit, ce qui est le cas avant le premier
  // lancement. On dimensionne alors sur un téléphone ordinaire, et on l'annonce
  // plutôt que de laisser croire qu'on parle du sien.
  viewport?: Viewport | null
}>()

const grid = computed<Viewport>(() => props.viewport || PHONE_GRID)
const measured = computed(() => !!props.viewport)

const presets = reactive<Preset[]>(structuredClone(props.document.presets))
const current = ref(0)
const openPage = ref<number | null>(null)
const selected = ref<Cell | null>(null)

// Où ira le composant que la dialogue va rendre. Quatre destinations et pas une
// seule : poser dans une case vide n'est pas remplacer une cellule, et ajouter à
// la fin d'une page qui défile n'est pas y modifier une ligne. Les distinguer
// ici évite un « si la cellule existe alors… » réparti sur quatre appelants.
type PickerTarget =
  | { at: 'cell'; page: Page; cell: Cell }
  | { at: 'slot'; page: Page; row: number; col: number }
  | { at: 'block'; page: Page; index: number }
  | { at: 'append'; page: Page }

const picker = ref<PickerTarget | null>(null)

// La place qu'aura le composant qu'on est en train de choisir, pour que les
// vignettes de la dialogue montrent ce que **cette case-là** dessinera : une
// légende de zones proposée pour une case qui ne la portera pas est un choix
// qu'on regrette en roulant. Rien pour une page qui défile : la hauteur y est
// libre, tout se dessine.
const pickerCell = computed<CellSize | undefined>(() => {
  const target = picker.value
  if (!target) return undefined
  if (target.at === 'cell') return sizeFor(target.page, target.cell)
  if (target.at === 'slot') {
    return phoneCell(target.page.rows || 1, target.page.cols || 1, 1, 1, grid.value)
  }
  return undefined
})

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

// Ranger une page derrière le menu, ou la rendre au défilement.
//
// Le bouton s'éteint quand le déplacement n'est pas permis (`canHideBehindMenu`)
// plutôt que d'être corrigé à l'enregistrement : c'est la même règle que partout
// ici — la limite se voit au lieu de se deviner.
function toggleMenuPage(page: Page) {
  if (!canHideBehindMenu(page, preset.value.pages)) return
  // La clé est effacée et non mise à `false` : le document ne porte que ce qui
  // s'écarte du défaut, comme les capteurs coupés.
  if (page.menu) delete page.menu
  else page.menu = true
}

// Combien de pages restent à faire défiler. Sert à dire, sous la liste, ce que le
// cycliste trouvera au glissé et ce qu'il devra aller chercher.
const swipeCount = computed(
  () => preset.value.pages.filter((page) => !page.menu).length,
)

// ── la grille ───────────────────────────────────────────────────────────────

// Le nombre de lignes / colonnes, validé **quand on quitte le champ** et non à
// chaque frappe.
//
// À la frappe, c'était intenable au doigt : pour remplacer 6 par 2 on efface
// d'abord, or un champ vide vaut 0, ramené à 1 — ce qui **jetait au passage
// toutes les cellules des lignes 2 à 6** (`fitCells` perd une origine hors
// grille, à dessein). Vue réécrivait ensuite « 1 » dans le champ, si bien que le
// « 2 » tapé ensuite donnait « 12 », borné à 6 : la grille refusait de rétrécir
// et le contenu était déjà perdu. Sur ordinateur ça passait inaperçu — on
// sélectionne le chiffre et on tape par-dessus, ce qui ne fait qu'une seule
// saisie valide.
function commitSide(page: Page, axis: 'rows' | 'cols', input: HTMLInputElement) {
  const side = Math.min(gridSideOf(input.value), props.catalog.max_grid_side)
  page[axis] = side
  page.cells = fitCells(page.cells || [], page.rows || 1, page.cols || 1)
  if (selected.value && !page.cells.includes(selected.value)) selected.value = null
  repaint(input, side)
}

// Le champ peut afficher autre chose que ce qu'on a gardé — « 12 » ramené à 6, un
// champ vide ramené à sa valeur. Vue ne repeint pas un `:value` dont l'expression
// n'a pas changé, d'où cette remise à la main : sans elle, le champ montrerait un
// nombre que le document ne contient pas.
function repaint(input: HTMLInputElement, value: number) {
  input.value = String(value)
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

function spanOf(cell: Cell, axis: 'row' | 'col'): number {
  return axis === 'row' ? cell.row_span : cell.col_span
}

// L'étendue se règle d'un pas à la fois, et non en tapant un nombre.
//
// Un champ demandait de connaître d'avance la place libre — taper 3 là où il n'y
// a que 2 donnait 2 sans qu'on sache pourquoi — et souffrait du travers de
// [commitSide] au doigt : effacer pour retaper renvoyait un 1 qui se collait au
// chiffre suivant. Un pas ne peut pas sortir de l'intervalle, et le bouton
// s'éteint quand il n'y a plus de place : **la limite se voit au lieu de se
// deviner**, ce qui est la même règle que partout ici — on ne compose pas ce que
// l'assainisseur jettera.
function stepSpan(page: Page, axis: 'row' | 'col', delta: number) {
  const cell = selected.value
  if (!cell) return

  const span = spanOf(cell, axis) + delta
  if (span < 1 || span > spanLimit(page, axis)) return
  if (axis === 'row') cell.row_span = span
  else cell.col_span = span
}

function styleFor(page: Page, cell: Cell | null, row: number, col: number) {
  const rowSpan = cell?.row_span || 1
  const colSpan = cell?.col_span || 1
  const size = phoneCell(page.rows || 1, page.cols || 1, rowSpan, colSpan, grid.value)

  return {
    gridRow: `${row + 1} / span ${rowSpan}`,
    gridColumn: `${col + 1} / span ${colSpan}`,
    // La vignette est dessinée à l'échelle du téléphone : `1cqw` vaut 1 % de la
    // largeur de la case **dans l'éditeur**, si bien que rapporter la taille de
    // ligne du téléphone (réduite comme `ScaleToFit` la réduirait) à la largeur
    // qu'aura la case sur son écran rend la même proportion des deux côtés —
    // quelle que soit la place que la page web laisse à la grille.
    '--cbp-em': `${(NATURAL_LINE_SIZE * previewScale(size) / 1.15 / size.width) * 100}`,
  }
}

// La place qu'aura une case sur le téléphone, pour la vignette qui s'y dessine.
function sizeFor(page: Page, cell: Cell): CellSize {
  return phoneCell(
    page.rows || 1, page.cols || 1, cell.row_span, cell.col_span, grid.value,
  )
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
        <div class="mb-2">
          <label class="form-label small mb-1">{{ t('companion.settings.name') }}</label>
          <input v-model="preset.name" class="form-control" type="text">
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">{{ t('companion.settings.description') }}</label>
          <input v-model="preset.description" class="form-control" type="text" maxlength="140"
                 :placeholder="t('companion.settings.description_placeholder')">
        </div>
        <div class="d-flex gap-2 mb-3">
          <button class="btn btn-outline-secondary" type="button" @click="duplicatePreset">
            <i class="fa-regular fa-copy me-1" aria-hidden="true"></i>{{ t('companion.settings.duplicate') }}
          </button>
          <button class="btn btn-outline-danger" type="button"
                  :disabled="presets.length <= 1" @click="removePreset">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>

        <!-- Les pages -->
        <h2 class="h6">{{ t('companion.settings.pages') }}</h2>
        <p class="text-body-secondary small">{{ t('companion.settings.pages_help') }}</p>

        <div v-for="(page, index) in preset.pages" :key="index" class="border rounded mb-2">
          <div class="d-flex align-items-center gap-2 p-2">
            <span class="badge text-bg-secondary">{{ t(`companion.settings.page_kinds.${page.kind}`) }}</span>
            <!-- Là où elle se trouve, et pas seulement le fait qu'elle soit
                 rangée : « Menu » à côté du genre est le seul endroit où l'on
                 relit la composition du défilement sans ouvrir chaque page. -->
            <span v-if="page.menu" class="badge text-bg-light border">
              <i class="fa-solid fa-ellipsis-vertical me-1" aria-hidden="true"></i>{{ t('companion.settings.behind_menu') }}
            </span>
            <span class="flex-grow-1 text-truncate">{{ page.title || t('companion.settings.page_kinds.map') }}</span>
            <button class="btn btn-sm btn-link p-1" type="button"
                    :disabled="index === 0" @click="movePage(index, -1)">
              <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
            </button>
            <button class="btn btn-sm btn-link p-1" type="button"
                    :disabled="index === preset.pages.length - 1" @click="movePage(index, 1)">
              <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
            </button>
            <!-- Le bouton s'éteint sur la dernière page du défilement : tout
                 ranger derrière le menu ne laisserait aucune page où l'ouvrir. -->
            <button v-if="page.kind !== 'map'" class="btn btn-sm btn-link p-1"
                    type="button" :disabled="!canHideBehindMenu(page, preset.pages)"
                    :title="page.menu
                      ? t('companion.settings.show_in_swipe')
                      : t('companion.settings.hide_behind_menu')"
                    :aria-label="page.menu
                      ? t('companion.settings.show_in_swipe')
                      : t('companion.settings.hide_behind_menu')"
                    @click="toggleMenuPage(page)">
              <i :class="page.menu ? 'fa-solid fa-eye' : 'fa-solid fa-ellipsis-vertical'"
                 aria-hidden="true"></i>
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
                <!-- `change` et non `input` : la saisie n'est validée qu'une fois
                     le champ quitté (ou Entrée), sinon effacer pour retaper
                     rétrécit la grille à une ligne au passage. -->
                <label class="small mb-0">{{ t('companion.settings.rows') }}
                  <input class="form-control form-control-sm d-inline-block ms-1"
                         style="width: 5rem" type="number" min="1"
                         :max="catalog.max_grid_side" :value="page.rows"
                         @change="commitSide(page, 'rows', $event.target as HTMLInputElement)">
                </label>
                <label class="small mb-0">{{ t('companion.settings.cols') }}
                  <input class="form-control form-control-sm d-inline-block ms-1"
                         style="width: 5rem" type="number" min="1"
                         :max="catalog.max_grid_side" :value="page.cols"
                         @change="commitSide(page, 'cols', $event.target as HTMLInputElement)">
                </label>
              </div>

              <p class="text-body-secondary small mb-1">{{ t('companion.settings.grid_help') }}</p>

              <div class="companion-grid mb-2"
                   :style="{ gridTemplateColumns: `repeat(${page.cols}, 1fr)`,
                             gridTemplateRows: `repeat(${page.rows}, 1fr)`,
                             aspectRatio: `${grid.width} / ${grid.height}` }">
                <!-- `selected` teste `!!slot.cell` d'abord : sans lui, une case
                     vide (`null`) est « égale » à l'absence de sélection (`null`
                     aussi), et **toutes** les cases libres s'allument dès qu'on
                     ne sélectionne rien. -->
                <button v-for="slot in slots(page)" :key="slot.key" type="button"
                        class="companion-cell"
                        :class="{ filled: !!slot.cell, selected: !!slot.cell && slot.cell === selected }"
                        :style="styleFor(page, slot.cell, slot.row, slot.col)"
                        :title="slot.cell ? labelFor(slot.cell.block) : t('companion.settings.add_block')"
                        @click="tapSlot(page, slot.row, slot.col, slot.cell)">
                  <CompanionBlockPreview v-if="slot.cell" :block="slot.cell.block" />
                  <i v-else class="fa-solid fa-plus text-body-secondary" aria-hidden="true"></i>
                </button>
              </div>

              <!-- À quelle échelle on vient de composer. La phrase change selon
                   que l'appli a annoncé sa grille ou non : une mesure et une
                   supposition ne se lisent pas pareil, et c'est toute la
                   différence que cette annonce apporte. -->
              <p class="text-body-secondary small">
                {{ measured
                  ? t('companion.settings.scale_measured', { width: grid.width, height: grid.height })
                  : t('companion.settings.scale_assumed', { width: grid.width, height: grid.height }) }}
              </p>

              <div v-if="selected" class="border rounded p-2 bg-body-tertiary">
                <div class="d-flex align-items-center gap-2">
                  <span class="flex-grow-1 text-truncate small">{{ labelFor(selected.block) }}</span>
                  <button class="btn btn-sm btn-outline-secondary" type="button"
                          @click="picker = { at: 'cell', page, cell: selected }">
                    {{ t('companion.settings.change_block') }}
                  </button>
                </div>
                <!-- L'étendue au pas : le « + » s'éteint dès que la voisine ou le
                     bord de la grille est atteint, si bien que la place libre se
                     voit sans avoir à la calculer. -->
                <div class="d-flex align-items-end gap-3 mt-2 flex-wrap">
                  <div v-for="axis in (['row', 'col'] as const)" :key="axis">
                    <div class="small mb-1">{{ t(`companion.settings.${axis}_span`) }}</div>
                    <div class="input-group input-group-sm companion-span">
                      <button class="btn btn-outline-secondary" type="button"
                              :disabled="spanOf(selected, axis) <= 1"
                              :aria-label="t('companion.settings.span_decrease',
                                             { axis: t(`companion.settings.${axis}_span`) })"
                              @click="stepSpan(page, axis, -1)">
                        <i class="fa-solid fa-minus" aria-hidden="true"></i>
                      </button>
                      <span class="input-group-text flex-grow-1 justify-content-center">
                        {{ spanOf(selected, axis) }}
                      </span>
                      <button class="btn btn-outline-secondary" type="button"
                              :disabled="spanOf(selected, axis) >= spanLimit(page, axis)"
                              :aria-label="t('companion.settings.span_increase',
                                             { axis: t(`companion.settings.${axis}_span`) })"
                              @click="stepSpan(page, axis, 1)">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                      </button>
                    </div>
                  </div>
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

        <div class="d-flex gap-2 mb-2">
          <button v-for="kind in catalog.page_kinds" :key="kind"
                  class="btn btn-sm btn-outline-secondary" type="button"
                  :disabled="kind === 'map' && hasMap" @click="addPage(kind)">
            <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t(`companion.settings.page_kinds.${kind}`) }}
          </button>
        </div>

        <!-- Le partage, en toutes lettres. La liste ci-dessus est dans l'ordre du
             document ; ce que le cycliste vivra, c'est un défilement d'un côté et
             un menu de l'autre, et ce compte est le seul endroit où les deux se
             lisent d'un coup. -->
        <p class="text-body-secondary small mb-4">
          {{ t('companion.settings.pages_split', {
            swipe: swipeCount, menu: preset.pages.length - swipeCount,
          }) }}
        </p>

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
        <p class="text-body-secondary small">{{ t('companion.settings.radar_overlay_help') }}</p>
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
          <!-- L'habillage plein écran. Coupé, le capteur continue de tourner :
               les tonalités restent, le réveil d'écran aussi, et le radar ne se
               voit plus que là où on l'a posé — d'où la mention du composant, le
               seul moyen d'en garder quelque chose à l'œil. -->
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="radar-overlay"
                     :checked="preset.radar?.overlay !== false"
                     @change="setRadar('overlay', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="radar-overlay">
                {{ t('companion.settings.radar_overlay') }}
              </label>
            </div>
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
                          :cell="pickerCell"
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
  /* Les proportions exactes de `PHONE_GRID` (328 × 598 px logiques, gouttières
     de 8) réduites au quart : c'est ce qui permet à `--cbp-em` d'être un simple
     rapport de largeurs — un seul facteur d'échelle vaut alors pour toutes les
     grilles, quel que soit le nombre de lignes et de colonnes. */
  gap: 0.4rem;
  width: 100%;
  max-width: 16rem;
  /* La hauteur se déduit des proportions du téléphone, posées par `aspectRatio` :
     celles de l'appareil quand il les a annoncées, celles d'un téléphone
     ordinaire sinon. Une hauteur en dur redeviendrait fausse au premier écran
     qui n'a pas ce format. */
  aspect-ratio: 328 / 598;
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
  /* La case devient l'unité de mesure de sa vignette : `1cqw` vaut 1 % de sa
     largeur, ce dont `--cbp-em` a besoin pour rendre les proportions du
     téléphone quelle que soit la largeur laissée à la grille. */
  container-type: inline-size;
}

.companion-cell.filled {
  border-style: solid;
}

/* La vignette se met à l'échelle par sa `font-size` : dans une case de grille,
   la taille de la dialogue de choix déborderait de partout.

   `--cbp-em` est posé par `styleFor` : c'est la taille de ligne du téléphone
   rapportée à la largeur qu'aura la case sur son écran. Une case de six colonnes
   dessine donc son chiffre aussi petit qu'il le sera vraiment, au lieu de le
   montrer à la taille d'une case de deux. Le repli du milieu couvre un
   navigateur sans requêtes de conteneur : la vignette y reste lisible, à
   l'échelle d'avant. */
.companion-cell :deep(.cbp) {
  font-size: 0.5rem;
  font-size: calc(var(--cbp-em, 5) * 1cqw);
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

/* Assez large pour deux chiffres entre ses boutons, et pas plus : les deux
   étendues tiennent alors sur la même ligne que le bouton de retrait, y compris
   sur un portable. */
.companion-span {
  width: 8rem;
}

.companion-cell.selected {
  outline: 2px solid var(--bs-primary);
  outline-offset: -2px;
}
</style>
