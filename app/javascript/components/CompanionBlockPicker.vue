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
import CompanionColorPicker from './CompanionColorPicker.vue'
import {
  blockChoices, blockFor, isChoiceOf, isDurationMetric, isDynamicGaugeMetric, isRangeGaugeMetric,
  DEFAULT_METRIC_LAYOUT, LAYOUT_TOKEN_ORDER, MAX_LAYOUT_ROWS, METRIC_RANGE_DEFAULTS,
  metricDropdownLabel, metricLayout, metricSample, NATURAL_LINE_SIZE, previewScale,
  type Block, type BlockChoice, type Catalog, type CellSize, type LayoutToken, type MetricLayout,
  type MetricLayoutPreset, type RowHeight,
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
  // Les dispositions de bloc `metric` déjà enregistrées par l'utilisateur —
  // un point de départ qu'on charge dans la grille ci-dessous, pas un lien
  // conservé : la modifier ensuite ne change pas la disposition enregistrée.
  metricLayouts?: MetricLayoutPreset[]
  // Le `kind` de la page qui recevra le composant — sert seulement à retirer
  // « Horloge » d'une page tour (`laps`), où l'appli l'ignore déjà
  // silencieusement (`LapListBody._block`, dépôt voisin) : composer une
  // horloge qui n'aura jamais d'effet serait la seule surprise ici.
  pageKind?: string
}>()

const emit = defineEmits<{
  close: []
  choose: [block: Block]
  // Une nouvelle disposition à ajouter à `metric_layouts`, sur demande de
  // l'utilisateur (« Enregistrer cette disposition ») — `CompanionDashboard`
  // porte le document entier, c'est elle qui l'y ajoute.
  saveLayout: [preset: { name: string; layout: MetricLayout }]
}>()

const metric = ref(props.block?.metric || props.catalog.metrics[0])
const source = ref(props.block?.source || props.catalog.zone_sources[0])
const series = ref(props.block?.series || 'default')
const format = ref(props.block?.format || 'hm')
// La fenêtre roulante d'un bloc `altitude_profile` — vide par défaut (`0` ne
// sort jamais du composant, voir plus bas et `blockFor`) : le profil entier
// du tracé, comportement d'avant ce réglage, plutôt qu'une fenêtre choisie
// pour personne.
const windowKm = ref<number>(props.block?.window_km || 0)

// ── La disposition d'un bloc `metric` ───────────────────────────────────────
//
// Une grille à 3 colonnes et jusqu'à `MAX_LAYOUT_ROWS` rangées, où chaque
// élément (icône, étiquette, unité, chiffre, jauge) se pose dans une case
// précise — voir `companionSettings.ts` pour le contrat complet. `layout` est
// l'état brut, éditable librement ; `currentLayout` (plus bas) en est la
// version qui sera réellement enregistrée, jauge retirée si la mesure
// choisie n'y a pas droit — c'est elle que l'aperçu et la vignette doivent
// lire, pour ne jamais promettre ce que l'assainisseur retirerait.
const layout = ref<MetricLayout>(
  props.block?.kind === 'metric' ? metricLayout(props.block) : { ...DEFAULT_METRIC_LAYOUT },
)
const iconChoice = ref<string | undefined>(props.block?.icon)
const labelChoice = ref<string>(props.block?.label || '')
const gaugeKindChoice = ref<string>(props.block?.gauge_kind || 'range')

// Le jeton de palette actuellement « en main » — un tap sur une case de la
// grille l'y pose, sans glisser-déposer. `null` : un tap sur une case
// occupée la libère à la place.
const selectedToken = ref<LayoutToken | 'gauge' | null>(null)

