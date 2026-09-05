<script setup lang="ts">
import { computed, reactive, ref, toRaw, watch } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import CompanionBlockPicker from './CompanionBlockPicker.vue'
import CompanionBlockPreview from './CompanionBlockPreview.vue'
import CompanionColorPicker from './CompanionColorPicker.vue'
import {
  canHideBehindMenu, canMoveCell, climbLapSeries, DEFAULT_DIVIDER_COLOR, DEFAULT_METRIC_LAYOUT,
  DEFAULT_TRAVELED_PATH_COLOR, fitCells,
  fitDividers, fitListBlocks, gridSideOf, gutterRect, isGridLayout, listSegments,
  maxSpan, metricDropdownLabel, NATURAL_LINE_SIZE, occupancy, phoneCell, previewScale, PHONE_GRID,
  swapCells,
  type Band, type BandMarkLapSlot, type Block, type Buttons, type ButtonChannel, type Catalog, type Cell,
  type CellSize, type Divider, type CompanionDocument, type MetricLayout, type MetricLayoutPreset, type Notch,
  type Page, type Preset, type Reminder, type Viewport,
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
// marchent au doigt comme à la souris, et coûtent le dixième du code. Déplacer
// une cellule déjà posée suit la même règle : un pavé de quatre flèches
// (`moveCell`) plutôt qu'un glissé, chaque bouton s'éteignant dès que la case
// visée est prise ou hors grille — la même logique que l'étendue (`maxSpan`).
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

// Les dispositions de bloc `metric` enregistrées, proposées comme point de
// départ dans `CompanionBlockPicker` — un réglage de compte comme les
// profils, gardé dans le même document et enregistré par le même `PATCH`.
const metricLayouts = reactive<MetricLayoutPreset[]>(structuredClone(props.document.metric_layouts || []))

function onSaveLayout(preset: { name: string; layout: MetricLayout }) {
  metricLayouts.push({ key: crypto.randomUUID(), name: preset.name, layout: preset.layout })
}

const current = ref(0)
const openPage = ref<number | null>(null)
const selected = ref<Cell | null>(null)

// Les réglages de page (nom, icône, nombre de lignes/colonnes) repliés
// derrière un bouton : à l'ouverture d'une page, on veut composer son
// contenu, pas la renommer. Remis à `false` à chaque changement de page
// ouverte (`togglePage`).
const showPageConfig = ref(false)

// Idem pour les réglages d'identité du profil (nom, description, icône, types
// d'itinéraire) : à l'ouverture de l'éditeur on compose d'abord les pages et
// le bandeau, on ne renomme pas le profil. Remis à `false` à chaque
// changement de profil (`select`), forcé à `true` sur un profil neuf qui n'a
// pas encore de nom (`addPreset`).
const showPresetConfig = ref(false)

// Les grandes sections de l'éditeur (pages, bandeau, capteurs, radar…),
// repliées par défaut : on déplie celle qu'on vient régler puis on la
// referme, plutôt qu'une seule page à faire défiler sur toute sa hauteur. Un
// objet indexé par clé de section plutôt qu'un `ref` booléen par section —
// une douzaine à tenir, et le même gabarit d'en-tête pour chacune. Tout
// remis à `false` au changement de profil (`select`).
const SECTIONS = [
  'pages', 'notch', 'bands', 'sensors', 'buttons', 'radar', 'battery',
  'climb', 'workout', 'laps', 'reminders', 'traveled_path',
] as const
const openSections = reactive<Record<string, boolean>>(
  Object.fromEntries(SECTIONS.map((name) => [name, false])),
)
function toggleSection(name: string) {
  openSections[name] = !openSections[name]
}

// Une icône par section, pour la repérer d'un coup d'œil dans la liste des
// en-têtes repliés. Purement décoratives (classes FontAwesome libres, pas la
// liste blanche `catalog.icons` de l'appli) : elles ne voyagent pas dans le
// document.
const SECTION_ICONS: Record<string, string> = {
  pages: 'fa-solid fa-layer-group',
  notch: 'fa-solid fa-mobile-screen',
  bands: 'fa-solid fa-table-columns',
  sensors: 'fa-solid fa-tower-broadcast',
  buttons: 'fa-solid fa-hand-pointer',
  radar: 'fa-solid fa-car-rear',
  battery: 'fa-solid fa-battery-half',
  climb: 'fa-solid fa-mountain',
  workout: 'fa-solid fa-dumbbell',
  laps: 'fa-solid fa-stopwatch',
  reminders: 'fa-solid fa-bell',
  traveled_path: 'fa-solid fa-route',
}

// La gouttière sélectionnée — jamais en même temps qu'une cellule : les deux
// panneaux de réglage (couleur du séparateur / étendue de la cellule)
// prendraient sinon la même place sous la grille.
const selectedDivider = ref<Divider | null>(null)
watch(selected, (cell) => { if (cell) selectedDivider.value = null })
watch(selectedDivider, (divider) => { if (divider) selected.value = null })

// Échanger la cellule sélectionnée avec une autre : le bouton « Échanger »
// l'arme, et la case suivante qu'on touche reçoit l'échange — toujours
// permis, qu'elle porte un composant ou non. Le composant sélectionné prend
// la taille de la case qui le reçoit : la sienne pour un autre composant
// (`swapCells` n'échange que le composant, jamais la position ni l'étendue —
// les échanger aussi serait indiscernable d'un no-op une fois rendu), 1 × 1
// pour une case vide, qui n'en a pas d'autre à offrir — l'ancien emplacement
// redevient alors entièrement vide, aussi grand qu'il était.
const swapping = ref(false)

// Toute nouvelle sélection éteint un échange resté armé : il n'a de sens que
// pour la cellule qu'on vient de quitter.
watch(selected, () => { swapping.value = false })

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

// L'icône que l'appli affiche faute de choix explicite dans le sélecteur de
// départ (`preset_picker.dart`, `main.dart` du dépôt voisin : carte si le
// profil a une carte, maison sinon) — recopiée à la main comme les vignettes
// du picker. Le bouton « par défaut » la dessine, comme pour l'icône de page.
const presetDefaultIcon = computed(() => (hasMap.value ? 'fa-solid fa-map' : 'fa-solid fa-house'))

// Le compteur affiché dans l'en-tête d'une section repliée, pour lire d'un
// coup d'œil ce qu'elle contient sans l'ouvrir : nombre de pages, de jeux du
// bandeau/de l'encoche, de rappels, de raccourcis Di2 réglés, capteurs actifs
// sur le total, et seuil d'alerte batterie. `null` pour les sections sans
// quantité parlante (radar, cols, entraînement, tours, trajet).
function sectionBadge(name: string): string | null {
  switch (name) {
    case 'pages':
      return String(preset.value.pages.length)
    case 'notch':
      return String((preset.value.notch || []).length)
    case 'bands':
      return String(preset.value.bands.length)
    case 'sensors': {
      const on = props.catalog.sensors.filter((sensor) => sensorOn(sensor)).length
      return `${on}/${props.catalog.sensors.length}`
    }
    case 'buttons': {
      const channels = Object.values(preset.value.buttons || {})
      return String(channels.reduce<number>((sum, ch) => sum + Object.keys(ch || {}).length, 0))
    }
    case 'reminders':
      return String((preset.value.reminders || []).length)
    case 'battery':
      return `${batteryValue('threshold_percent', 20)} %`
    default:
      return null
  }
}

// Les séries de tours déjà posées dans ce profil — pages `laps` et boutons
// `mark_lap`, où qu'ils soient (liste, grille). Suggérées dans les deux
// endroits où l'on tape une série (`lap_series` de la page, paramètre du
// bouton dans `CompanionBlockPicker`) : c'est une clé de texte libre, et une
// suggestion évite l'écart d'orthographe entre un bouton et sa page.
const lapSeries = computed(() => {
  // `climbLapSeries` ('cols') est toujours suggérée, même avant d'avoir été
  // posée où que ce soit dans le profil : c'est l'appli qui la remplit, pas
  // un bouton de ce profil, et l'éditeur ne la découvrirait donc jamais
  // toute seule.
  const keys = new Set<string>([climbLapSeries])
  const collect = (block?: Block) => {
    if (block?.kind === 'mark_lap') keys.add(block.series || 'default')
  }
  // Une case de bandeau/encoche « marquer un tour » (`BandMarkLapSlot`) porte
  // aussi une série, au même titre qu'un bouton `mark_lap` de page — mêmes
  // suggestions des deux côtés.
  const collectSlot = (slot?: string | BandMarkLapSlot) => {
    if (typeof slot === 'object') keys.add(slot.series || 'default')
  }
  preset.value.pages.forEach((page) => {
    if (page.kind === 'laps') keys.add(page.series || 'default')
    page.blocks?.forEach(collect)
    page.cells?.forEach((cell) => collect(cell.block))
  })
  preset.value.bands.forEach((band) => band.metrics.forEach(collectSlot))
  ;(preset.value.notch || []).forEach((set) => {
    collectSlot(set.left)
    collectSlot(set.right)
  })
  // Un bouton Di2 « marquer un tour » (`start_lap:<série>`) porte la même
  // série libre — mêmes suggestions que les autres endroits qui en tapent une.
  const buttons = preset.value.buttons
  BUTTON_CHANNELS.forEach((channel) => {
    Object.values(buttons?.[channel] || {}).forEach((action) => {
      const series = buttonActionLapSeries(action)
      if (series !== null) keys.add(series)
    })
  })
  return [...keys]
})

// Le libellé de liste déroulante (préfixe Di2, raccourcis de durée) est
// partagé avec la dialogue de choix (`CompanionBlockPicker.vue`) — voir
// `metricDropdownLabel` dans `companionSettings.ts`.
function metricLabel(metric: string): string {
  return metricDropdownLabel(metric, t)
}

// Le catalogue liste les mesures dans l'ordre du serveur ; le bandeau les
// propose triées par libellé affiché, pour qu'on les retrouve sans connaître
// cet ordre-là par cœur.
const sortedMetrics = computed(() => (
  [...props.catalog.metrics].sort((a, b) => metricLabel(a).localeCompare(metricLabel(b)))
))

// Le libellé d'une commande de case (`sleep`) : celui de sa vignette dans la
// dialogue de choix de bloc, pas un nouveau texte à tenir à jour à part.
function bandActionLabel(action: string): string {
  return t(`companion.settings.blocks.${action}`)
}

// Le libellé d'un mode de radar de case (`radar_distance`) : le nom du
// composant puis son mode — même format que `labelFor` pour un bloc de
// grille, pour que « Radar » se lise pareil aux deux endroits.
function bandRadarLabel(key: string): string {
  const mode = key.slice('radar_'.length)
  return `${t('companion.settings.blocks.radar')} · ${t(`companion.settings.modes.${mode}`)}`
}

// Le libellé d'un habillage de case du tronçon d'entraînement en cours
// (`workout_segment`) — sa propre table plutôt que le format
// `bandRadarLabel` : les trois habillages (`segment`/`remaining`/`combo`)
// n'ont pas de mode de composant de page équivalent à réutiliser, `combo`
// n'existant que dans une case de bandeau/encoche.
function bandWorkoutLabel(key: string): string {
  const mode = key.slice('workout_'.length)
  return t(`companion.settings.band_workout.${mode}`)
}

// Le libellé d'un son de sonnette de case (`bell_horn`) — même format que
// `bandRadarLabel` : le nom du composant puis le son choisi.
function bandBellLabel(key: string): string {
  const sound = key.slice('bell_'.length)
  return `${t('companion.settings.blocks.bell')} · ${t(`companion.settings.bell_sounds.${sound}`)}`
}

// Ce que porte un `<select>` de case de bandeau/encoche : le jeton simple
// (chaîne) tel quel, ou le `kind` de l'objet « marquer un tour » — c'est ce
// qui sélectionne l'option correspondante dans le menu déroulant.
function bandSlotKind(value?: string | BandMarkLapSlot): string {
  return typeof value === 'object' ? value.kind : (value || '')
}

// L'objet « marquer un tour » d'une case, ou `null` — ce qui commande
// l'affichage des champs série/label sous le `<select>`.
function bandLapSlot(value?: string | BandMarkLapSlot): BandMarkLapSlot | null {
  return typeof value === 'object' ? value : null
}

// Le libellé d'une action de bouton Di2 (`catalog.button_actions`) — sa
// propre table plutôt qu'un renvoi vers `blocks.*` comme `bandActionLabel` :
// « Sortir de veille » ou « Page suivante » n'ont pas de vignette de bloc
// dont ils reprendraient le nom.
function buttonActionLabel(action: string): string {
  return t(`companion.settings.button_actions.${action}`)
}

// Le libellé d'une page visée par « Aller à… » : son titre s'il en a un, sinon
// le nom de son genre — une carte n'a pas de titre côté document.
function pageLabel(page: Page): string {
  return page.title || t(`companion.settings.page_kinds.${page.kind}`)
}

// ── les profils ─────────────────────────────────────────────────────────────

function select(index: number) {
  current.value = index
  openPage.value = null
  selected.value = null
  showPresetConfig.value = false
  SECTIONS.forEach((name) => { openSections[name] = false })
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
  // Un profil neuf n'a pas encore de nom : on ouvre d'emblée ses réglages
  // d'identité, sinon « Nouveau profil » resterait tel quel sans qu'on voie où
  // le changer.
  showPresetConfig.value = true
}

function duplicatePreset() {
  // Sans clé : le serveur en fabriquera une, suffixée pour ne pas écraser
  // l'original. La recopier ici ferait perdre l'un des deux profils.
  const copy = structuredClone({ ...toRaw(preset.value), key: undefined }) as Preset
  copy.name = `${preset.value.name} (2)`
  presets.splice(current.value + 1, 0, copy)
  select(current.value + 1)
}

function removePreset() {
  presets.splice(current.value, 1)
  select(Math.max(0, current.value - 1))
}

// L'icône qui repère ce profil dans le sélecteur de départ de l'appli — voir
// `Preset.icon`. Effacée et non mise à une valeur creuse quand on choisit
// « par défaut », même règle que l'icône de page (`setPageIcon`).
function setPresetIcon(icon: string | undefined) {
  if (icon) preset.value.icon = icon
  else delete preset.value.icon
}

// ── les types d'itinéraire ──────────────────────────────────────────────────

function presetHasActivity(activity: string): boolean {
  return (preset.value.activities || []).includes(activity)
}

function toggleActivity(activity: string, on: boolean) {
  const activities = new Set(preset.value.activities || [])
  if (on) {
    activities.add(activity)
  } else {
    activities.delete(activity)
    // Un type retiré ne peut pas rester le défaut de ce profil.
    preset.value.default_for = (preset.value.default_for || []).filter((a) => a !== activity)
  }
  preset.value.activities = activities.size > 0 ? [...activities] : undefined
}

function isDefaultForActivity(activity: string): boolean {
  return (preset.value.default_for || []).includes(activity)
}

// Un type n'a qu'un seul profil par défaut : on retire la revendication des
// autres profils avant de la poser ici, pour que la limite se voie plutôt que
// de se découvrir à l'enregistrement — même règle que partout dans cet éditeur.
function toggleDefaultForActivity(activity: string) {
  if (isDefaultForActivity(activity)) {
    preset.value.default_for = (preset.value.default_for || []).filter((a) => a !== activity)
    return
  }
  presets.forEach((p) => {
    if (p === preset.value || !p.default_for?.includes(activity)) return
    p.default_for = p.default_for.filter((a) => a !== activity)
  })
  preset.value.default_for = [...(preset.value.default_for || []), activity]
}

// ── les pages ───────────────────────────────────────────────────────────────

function addPage(kind: string) {
  if (kind === 'map') preset.value.pages.push({ kind: 'map' })
  else if (kind === 'grid') {
    preset.value.pages.push({
      kind: 'grid', title: t('companion.settings.page_numbers'), rows: 2, cols: 2,
      cells: [{ row: 0, col: 0, row_span: 1, col_span: 1,
                block: { kind: 'metric', metric: 'speed', layout: { ...DEFAULT_METRIC_LAYOUT } } }],
    })
  } else if (kind === 'laps') {
    // `lap_selector` d'abord — sans lui, la page ne montre jamais que le tour
    // le plus récent, sans rien à choisir. `lap_summary` ensuite, pendant du
    // `recording` par défaut d'une page « Effort » : ce qu'on veut voir en
    // premier une fois un tour choisi.
    //
    // Pas de `mark_lap` par défaut : sa série est un réglage à part de celle
    // de la page (voir `lapSeriesMismatch`), et le deviner ici — recopier
    // celle de la page — surprendrait plus qu'aider si le choix n'était pas
    // le bon. Qui veut marquer un tour depuis cette page l'ajoute et règle sa
    // série lui-même.
    preset.value.pages.push({
      kind: 'laps', title: t('companion.settings.page_laps'), series: 'default',
      blocks: [{ kind: 'lap_selector' }, { kind: 'lap_summary', mode: 'cards' }],
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

// Bascule une page `laps` entre liste défilante et grille — même choix
// qu'entre une page `list` et une page `grid`, mais qui ne change pas le
// `kind` : la série et la place dans le catalogue de pages restent, seule la
// façon de composer le contenu change.
//
// Chaque branche **sème** un contenu par défaut si l'autre n'en a jamais eu
// (`?.length` et non `!page.cells` : une page déjà composée dans un sens ne
// perd pas ce qu'elle porte à l'aller-retour), sinon la première bascule vers
// la grille tomberait sur une page vide, indiscernable d'une grille encore
// non composée.
function setLapLayout(page: Page, layout: 'list' | 'grid') {
  if (layout === 'grid') {
    page.layout = 'grid'
    if (!page.cells?.length) {
      const rows = page.rows || 2
      const cols = page.cols || 2
      page.rows = rows
      page.cols = cols
      // Le sélecteur sur toute la largeur de la première ligne, comme dans
      // `addPage('laps')` : sans lui, une grille de tours fraîchement basculée
      // ne montrerait jamais que le tour le plus récent.
      page.cells = [
        { row: 0, col: 0, row_span: 1, col_span: cols, block: { kind: 'lap_selector' } },
        { row: 1, col: 0, row_span: 1, col_span: cols,
          block: { kind: 'lap_summary', mode: 'cards' } },
      ]
    }
  } else {
    delete page.layout
    if (!page.blocks?.length) {
      page.blocks = [{ kind: 'lap_selector' }, { kind: 'lap_summary', mode: 'cards' }]
    }
    // `cols` sert aux deux dispositions (colonnes de grille, colonnes de
    // liste) avec deux plafonds différents : une grille large basculée en
    // liste ne doit pas laisser un nombre de colonnes que celle-ci refuse,
    // ni des blocs dont la colonne dépasserait ce qui reste.
    if ((page.cols || 1) > props.catalog.max_list_cols) {
      page.cols = props.catalog.max_list_cols
      page.blocks = fitListBlocks(page.blocks || [], page.cols)
    }
  }
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

// Sans clé : le serveur en fabriquera une à l'enregistrement (`page_key`),
// comme pour un profil dupliqué (`duplicatePreset`) — la recopier ici ferait
// viser la même page à deux boutons « Aller à… » à la fois.
function duplicatePage(index: number) {
  const copy = structuredClone(toRaw(preset.value.pages[index])) as Page
  delete copy.key
  preset.value.pages.splice(index + 1, 0, copy)
  openPage.value = index + 1
  selected.value = null
}

function togglePage(index: number) {
  openPage.value = openPage.value === index ? null : index
  selected.value = null
  showPageConfig.value = false
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

// La condition qui fait rejoindre le défilement à une page rangée derrière le
// menu, le temps qu'elle dure — voir `Page.menu_condition`. Effacée et non mise
// à une valeur creuse quand on choisit « aucune », même règle que `menu`.
function setMenuCondition(page: Page, value: string) {
  if (props.catalog.menu_conditions.includes(value)) {
    page.menu_condition = value as Page['menu_condition']
    if (page.menu_condition !== 'lap_named') delete page.menu_condition_lap_name
  } else {
    delete page.menu_condition
    delete page.menu_condition_lap_name
    delete page.menu_auto_open
  }
}

// Le nom comparé au dernier tour ouvert par la condition `lap_named` — même
// règle que `menu`/`menu_condition` ci-dessus : effacé et non mis à une
// valeur creuse.
function setMenuConditionLapName(page: Page, value: string) {
  const trimmed = value.trim()
  if (trimmed) page.menu_condition_lap_name = trimmed
  else delete page.menu_condition_lap_name
}

// L'icône qui repère la page dans le menu ⋮ de l'appli — voir `Page.icon`.
// Effacée et non mise à une valeur creuse quand on choisit « par défaut »,
// même règle que `menu`/`menu_condition` ci-dessus.
function setPageIcon(page: Page, icon: string | undefined) {
  if (icon) page.icon = icon
  else delete page.icon
}

// L'icône que l'appli déduit du genre de page faute de choix explicite
// (`dashboard_page.dart`, menu ⋮ : `grid_view` pour une grille, `view_agenda`
// sinon) — recopiée à la main comme les vignettes du picker. Le bouton
// « par défaut » la dessine, au lieu d'afficher son libellé qui débordait
// de la case.
function pageDefaultIcon(page: Page): string {
  return isGridLayout(page) ? 'fa-solid fa-table-cells-large' : 'fa-solid fa-list'
}

// Le bouton « Revenir à l'accueil » de l'en-tête — voir `Page.leave_button`.
// Effacée et non mise à `false`, même règle que `menu`/`icon` ci-dessus.
function toggleLeaveButton(page: Page) {
  if (page.leave_button) delete page.leave_button
  else page.leave_button = true
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
// À la frappe, c'était intenable au doigt : pour remplacer 9 par 2 on efface
// d'abord, or un champ vide vaut 0, ramené à 1 — ce qui **jetait au passage
// toutes les cellules des lignes 2 à 9** (`fitCells` perd une origine hors
// grille, à dessein). Vue réécrivait ensuite « 1 » dans le champ, si bien que le
// « 2 » tapé ensuite donnait « 12 » plutôt que « 2 » : la grille refusait de
// rétrécir et le contenu était déjà perdu. Sur ordinateur ça passait
// inaperçu — on sélectionne le chiffre et on tape par-dessus, ce qui ne fait
// qu'une seule saisie valide.
function commitSide(page: Page, axis: 'rows' | 'cols', input: HTMLInputElement) {
  const side = Math.min(gridSideOf(input.value), props.catalog.max_grid_side)
  page[axis] = side
  page.cells = fitCells(page.cells || [], page.rows || 1, page.cols || 1)
  if (selected.value && !page.cells.includes(selected.value)) selected.value = null
  page.dividers = fitDividers(page.dividers || [], page.rows || 1, page.cols || 1)
  if (selectedDivider.value && !page.dividers.includes(selectedDivider.value)) selectedDivider.value = null
  repaint(input, side)
}

// Le champ peut afficher autre chose que ce qu'on a gardé — « 12 » ramené à 6, un
// champ vide ramené à sa valeur. Vue ne repeint pas un `:value` dont l'expression
// n'a pas changé, d'où cette remise à la main : sans elle, le champ montrerait un
// nombre que le document ne contient pas.
function repaint(input: HTMLInputElement, value: number) {
  input.value = String(value)
}

// ── la liste ────────────────────────────────────────────────────────────────

// Le nombre de colonnes d'une page `list` — même piège que `commitSide` (voir
// son commentaire) : validé à la sortie du champ, jamais à la frappe. Réduire
// retire les `new_column` devenus sans effet (`fitListBlocks`) plutôt que de
// laisser une rupture muette dans le document, même arbitrage que
// l'assainisseur.
function commitListCols(page: Page, input: HTMLInputElement) {
  const cols = Math.min(gridSideOf(input.value), props.catalog.max_list_cols)
  page.cols = cols
  page.blocks = fitListBlocks(page.blocks || [], cols)
  repaint(input, cols)
}

// Les deux ruptures d'un bloc de liste sont mutuellement exclusives (voir
// `place_list_blocks` côté Rails, qui fait de toute façon gagner `full_width`)
// — les boutons les gardent donc exclusives dans l'éditeur aussi, plutôt que
// de laisser cocher les deux et résoudre le conflit sans le montrer.
function toggleNewColumn(block: Block) {
  if (block.new_column) delete block.new_column
  else {
    block.new_column = true
    delete block.full_width
  }
}

function toggleFullWidth(block: Block) {
  if (block.full_width) delete block.full_width
  else {
    block.full_width = true
    delete block.new_column
  }
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

// Ce qu'on dessine par-dessus la grille : une gouttière par ligne/colonne
// interne — `rows - 1` horizontales, `cols - 1` verticales — avec le
// séparateur qui l'occupe, s'il y en a un. `at` commence à 1 : la gouttière 0
// serait le bord de la grille, pas un espace entre deux cases.
function gutters(page: Page) {
  const dividers = page.dividers || []
  const out: { key: string; axis: 'h' | 'v'; at: number; divider: Divider | null }[] = []

  for (let at = 1; at < (page.rows || 1); at++) {
    out.push({ key: `h:${at}`, axis: 'h', at, divider: dividers.find((d) => d.axis === 'h' && d.at === at) || null })
  }
  for (let at = 1; at < (page.cols || 1); at++) {
    out.push({ key: `v:${at}`, axis: 'v', at, divider: dividers.find((d) => d.axis === 'v' && d.at === at) || null })
  }
  return out
}

// Une gouttière vide en pose un séparateur et le sélectionne aussitôt — un
// clic suffit, la couleur se règle ensuite dans le panneau sous la grille.
// Une gouttière déjà occupée bascule sa sélection, comme une cellule
// (`tapSlot`).
function tapGutter(page: Page, axis: 'h' | 'v', at: number, divider: Divider | null) {
  if (divider) {
    selectedDivider.value = selectedDivider.value === divider ? null : divider
    return
  }
  const created: Divider = { axis, at, color: DEFAULT_DIVIDER_COLOR }
  page.dividers = [...(page.dividers || []), created]
  selectedDivider.value = created
}

function removeDivider(page: Page) {
  page.dividers = (page.dividers || []).filter((divider) => divider !== selectedDivider.value)
  selectedDivider.value = null
}

// `CompanionColorPicker` porte un bouton « réinitialiser » qui émet `null` —
// pertinent pour `block.color` (l'absence laisse l'appli calculer), pas pour
// un séparateur, purement décoratif, qui a toujours besoin d'une couleur : un
// `null` y retombe donc sur la couleur par défaut plutôt que de rester sans
// couleur.
const dividerColor = computed<string | null>({
  get: () => selectedDivider.value?.color ?? null,
  set: (value) => { if (selectedDivider.value) selectedDivider.value.color = value || DEFAULT_DIVIDER_COLOR },
})

// Cette case peut-elle recevoir l'échange ? Sert à la fois à `tapSlot`
// (n'agir que si c'est permis) et à la grille (montrer la case où l'échange
// ira, sans avoir à le tenter pour le savoir — même règle que
// `spanLimit`/`canMove`).
//
// Toujours permis, qu'elle soit remplie ou vide : le composant reçu s'affiche
// à la taille de la case qui le reçoit — la sienne pour un autre composant
// (`swapCells`), 1 × 1 pour une case vide (elle n'en a pas d'autre). Rien à
// vérifier ni à refuser dans un cas comme dans l'autre.
function canSwapTo(cell: Cell | null): boolean {
  return !!selected.value && cell !== selected.value
}

function tapSlot(page: Page, row: number, col: number, cell: Cell | null) {
  if (swapping.value) {
    const target = selected.value
    // Se retoucher soi-même annule l'échange plutôt que de ne rien faire :
    // c'est le seul moyen de sortir du mode sans retomber sur le bouton
    // « Échanger ». canSwapTo ne peut renvoyer faux qu'ici (aucune autre
    // case ne peut être refusée), mais on garde l'appel pour rester
    // cohérent avec la grille, qui s'en sert pour éteindre cette case-là.
    if (!target || cell === target) { swapping.value = false; return }
    if (!canSwapTo(cell)) return
    if (cell) {
      swapCells(target, cell)
    } else {
      // Une case vide n'a que sa propre taille (1 × 1) à offrir en retour : le
      // composant qui l'y rejoint devient donc 1 × 1, et son ancien
      // emplacement — la cellule qu'on retire — redevient entièrement vide,
      // aussi grand qu'il était.
      const cells = [...(page.cells || []).filter((c) => c !== target),
        { row, col, row_span: 1, col_span: 1, block: target.block }]
      page.cells = cells
      // On relit la cellule dans le tableau plutôt que de garder l'objet
      // qu'on vient d'écrire — même raison qu'`applyPick` : `presets` est
      // réactif, ce qui en ressort est un proxy et non l'original.
      selected.value = page.cells[page.cells.length - 1]
    }
    swapping.value = false
    return
  }
  if (cell) {
    selected.value = selected.value === cell ? null : cell
    return
  }
  // Une case vide ouvre la dialogue plutôt que de poser une mesure par défaut :
  // celle-ci demandait de deviner ce qu'on voulait, puis de la corriger dans un
  // panneau plus bas — deux gestes pour un choix qu'on n'avait pas fait.
  picker.value = { at: 'slot', page, row, col }
}

// Double clic / double tap sur une case posée : on ouvre directement la
// dialogue pour changer le composant, sans passer par le bouton « Changer »
// du panneau. Le double clic arrive après deux `@click` (sélectionne puis
// dé-sélectionne) : on rétablit donc la sélection avant d'ouvrir. Sans effet
// pendant un échange ou sur une case vide (le simple clic y ouvre déjà la
// dialogue).
function dblTapSlot(page: Page, cell: Cell | null) {
  if (swapping.value || !cell) return
  selected.value = cell
  picker.value = { at: 'cell', page, cell }
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
    case 'block': {
      // `blockFor` fabrique un bloc neuf, sans rupture : la recopier de
      // l'ancien évite qu'un simple changement de genre/mode déplace le
      // composant dans le flux des colonnes, sous les yeux de personne.
      const previous = target.page.blocks?.[target.index]
      if (target.page.blocks) {
        target.page.blocks[target.index] = previous?.new_column
          ? { ...block, new_column: true }
          : previous?.full_width
            ? { ...block, full_width: true }
            : block
      }
      break
    }
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

// La cellule sélectionnée peut-elle se déplacer d'une case dans ce sens ? Le
// bouton s'éteint plutôt que de tenter le déplacement et de le refuser après
// coup — même règle que `spanLimit`.
function canMove(page: Page, axis: 'row' | 'col', delta: number): boolean {
  if (!selected.value) return false
  return canMoveCell(
    selected.value, page.cells || [], page.rows || 1, page.cols || 1,
    axis === 'row' ? delta : 0, axis === 'col' ? delta : 0,
  )
}

function moveCell(page: Page, axis: 'row' | 'col', delta: number) {
  if (!canMove(page, axis, delta)) return
  const cell = selected.value!
  if (axis === 'row') cell.row += delta
  else cell.col += delta
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

// Le rectangle d'une gouttière, en `%` du conteneur — celui-ci est positionné
// en absolu par-dessus `.companion-grid`, qui a déjà l'échelle du téléphone
// (`aspect-ratio`), d'où la conversion directe en pourcentage plutôt qu'une
// mesure du DOM.
function styleForGutter(page: Page, axis: 'h' | 'v', at: number, color: string | undefined) {
  const rect = gutterRect(axis, at, page.rows || 1, page.cols || 1, grid.value)
  return {
    left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%`,
    backgroundColor: color,
  }
}

// Le nom de ce qui est posé : le genre, son paramètre, son mode. La vignette
// dit déjà à quoi ça ressemble — ce libellé sert à le **nommer**, ce qu'un
// dessin ne fait pas : c'est lui qu'on relit pour vérifier qu'on a bien mis la
// puissance normalisée et non la puissance moyenne.
function labelFor(block: Block): string {
  const parts = [t(`companion.settings.blocks.${block.kind}`)]
  if (block.kind === 'metric') parts.push(block.label?.trim() || t(`companion.settings.metrics.${block.metric}`))
  if (block.kind === 'zones') parts.push(t(`companion.settings.sources.${block.source}`))
  // La série est un texte libre, pas une clé du catalogue : elle se relit
  // telle quelle. Sans elle, deux boutons « Marquer un tour » de séries
  // différentes se ressembleraient à l'identique dans la liste des
  // composants d'une page — et c'est justement la série qui décide où le tour
  // marqué atterrit.
  if (block.kind === 'mark_lap') parts.push(block.series || 'default')
  if (block.mode) parts.push(t(`companion.settings.modes.${block.mode}`))
  return parts.join(' · ')
}

// La phrase qui dit ce que le composant montre et d'où il tient sa donnée —
// la même que la dialogue de choix affiche sous l'en-tête de son groupe
// (`companion.settings.block_help`). Reprise dans le panneau de réglage de la
// case pour l'avoir sous les yeux pendant qu'on règle sa place et son étendue,
// pas seulement au moment de le choisir. Pour un chiffre unique, c'est l'aide
// de *sa* mesure qu'on veut ici — pas celle du genre, qui parle de « la mesure
// choisie ci-dessus » et n'a de sens que dans la dialogue. `''` tant qu'aucune
// clé n'existe (masquée).
function blockDescription(block: Block): string {
  if (block.kind === 'metric') {
    return block.metric && block.metric !== 'clock'
      ? t(`companion.settings.metric_help.${block.metric}`, { defaultValue: '' })
      : ''
  }
  return t(`companion.settings.block_help.${block.kind}`, { defaultValue: '' })
}

// Un bouton « Marquer un tour » posé sur une page Tours dont la série ne
// correspond pas à celle de la page : il marque bien un tour, mais pas dans
// la liste que cette page affiche — deux réglages indépendants de l'éditeur
// que rien ne relie côté appli (`LapListBody._block`, dépôt voisin). Averti
// ici plutôt que découvert sur la route, où le bouton semblerait ne rien
// faire.
function lapSeriesMismatch(page: Page, block: Block): boolean {
  return page.kind === 'laps' && block.kind === 'mark_lap' &&
    (block.series || 'default') !== (page.series || 'default')
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

function moveBand(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= preset.value.bands.length) return
  const [band] = preset.value.bands.splice(index, 1)
  preset.value.bands.splice(target, 0, band)
}

function duplicateBand(index: number) {
  const copy = structuredClone(toRaw(preset.value.bands[index])) as Band
  preset.value.bands.splice(index + 1, 0, copy)
}

function setBandMetric(band: Band, index: number, value: string | BandMarkLapSlot) {
  // Écrit en place plutôt que de retirer la case : un `splice` décalerait
  // tout ce qui suit vers la gauche, et une case vidée au milieu se
  // retrouverait toujours en bout de jeu. Seules les cases vides en fin de
  // tableau sont coupées, pour ne pas faire grossir le document pour rien.
  while (band.metrics.length <= index) band.metrics.push('')
  band.metrics[index] = value
  while (band.metrics.length && band.metrics[band.metrics.length - 1] === '') {
    band.metrics.pop()
  }
}

// Ce que choisit le `<select>` d'une case : soit un jeton simple (mesure,
// commande, radar, sonnette), soit `'mark_lap'` — auquel cas la case devient
// l'objet réglable (série + label) plutôt que la chaîne elle-même.
function setBandSlotKind(band: Band, index: number, value: string) {
  setBandMetric(band, index, value === 'mark_lap' ? { kind: 'mark_lap', series: 'default' } : value)
}

function setBandLapSeries(band: Band, index: number, value: string) {
  const slot = band.metrics[index]
  if (typeof slot === 'object') slot.series = value
}

function setBandLapLabel(band: Band, index: number, value: string) {
  const slot = band.metrics[index]
  if (typeof slot === 'object') slot.label = value || undefined
}

// ── la bande de l'encoche ───────────────────────────────────────────────────

function addNotchSet() {
  const notch = preset.value.notch || (preset.value.notch = [])
  notch.push({})
}

function setNotchMetric(set: Notch, side: 'left' | 'right', value: string | BandMarkLapSlot) {
  if (value) set[side] = value
  else delete set[side]
}

// Même rôle que `setBandSlotKind`, côté encoche.
function setNotchSlotKind(set: Notch, side: 'left' | 'right', value: string) {
  setNotchMetric(set, side, value === 'mark_lap' ? { kind: 'mark_lap', series: 'default' } : value)
}

function setNotchLapSeries(set: Notch, side: 'left' | 'right', value: string) {
  const slot = set[side]
  if (typeof slot === 'object') slot.series = value
}

function setNotchLapLabel(set: Notch, side: 'left' | 'right', value: string) {
  const slot = set[side]
  if (typeof slot === 'object') slot.label = value || undefined
}

function removeNotchSet(index: number) {
  const notch = preset.value.notch
  if (!notch) return
  notch.splice(index, 1)
  if (notch.length === 0) preset.value.notch = undefined
}

function moveNotchSet(index: number, delta: number) {
  const notch = preset.value.notch
  if (!notch) return
  const target = index + delta
  if (target < 0 || target >= notch.length) return
  const [set] = notch.splice(index, 1)
  notch.splice(target, 0, set)
}

function duplicateNotchSet(index: number) {
  const notch = preset.value.notch
  if (!notch) return
  const copy = structuredClone(toRaw(notch[index])) as Notch
  notch.splice(index + 1, 0, copy)
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

function batteryValue(key: string, fallback: number): number {
  const value = preset.value.battery?.[key]
  return typeof value === 'number' ? value : fallback
}

function setBattery(key: string, value: number | boolean) {
  preset.value.battery = { ...(preset.value.battery || {}), [key]: value }
}

function setClimb(key: string, value: boolean) {
  preset.value.climb = { ...(preset.value.climb || {}), [key]: value }
}

function setWorkout(key: string, value: boolean) {
  preset.value.workout = { ...(preset.value.workout || {}), [key]: value }
}

function setLaps(key: string, value: boolean) {
  preset.value.laps = { ...(preset.value.laps || {}), [key]: value }
}

// ── les rappels périodiques ─────────────────────────────────────────────────

function addReminder() {
  const reminders = preset.value.reminders || (preset.value.reminders = [])
  if (reminders.length >= props.catalog.max_reminders) return
  // Un message non vide dès la création : un rappel sans texte est rejeté par
  // l'assainisseur (`CompanionSettings.sanitize_reminder`) comme un rappel qui
  // ne dirait jamais rien, et disparaîtrait donc silencieusement au premier
  // « Enregistrer » avant même d'avoir eu le temps de le remplir — même raison
  // qu'`addBand` ne part jamais d'un jeu vide.
  reminders.push({
    interval_minutes: 30,
    message: t('companion.settings.new_reminder_message'),
    sound: props.catalog.reminder_sounds[0],
  })
}

function removeReminder(index: number) {
  const reminders = preset.value.reminders
  if (!reminders) return
  reminders.splice(index, 1)
  if (reminders.length === 0) preset.value.reminders = undefined
}

// Le nombre de fois qu'un rappel sonne dans la sortie. Vide (ou < 1) = illimité :
// on retire alors la clé plutôt que d'écrire un `count` que l'assainisseur
// (`CompanionSettings.sanitize_reminder`) jetterait de toute façon — un rappel
// « boire » ordinaire n'en porte pas.
function setReminderCount(reminder: Reminder, raw: string) {
  const n = Math.round(Number(raw))
  if (!raw || !Number.isFinite(n) || n < 1) {
    delete reminder.count
    return
  }
  reminder.count = Math.min(n, props.catalog.max_reminder_count)
}

// Le délai avant le tout premier rappel. 0 (ou vide) = pas de délai, même
// convention que `count` : on retire alors la clé plutôt que d'écrire un
// `start_after_minutes` que l'assainisseur jetterait de toute façon.
function setReminderStartAfter(reminder: Reminder, raw: string) {
  const n = Math.round(Number(raw))
  if (!raw || !Number.isFinite(n) || n < 1) {
    delete reminder.start_after_minutes
    return
  }
  reminder.start_after_minutes = Math.min(n, props.catalog.max_reminder_start_after_minutes)
}

// ── les boutons Di2 ─────────────────────────────────────────────────────────
//
// Quatre canaux fixes — seuls 1 et 2 sont câblés sur le matériel testé côté
// appli, mais 3 et 4 suivent le même format et n'ont pas de raison d'attendre
// pour être configurables. Une constante locale et non un catalogue serveur,
// contrairement aux gestes (`catalog.button_gestures`) : c'est une propriété
// du D-Fly, pas un réglage qui pourrait évoluer sans toucher au code.
const BUTTON_CHANNELS = ['channel1', 'channel2', 'channel3', 'channel4'] as const

// Seules les pages déjà enregistrées (qui ont donc une clé — voir `Page.key`)
// peuvent être visées par « Aller à… » : le serveur est ce qui fabrique la
// clé, une page qui vient d'être ajoutée n'en a pas encore.
const goToPageTargets = computed(() => preset.value.pages.filter((page) => page.key))

function buttonAction(channel: keyof Buttons, gesture: keyof ButtonChannel): string {
  return preset.value.buttons?.[channel]?.[gesture] || ''
}

function setButtonAction(channel: keyof Buttons, gesture: keyof ButtonChannel, value: string) {
  const buttons: Buttons = { ...(preset.value.buttons || {}) }
  const channelActions: ButtonChannel = { ...(buttons[channel] || {}) }
  if (value) channelActions[gesture] = value
  else delete channelActions[gesture]

  if (Object.keys(channelActions).length > 0) buttons[channel] = channelActions
  else delete buttons[channel]
  preset.value.buttons = Object.keys(buttons).length > 0 ? buttons : undefined
}

// `start_lap` (seul, ou `start_lap:<série>`) est le seul token de
// `button_actions` à porter un réglage libre — même raison que
// `BandMarkLapSlot` porte sa `series` à part d'un simple jeton. `null` pour
// tout autre choix (dont l'absence) : c'est ce qui décide si le champ série
// apparaît sous le menu déroulant.
function buttonActionLapSeries(action: string): string | null {
  if (action === 'start_lap') return 'default'
  if (action.startsWith('start_lap:')) return action.slice('start_lap:'.length) || 'default'
  return null
}

// Le menu déroulant n'a qu'une option `start_lap` (sans série) : un choix
// `start_lap:<série>` doit donc s'y reconnaître comme ce même choix, sous
// peine de retomber visuellement sur « aucune action » dès qu'une série est
// tapée dans le champ à part.
function buttonActionKind(action: string): string {
  return buttonActionLapSeries(action) !== null ? 'start_lap' : action
}

function setButtonActionLapSeries(channel: keyof Buttons, gesture: keyof ButtonChannel, series: string) {
  setButtonAction(channel, gesture, `start_lap:${series || 'default'}`)
}

// Choix dans le menu déroulant (`buttonActionKind`, valeurs de base) — préserve
// la série déjà tapée si elle y en avait une, plutôt que de la perdre au
// moindre aller-retour sur `start_lap` dans le menu.
function setButtonActionKind(channel: keyof Buttons, gesture: keyof ButtonChannel, kind: string) {
  if (kind !== 'start_lap') {
    setButtonAction(channel, gesture, kind)
    return
  }
  const series = buttonActionLapSeries(buttonAction(channel, gesture))
  setButtonAction(channel, gesture, `start_lap:${series || 'default'}`)
}

function traveledPathValue(key: string, fallback: number): number {
  const value = preset.value.traveled_path?.[key]
  return typeof value === 'number' ? value : fallback
}

function setTraveledPath(key: string, value: number | string) {
  preset.value.traveled_path = { ...(preset.value.traveled_path || {}), [key]: value }
}

// Même raison qu'un séparateur (`dividerColor`) : la ligne du trajet parcouru
// a toujours besoin d'une couleur, un `null` (bouton « réinitialiser » de
// `CompanionColorPicker`) retombe donc sur la couleur par défaut plutôt que de
// rester sans couleur.
const traveledPathColor = computed<string | null>({
  get: () => (typeof preset.value.traveled_path?.color === 'string' ? preset.value.traveled_path.color : null),
  set: (value) => setTraveledPath('color', value || DEFAULT_TRAVELED_PATH_COLOR),
})

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
      body: JSON.stringify({ presets, metric_layouts: metricLayouts }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    // On se réaligne sur ce que le serveur a réellement gardé. C'est le point :
    // l'appli appliquerait les mêmes corrections en silence et sur la route ;
    // les montrer ici est la seule occasion de s'en apercevoir.
    const payload = (await res.json()) as CompanionDocument
    presets.splice(0, presets.length, ...payload.presets)
    metricLayouts.splice(0, metricLayouts.length, ...(payload.metric_layouts || []))
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
          <i v-if="item.icon" :class="item.icon" class="me-1" aria-hidden="true"></i>{{ item.name }}
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
        <!-- Nom, description, icône et types d'itinéraire repliés derrière un
             bouton, même parti pris que les réglages d'une page
             (`showPageConfig`) : ce sont les traits d'identité du profil, on
             les fixe une fois puis on compose les pages et le bandeau. Les
             pastilles du sélecteur en haut redisent déjà le nom et l'icône
             pendant qu'on travaille. -->
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
          <button type="button"
                  class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2"
                  :class="{ active: showPresetConfig }"
                  :aria-expanded="showPresetConfig"
                  @click="showPresetConfig = !showPresetConfig">
            <i class="fa-solid fa-sliders" aria-hidden="true"></i>
            {{ t('companion.settings.configure_preset') }}
          </button>
          <div class="d-flex gap-2 ms-auto">
            <button class="btn btn-sm btn-outline-secondary" type="button" @click="duplicatePreset">
              <i class="fa-regular fa-copy me-1" aria-hidden="true"></i>{{ t('companion.settings.duplicate') }}
            </button>
            <button class="btn btn-sm btn-outline-danger" type="button"
                    :disabled="presets.length <= 1" @click="removePreset">
              <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <template v-if="showPresetConfig">
          <div class="mb-2">
            <label class="form-label small mb-1">{{ t('companion.settings.name') }}</label>
            <input v-model="preset.name" class="form-control" type="text">
          </div>
          <div class="mb-2">
            <label class="form-label small mb-1">{{ t('companion.settings.description') }}</label>
            <input v-model="preset.description" class="form-control" type="text" maxlength="140"
                   :placeholder="t('companion.settings.description_placeholder')">
          </div>

          <!-- L'icône qui voyage avec le profil : l'appli la montre dans son
               sélecteur de départ, où plusieurs profils se ressembleraient sinon.
               « Icône par défaut » dessine le repère que l'appli prendra faute de
               choix (carte si le profil a une carte, maison sinon). -->
          <div class="mb-3">
            <label class="form-label small mb-1">{{ t('companion.settings.preset_icon_label') }}</label>
            <div class="cdb-icons">
              <button type="button" class="cdb-icon-btn cdb-icon-btn--default"
                      :class="{ 'cdb-icon-btn--selected': !preset.icon }"
                      :title="t('companion.settings.default_icon')"
                      @click="setPresetIcon(undefined)">
                <i :class="presetDefaultIcon" aria-hidden="true"></i>
              </button>
              <button v-for="ic in catalog.icons" :key="ic" type="button"
                      class="cdb-icon-btn" :class="{ 'cdb-icon-btn--selected': preset.icon === ic }"
                      @click="setPresetIcon(ic)">
                <i :class="ic" aria-hidden="true"></i>
              </button>
            </div>
            <p class="text-body-secondary small mb-0">{{ t('companion.settings.preset_icon_help') }}</p>
          </div>

          <div class="mb-3">
            <label class="form-label small mb-1">{{ t('companion.settings.activities_title') }}</label>
            <p class="text-body-secondary small mb-2">{{ t('companion.settings.activities_help') }}</p>
            <div class="d-flex flex-column gap-1">
              <div v-for="activity in catalog.activities" :key="activity"
                   class="d-flex align-items-center gap-2">
                <div class="form-check mb-0">
                  <input class="form-check-input" type="checkbox" :id="`activity-${activity}`"
                         :checked="presetHasActivity(activity)"
                         @change="toggleActivity(activity, ($event.target as HTMLInputElement).checked)">
                  <label class="form-check-label small" :for="`activity-${activity}`">
                    {{ t(`routes.wt_sport_${activity}`) }}
                  </label>
                </div>
                <!-- L'étoile n'apparaît qu'une fois le type lié : marquer un
                     défaut pour un type que ce profil ne propose même pas ne
                     voudrait rien dire. -->
                <button v-if="presetHasActivity(activity)" type="button"
                        class="btn btn-sm btn-link p-0"
                        :class="isDefaultForActivity(activity) ? 'text-warning' : 'text-body-secondary'"
                        :title="t('companion.settings.default_for', { sport: t(`routes.wt_sport_${activity}`) })"
                        :aria-label="t('companion.settings.default_for', { sport: t(`routes.wt_sport_${activity}`) })"
                        @click="toggleDefaultForActivity(activity)">
                  <i :class="isDefaultForActivity(activity) ? 'fa-solid fa-star' : 'fa-regular fa-star'"
                     aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </div>
        </template>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.pages"
                  @click="toggleSection('pages')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.pages }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.pages" aria-hidden="true"></i>
            {{ t('companion.settings.pages') }}
            <span v-if="sectionBadge('pages')" class="cdb-sec-count">{{ sectionBadge('pages') }}</span>
          </button>
        </h2>
        <div v-if="openSections.pages" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.pages_help') }}</p>

        <div v-for="(page, index) in preset.pages" :key="index" class="border rounded mb-2">
          <div class="d-flex align-items-center flex-wrap gap-2 p-2">
            <span class="badge text-bg-secondary">{{ t(`companion.settings.page_kinds.${page.kind}`) }}</span>
            <!-- Là où elle se trouve, et pas seulement le fait qu'elle soit
                 rangée : « Menu » à côté du genre est le seul endroit où l'on
                 relit la composition du défilement sans ouvrir chaque page. -->
            <span v-if="page.menu" class="badge text-bg-light border">
              <i class="fa-solid fa-ellipsis-vertical me-1" aria-hidden="true"></i>{{ t('companion.settings.behind_menu') }}
            </span>
            <!-- Le même repère qu'on ira relire dans le menu ⋮ du téléphone :
                 le voir déjà ici aide à choisir une icône qui distingue
                 vraiment cette page des pages voisines. -->
            <i v-if="page.icon" :class="page.icon" class="text-body-secondary" aria-hidden="true"></i>
            <span class="flex-grow-1 text-truncate" style="min-width: 5rem">
              {{ page.title || t('companion.settings.page_kinds.map') }}
            </span>
            <!-- Les actions groupées et poussées à droite (`ms-auto`) : sur un
                 écran étroit, le groupe passe entier sous le titre au lieu de
                 déborder l'en-tête bouton par bouton. -->
            <div class="d-flex align-items-center gap-1 ms-auto">
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
              <!-- Pas pour la carte : il ne peut jamais y en avoir deux (voir
                   `hasMap` sur le bouton « Ajouter »), une copie disparaîtrait
                   donc en silence au premier « Enregistrer ». -->
              <button v-if="page.kind !== 'map'" class="btn btn-sm btn-link p-1" type="button"
                      :title="t('companion.settings.duplicate')"
                      :aria-label="t('companion.settings.duplicate')"
                      @click="duplicatePage(index)">
                <i class="fa-regular fa-copy" aria-hidden="true"></i>
              </button>
              <button class="btn btn-sm btn-link text-danger p-1" type="button"
                      @click="removePage(index)">
                <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
              </button>
            </div>
          </div>

          <div v-if="openPage === index" class="border-top p-2">
            <!-- Réglages de page repliés ici pour alléger le panneau : nom,
                 icône, bouton retour, condition de retour au défilement +
                 bascule auto, et (plus bas, même `v-if`) le nombre de lignes /
                 colonnes. À l'ouverture on voit d'abord l'aperçu, pas une pile
                 de champs. -->
            <button type="button"
                    class="btn btn-sm btn-outline-secondary mb-2 d-inline-flex align-items-center gap-2"
                    :class="{ active: showPageConfig }"
                    :aria-expanded="showPageConfig"
                    @click="showPageConfig = !showPageConfig">
              <i class="fa-solid fa-sliders" aria-hidden="true"></i>
              {{ t('companion.settings.configure_page') }}
            </button>

            <template v-if="showPageConfig">
              <input v-model="page.title" class="form-control form-control-sm mb-2"
                     :placeholder="t('companion.settings.page_title')">

              <!-- Le repère qui la distingue dans le menu ⋮ du téléphone, où
                   plusieurs pages du même genre (deux grilles, par exemple) se
                   ressembleraient sinon trait pour trait. Pas seulement pour les
                   pages rangées derrière le menu : une page du défilement peut y
                   être rangée plus tard sans repasser par ici. -->
              <div class="mb-2">
                <label class="small mb-1 d-block">{{ t('companion.settings.page_icon_label') }}</label>
                <div class="cdb-icons">
                  <!-- « Icône par défaut » : on dessine l'icône déduite du genre
                       de page (celle que l'appli prendra faute de choix), pas son
                       libellé — qui débordait de la case. Le point dans le coin
                       et l'infobulle disent que c'est le choix qui suit le genre. -->
                  <button type="button" class="cdb-icon-btn cdb-icon-btn--default"
                          :class="{ 'cdb-icon-btn--selected': !page.icon }"
                          :title="t('companion.settings.default_icon')"
                          @click="setPageIcon(page, undefined)">
                    <i :class="pageDefaultIcon(page)" aria-hidden="true"></i>
                  </button>
                  <button v-for="ic in catalog.icons" :key="ic" type="button"
                          class="cdb-icon-btn" :class="{ 'cdb-icon-btn--selected': page.icon === ic }"
                          @click="setPageIcon(page, ic)">
                    <i :class="ic" aria-hidden="true"></i>
                  </button>
                </div>
                <p class="text-body-secondary small mb-0">{{ t('companion.settings.page_icon_help') }}</p>
              </div>

              <!-- Un raccourci de plus pour sortir, jamais le seul : le menu ⋮
                   garde toujours « Revenir à l'accueil », que cette case soit
                   cochée ou non. -->
              <div class="mb-2 form-check">
                <input :id="`leave-button-${index}`" type="checkbox" class="form-check-input"
                       :checked="!!page.leave_button" @change="toggleLeaveButton(page)">
                <label class="form-check-label small" :for="`leave-button-${index}`">
                  {{ t('companion.settings.page_leave_button_label') }}
                </label>
                <p class="text-body-secondary small mb-0">{{ t('companion.settings.page_leave_button_help') }}</p>
              </div>

              <!-- Seulement pour une page déjà rangée derrière le menu : la
                   condition qui l'en fait ressortir toute seule pendant la
                   sortie, et si on bascule dessus quand elle devient vraie. -->
              <div v-if="page.menu" class="mb-2">
                <label class="small mb-1 d-block">{{ t('companion.settings.menu_condition_label') }}
                  <select class="form-select form-select-sm" :value="page.menu_condition || ''"
                          @change="setMenuCondition(page, ($event.target as HTMLSelectElement).value)">
                    <option value="">{{ t('companion.settings.menu_condition_options.none') }}</option>
                    <option v-for="condition in catalog.menu_conditions" :key="condition" :value="condition">
                      {{ t(`companion.settings.menu_condition_options.${condition}`) }}
                    </option>
                  </select>
                </label>
                <p class="text-body-secondary small mb-0">{{ t('companion.settings.menu_condition_help') }}</p>
                <div v-if="page.menu_condition === 'lap_named'" class="mt-1">
                  <input class="form-control form-control-sm"
                         :value="page.menu_condition_lap_name || ''"
                         @change="setMenuConditionLapName(page, ($event.target as HTMLInputElement).value)"
                         maxlength="10" :placeholder="t('companion.settings.menu_condition_lap_name_placeholder')">
                </div>
                <div v-if="page.menu_condition" class="form-check mt-1">
                  <input v-model="page.menu_auto_open" type="checkbox" class="form-check-input"
                         :id="`menu-auto-open-${index}`">
                  <label class="form-check-label small" :for="`menu-auto-open-${index}`">
                    {{ t('companion.settings.menu_auto_open_label') }}
                  </label>
                </div>
              </div>
            </template>

            <!-- Une page de tours : la série qu'elle affiche. Un bouton
                 « Marquer un tour » posé ailleurs doit porter la même clé
                 pour alimenter cette page-là — voir `lapSeries`. -->
            <div v-if="page.kind === 'laps'" class="mb-2">
              <label class="small mb-1 d-block">{{ t('companion.settings.lap_series') }}
                <input v-model="page.series" type="text" list="companion-series-list"
                       class="form-control form-control-sm">
              </label>
              <p class="text-body-secondary small mb-0">{{ t('companion.settings.lap_series_help') }}</p>
              <p class="text-body-secondary small mb-0">{{ t('companion.settings.lap_series_cols_hint') }}</p>
            </div>

            <!-- Liste défilante ou grille : même choix qu'entre une page
                 `list` et une page `grid`, mais qui reste une page `laps` —
                 seule la disposition du contenu du tour choisi change. -->
            <div v-if="page.kind === 'laps'" class="mb-3">
              <label class="small mb-1 d-block">{{ t('companion.settings.lap_layout') }}</label>
              <div class="btn-group btn-group-sm" role="group">
                <button type="button" class="btn"
                        :class="isGridLayout(page) ? 'btn-outline-secondary' : 'btn-secondary'"
                        @click="setLapLayout(page, 'list')">
                  {{ t('companion.settings.page_kinds.list') }}
                </button>
                <button type="button" class="btn"
                        :class="isGridLayout(page) ? 'btn-secondary' : 'btn-outline-secondary'"
                        @click="setLapLayout(page, 'grid')">
                  {{ t('companion.settings.page_kinds.grid') }}
                </button>
              </div>
            </div>

            <!-- Une grille -->
            <template v-if="isGridLayout(page)">
              <div v-if="showPageConfig" class="d-flex align-items-center gap-3 mb-2">
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

              <!-- Sur PC : l'aperçu à gauche, le panneau de réglages de la case
                   (déplacer, étendues, changer, échanger, retirer) à sa droite
                   plutôt qu'en dessous, où il obligeait à faire l'aller-retour
                   des yeux. Sous 768 px, `.companion-grid-edit` redevient un
                   simple bloc : tout se réempile comme avant. -->
              <div class="companion-grid-edit">
              <div class="companion-grid-wrap mb-2">
                <div class="companion-grid"
                     :style="{ gridTemplateColumns: `repeat(${page.cols}, 1fr)`,
                               gridTemplateRows: `repeat(${page.rows}, 1fr)`,
                               aspectRatio: `${grid.width} / ${grid.height}` }">
                  <!-- `selected` teste `!!slot.cell` d'abord : sans lui, une case
                       vide (`null`) est « égale » à l'absence de sélection (`null`
                       aussi), et **toutes** les cases libres s'allument dès qu'on
                       ne sélectionne rien. -->
                  <button v-for="slot in slots(page)" :key="slot.key" type="button"
                          class="companion-cell"
                          :class="{ filled: !!slot.cell, selected: !!slot.cell && slot.cell === selected,
                                    'swap-target': swapping && canSwapTo(slot.cell),
                                    'swap-source': swapping && slot.cell === selected,
                                    'cell-muted': !!selected && !swapping && !!slot.cell && slot.cell !== selected }"
                          :style="styleFor(page, slot.cell, slot.row, slot.col)"
                          :title="slot.cell ? labelFor(slot.cell.block) : t('companion.settings.add_block')"
                          @click="tapSlot(page, slot.row, slot.col, slot.cell)"
                          @dblclick="dblTapSlot(page, slot.cell)">
                    <CompanionBlockPreview v-if="slot.cell" :block="slot.cell.block"
                                           :lap-scoped="page.kind === 'laps'" />
                    <i v-else class="fa-solid fa-plus text-body-secondary" aria-hidden="true"></i>
                  </button>
                </div>
                <!-- Les gouttières, en survol par-dessus la grille : un séparateur
                     traverse toujours toute la largeur/hauteur, un clic sur sa
                     gouttière suffit donc à le poser. -->
                <button v-for="gutter in gutters(page)" :key="gutter.key" type="button"
                        class="companion-gutter"
                        :class="[`companion-gutter-${gutter.axis}`,
                                 { filled: !!gutter.divider, selected: !!gutter.divider && gutter.divider === selectedDivider }]"
                        :style="styleForGutter(page, gutter.axis, gutter.at, gutter.divider?.color)"
                        :title="t('companion.settings.divider_hint')"
                        @click="tapGutter(page, gutter.axis, gutter.at, gutter.divider)">
                </button>
              </div>

              <div class="companion-grid-edit-side">
              <!-- Le mode échange s'annonce à côté de la grille (sous elle sur
                   téléphone) : c'est la seule phrase qui dit ce que touchent
                   maintenant les cases, y compris celles restées ternes (pas de
                   cible valable). -->
              <p v-if="swapping" class="text-primary small mb-2">
                <i class="fa-solid fa-right-left me-1" aria-hidden="true"></i>{{ t('companion.settings.swap_hint') }}
              </p>

              <!-- À quelle échelle on vient de composer. La phrase change selon
                   que l'appli a annoncé sa grille ou non : une mesure et une
                   supposition ne se lisent pas pareil, et c'est toute la
                   différence que cette annonce apporte. -->
              <p class="text-body-secondary small">
                {{ measured
                  ? t('companion.settings.scale_measured', { width: grid.width, height: grid.height })
                  : t('companion.settings.scale_assumed', { width: grid.width, height: grid.height }) }}
              </p>

              <div v-if="selected" class="border border-primary rounded p-2 bg-body-tertiary">
                <!-- `flex-wrap` + groupe de boutons : sur un écran étroit,
                     « Changer »/« Échanger » passent sous le nom du composant
                     au lieu de le tronquer sur la même ligne. -->
                <div class="d-flex align-items-center flex-wrap gap-2">
                  <i class="fa-solid fa-up-down-left-right text-primary" aria-hidden="true"></i>
                  <span class="flex-grow-1 text-truncate small fw-semibold" style="min-width: 8rem">
                    {{ labelFor(selected.block) }}
                  </span>
                  <div class="d-flex align-items-center gap-2 ms-auto">
                    <i v-if="lapSeriesMismatch(page, selected.block)"
                       class="fa-solid fa-triangle-exclamation text-warning"
                       :title="t('companion.settings.lap_series_mismatch', { series: page.series || 'default' })"
                       aria-hidden="true"></i>
                    <button class="btn btn-sm btn-outline-secondary" type="button"
                            @click="picker = { at: 'cell', page, cell: selected }">
                      {{ t('companion.settings.change_block') }}
                    </button>
                    <button class="btn btn-sm btn-outline-secondary" type="button"
                            :class="{ active: swapping }"
                            @click="swapping = !swapping">
                      <i class="fa-solid fa-right-left me-1" aria-hidden="true"></i>{{ t('companion.settings.swap_cell') }}
                    </button>
                  </div>
                </div>
                <!-- Ce que ce composant montre, en une phrase : la même aide que
                     la dialogue de choix, gardée sous les yeux pendant qu'on
                     règle sa place et son étendue. -->
                <p v-if="blockDescription(selected.block)"
                   class="text-body-secondary small mb-0 mt-2">
                  {{ blockDescription(selected.block) }}
                </p>
                <!-- L'étendue au pas : le « + » s'éteint dès que la voisine ou le
                     bord de la grille est atteint, si bien que la place libre se
                     voit sans avoir à la calculer. -->
                <div class="d-flex align-items-end gap-3 mt-2 flex-wrap">
                  <div>
                    <div class="small mb-1">{{ t('companion.settings.move_cell') }}</div>
                    <div class="companion-move-pad" role="group"
                         :aria-label="t('companion.settings.move_cell')">
                      <span></span>
                      <button class="btn btn-sm btn-outline-secondary p-1" type="button"
                              :disabled="!canMove(page, 'row', -1)"
                              :aria-label="t('companion.settings.move_up')"
                              @click="moveCell(page, 'row', -1)">
                        <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
                      </button>
                      <span></span>
                      <button class="btn btn-sm btn-outline-secondary p-1" type="button"
                              :disabled="!canMove(page, 'col', -1)"
                              :aria-label="t('companion.settings.move_left')"
                              @click="moveCell(page, 'col', -1)">
                        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
                      </button>
                      <span class="companion-move-center text-body-secondary">
                        <i class="fa-solid fa-up-down-left-right" aria-hidden="true"></i>
                      </span>
                      <button class="btn btn-sm btn-outline-secondary p-1" type="button"
                              :disabled="!canMove(page, 'col', 1)"
                              :aria-label="t('companion.settings.move_right')"
                              @click="moveCell(page, 'col', 1)">
                        <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
                      </button>
                      <span></span>
                      <button class="btn btn-sm btn-outline-secondary p-1" type="button"
                              :disabled="!canMove(page, 'row', 1)"
                              :aria-label="t('companion.settings.move_down')"
                              @click="moveCell(page, 'row', 1)">
                        <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
                      </button>
                      <span></span>
                    </div>
                  </div>
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

              <div v-if="selectedDivider" class="border rounded p-2 bg-body-tertiary d-flex align-items-center gap-2">
                <span class="flex-grow-1 small">{{ t('companion.settings.divider_color') }}</span>
                <CompanionColorPicker v-model="dividerColor" :fallback="DEFAULT_DIVIDER_COLOR"
                                       :label="t('companion.settings.divider_color')" />
                <button class="btn btn-sm btn-outline-danger" type="button" @click="removeDivider(page)">
                  {{ t('companion.settings.remove_divider') }}
                </button>
              </div>
              </div><!-- /.companion-grid-edit-side -->
              </div><!-- /.companion-grid-edit -->
            </template>

            <!-- Une page qui défile : les composants dans l'ordre où elle les
                 empile, chacun dessiné tel qu'il paraîtra. Vaut aussi bien pour
                 `list` que pour `laps` en liste défilante — même disposition
                 des deux côtés, seule la série de tours change autour. -->
            <template v-else>
              <div v-if="showPageConfig" class="d-flex align-items-center gap-3 mb-2">
                <label class="small mb-0">{{ t('companion.settings.cols') }}
                  <input class="form-control form-control-sm d-inline-block ms-1"
                         style="width: 5rem" type="number" min="1"
                         :max="catalog.max_list_cols" :value="page.cols || 1"
                         @change="commitListCols(page, $event.target as HTMLInputElement)">
                </label>
                <p v-if="(page.cols || 1) > 1" class="text-body-secondary small mb-0">
                  {{ t('companion.settings.list_cols_help') }}
                </p>
              </div>

              <!-- L'aperçu : la même traversée que `DashboardListBody` côté
                   appli (`listSegments`), en schéma plutôt qu'en rendu exact —
                   une page qui défile n'a pas de largeur de téléphone à
                   simuler comme une grille. Seulement à plus d'une colonne :
                   à une seule, la liste ci-dessous en dessous dit déjà tout. -->
              <div v-if="(page.cols || 1) > 1"
                   class="companion-list-preview d-flex flex-column gap-1 border rounded p-2 mb-3 bg-body-tertiary">
                <template v-for="(segment, si) in listSegments(page.blocks || [], page.cols || 1)" :key="si">
                  <div v-if="segment.kind === 'full_width'"
                       class="companion-list-preview-chip companion-list-preview-chip--full text-truncate">
                    {{ labelFor(segment.block) }}
                  </div>
                  <div v-else-if="segment.kind === 'columns'" class="d-flex gap-1 align-items-stretch">
                    <div v-for="(column, ci) in segment.columns" :key="ci"
                         class="d-flex flex-column gap-1 flex-fill" style="min-width: 0">
                      <div v-for="(block, bi) in column" :key="bi"
                           class="companion-list-preview-chip text-truncate">
                        {{ labelFor(block) }}
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <div v-for="(block, i) in page.blocks" :key="i"
                   class="d-flex align-items-center gap-2 mb-2">
                <!-- Double clic / double tap sur l'aperçu : ouvre la dialogue de
                     changement, comme le bouton « Changer » de la ligne (qui
                     reste le chemin au clavier). -->
                <div class="companion-block-preview flex-shrink-0"
                     @dblclick="picker = { at: 'block', page, index: i }">
                  <CompanionBlockPreview :block="block" :lap-scoped="page.kind === 'laps'" />
                </div>
                <span class="flex-grow-1 text-truncate small">{{ labelFor(block) }}</span>
                <!-- La série du bouton et celle de la page sont deux réglages
                     indépendants (voir `LapListBody._block`, dépôt voisin) :
                     un bouton qui ne porte pas la série affichée marque un
                     tour ailleurs, sans que rien ne bouge sous les yeux. -->
                <i v-if="lapSeriesMismatch(page, block)"
                   class="fa-solid fa-triangle-exclamation text-warning"
                   :title="t('companion.settings.lap_series_mismatch', { series: page.series || 'default' })"
                   aria-hidden="true"></i>
                <!-- Seulement quand la page a plus d'une colonne : à une
                     seule, les deux ruptures n'auraient rien à côté de quoi
                     rompre, et les afficher quand même ferait chercher un
                     réglage qui ne change jamais rien. Un bloc reste sinon
                     par défaut dans la colonne du précédent — ces deux
                     boutons ne marquent que les ruptures. -->
                <template v-if="(page.cols || 1) > 1">
                  <button class="btn btn-sm btn-outline-secondary" type="button"
                          :class="{ active: block.new_column }"
                          :disabled="!!block.full_width"
                          :title="t('companion.settings.block_new_column')"
                          @click="toggleNewColumn(block)">
                    <i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i>
                  </button>
                  <button class="btn btn-sm btn-outline-secondary" type="button"
                          :class="{ active: block.full_width }"
                          :title="t('companion.settings.block_full_width')"
                          @click="toggleFullWidth(block)">
                    <i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i>
                  </button>
                </template>
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

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.notch"
                  @click="toggleSection('notch')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.notch }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.notch" aria-hidden="true"></i>
            {{ t('companion.settings.notch') }}
            <span v-if="sectionBadge('notch')" class="cdb-sec-count">{{ sectionBadge('notch') }}</span>
          </button>
        </h2>
        <div v-if="openSections.notch" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.notch_help') }}</p>

        <div v-for="(set, index) in preset.notch || []" :key="index"
             class="d-flex align-items-center gap-2 mb-2">
          <div class="row g-1 flex-grow-1">
            <div class="col-6">
              <select class="form-select form-select-sm" :value="bandSlotKind(set.left)"
                      @change="setNotchSlotKind(set, 'left', ($event.target as HTMLSelectElement).value)">
                <option value="">—</option>
                <optgroup :label="t('companion.settings.band_actions_group')">
                  <option v-for="action in catalog.band_actions" :key="action" :value="action">
                    {{ bandActionLabel(action) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_radar_group')">
                  <option v-for="radar in catalog.band_radar" :key="radar" :value="radar">
                    {{ bandRadarLabel(radar) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_workout_group')">
                  <option v-for="workout in catalog.band_workout" :key="workout" :value="workout">
                    {{ bandWorkoutLabel(workout) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_bell_group')">
                  <option v-for="bell in catalog.band_bell" :key="bell" :value="bell">
                    {{ bandBellLabel(bell) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_lap_group')">
                  <option v-for="lap in catalog.band_mark_lap" :key="lap" :value="lap">
                    {{ bandActionLabel(lap) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_metrics_group')">
                  <option v-for="metric in sortedMetrics" :key="metric" :value="metric">
                    {{ metricLabel(metric) }}
                  </option>
                </optgroup>
              </select>
              <div v-if="bandLapSlot(set.left)" class="d-flex gap-1 mt-1">
                <input class="form-control form-control-sm" style="min-width: 0"
                       :value="bandLapSlot(set.left)!.series"
                       @change="setNotchLapSeries(set, 'left', ($event.target as HTMLInputElement).value)"
                       list="band-lap-series-list" :placeholder="t('companion.settings.lap_series')">
                <input class="form-control form-control-sm" style="min-width: 0"
                       :value="bandLapSlot(set.left)!.label || ''"
                       @change="setNotchLapLabel(set, 'left', ($event.target as HTMLInputElement).value)"
                       maxlength="10" :placeholder="t('companion.settings.band_lap_label')">
              </div>
            </div>
            <div class="col-6">
              <select class="form-select form-select-sm" :value="bandSlotKind(set.right)"
                      @change="setNotchSlotKind(set, 'right', ($event.target as HTMLSelectElement).value)">
                <option value="">—</option>
                <optgroup :label="t('companion.settings.band_actions_group')">
                  <option v-for="action in catalog.band_actions" :key="action" :value="action">
                    {{ bandActionLabel(action) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_radar_group')">
                  <option v-for="radar in catalog.band_radar" :key="radar" :value="radar">
                    {{ bandRadarLabel(radar) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_workout_group')">
                  <option v-for="workout in catalog.band_workout" :key="workout" :value="workout">
                    {{ bandWorkoutLabel(workout) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_bell_group')">
                  <option v-for="bell in catalog.band_bell" :key="bell" :value="bell">
                    {{ bandBellLabel(bell) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_lap_group')">
                  <option v-for="lap in catalog.band_mark_lap" :key="lap" :value="lap">
                    {{ bandActionLabel(lap) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_metrics_group')">
                  <option v-for="metric in sortedMetrics" :key="metric" :value="metric">
                    {{ metricLabel(metric) }}
                  </option>
                </optgroup>
              </select>
              <div v-if="bandLapSlot(set.right)" class="d-flex gap-1 mt-1">
                <input class="form-control form-control-sm" style="min-width: 0"
                       :value="bandLapSlot(set.right)!.series"
                       @change="setNotchLapSeries(set, 'right', ($event.target as HTMLInputElement).value)"
                       list="band-lap-series-list" :placeholder="t('companion.settings.lap_series')">
                <input class="form-control form-control-sm" style="min-width: 0"
                       :value="bandLapSlot(set.right)!.label || ''"
                       @change="setNotchLapLabel(set, 'right', ($event.target as HTMLInputElement).value)"
                       maxlength="10" :placeholder="t('companion.settings.band_lap_label')">
              </div>
            </div>
          </div>
          <button class="btn btn-sm btn-link p-1" type="button"
                  :disabled="index === 0" @click="moveNotchSet(index, -1)">
            <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
          </button>
          <button class="btn btn-sm btn-link p-1" type="button"
                  :disabled="index === (preset.notch || []).length - 1" @click="moveNotchSet(index, 1)">
            <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
          </button>
          <button class="btn btn-sm btn-link p-1" type="button"
                  :title="t('companion.settings.duplicate')"
                  :aria-label="t('companion.settings.duplicate')"
                  @click="duplicateNotchSet(index)">
            <i class="fa-regular fa-copy" aria-hidden="true"></i>
          </button>
          <button class="btn btn-sm btn-link text-danger p-1" type="button" @click="removeNotchSet(index)">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
        <button class="btn btn-sm btn-outline-secondary mb-4" type="button" @click="addNotchSet">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('companion.settings.add_notch_set') }}
        </button>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.bands"
                  @click="toggleSection('bands')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.bands }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.bands" aria-hidden="true"></i>
            {{ t('companion.settings.bands') }}
            <span v-if="sectionBadge('bands')" class="cdb-sec-count">{{ sectionBadge('bands') }}</span>
          </button>
        </h2>
        <div v-if="openSections.bands" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.bands_help') }}</p>

        <div v-for="(band, index) in preset.bands" :key="index"
             class="d-flex align-items-center gap-2 mb-2">
          <div class="row g-1 flex-grow-1">
            <div v-for="slot in catalog.max_band_metrics" :key="slot" class="col-6 col-sm-3">
              <select class="form-select form-select-sm"
                      :value="bandSlotKind(band.metrics[slot - 1])"
                      @change="setBandSlotKind(band, slot - 1, ($event.target as HTMLSelectElement).value)">
                <option value="">—</option>
                <optgroup :label="t('companion.settings.band_actions_group')">
                  <option v-for="action in catalog.band_actions" :key="action" :value="action">
                    {{ bandActionLabel(action) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_radar_group')">
                  <option v-for="radar in catalog.band_radar" :key="radar" :value="radar">
                    {{ bandRadarLabel(radar) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_workout_group')">
                  <option v-for="workout in catalog.band_workout" :key="workout" :value="workout">
                    {{ bandWorkoutLabel(workout) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_bell_group')">
                  <option v-for="bell in catalog.band_bell" :key="bell" :value="bell">
                    {{ bandBellLabel(bell) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_lap_group')">
                  <option v-for="lap in catalog.band_mark_lap" :key="lap" :value="lap">
                    {{ bandActionLabel(lap) }}
                  </option>
                </optgroup>
                <optgroup :label="t('companion.settings.band_metrics_group')">
                  <option v-for="metric in sortedMetrics" :key="metric" :value="metric">
                    {{ metricLabel(metric) }}
                  </option>
                </optgroup>
              </select>
              <div v-if="bandLapSlot(band.metrics[slot - 1])" class="d-flex gap-1 mt-1">
                <input class="form-control form-control-sm" style="min-width: 0"
                       :value="bandLapSlot(band.metrics[slot - 1])!.series"
                       @change="setBandLapSeries(band, slot - 1, ($event.target as HTMLInputElement).value)"
                       list="band-lap-series-list" :placeholder="t('companion.settings.lap_series')">
                <input class="form-control form-control-sm" style="min-width: 0"
                       :value="bandLapSlot(band.metrics[slot - 1])!.label || ''"
                       @change="setBandLapLabel(band, slot - 1, ($event.target as HTMLInputElement).value)"
                       maxlength="10" :placeholder="t('companion.settings.band_lap_label')">
              </div>
            </div>
          </div>
          <button class="btn btn-sm btn-link p-1" type="button"
                  :disabled="index === 0" @click="moveBand(index, -1)">
            <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
          </button>
          <button class="btn btn-sm btn-link p-1" type="button"
                  :disabled="index === preset.bands.length - 1" @click="moveBand(index, 1)">
            <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
          </button>
          <button class="btn btn-sm btn-link p-1" type="button"
                  :title="t('companion.settings.duplicate')"
                  :aria-label="t('companion.settings.duplicate')"
                  @click="duplicateBand(index)">
            <i class="fa-regular fa-copy" aria-hidden="true"></i>
          </button>
          <button class="btn btn-sm btn-link text-danger p-1" type="button"
                  :disabled="preset.bands.length <= 1" @click="preset.bands.splice(index, 1)">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
        <button class="btn btn-sm btn-outline-secondary mb-4" type="button" @click="addBand">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('companion.settings.add_band') }}
        </button>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.sensors"
                  @click="toggleSection('sensors')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.sensors }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.sensors" aria-hidden="true"></i>
            {{ t('companion.settings.sensors_title') }}
            <span v-if="sectionBadge('sensors')" class="cdb-sec-count">{{ sectionBadge('sensors') }}</span>
          </button>
        </h2>
        <div v-if="openSections.sensors" class="cdb-sec-body">
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

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.buttons"
                  @click="toggleSection('buttons')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.buttons }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.buttons" aria-hidden="true"></i>
            {{ t('companion.settings.buttons_title') }}
            <span v-if="sectionBadge('buttons')" class="cdb-sec-count">{{ sectionBadge('buttons') }}</span>
          </button>
        </h2>
        <div v-if="openSections.buttons" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.buttons_help') }}</p>

        <div class="row g-2 mb-1">
          <div v-for="(channel, index) in BUTTON_CHANNELS" :key="channel" class="col-12 col-md-6">
            <div class="small text-body-secondary mb-1">
              {{ t('companion.settings.button_channel', { n: index + 1 }) }}
            </div>
            <div class="row g-1 mb-3">
              <div v-for="gesture in catalog.button_gestures" :key="gesture" class="col-4">
                <label class="form-label small mb-1">
                  {{ t(`companion.settings.button_gestures.${gesture}`) }}
                </label>
                <select class="form-select form-select-sm"
                        :value="buttonActionKind(buttonAction(channel, gesture as keyof ButtonChannel))"
                        @change="setButtonActionKind(channel, gesture as keyof ButtonChannel,
                                                      ($event.target as HTMLSelectElement).value)">
                  <option value="">{{ t('companion.settings.button_action_none') }}</option>
                  <optgroup :label="t('companion.settings.button_actions_group')">
                    <option v-for="action in catalog.button_actions" :key="action" :value="action">
                      {{ buttonActionLabel(action) }}
                    </option>
                  </optgroup>
                  <optgroup v-if="goToPageTargets.length" :label="t('companion.settings.button_go_to_page_group')">
                    <option v-for="page in goToPageTargets" :key="page.key" :value="`go_to_page:${page.key}`">
                      {{ pageLabel(page) }}
                    </option>
                  </optgroup>
                </select>
                <input v-if="buttonActionLapSeries(buttonAction(channel, gesture as keyof ButtonChannel)) !== null"
                       class="form-control form-control-sm mt-1"
                       :value="buttonActionLapSeries(buttonAction(channel, gesture as keyof ButtonChannel))"
                       @change="setButtonActionLapSeries(channel, gesture as keyof ButtonChannel,
                                                          ($event.target as HTMLInputElement).value)"
                       list="band-lap-series-list" :placeholder="t('companion.settings.lap_series')">
              </div>
            </div>
          </div>
        </div>
        <!-- Une page fraîchement ajoutée n'a pas encore de clé (voir `Page.key`) :
             elle ne peut donc pas encore être visée par « Aller à… ». -->
        <p v-if="preset.pages.length > goToPageTargets.length" class="text-body-secondary small mb-4">
          {{ t('companion.settings.button_go_to_page_pending') }}
        </p>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.radar"
                  @click="toggleSection('radar')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.radar }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.radar" aria-hidden="true"></i>
            {{ t('companion.settings.radar_title') }}
          </button>
        </h2>
        <div v-if="openSections.radar" class="cdb-sec-body">
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

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.battery"
                  @click="toggleSection('battery')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.battery }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.battery" aria-hidden="true"></i>
            {{ t('companion.settings.battery_title') }}
            <span v-if="sectionBadge('battery')" class="cdb-sec-count">{{ sectionBadge('battery') }}</span>
          </button>
        </h2>
        <div v-if="openSections.battery" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.battery_help') }}</p>
        <div class="row g-2 align-items-end mb-4">
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">{{ t('companion.settings.battery_threshold') }}</label>
            <input class="form-control form-control-sm" type="number" min="1" max="100"
                   :value="batteryValue('threshold_percent', 20)"
                   @input="setBattery('threshold_percent', Number(($event.target as HTMLInputElement).value))">
          </div>
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="battery-sounds"
                     :checked="preset.battery?.sounds !== false"
                     @change="setBattery('sounds', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="battery-sounds">
                {{ t('companion.settings.battery_sounds') }}
              </label>
            </div>
          </div>
        </div>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.climb"
                  @click="toggleSection('climb')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.climb }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.climb" aria-hidden="true"></i>
            {{ t('companion.settings.climb_title') }}
          </button>
        </h2>
        <div v-if="openSections.climb" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.climb_help') }}</p>
        <div class="row g-2 align-items-end mb-4">
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="climb-sounds"
                     :checked="preset.climb?.sounds !== false"
                     @change="setClimb('sounds', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="climb-sounds">
                {{ t('companion.settings.climb_sounds') }}
              </label>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="climb-expanded"
                     :checked="preset.climb?.expanded_by_default === true"
                     @change="setClimb('expanded_by_default', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="climb-expanded">
                {{ t('companion.settings.climb_expanded') }}
              </label>
            </div>
          </div>
        </div>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.workout"
                  @click="toggleSection('workout')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.workout }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.workout" aria-hidden="true"></i>
            {{ t('companion.settings.workout_title') }}
          </button>
        </h2>
        <div v-if="openSections.workout" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.workout_help') }}</p>
        <div class="row g-2 align-items-end mb-4">
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="workout-badge"
                     :checked="preset.workout?.badge !== false"
                     @change="setWorkout('badge', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="workout-badge">
                {{ t('companion.settings.workout_badge') }}
              </label>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="workout-popup"
                     :checked="preset.workout?.popup !== false"
                     @change="setWorkout('popup', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="workout-popup">
                {{ t('companion.settings.workout_popup') }}
              </label>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="workout-sounds"
                     :checked="preset.workout?.sounds !== false"
                     @change="setWorkout('sounds', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="workout-sounds">
                {{ t('companion.settings.workout_sounds') }}
              </label>
            </div>
          </div>
        </div>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.laps"
                  @click="toggleSection('laps')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.laps }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.laps" aria-hidden="true"></i>
            {{ t('companion.settings.laps_title') }}
          </button>
        </h2>
        <div v-if="openSections.laps" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.laps_help') }}</p>
        <div class="row g-2 align-items-end mb-4">
          <div class="col-6 col-md-3">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="laps-toast"
                     :checked="preset.laps?.toast === true"
                     @change="setLaps('toast', ($event.target as HTMLInputElement).checked)">
              <label class="form-check-label small" for="laps-toast">
                {{ t('companion.settings.laps_toast') }}
              </label>
            </div>
          </div>
        </div>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.reminders"
                  @click="toggleSection('reminders')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.reminders }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.reminders" aria-hidden="true"></i>
            {{ t('companion.settings.reminders_title') }}
            <span v-if="sectionBadge('reminders')" class="cdb-sec-count">{{ sectionBadge('reminders') }}</span>
          </button>
        </h2>
        <div v-if="openSections.reminders" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.reminders_help') }}</p>

        <div v-for="(reminder, index) in preset.reminders || []" :key="index"
             class="d-flex align-items-start gap-2 mb-2">
          <div class="row g-1 flex-grow-1">
            <div class="col-2">
              <label class="form-label small mb-1">{{ t('companion.settings.reminder_interval') }}</label>
              <input class="form-control form-control-sm" type="number" min="1" max="360"
                     :value="reminder.interval_minutes"
                     @input="reminder.interval_minutes = Number(($event.target as HTMLInputElement).value)">
            </div>
            <div class="col-2">
              <label class="form-label small mb-1">{{ t('companion.settings.reminder_start_after') }}</label>
              <input class="form-control form-control-sm" type="number" min="0"
                     :max="catalog.max_reminder_start_after_minutes"
                     :placeholder="t('companion.settings.reminder_start_after_none')"
                     :value="reminder.start_after_minutes ?? ''"
                     @input="setReminderStartAfter(reminder, ($event.target as HTMLInputElement).value)">
            </div>
            <div class="col-2">
              <label class="form-label small mb-1">{{ t('companion.settings.reminder_count') }}</label>
              <input class="form-control form-control-sm" type="number" min="1"
                     :max="catalog.max_reminder_count"
                     :placeholder="t('companion.settings.reminder_count_unlimited')"
                     :value="reminder.count ?? ''"
                     @input="setReminderCount(reminder, ($event.target as HTMLInputElement).value)">
            </div>
            <div class="col-4">
              <label class="form-label small mb-1">{{ t('companion.settings.reminder_message') }}</label>
              <input class="form-control form-control-sm" type="text"
                     :maxlength="catalog.max_reminder_message_length"
                     :placeholder="t('companion.settings.reminder_message_placeholder')"
                     v-model="reminder.message">
            </div>
            <div class="col-2">
              <label class="form-label small mb-1">{{ t('companion.settings.reminder_sound') }}</label>
              <select class="form-select form-select-sm" v-model="reminder.sound">
                <option v-for="sound in catalog.reminder_sounds" :key="sound" :value="sound">
                  {{ t(`companion.settings.bell_sounds.${sound}`) }}
                </option>
              </select>
            </div>
          </div>
          <button class="btn btn-sm btn-link text-danger p-1 mt-4" type="button" @click="removeReminder(index)">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
        <button class="btn btn-sm btn-outline-secondary mb-4" type="button"
                :disabled="(preset.reminders || []).length >= catalog.max_reminders" @click="addReminder">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('companion.settings.add_reminder') }}
        </button>

        </div>

        <h2 class="h6 mb-0">
          <button type="button" class="cdb-sec-head" :aria-expanded="openSections.traveled_path"
                  @click="toggleSection('traveled_path')">
            <i class="fa-solid fa-chevron-right cdb-sec-caret"
               :class="{ 'cdb-sec-caret--open': openSections.traveled_path }" aria-hidden="true"></i>
            <i class="cdb-sec-icon" :class="SECTION_ICONS.traveled_path" aria-hidden="true"></i>
            {{ t('companion.settings.traveled_path_title') }}
          </button>
        </h2>
        <div v-if="openSections.traveled_path" class="cdb-sec-body">
        <p class="text-body-secondary small">{{ t('companion.settings.traveled_path_help') }}</p>
        <div class="row g-2 align-items-end">
          <div class="col-6 col-md-3 d-flex align-items-center gap-2">
            <span class="small">{{ t('companion.settings.traveled_path_color') }}</span>
            <CompanionColorPicker v-model="traveledPathColor" :fallback="DEFAULT_TRAVELED_PATH_COLOR"
                                   :label="t('companion.settings.traveled_path_color')" />
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">{{ t('companion.settings.traveled_path_width') }}</label>
            <input class="form-control form-control-sm" type="number" min="1" step="1"
                   :value="traveledPathValue('width', 4)"
                   @input="setTraveledPath('width', Number(($event.target as HTMLInputElement).value))">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">{{ t('companion.settings.traveled_path_opacity') }}</label>
            <input class="form-control form-control-sm" type="number" min="0" max="1" step="0.05"
                   :value="traveledPathValue('opacity', 0.85)"
                   @input="setTraveledPath('opacity', Number(($event.target as HTMLInputElement).value))">
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
                          :cell="pickerCell" :known-series="lapSeries" :metric-layouts="metricLayouts"
                          :page-kind="picker.page.kind"
                          @choose="applyPick" @close="picker = null" @save-layout="onSaveLayout" />

    <datalist id="companion-series-list">
      <option v-for="s in lapSeries" :key="s" :value="s" />
    </datalist>

    <!-- Suggestions de série pour les cases « marquer un tour » du bandeau et
         de l'encoche — hors des sections repliables pour rester joignable même
         quand la section est fermée. Mêmes clés que `lapSeries`. -->
    <datalist id="band-lap-series-list">
      <option v-for="series in lapSeries" :key="series" :value="series"></option>
    </datalist>
  </div>
</template>

<style scoped>
/* En-tête de section repliable : une ligne pleine largeur qu'on tape pour
   déplier, le chevron tourne quand c'est ouvert. Le `<h2 class="h6">` garde le
   style de titre, le bouton n'hérite que de la mise en page. */
.cdb-sec-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.65rem 0;
  border: 0;
  border-top: 1px solid var(--bs-border-color);
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
}
.cdb-sec-caret {
  font-size: 0.7em;
  color: var(--bs-secondary-color);
  transition: transform 0.15s ease;
}
.cdb-sec-caret--open {
  transform: rotate(90deg);
}
.cdb-sec-icon {
  width: 1.1em;
  text-align: center;
  color: var(--bs-secondary-color);
}
/* La pastille de compteur, poussée au bout de l'en-tête : nombre de pages, de
   jeux, de rappels… lisible section fermée. */
.cdb-sec-count {
  margin-left: auto;
  min-width: 1.6rem;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.5;
  text-align: center;
}
.cdb-sec-body {
  padding: 0.25rem 0 0.5rem;
}

/* Aux proportions de l'écran du téléphone, et non à la largeur de la page :
   étalée sur 60 rem, une grille de 2 × 2 donnait des cases en bandeau là où le
   cycliste en aura des carrés debout — on composait donc pour une mise en page
   qui n'existe nulle part. La hauteur est fixe et les lignes se partagent la
   place (`1fr`) : ajouter une ligne resserre les cases, exactement comme sur
   l'écran, plutôt que d'allonger un écran qui ne s'allonge pas. */
/* La grille et ses gouttières partagent le même repère : le wrapper ne fait
   que la taille de la grille (aucun autre enfant en flux normal), si bien que
   les gouttières — positionnées en absolu dedans, en `%` — retombent
   exactement sur les espaces qu'elles doivent colorer. */
.companion-grid-wrap {
  position: relative;
  /* Sans ceci, `position: relative` seul ne crée pas de contexte d'empilement
     (il en faudrait un `z-index` non `auto`) : le `z-index: -1` d'une
     gouttière irait alors chercher le contexte d'empilement le plus proche
     au-dessus — potentiellement bien plus haut dans la page — plutôt que de
     rester sous les cases de *cette* grille. */
  isolation: isolate;
  width: 100%;
  max-width: 16rem;
}

/* PC : aperçu à gauche, réglages de la case à droite. Sous 768 px, bloc
   normal — l'aperçu puis les réglages, empilés comme avant. */
@media (min-width: 768px) {
  .companion-grid-edit {
    display: flex;
    align-items: flex-start;
    gap: 1.25rem;
  }
  .companion-grid-edit > .companion-grid-wrap {
    flex: 0 0 auto;
  }
  .companion-grid-edit-side {
    flex: 1 1 0;
    min-width: 0;
    max-width: 34rem;
  }
}

.companion-grid {
  display: grid;
  /* Les proportions exactes de `PHONE_GRID` (328 × 598 px logiques, gouttières
     de 8) réduites au quart : c'est ce qui permet à `--cbp-em` d'être un simple
     rapport de largeurs — un seul facteur d'échelle vaut alors pour toutes les
     grilles, quel que soit le nombre de lignes et de colonnes. */
  gap: 0.4rem;
  width: 100%;
  /* La hauteur se déduit des proportions du téléphone, posées par `aspectRatio` :
     celles de l'appareil quand il les a annoncées, celles d'un téléphone
     ordinaire sinon. Une hauteur en dur redeviendrait fausse au premier écran
     qui n'a pas ce format. */
  aspect-ratio: 328 / 598;
  /* Le conteneur occupe tout le wrapper, gouttières comprises — même là où
     aucune case n'est dessinée (une fusion de 2 colonnes n'a pas de
     gouttière interne à son propre travers). Sans ceci, cette zone
     transparente resterait quand même la cible des clics/survols (une boîte
     HTML capte les événements même sans rien y peindre), et les gouttières
     dessous — reculées par `z-index: -1` — ne recevraient plus jamais rien.
     `.companion-cell` republie `auto` pour rester cliquable. */
  pointer-events: none;
}

/* Positionnée par `styleForGutter` (`gutterRect`), en `%` du wrapper, à la
   même géométrie que les cases (`phoneCell`) : les deux se partagent
   exactement la largeur/hauteur du conteneur, sans jamais se chevaucher. Vide,
   elle ne se voit qu'au survol — une ligne pointillée discrète, la même
   invite que la case vide (`+`) — pour ne pas couvrir la grille de traits
   tant qu'on n'a rien posé.

   `z-index: -1` (et `isolation: isolate` sur le wrapper, juste au-dessus) :
   un élément positionné se peint après le contenu normal de son empilement,
   quel que soit son ordre dans le HTML — sans ceci, un séparateur poserait sa
   couleur *par-dessus* le coin d'une case voisine plutôt que dessous, dès que
   les deux se frôlent. Même règle que côté appli, où les séparateurs sont
   peints avant les cellules dans le `Stack` (`DashboardGrid`). */
.companion-gutter {
  position: absolute;
  z-index: -1;
  border: none;
  border-radius: 2px;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.companion-gutter:not(.filled):hover {
  background: repeating-linear-gradient(
    90deg, var(--bs-secondary-color) 0 4px, transparent 4px 8px
  );
}

/* `outline-offset` négatif plutôt que positif : la gouttière peint sous les
   cases (`z-index: -1`), un liseré qui déborderait vers l'extérieur se
   ferait donc en partie recouvrir par la case voisine. */
.companion-gutter.selected {
  outline: 2px solid var(--bs-primary);
  outline-offset: -1px;
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
  /* Rétablit ce que `.companion-grid` vient d'éteindre : la case reste
     cliquable, seul le conteneur (gouttières comprises) ne doit plus
     intercepter les clics à la place des gouttières qu'il recouvre. */
  pointer-events: auto;
  /* La case devient l'unité de mesure de sa vignette : `1cqw` vaut 1 % de sa
     largeur, ce dont `--cbp-em` a besoin pour rendre les proportions du
     téléphone quelle que soit la largeur laissée à la grille. */
  container-type: inline-size;
}

.companion-cell.filled {
  border-style: solid;
  cursor: pointer;
}

/* Aperçu d'un bloc de liste : double clic pour changer le composant. */
.companion-block-preview {
  cursor: pointer;
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

/* Un schéma, pas un rendu : un simple libellé par bloc suffit à montrer où
   tombent les ruptures, `CompanionBlockPreview` resterait illisible étalé
   sur une fraction de colonne. Bordure à gauche plus marquée sur un bloc
   `full_width` pour le distinguer d'une colonne au premier coup d'œil. */
.companion-list-preview-chip {
  font-size: 0.7rem;
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.25rem;
  background: var(--bs-body-bg);
}
.companion-list-preview-chip--full {
  border-left: 3px solid var(--bs-primary);
}

/* Assez large pour deux chiffres entre ses boutons, et pas plus : les deux
   étendues tiennent alors sur la même ligne que le bouton de retrait, y compris
   sur un portable. */
.companion-span {
  width: 8rem;
}

/* La case sélectionnée : un anneau épais *vers l'extérieur* (dans la gouttière,
   au-dessus des voisines grâce au `z-index`) plus un halo, là où un simple
   liseré de 2 px en retrait se perdait sur une vignette déjà colorée et
   bordée. Les autres cases posées s'estompent (`.cell-muted`) : la
   sélectionnée reste la seule en pleine couleur, quelle que soit sa taille. */
.companion-cell.selected {
  outline: 3px solid var(--bs-primary);
  outline-offset: 2px;
  box-shadow: 0 0 0 5px rgba(13, 110, 253, 0.3);
  z-index: 3;
}
.companion-cell.cell-muted {
  opacity: 0.38;
}

/* Pendant un échange : la case qu'on va quitter reste marquée mais s'efface un
   peu, les cases où l'échange est possible se distinguent par un liseré en
   tirets — les autres restent ternes, pour que la limite se voie sans avoir à
   la tenter (même règle que `spanLimit`/`canMove`). */
.companion-cell.swap-source {
  outline: 3px solid var(--bs-primary);
  outline-offset: 2px;
  opacity: 0.5;
  z-index: 3;
}

.companion-cell.swap-target {
  outline: 2px dashed var(--bs-primary);
  outline-offset: 2px;
  z-index: 2;
  cursor: pointer;
}

/* Le pavé de déplacement d'une cellule : quatre flèches en croix, le centre
   n'étant qu'un repère visuel. Une grille 3 × 3 plutôt que quatre boutons
   alignés, pour que la direction se lise d'un coup d'œil, comme sur une
   manette. */
.companion-move-pad {
  display: grid;
  grid-template-columns: repeat(3, 1.75rem);
  grid-template-rows: repeat(3, 1.75rem);
  gap: 0.15rem;
}

.companion-move-pad button {
  width: 100%;
  height: 100%;
}

.companion-move-center {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
}

/* Même dessin que le sélecteur d'icône d'un composant `metric`
   (`CompanionBlockPicker.cbpk-icons`) — une seule grille de vignettes, pour
   qu'apprendre l'un vaille pour l'autre. Dupliqué plutôt que partagé : les
   deux composants n'ont aujourd'hui rien d'autre en commun qui justifie un
   fichier de styles à eux deux. */
.cdb-icons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.cdb-icon-btn {
  position: relative;
  width: 2.2rem;
  height: 2.2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.4rem;
  background: transparent;
  font-size: 1rem;
  padding: 0;
}
.cdb-icon-btn--selected {
  border-color: var(--bs-primary);
  outline: 2px solid var(--bs-primary);
  outline-offset: -2px;
}
/* Le bouton « suit le genre de page » : même traitement que les autres, un
   point dans le coin pour le distinguer d'un choix explicite de la même icône. */
.cdb-icon-btn--default::after {
  content: "";
  position: absolute;
  top: 2px;
  right: 2px;
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: var(--bs-primary);
}
</style>