// ── La disposition d'un bloc `clock` ────────────────────────────────────────
//
// Un état à part, pas partagé avec `layout`/`iconChoice` ci-dessus : les
// groupes « Une mesure » et « Horloge » sont tous deux visibles dans la même
// boîte de dialogue défilante (`groups`, plus bas), donc partager l'état
// ferait que modifier l'un modifierait l'autre sous les yeux. Plus courte que
// son équivalent `metric` : une horloge n'a que 3 jetons possibles, jamais
// d'unité ni de jauge — pas de `hasUnit`/`gaugeEligible` à calculer.
const clockLayout = ref<MetricLayout>(
  props.block?.kind === 'clock' ? metricLayout(props.block) : { value: '0-center' },
)
const clockIconChoice = ref<string | undefined>(
  props.block?.kind === 'clock' ? props.block?.icon : undefined,
)
const clockSelectedToken = ref<'icon' | 'label' | 'value' | null>(null)
const clockPaletteTokens: ('icon' | 'label' | 'value')[] = ['value', 'icon', 'label']

function clockTokensAt(row: number, col: 'left' | 'center' | 'right'): ('icon' | 'label' | 'value')[] {
  return (['icon', 'label', 'value'] as const).filter((token) => {
    const pos = clockLayout.value[token]
    if (!pos) return false
    const [r, c] = pos.split('-')
    return Number(r) === row && c === col
  })
}

const clockHighestUsedRow = computed(() => {
  const rows: number[] = []
  for (const token of ['icon', 'label', 'value'] as const) {
    const pos = clockLayout.value[token]
    if (pos) rows.push(Number(pos.split('-')[0]))
  }
  return rows.length ? Math.max(...rows) : 0
})
const clockVisibleRowCount = computed(() => Math.min(clockHighestUsedRow.value + 2, MAX_LAYOUT_ROWS))

// Même règle que `placeToken` : le chiffre est toujours au moins quelque
// part, jamais retirable — seuls icône/étiquette le sont.
function placeClockToken(token: 'icon' | 'label' | 'value', row: number, col: 'left' | 'center' | 'right') {
  const next: MetricLayout = { ...clockLayout.value, [token]: `${row}-${col}` }
  if (!next.value) next.value = '0-center'
  clockLayout.value = next
}

function removeClockToken(token: 'icon' | 'label') {
  const next: MetricLayout = { ...clockLayout.value }
  delete next[token]
  clockLayout.value = next
}

function onClockCellClick(row: number, col: 'left' | 'center' | 'right') {
  if (clockSelectedToken.value) {
    placeClockToken(clockSelectedToken.value, row, col)
    clockSelectedToken.value = null
    return
  }
  for (const token of clockTokensAt(row, col)) {
    if (token !== 'value') removeClockToken(token)
  }
}

function toggleClockToken(token: 'icon' | 'label' | 'value') {
  clockSelectedToken.value = clockSelectedToken.value === token ? null : token
}

function isClockPlaced(token: 'icon' | 'label' | 'value'): boolean {
  return !!clockLayout.value[token]
}

function clockRowHeightAt(row: number): RowHeight {
  return clockLayout.value.row_heights?.[String(row)] || 'normal'
}

function setClockRowHeight(row: number, height: RowHeight) {
  const heights = { ...clockLayout.value.row_heights }
  if (height === 'normal') delete heights[String(row)]
  else heights[String(row)] = height
  clockLayout.value = { ...clockLayout.value, row_heights: Object.keys(heights).length ? heights : undefined }
}

const metricZoneEligible = computed(() => !!metricSample(metric.value).zone)
const rangeEligible = computed(() => isRangeGaugeMetric(metric.value))
const dynamicEligible = computed(() => isDynamicGaugeMetric(metric.value))
const gaugeEligible = computed(
  () => metricZoneEligible.value || rangeEligible.value || dynamicEligible.value,
)
const hasUnit = computed(() => metricSample(metric.value).unit !== '')

// `range` ou `dynamic` seulement si la mesure a droit aux deux — sinon
// dérivé de l'éligibilité, comme le fait `sanitize_block` côté Rails.
const effectiveGaugeKind = computed<'range' | 'dynamic' | null>(() => {
  if (metricZoneEligible.value) return null
  if (rangeEligible.value && dynamicEligible.value) return gaugeKindChoice.value as 'range' | 'dynamic'
  return rangeEligible.value ? 'range' : 'dynamic'
})

// Ce que l'enregistrement gardera réellement : la jauge retirée si la mesure
// choisie n'y a pas droit (un changement de mesure en cours d'édition peut
// rendre une jauge déjà posée caduque). Tout le reste de la dialogue — aperçu,
// vignette, palette — lit cette version-ci, jamais `layout` directement.
const currentLayout = computed<MetricLayout>(() => {
  if (layout.value.gauge && !gaugeEligible.value) {
    const { gauge, ...rest } = layout.value
    return rest as MetricLayout
  }
  return layout.value
})

// Les jetons que la palette propose : le chiffre est toujours là (déplaçable,
// jamais retirable), la jauge et l'unité seulement quand la mesure choisie
// leur donne un sens.
const paletteTokens = computed<('icon' | 'label' | 'unit' | 'value' | 'gauge')[]>(() => {
  const tokens: ('icon' | 'label' | 'unit' | 'value' | 'gauge')[] = ['value', 'icon', 'label']
  if (hasUnit.value) tokens.push('unit')
  if (gaugeEligible.value) tokens.push('gauge')
  return tokens
})

function isPlaced(token: 'icon' | 'label' | 'unit' | 'value' | 'gauge'): boolean {
  return token === 'gauge' ? !!currentLayout.value.gauge : !!currentLayout.value[token]
}

// Les jetons posés dans une case précise, dans l'ordre d'affichage fixe
// (icône, étiquette, unité, chiffre) — un empilement volontaire (ex.
// étiquette + unité dans la même case) s'y lit dans cet ordre, pas celui où
// on les y a posés.
function tokensAt(row: number, col: 'left' | 'center' | 'right'): LayoutToken[] {
  return LAYOUT_TOKEN_ORDER.filter((token) => {
    const pos = currentLayout.value[token]
    if (!pos) return false
    const [r, c] = pos.split('-')
    return Number(r) === row && c === col
  })
}

// Une rangée de plus que la plus haute utilisée, dans la limite du plafond —
// toujours une case vide où poser le prochain élément, sans bouton
// « + » séparé : elle apparaît d'elle-même, et disparaît de la même façon
// quand on retire ce qui l'occupait.
const highestUsedRow = computed(() => {
  const rows: number[] = []
  for (const token of LAYOUT_TOKEN_ORDER) {
    const pos = currentLayout.value[token]
    if (pos) rows.push(Number(pos.split('-')[0]))
  }
  if (currentLayout.value.gauge) rows.push(Number(currentLayout.value.gauge))
  return rows.length ? Math.max(...rows) : 0
})
const visibleRowCount = computed(() => Math.min(highestUsedRow.value + 2, MAX_LAYOUT_ROWS))

// Pose [token] en `[row]-[col]` (la colonne ne veut rien dire pour la jauge,
// une barre pleine largeur). Toujours au moins un `value` valide en sortie —
// jamais de bloc qui n'afficherait pas le chiffre — et jamais de jauge qui
// partage sa rangée avec autre chose, dans les deux sens : la poser évince ce
// qui s'y trouvait, et poser autre chose sur sa rangée la retire.
function placeToken(token: 'icon' | 'label' | 'unit' | 'value' | 'gauge', row: number, col: 'left' | 'center' | 'right') {
  const next: MetricLayout = { ...layout.value }
  if (token === 'gauge') {
    for (const other of ['icon', 'label', 'unit', 'value'] as const) {
      if (next[other]?.startsWith(`${row}-`)) delete next[other]
    }
    next.gauge = String(row)
  } else {
    if (next.gauge === String(row)) delete next.gauge
    next[token] = `${row}-${col}`
  }
  if (!next.value) next.value = `${next.gauge === '0' ? 1 : 0}-center`
  layout.value = next
}

function removeToken(token: 'icon' | 'label' | 'unit' | 'gauge') {
  const next: MetricLayout = { ...layout.value }
  delete next[token]
  layout.value = next
}

// Le poids d'une rangée — `'normal'` quand `row_heights` ne la mentionne pas
// (jamais écrit dans ce cas, voir `setRowHeight`).
function rowHeightAt(row: number): RowHeight {
  return layout.value.row_heights?.[String(row)] || 'normal'
}

function setRowHeight(row: number, height: RowHeight) {
  const heights = { ...layout.value.row_heights }
  if (height === 'normal') delete heights[String(row)]
  else heights[String(row)] = height
  layout.value = { ...layout.value, row_heights: Object.keys(heights).length ? heights : undefined }
}

function onCellClick(row: number, col: 'left' | 'center' | 'right') {
  if (selectedToken.value) {
    placeToken(selectedToken.value, row, col)
    selectedToken.value = null
    return
  }
  for (const token of tokensAt(row, col)) {
    if (token !== 'value') removeToken(token)
  }
}

function onGaugeRowClick(row: number) {
  if (selectedToken.value) {
    placeToken(selectedToken.value, row, 'center')
    selectedToken.value = null
    return
  }
  removeToken('gauge')
}

function toggleToken(token: 'icon' | 'label' | 'unit' | 'value' | 'gauge') {
  selectedToken.value = selectedToken.value === token ? null : token
}

function onLoadPreset(event: Event) {
  const key = (event.target as HTMLSelectElement).value
  const preset = props.metricLayouts?.find((p) => p.key === key)
  if (preset) layout.value = { ...preset.layout }
  ;(event.target as HTMLSelectElement).value = ''
}

function saveLayoutPreset() {
  // eslint-disable-next-line no-alert
  const name = window.prompt(t('companion.settings.metric_layouts.name_prompt'))?.trim()
  if (!name) return
  emit('saveLayout', { name, layout: currentLayout.value })
}

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

  return Object.keys(props.catalog.blocks)
    // Une horloge posée sur une page tour n'aurait jamais d'effet — l'appli
    // l'ignore déjà silencieusement (voir la doc de `pageKind`) — donc pas de
    // quoi la proposer là et laisser croire qu'elle s'affichera.
    .filter((kind) => !(kind === 'clock' && props.pageKind === 'laps'))
    .map((kind) => {
      const tiles = choices
        .filter((choice) => choice.kind === kind)
        .map((choice) => ({
          key: `${choice.kind}:${choice.mode || ''}`,
          block: blockFor(choice, {
            metric: metric.value, source: source.value, series: series.value, format: format.value,
            layout: currentLayout.value, icon: iconChoice.value, label: labelChoice.value,
            gaugeKind: effectiveGaugeKind.value || undefined,
            clockLayout: clockLayout.value, clockIcon: clockIconChoice.value,
            min: min.value, max: max.value, windowKm: windowKm.value || undefined,
            color: color.value, textColor: textColor.value,
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
            <CompanionColorPicker v-model="color" fallback="#1f2226" :label="t('companion.settings.block_color')" />
          </label>
          <label class="cbpk-color-field small">
            {{ t('companion.settings.block_text_color') }}
            <CompanionColorPicker v-model="textColor" fallback="#ffffff" :label="t('companion.settings.block_text_color')" />
          </label>
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

            <label v-if="group.kind === 'metric'" class="cbpk-param small">
              {{ t('companion.settings.metric_label') }}
              <input
                v-model="labelChoice"
                type="text"
                class="form-control form-control-sm"
                :placeholder="metricLabel(metric)"
                maxlength="24"
              >
            </label>

            <label v-if="group.kind === 'metric' && isDurationMetric(metric)" class="cbpk-param small">
              {{ t('companion.settings.duration_format') }}
              <select v-model="format" class="form-select form-select-sm">
                <option value="hm">{{ t('companion.settings.duration_formats.hm') }}</option>
                <option value="hms">{{ t('companion.settings.duration_formats.hms') }}</option>
              </select>
            </label>

            <label
              v-if="group.kind === 'metric' && !!currentLayout.gauge && rangeEligible && dynamicEligible && !metricZoneEligible"
              class="cbpk-param small"
            >
              {{ t('companion.settings.gauge_kind') }}
              <select v-model="gaugeKindChoice" class="form-select form-select-sm">
                <option value="range">{{ t('companion.settings.gauge_kinds.range') }}</option>
                <option value="dynamic">{{ t('companion.settings.gauge_kinds.dynamic') }}</option>
              </select>
            </label>

            <div
              v-if="group.kind === 'metric' && !!currentLayout.gauge && effectiveGaugeKind === 'range'"
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

            <label v-if="group.kind === 'zones' || group.kind === 'lap_zones'" class="cbpk-param small">
              {{ t('companion.settings.source') }}
              <select v-model="source" class="form-select form-select-sm">
                <option v-for="s in catalog.zone_sources" :key="s" :value="s">
                  {{ t(`companion.settings.sources.${s}`) }}
                </option>
              </select>
            </label>

            <label v-if="group.kind === 'mark_lap'" class="cbpk-param small">
              {{ t('companion.settings.lap_series') }}
              <input
                v-model="series"
                type="text"
                list="cbpk-series-list"
                class="form-control form-control-sm"
              >
            </label>

            <label v-if="group.kind === 'altitude_profile'" class="cbpk-param small">
              {{ t('companion.settings.altitude_window_km') }}
              <input
                v-model.number="windowKm"
                type="number"
                min="1"
                max="50"
                step="1"
                :placeholder="t('companion.settings.altitude_window_km_placeholder')"
                class="form-control form-control-sm"
              >
            </label>
          </div>

          <p v-if="group.kind === 'mark_lap'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.lap_series_cols_hint') }}
          </p>

          <p v-if="group.kind === 'metric' && props.pageKind === 'laps'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.metric_lap_scope_hint') }}
          </p>

          <p v-if="group.kind === 'altitude_profile'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.altitude_window_km_hint') }}
          </p>

          <!-- L'éditeur de disposition d'un bloc `metric` : une grille à 3
               colonnes et jusqu'à `MAX_LAYOUT_ROWS` rangées, chaque case
               recevant un jeton de la palette d'en dessous. -->
          <div v-if="group.kind === 'metric'" class="cbpk-layout">
            <label v-if="metricLayouts?.length" class="cbpk-param small cbpk-layout-presets">
              {{ t('companion.settings.metric_layouts.load') }}
              <select class="form-select form-select-sm" @change="onLoadPreset($event)">
                <option value="">{{ t('companion.settings.metric_layouts.load_placeholder') }}</option>
                <option v-for="preset in metricLayouts" :key="preset.key" :value="preset.key">
                  {{ preset.name }}
                </option>
              </select>
            </label>

            <div class="cbpk-grid">
              <div v-for="row in visibleRowCount" :key="row - 1" class="cbpk-grid-row">
                <button
                  v-if="currentLayout.gauge === String(row - 1)"
                  type="button"
                  class="cbpk-grid-gauge"
                  @click="onGaugeRowClick(row - 1)"
                >
                  {{ t('companion.settings.layout_tokens.gauge') }}
                </button>
                <template v-else>
                  <button
                    v-for="col in (['left', 'center', 'right'] as const)"
                    :key="col"
                    type="button"
                    class="cbpk-grid-cell"
                    @click="onCellClick(row - 1, col)"
                  >
                    <template v-for="token in tokensAt(row - 1, col)" :key="token">
                      <i
                        v-if="token === 'icon'"
                        class="cbpk-grid-icon"
                        :class="iconChoice || metricSample(metric).icon"
                        aria-hidden="true"
                      ></i>
                      <span v-else class="cbpk-grid-token">
                        {{ t(`companion.settings.layout_tokens.${token}`) }}
                      </span>
                    </template>
                  </button>

                  <!-- La jauge garde toujours sa hauteur naturelle (une barre
                       plus haute n'apporte rien) : ce réglage n'a de sens que
                       pour une rangée de texte/chiffre. -->
                  <div class="cbpk-row-heights" role="group" :aria-label="t('companion.settings.row_height')">
                    <button
                      v-for="h in (['small', 'normal', 'large'] as const)"
                      :key="h"
                      type="button"
                      class="cbpk-row-height-btn"
                      :class="{ 'cbpk-row-height-btn--selected': rowHeightAt(row - 1) === h }"
                      :title="t(`companion.settings.row_heights.${h}`)"
                      @click="setRowHeight(row - 1, h)"
                    >
                      {{ t(`companion.settings.row_heights.${h}_short`) }}
                    </button>
                  </div>
                </template>
              </div>
            </div>

            <div class="cbpk-palette">
              <button
                v-for="token in paletteTokens"
                :key="token"
                type="button"
                class="cbpk-chip"
                :class="{
                  'cbpk-chip--selected': selectedToken === token,
                  'cbpk-chip--placed': isPlaced(token),
                }"
                @click="toggleToken(token)"
              >
                {{ t(`companion.settings.layout_tokens.${token}`) }}
              </button>
            </div>

            <div v-if="currentLayout.icon" class="cbpk-icons">
              <button
                type="button"
                class="cbpk-icon-btn"
                :class="{ 'cbpk-icon-btn--selected': !iconChoice }"
                :title="t('companion.settings.default_icon')"
                @click="iconChoice = undefined"
              >
                {{ t('companion.settings.default_icon') }}
              </button>
              <button
                v-for="ic in catalog.icons"
                :key="ic"
                type="button"
                class="cbpk-icon-btn"
                :class="{ 'cbpk-icon-btn--selected': iconChoice === ic }"
                @click="iconChoice = ic"
              >
                <i :class="ic" aria-hidden="true"></i>
              </button>
            </div>

            <button type="button" class="btn btn-sm btn-outline-secondary" @click="saveLayoutPreset">
              {{ t('companion.settings.metric_layouts.save') }}
            </button>
          </div>

          <!-- L'éditeur de disposition d'un bloc `clock` : la même grille
               qu'un bloc `metric`, mais seulement 3 jetons (icône, étiquette,
               chiffre) — jamais d'unité ni de jauge, donc pas de ligne « +
               jauge » dans la grille ni de disposition enregistrée à charger
               (`metricLayouts` est propre aux blocs `metric`). -->
          <div v-if="group.kind === 'clock'" class="cbpk-layout">
            <div class="cbpk-grid">
              <div v-for="row in clockVisibleRowCount" :key="row - 1" class="cbpk-grid-row">
                <button
                  v-for="col in (['left', 'center', 'right'] as const)"
                  :key="col"
                  type="button"
                  class="cbpk-grid-cell"
                  @click="onClockCellClick(row - 1, col)"
                >
                  <template v-for="token in clockTokensAt(row - 1, col)" :key="token">
                    <i
                      v-if="token === 'icon'"
                      class="cbpk-grid-icon"
                      :class="clockIconChoice || 'fa-regular fa-clock'"
                      aria-hidden="true"
                    ></i>
                    <span v-else class="cbpk-grid-token">
                      {{ t(`companion.settings.layout_tokens.${token}`) }}
                    </span>
                  </template>
                </button>

                <div class="cbpk-row-heights" role="group" :aria-label="t('companion.settings.row_height')">
                  <button
                    v-for="h in (['small', 'normal', 'large'] as const)"
                    :key="h"
                    type="button"
                    class="cbpk-row-height-btn"
                    :class="{ 'cbpk-row-height-btn--selected': clockRowHeightAt(row - 1) === h }"
                    :title="t(`companion.settings.row_heights.${h}`)"
                    @click="setClockRowHeight(row - 1, h)"
                  >
                    {{ t(`companion.settings.row_heights.${h}_short`) }}
                  </button>
                </div>
              </div>
            </div>

            <div class="cbpk-palette">
              <button
                v-for="token in clockPaletteTokens"
                :key="token"
                type="button"
                class="cbpk-chip"
                :class="{
                  'cbpk-chip--selected': clockSelectedToken === token,
                  'cbpk-chip--placed': isClockPlaced(token),
                }"
                @click="toggleClockToken(token)"
              >
                {{ t(`companion.settings.layout_tokens.${token}`) }}
              </button>
            </div>

            <div v-if="clockLayout.icon" class="cbpk-icons">
              <button
                type="button"
                class="cbpk-icon-btn"
                :class="{ 'cbpk-icon-btn--selected': !clockIconChoice }"
                :title="t('companion.settings.default_icon')"
                @click="clockIconChoice = undefined"
              >
                {{ t('companion.settings.default_icon') }}
              </button>
              <button
                v-for="ic in catalog.icons"
                :key="ic"
                type="button"
                class="cbpk-icon-btn"
                :class="{ 'cbpk-icon-btn--selected': clockIconChoice === ic }"
                @click="clockIconChoice = ic"
              >
                <i :class="ic" aria-hidden="true"></i>
              </button>
            </div>
          </div>

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
                  <CompanionBlockPreview :block="tile.block" :lap-scoped="pageKind === 'laps'" />
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

/* L'éditeur de disposition d'un bloc `metric` : la grille, la palette de
   jetons, la grille d'icônes — dans cet ordre, celui où on les utilise. */
.cbpk-layout {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 0.8rem;
  padding: 0.6rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
}
.cbpk-layout-presets {
  margin-left: 0;
}

.cbpk-grid {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.cbpk-grid-row {
  display: flex;
  gap: 0.35rem;
}
.cbpk-grid-cell {
  flex: 1 1 0;
  min-width: 0;
  min-height: 2.6rem;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.4rem;
  background: transparent;
  padding: 0.3rem;
}
.cbpk-grid-cell:hover {
  border-color: var(--bs-primary);
}
.cbpk-grid-gauge {
  flex: 1 1 0;
  min-height: 2.6rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--bs-primary);
  border-radius: 0.4rem;
  background: var(--bs-primary-bg-subtle, rgba(13, 110, 253, 0.1));
  font-size: 0.85rem;
  text-transform: uppercase;
}
.cbpk-grid-icon {
  font-size: 1.1rem;
  opacity: 0.8;
}
.cbpk-grid-token {
  font-size: 0.78rem;
  padding: 0.1rem 0.4rem;
  border-radius: 0.3rem;
  background: var(--bs-secondary-bg, #e9ecef);
  white-space: nowrap;
}

/* Le poids d'une rangée — pas un des 3 tiers de la grille (`flex: 1 1 0`
   comme les cases), à côté d'elle plutôt que dedans. */
.cbpk-row-heights {
  flex: none;
  display: flex;
  gap: 0.2rem;
}
.cbpk-row-height-btn {
  min-width: 1.8rem;
  padding: 0.2rem 0.35rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.3rem;
  background: transparent;
  font-size: 0.75rem;
}
.cbpk-row-height-btn--selected {
  border-color: var(--bs-primary);
  background: var(--bs-primary);
  color: #fff;
}

.cbpk-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.cbpk-chip {
  border: 1px solid var(--bs-border-color);
  border-radius: 1rem;
  background: transparent;
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
}
.cbpk-chip--placed {
  border-style: solid;
  opacity: 0.7;
}
.cbpk-chip--selected {
  border-color: var(--bs-primary);
  background: var(--bs-primary);
  color: #fff;
  opacity: 1;
}

.cbpk-icons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.cbpk-icon-btn {
  width: 2.2rem;
  height: 2.2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.4rem;
  background: transparent;
  font-size: 0.65rem;
  padding: 0;
}
.cbpk-icon-btn--selected {
  border-color: var(--bs-primary);
  outline: 2px solid var(--bs-primary);
  outline-offset: -2px;
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
