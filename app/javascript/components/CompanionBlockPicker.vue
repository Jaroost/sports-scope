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
import { computed, onMounted, onBeforeUnmount, nextTick, ref, watch } from 'vue'
import { t } from '../i18n'
import CompanionBlockPreview from './CompanionBlockPreview.vue'
import CompanionColorPicker from './CompanionColorPicker.vue'
import {
  blockChoices, blockFor, defaultGaugeThresholds, gaugeThresholdBandIndex, gaugeThresholdColor, isChoiceOf,
  isDurationMetric, isDynamicGaugeMetric, isRangeGaugeMetric,
  DEFAULT_METRIC_LAYOUT, GAUGE_SEGMENTS_MAX, GAUGE_SEGMENTS_MIN, GAUGE_THRESHOLD_COUNT_RANGE,
  LAYOUT_TOKEN_ORDER, MAX_LAYOUT_ROWS,
  FUELING_CARBS_RANGE, FUELING_DEFAULTS, FUELING_INTERVAL_RANGE,
  MAX_SECONDARY_METRICS, METRIC_RANGE_DEFAULTS, metricDropdownLabel, metricLayout, metricSample,
  NATURAL_LINE_SIZE, previewScale, RANGE_GAUGE_COLOR, RANGE_GAUGE_SEGMENTS,
  type Block, type BlockChoice, type Catalog, type CellSize, type GaugeColorMode, type GaugeFill,
  type GaugeThickness, type LayoutToken, type MetricLayout, type MetricLayoutPreset, type RowHeight,
  type SecondaryMetricSize, type SecondaryMetricSlot,
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

// « Horloge » n'a pas de `Block.metric` propre (elle persiste `kind: 'clock'`,
// voir `blockFor`) : c'est ce `kind` qui la distingue ici, pour présélectionner
// « Horloge » dans le menu déroulant en rouvrant un composant déjà posé.
const metric = ref(props.block?.kind === 'clock' ? 'clock' : (props.block?.metric || props.catalog.metrics[0]))
const source = ref(props.block?.source || props.catalog.zone_sources[0])
// Vide plutôt qu'un premier jeton par défaut, contrairement à `source` : « tous
// les appareils confondus » est un choix à part entière (le comportement
// d'avant ce réglage), pas un repli sur le premier capteur de la liste.
const sensor = ref<string>(props.block?.sensor || '')
const sound = ref(props.block?.sound || props.catalog.bell_sounds[0])
const series = ref(props.block?.series || 'default')
// L'horloge n'a pas de `Block.format` (elle garde `mode`, comme avant que les
// deux genres partagent cet éditeur — voir `blockFor`) : ce même bouton
// HH:MM/HH:MM:SS lit donc l'un ou l'autre selon ce qui est réellement édité.
const format = ref(
  props.block?.kind === 'clock' ? (props.block?.mode || 'hm') : (props.block?.format || 'hm'),
)
// La fenêtre roulante d'un bloc `altitude_profile` — vide par défaut (`0` ne
// sort jamais du composant, voir plus bas et `blockFor`) : le profil entier
// du tracé, comportement d'avant ce réglage, plutôt qu'une fenêtre choisie
// pour personne.
const windowKm = ref<number>(props.block?.window_km || 0)
// La fenêtre récente d'un bloc `metric_trend` — même repli que `windowKm` :
// vide vaut toute la sortie, le comportement par défaut.
const windowS = ref<number>(props.block?.window_s || 0)
// Les deux réglages d'un bloc `fueling` — toujours présents, contrairement à
// `windowKm`/`windowS` : le bloc n'a pas de comportement utile sans eux, d'où
// un repli sur `FUELING_DEFAULTS` plutôt que sur « vide ».
const carbsPerHour = ref<number>(props.block?.carbs_g_per_h ?? FUELING_DEFAULTS.carbs_g_per_h)
const intervalMin = ref<number>(props.block?.interval_min ?? FUELING_DEFAULTS.interval_min)
// Le tronçon en cours ou celui qui suivra, pour les trois genres `workout_*`
// — même repli que `windowKm`/`windowS` : la valeur d'avant ce réglage
// (`'current'`) plutôt qu'un aperçu deviné pour personne.
const workoutTarget = ref<'current' | 'next'>(props.block?.upcoming ? 'next' : 'current')

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
  props.block?.kind === 'metric' || props.block?.kind === 'clock'
    ? metricLayout(props.block)
    : { ...DEFAULT_METRIC_LAYOUT },
)
const iconChoice = ref<string | undefined>(props.block?.icon)
const labelChoice = ref<string>(props.block?.label || '')
const gaugeKindChoice = ref<string>(props.block?.gauge_kind || 'range')

// L'éditeur de disposition (grille, palette, jauge, annotations, enregistrer)
// est replié derrière un bouton « Configurer » : on choisit une mesure et,
// si besoin, une disposition enregistrée sans jamais le déplier. Il ne sert
// qu'à *composer* une disposition, ce qui reste l'exception.
const showLayoutEditor = ref(false)

// Le jeton de palette actuellement « en main » — un tap sur une case de la
// grille l'y pose, sans glisser-déposer. `null` : un tap sur une case
// occupée la libère à la place.
const selectedToken = ref<LayoutToken | 'gauge' | null>(null)

// ── Les annotations de coin (`layout.secondary`) ────────────────────────────
//
// Même geste palette → case que les jetons classiques, mais un slot
// secondaire porte en plus sa propre mesure : il faut donc d'abord la
// choisir (`newSecondaryMetric`/`newSecondaryLabel`), « Ajouter » le posant
// en attente (`pendingSecondary`) plutôt que directement dans `layout` — un
// tap sur une case le place ensuite, exactement comme pour icône/étiquette/
// unité/chiffre.
const newSecondaryMetric = ref<string>(props.catalog.metrics[0])
const newSecondaryLabel = ref<string>('')
const pendingSecondary = ref<{ metric: string; label?: string } | null>(null)

// « Horloge » (voir `primaryMetricChoices` plus bas) : ni zone, ni jauge, ni
// unité, ni étiquette personnalisée — `metricZoneEligible`/`rangeEligible`/
// `dynamicEligible`/`hasUnit` le sont déjà naturellement (aucune entrée
// `METRIC_SAMPLES.clock.zone`/`.unit`, `clock` absente de `RANGE_GAUGE_METRICS`/
// `DYNAMIC_GAUGE_METRICS`), ne reste que le libellé et les annotations de coin
// à masquer explicitement plus bas dans le gabarit.
const isClockMetric = computed(() => metric.value === 'clock')

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

// L'annotation de coin posée dans cette case, s'il y en a une — au plus une :
// `placeSecondary` refuse une case déjà prise par un jeton classique, et
// `placeToken` évince l'annotation qui s'y trouverait déjà.
function secondaryAt(row: number, col: 'left' | 'center' | 'right'): SecondaryMetricSlot | undefined {
  return (currentLayout.value.secondary || []).find((slot) => {
    const [r, c] = slot.position.split('-')
    return Number(r) === row && c === col
  })
}

// « Ajouter » ne pose rien tout de suite : il met la mesure choisie « en
// main » (comme un jeton de palette), à poser sur une case d'un tap suivant.
function addPendingSecondary() {
  if ((currentLayout.value.secondary || []).length >= MAX_SECONDARY_METRICS) return
  pendingSecondary.value = { metric: newSecondaryMetric.value, label: newSecondaryLabel.value.trim() || undefined }
  selectedToken.value = null
  newSecondaryLabel.value = ''
}

// Refuse une case déjà prise par un jeton classique ou par la jauge — même
// règle que côté Rails (`sanitize_secondary_slots`) : la poser quand même
// ferait composer ici ce que le serveur retirerait à l'enregistrement.
function placeSecondary(row: number, col: 'left' | 'center' | 'right') {
  const slot = pendingSecondary.value
  if (!slot) return
  if (tokensAt(row, col).length || currentLayout.value.gauge === String(row)) return

  const next = (currentLayout.value.secondary || []).filter((entry) => entry.position !== `${row}-${col}`)
  next.push({ metric: slot.metric, position: `${row}-${col}`, label: slot.label })
  layout.value = { ...layout.value, secondary: next }
  pendingSecondary.value = null
}

function removeSecondaryAt(row: number, col: 'left' | 'center' | 'right') {
  const next = (currentLayout.value.secondary || []).filter((entry) => entry.position !== `${row}-${col}`)
  layout.value = { ...layout.value, secondary: next.length ? next : undefined }
}

// Retirer directement depuis la liste des annotations déjà posées (pas
// besoin de retrouver puis cliquer la bonne case de la grille).
function removeSecondarySlot(slot: SecondaryMetricSlot) {
  const next = (currentLayout.value.secondary || []).filter((entry) => entry.position !== slot.position)
  layout.value = { ...layout.value, secondary: next.length ? next : undefined }
}

// Sa taille — `'small'` quand `size` est absent (jamais écrit dans ce cas,
// voir `setSecondarySize`), même repli que `rowHeightAt`.
function secondarySizeOf(slot: SecondaryMetricSlot): SecondaryMetricSize {
  return slot.size || 'small'
}

function setSecondarySize(slot: SecondaryMetricSlot, size: SecondaryMetricSize) {
  const next = (currentLayout.value.secondary || []).map((entry) => {
    if (entry.position !== slot.position) return entry
    if (size === 'small') {
      const { size: _drop, ...rest } = entry
      return rest
    }
    return { ...entry, size }
  })
  layout.value = { ...layout.value, secondary: next }
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
  for (const slot of currentLayout.value.secondary || []) rows.push(Number(slot.position.split('-')[0]))
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
    // La jauge est une barre pleine largeur : elle évince aussi les
    // annotations de coin de sa rangée, texte ou annotation.
    if (next.secondary?.some((entry) => entry.position.startsWith(`${row}-`))) {
      next.secondary = next.secondary.filter((entry) => !entry.position.startsWith(`${row}-`))
    }
  } else {
    if (next.gauge === String(row)) delete next.gauge
    next[token] = `${row}-${col}`
    // Un jeton classique gagne toujours sur une annotation de coin déjà posée
    // dans la même case — même arbitrage que côté Rails
    // (`sanitize_secondary_slots`) : la garder mentirait, le serveur la
    // retirerait au premier enregistrement.
    if (next.secondary?.some((entry) => entry.position === `${row}-${col}`)) {
      next.secondary = next.secondary.filter((entry) => entry.position !== `${row}-${col}`)
    }
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
  if (pendingSecondary.value) {
    placeSecondary(row, col)
    return
  }
  if (selectedToken.value) {
    placeToken(selectedToken.value, row, col)
    selectedToken.value = null
    return
  }
  const tokens = tokensAt(row, col)
  if (tokens.length) {
    for (const token of tokens) {
      if (token !== 'value') removeToken(token)
    }
    return
  }
  // Rien de classique ici : un tap libère l'annotation de coin éventuelle —
  // les deux ne coexistent jamais dans la même case (`placeSecondary` le
  // refuse déjà), donc ceci ne fait rien si la case était déjà vide.
  removeSecondaryAt(row, col)
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

// La forme, le nombre de tronçons et la couleur du remplissage de la jauge :
// ceux du composant en cours d'édition, sinon les mêmes replis que côté
// appli (`RANGE_GAUGE_SEGMENTS`/`RANGE_GAUGE_COLOR`) — sauf la couleur
// automatique, dont le repli dépend de la nature de la jauge au moment où la
// dialogue s'ouvre : automatique pour une jauge de zones (le rendu d'avant
// ce réglage), fixe sinon. Contrairement à min/max, on ne les réinitialise
// pas à chaque changement de mesure : la forme et la couleur choisies
// restent valables pour n'importe quelle mesure, elles ne sont pas mises à
// l'échelle comme une plage.
const gaugeFillChoice = ref<GaugeFill>((props.block?.gauge_fill as GaugeFill | undefined) || 'segments')
const gaugeSegmentsChoice = ref<number>(props.block?.gauge_segments || RANGE_GAUGE_SEGMENTS)
const gaugeColorModeChoice = ref<GaugeColorMode>(
  (props.block?.gauge_color_mode as GaugeColorMode | undefined) || (metricZoneEligible.value ? 'auto' : 'fixed'),
)
// `null` (pas un repli concret) : même contrat que `color`/`textColor` — le
// sélecteur peut y revenir explicitement (bouton « Réinitialiser »), et
// c'est ce qui laisse alors l'appli sur `_defaultColor` plutôt que d'y écrire
// la couleur par défaut en dur.
const gaugeColorChoice = ref<string | null>(props.block?.gauge_color || null)
const gaugeThicknessChoice = ref<GaugeThickness>(props.block?.gauge_thickness || 'normal')

// Les jalons d'une jauge à tranches personnalisées (`gauge_color_mode ===
// 'thresholds'`) : ceux du composant en cours d'édition s'ils sont de la
// forme attendue (une couleur de plus que de jalons), sinon un point de
// départ plausible (`defaultGaugeThresholds`) — même repli que min/max, mais
// jamais réinitialisé au changement de mesure : contrairement à une plage,
// des jalons choisis (« 80, 85, 95, 100 » pour la cadence) n'ont pas de sens
// mis à l'échelle sur une autre mesure.
function initialThresholdsFor(m: string): { thresholds: number[]; colors: string[] } {
  if (
    props.block?.gauge_thresholds?.length
    && props.block?.gauge_threshold_colors?.length === props.block.gauge_thresholds.length + 1
  ) {
    return { thresholds: [...props.block.gauge_thresholds], colors: [...props.block.gauge_threshold_colors] }
  }
  return defaultGaugeThresholds(m)
}
const gaugeThresholdsChoice = ref<number[]>(initialThresholdsFor(metric.value).thresholds)
const gaugeThresholdColorsChoice = ref<string[]>(initialThresholdsFor(metric.value).colors)

function addThreshold() {
  if (gaugeThresholdsChoice.value.length >= GAUGE_THRESHOLD_COUNT_RANGE.max) return
  const { min: rMin, max: rMax } = rangeDefaultsFor(metric.value)
  const last = gaugeThresholdsChoice.value[gaugeThresholdsChoice.value.length - 1]
  const next = last != null ? last + (rMax - rMin) / 10 : (rMin + rMax) / 2
  gaugeThresholdsChoice.value = [...gaugeThresholdsChoice.value, next]
  // Fusionne la nouvelle tranche dans la couleur de la dernière plutôt que
  // d'en inventer une : on affine ensuite au lieu de composer une couleur au
  // hasard.
  gaugeThresholdColorsChoice.value = [
    ...gaugeThresholdColorsChoice.value,
    gaugeThresholdColorsChoice.value[gaugeThresholdColorsChoice.value.length - 1],
  ]
}

function removeThreshold(index: number) {
  if (gaugeThresholdsChoice.value.length <= GAUGE_THRESHOLD_COUNT_RANGE.min) return
  gaugeThresholdsChoice.value = gaugeThresholdsChoice.value.filter((_, i) => i !== index)
  // La tranche retirée fusionne avec celle qui la précède : on garde une
  // couleur de plus que de jalons, jamais l'inverse.
  gaugeThresholdColorsChoice.value = gaugeThresholdColorsChoice.value.filter((_, i) => i !== index + 1)
}

function setThresholdColor(index: number, value: string | null) {
  const next = [...gaugeThresholdColorsChoice.value]
  next[index] = value || RANGE_GAUGE_COLOR
  gaugeThresholdColorsChoice.value = next
}

// Le fond par tranches n'a pas besoin d'une jauge posée : il tinte la carte
// elle-même (voir `MetricView._paint` côté appli), indépendamment de la
// barre — contrairement à `gaugeFillChoice`/`gaugeSegmentsChoice`/
// `gaugeColorChoice`, purs réglages de la barre. D'où ce bouton à part,
// plutôt qu'une troisième option dans le menu du panneau « Jauge » : le
// composer ne devrait pas être conditionné à poser un jeton qu'on ne veut
// pas forcément. Repli à la désactivation : le même que celui d'avant ce
// réglage (`gaugeColorModeChoice`, plus haut).
const thresholdsEnabled = computed<boolean>({
  get: () => gaugeColorModeChoice.value === 'thresholds',
  set: (enabled) => {
    gaugeColorModeChoice.value = enabled ? 'thresholds' : (metricZoneEligible.value ? 'auto' : 'fixed')
  },
})

// Un chiffre pour vérifier la règle composée, sans attendre de la retrouver
// en pleine sortie sur le téléphone : on tape une valeur plausible, la
// pastille et la tranche répondent tout de suite — même calcul que l'appli
// (`gaugeThresholdColor`/`gaugeThresholdBandIndex`, `companionSettings.ts`).
// `null` tant que rien n'est saisi, pas une valeur par défaut : une pastille
// vide dit plus clairement « pas encore testé » qu'une couleur qui pourrait
// passer pour un résultat.
const thresholdTestValue = ref<number | null>(null)
const thresholdTestColor = computed(
  () => gaugeThresholdColor(thresholdTestValue.value, gaugeThresholdsChoice.value, gaugeThresholdColorsChoice.value),
)
const thresholdTestBandIndex = computed(
  () => gaugeThresholdBandIndex(thresholdTestValue.value, gaugeThresholdsChoice.value),
)

// Pas `v-model.number` : sur un champ vidé, ce modificateur retombe sur la
// chaîne vide plutôt que sur `null` (rien à convertir), et `''` passerait
// les comparaisons de `gaugeThresholdBandIndex` comme un `0` — une pastille
// grise se lirait alors comme une vraie tranche.
function onThresholdTestInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  thresholdTestValue.value = raw === '' ? null : Number(raw)
}

// Le libellé de liste déroulante (préfixe Di2, raccourcis de durée) est
// partagé avec le bandeau du bas (`CompanionDashboard.vue`) — voir
// `metricDropdownLabel` dans `companionSettings.ts`. « Horloge » n'est pas une
// mesure du catalogue (voir `primaryMetricChoices`) : son libellé vient de
// `blocks.clock`, celui qui nommait déjà son ancienne section.
function metricLabel(metric: string): string {
  return metric === 'clock' ? t('companion.settings.blocks.clock') : metricDropdownLabel(metric, t)
}

// L'aide affichée sous l'en-tête d'un groupe : une phrase qui dit ce que le
// composant montre et d'où il tient sa donnée. `''` (masquée) tant que la clé
// n'existe pas — tous les genres ne l'ont pas encore. Les sections fondues
// (`GROUPED_KINDS` : `weather`, `workout`) ont leur propre clé.
function blockHelp(kind: string): string {
  return t(`companion.settings.block_help.${kind}`, { defaultValue: '' })
}

// La même chose pour une mesure, en tête du groupe « Une mesure » : une phrase
// pour chaque mesure du catalogue (`companion.settings.metric_help`), de quoi
// composer sans connaître le vocabulaire. `''` pour l'horloge, qui n'est pas
// une mesure.
const metricHelp = computed(() =>
  isClockMetric.value ? '' : t(`companion.settings.metric_help.${metric.value}`, { defaultValue: '' }),
)

// Le catalogue liste les mesures dans l'ordre du serveur ; la dialogue les
// propose triées par libellé affiché, pour qu'on les retrouve sans connaître
// cet ordre-là par cœur. Sert aussi le choix d'une mesure secondaire
// (`newSecondaryMetric`) — jamais « Horloge » ici : elle n'a pas de `MetricId`,
// `sanitize_secondary_slots` la retirerait en silence à l'enregistrement.
const sortedMetrics = computed(() => (
  [...props.catalog.metrics].sort((a, b) => metricLabel(a).localeCompare(metricLabel(b)))
))

// La même liste, avec « Horloge » en plus — seulement pour le menu déroulant
// « Mesure » en tête du groupe « Une mesure » : c'est elle qui choisit,
// désormais, entre une vraie mesure et l'horloge (voir `blockFor`, qui
// distingue les deux au moment d'enregistrer). Absente d'une page tour, comme
// avant que « Horloge » ait sa propre section (voir l'ancien filtre de
// `groups`) : l'appli l'ignore déjà silencieusement sur une page `laps`.
const primaryMetricChoices = computed(() => {
  const metrics = props.pageKind === 'laps' ? props.catalog.metrics : [...props.catalog.metrics, 'clock']
  return [...metrics].sort((a, b) => metricLabel(a).localeCompare(metricLabel(b)))
})

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

// Des genres qui partagent une même section de la dialogue plutôt que
// chacun la sienne : le tronçon en cours, le temps restant et les deux
// fondus racontent tous les trois le même programme d'entraînement ;
// précipitations, orage qui arrive, prévisions météo et météo compact
// racontent tous les quatre la même météo. Les séparer en en-têtes répétés
// (« Entraînement », « Météo ») n'aiderait personne à les comparer. Une
// table plutôt qu'un `if` de plus dans `groups` : un futur genre `workout_*`
// ou météo n'a qu'à y ajouter sa ligne.
const GROUPED_KINDS: Record<string, string> = {
  workout_segment: 'workout',
  workout_remaining: 'workout',
  workout_status: 'workout',
  precip_radar: 'weather',
  precip_forecast: 'weather',
  weather_forecast: 'weather',
  weather_compact: 'weather',
  wind: 'weather',
}

// Le libellé propre à chaque section fondue (`GROUPED_KINDS`) — ce ne sont
// pas des genres du catalogue, elles n'ont donc pas de
// `companion.settings.blocks.<kind>` à lire.
const GROUP_LABELS: Record<string, string> = {
  workout: 'companion.settings.workout_title',
  weather: 'companion.settings.weather_group_title',
}

// Le titre d'une section — celui du genre pour une section ordinaire, ou le
// libellé propre d'une section fondue (`GROUP_LABELS`).
function groupLabel(kind: string): string {
  const key = GROUP_LABELS[kind]
  return key ? t(key) : t(`companion.settings.blocks.${kind}`)
}

// Les vignettes, regroupées par genre — l'ordre est celui du catalogue, donc
// celui du serveur, qui est aussi l'ordre d'affichage des libellés. Une
// section fondue (`GROUPED_KINDS`) se place au rang de son premier genre.
const groups = computed(() => {
  const choices = blockChoices(props.catalog)

  const order: string[] = []
  const tilesByGroup = new Map<string, Tile[]>()

  Object.keys(props.catalog.blocks)
    // « Horloge » n'a plus sa propre section : elle se compose depuis le
    // menu déroulant du groupe « Une mesure », comme `duration` (voir
    // `primaryMetricChoices`, `blockFor`) — jamais une entrée à part ici,
    // sinon les deux chemins la proposeraient chacun la sienne.
    .filter((kind) => kind !== 'clock')
    .forEach((kind) => {
      const groupKind = GROUPED_KINDS[kind] || kind
      if (!tilesByGroup.has(groupKind)) {
        tilesByGroup.set(groupKind, [])
        order.push(groupKind)
      }

      const tiles = choices
        .filter((choice) => choice.kind === kind)
        .map((choice) => ({
          key: `${choice.kind}:${choice.mode || ''}`,
          block: blockFor(choice, {
            metric: metric.value, source: source.value, sensor: sensor.value || undefined,
            sound: sound.value, series: series.value, format: format.value,
            layout: currentLayout.value, icon: iconChoice.value, label: labelChoice.value,
            gaugeKind: effectiveGaugeKind.value || undefined,
            gaugeFill: gaugeFillChoice.value, gaugeSegments: gaugeSegmentsChoice.value,
            gaugeColorMode: gaugeColorModeChoice.value, gaugeColor: gaugeColorChoice.value ?? undefined,
            gaugeThresholds: gaugeThresholdsChoice.value, gaugeThresholdColors: gaugeThresholdColorsChoice.value,
            gaugeThickness: gaugeThicknessChoice.value,
            min: min.value, max: max.value, windowKm: windowKm.value || undefined,
            windowS: windowS.value || undefined,
            carbsPerHour: carbsPerHour.value, intervalMin: intervalMin.value,
            upcoming: workoutTarget.value === 'next',
            color: color.value, textColor: textColor.value,
          }),
          label: labelOf(choice),
        })) as Tile[]

      tilesByGroup.get(groupKind)!.push(...tiles)
    })

  return order.map((kind) => ({ kind, tiles: tilesByGroup.get(kind)! }))
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

// La dialogue défile — voir l'en-tête du fichier. Sans ce réglage, elle
// s'ouvre toujours en haut et il faut redescendre jusqu'au composant qu'on
// modifie, à chaque fois qu'on revient l'ajuster.
const currentTileEl = ref<HTMLElement | null>(null)
function setCurrentTileRef(el: Element | null, tileBlock: Block) {
  if (isChoiceOf(props.block, tileBlock)) currentTileEl.value = el as HTMLElement | null
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (props.block) {
    nextTick(() => currentTileEl.value?.scrollIntoView({ block: 'center' }))
  }
})
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
            <h3 class="h6 mb-0">{{ groupLabel(group.kind) }}</h3>

            <!-- Le paramètre du genre, en tête de son groupe : les vignettes
                 en dessous le dessinent aussitôt. `metric` est le seul genre qui
                 en a plusieurs : ils sont sortis d'ici (voir `.cbpk-metric-params`
                 et `.cbpk-gauge-params` plus bas), où ils s'entassaient sur
                 trois lignes dès qu'une jauge était posée. -->
            <label
              v-if="group.kind === 'zones' || group.kind === 'lap_zones' ||
                group.kind === 'metric_trend' || group.kind === 'lap_metric_trend'"
              class="cbpk-param small"
            >
              {{ t('companion.settings.source') }}
              <select v-model="source" class="form-select form-select-sm">
                <option v-for="s in catalog.zone_sources" :key="s" :value="s">
                  {{ t(`companion.settings.sources.${s}`) }}
                </option>
              </select>
            </label>

            <label v-if="group.kind === 'battery'" class="cbpk-param small">
              {{ t('companion.settings.battery_sensor') }}
              <select v-model="sensor" class="form-select form-select-sm">
                <option value="">{{ t('companion.settings.battery_sensor_any') }}</option>
                <option v-for="s in catalog.battery_sensors" :key="s" :value="s">
                  {{ t(`companion.settings.sensors.${s}`) }}
                </option>
              </select>
            </label>

            <label v-if="group.kind === 'bell'" class="cbpk-param small">
              {{ t('companion.settings.sound') }}
              <select v-model="sound" class="form-select form-select-sm">
                <option v-for="s in catalog.bell_sounds" :key="s" :value="s">
                  {{ t(`companion.settings.bell_sounds.${s}`) }}
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

            <label v-if="group.kind === 'metric_trend'" class="cbpk-param small">
              {{ t('companion.settings.metric_trend_window_s') }}
              <input
                v-model.number="windowS"
                type="number"
                min="30"
                max="3600"
                step="30"
                :placeholder="t('companion.settings.metric_trend_window_s_placeholder')"
                class="form-control form-control-sm"
              >
            </label>

            <label v-if="group.kind === 'workout'" class="cbpk-param small">
              {{ t('companion.settings.workout_target') }}
              <select v-model="workoutTarget" class="form-select form-select-sm">
                <option value="current">{{ t('companion.settings.workout_targets.current') }}</option>
                <option value="next">{{ t('companion.settings.workout_targets.next') }}</option>
              </select>
            </label>

            <template v-if="group.kind === 'fueling'">
              <label class="cbpk-param small">
                {{ t('companion.settings.fueling_carbs') }}
                <input
                  v-model.number="carbsPerHour"
                  type="number"
                  :min="FUELING_CARBS_RANGE.min"
                  :max="FUELING_CARBS_RANGE.max"
                  step="5"
                  class="form-control form-control-sm"
                >
              </label>
              <label class="cbpk-param small">
                {{ t('companion.settings.fueling_interval') }}
                <input
                  v-model.number="intervalMin"
                  type="number"
                  :min="FUELING_INTERVAL_RANGE.min"
                  :max="FUELING_INTERVAL_RANGE.max"
                  step="5"
                  class="form-control form-control-sm"
                >
              </label>
            </template>
          </div>

          <!-- Les réglages propres à la mesure : la mesure elle-même, son
               libellé, son format. Une grille de champs étiquetés (libellé
               au-dessus du contrôle) plutôt que la file de `.cbpk-param` qui
               débordait de l'en-tête du groupe. Les réglages de la jauge, eux,
               sont descendus près d'elle (`.cbpk-gauge-params`). -->
          <div v-if="group.kind === 'metric'" class="cbpk-metric-params">
            <label class="cbpk-field small">
              {{ t('companion.settings.metric') }}
              <select v-model="metric" class="form-select form-select-sm">
                <option v-for="m in primaryMetricChoices" :key="m" :value="m">
                  {{ metricLabel(m) }}
                </option>
              </select>
            </label>

            <!-- Pas d'étiquette personnalisée pour l'horloge : elle affiche
                 toujours « HORLOGE » (voir `ClockCard` côté appli). -->
            <label v-if="!isClockMetric" class="cbpk-field small">
              {{ t('companion.settings.metric_label') }}
              <input
                v-model="labelChoice"
                type="text"
                class="form-control form-control-sm"
                :placeholder="metricLabel(metric)"
                maxlength="24"
              >
            </label>

            <label v-if="isDurationMetric(metric) || isClockMetric" class="cbpk-field small">
              {{ t('companion.settings.duration_format') }}
              <select v-model="format" class="form-select form-select-sm">
                <option value="hm">{{ t('companion.settings.duration_formats.hm') }}</option>
                <option value="hms">{{ t('companion.settings.duration_formats.hms') }}</option>
              </select>
            </label>
          </div>

          <!-- Ce que le composant montre, et d'où il tient sa donnée — une
               phrase sous l'en-tête du groupe. Les hints plus bas restent pour
               les pièges propres à un réglage. Pour `metric`, cette phrase
               générique passe *sous* la section mesure (après le descriptif de
               la mesure choisie), au plus près de « Configurer la disposition »
               qu'elle évoque. -->
          <p v-if="blockHelp(group.kind) && group.kind !== 'metric'" class="text-body-secondary small mb-2">
            {{ blockHelp(group.kind) }}
          </p>

          <template v-if="group.kind === 'metric'">
            <p v-if="metricHelp" class="text-body-secondary small mb-2">
              {{ metricHelp }}
            </p>
            <p v-if="blockHelp('metric')" class="text-body-secondary small mb-2">
              {{ blockHelp('metric') }}
            </p>
          </template>

          <p v-if="group.kind === 'lap_delta'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.lap_delta_hint') }}
          </p>

          <p v-if="group.kind === 'fueling'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.fueling_hint') }}
          </p>

          <p v-if="group.kind === 'battery'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.battery_sensor_hint') }}
          </p>

          <p v-if="group.kind === 'mark_lap'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.lap_series_cols_hint') }}
          </p>

          <p v-if="group.kind === 'metric' && props.pageKind === 'laps'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.metric_lap_scope_hint') }}
          </p>

          <p v-if="group.kind === 'altitude_profile'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.altitude_window_km_hint') }}
          </p>

          <p v-if="group.kind === 'metric_trend'" class="text-body-secondary small mb-2">
            {{ t('companion.settings.metric_trend_window_s_hint') }}
          </p>

          <!-- L'éditeur de disposition d'un bloc `metric` : une grille à 3
               colonnes et jusqu'à `MAX_LAYOUT_ROWS` rangées, chaque case
               recevant un jeton de la palette d'en dessous. Replié derrière
               « Configurer » — seul le choix d'une disposition enregistrée
               reste toujours à portée. -->
          <div
            v-if="group.kind === 'metric'"
            class="cbpk-layout"
            :class="{ 'cbpk-layout--open': showLayoutEditor }"
          >
            <div class="cbpk-layout-bar">
              <label v-if="metricLayouts?.length" class="cbpk-field small cbpk-layout-presets">
                {{ t('companion.settings.metric_layouts.load') }}
                <select class="form-select form-select-sm" @change="onLoadPreset($event)">
                  <option value="">{{ t('companion.settings.metric_layouts.load_placeholder') }}</option>
                  <option v-for="preset in metricLayouts" :key="preset.key" :value="preset.key">
                    {{ preset.name }}
                  </option>
                </select>
              </label>

              <button
                type="button"
                class="btn btn-sm btn-outline-secondary cbpk-configure-btn"
                :class="{ 'cbpk-configure-btn--open': showLayoutEditor }"
                :aria-expanded="showLayoutEditor"
                @click="showLayoutEditor = !showLayoutEditor"
              >
                <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                {{ t('companion.settings.configure_layout') }}
              </button>
            </div>

            <template v-if="showLayoutEditor">
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
                    <span v-if="secondaryAt(row - 1, col)" class="cbpk-grid-token cbpk-grid-token--secondary">
                      {{ secondaryAt(row - 1, col)!.label || metricLabel(secondaryAt(row - 1, col)!.metric) }}
                    </span>
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

            <!-- Le fond par tranches : indépendant du jeton « Jauge », il tinte
                 la carte elle-même (voir le commentaire de `thresholdsEnabled`)
                 — proposé dès que la mesure s'y prête, jauge posée ou non. -->
            <div v-if="!metricZoneEligible && (rangeEligible || dynamicEligible)" class="cbpk-gauge-params">
              <p class="cbpk-subhead">{{ t('companion.settings.gauge_background') }}</p>

              <label class="cbpk-field small cbpk-threshold-toggle">
                <input v-model="thresholdsEnabled" type="checkbox" class="form-check-input">
                {{ t('companion.settings.gauge_thresholds_enable') }}
              </label>

              <!-- Les jalons : une couleur, puis une paire jalon/couleur par
                   tranche suivante — la couleur d'une tranche se règle
                   toujours à sa droite, dans l'ordre croissant des valeurs. -->
              <div v-if="thresholdsEnabled" class="cbpk-thresholds">
                <div class="cbpk-threshold-row">
                  <CompanionColorPicker
                    :model-value="gaugeThresholdColorsChoice[0]" :fallback="RANGE_GAUGE_COLOR"
                    :label="t('companion.settings.gauge_threshold_band_color')"
                    @update:model-value="(v) => setThresholdColor(0, v)"
                  />
                </div>
                <div v-for="(_, i) in gaugeThresholdsChoice" :key="i" class="cbpk-threshold-row">
                  <input
                    v-model.number="gaugeThresholdsChoice[i]" type="number"
                    class="form-control form-control-sm cbpk-threshold-input"
                    :aria-label="t('companion.settings.gauge_threshold_value')"
                  >
                  <button
                    v-if="gaugeThresholdsChoice.length > GAUGE_THRESHOLD_COUNT_RANGE.min"
                    type="button" class="btn btn-sm btn-outline-danger cbpk-threshold-remove"
                    :aria-label="t('companion.settings.gauge_threshold_remove')"
                    @click="removeThreshold(i)"
                  >
                    &times;
                  </button>
                  <CompanionColorPicker
                    :model-value="gaugeThresholdColorsChoice[i + 1]" :fallback="RANGE_GAUGE_COLOR"
                    :label="t('companion.settings.gauge_threshold_band_color')"
                    @update:model-value="(v) => setThresholdColor(i + 1, v)"
                  />
                </div>
                <button
                  type="button" class="btn btn-sm btn-outline-secondary"
                  :disabled="gaugeThresholdsChoice.length >= GAUGE_THRESHOLD_COUNT_RANGE.max"
                  @click="addThreshold"
                >
                  {{ t('companion.settings.gauge_threshold_add') }}
                </button>

                <!-- Vérifier la règle composée sans attendre de la retrouver
                     en pleine sortie : une valeur tapée ici répond tout de
                     suite avec la même couleur que l'appli calculerait. -->
                <div class="cbpk-threshold-test">
                  <label class="cbpk-field small">
                    {{ t('companion.settings.gauge_threshold_test_value') }}
                    <input
                      :value="thresholdTestValue ?? ''" type="number"
                      class="form-control form-control-sm cbpk-threshold-input"
                      @input="onThresholdTestInput"
                    >
                  </label>
                  <span
                    class="cbpk-threshold-test-swatch"
                    :style="{ background: thresholdTestColor || undefined }"
                  ></span>
                  <span class="small text-body-secondary">
                    {{
                      thresholdTestColor
                        ? t('companion.settings.gauge_threshold_test_result', { band: (thresholdTestBandIndex ?? 0) + 1 })
                        : t('companion.settings.gauge_threshold_test_empty')
                    }}
                  </span>
                </div>

                <p class="cbpk-gauge-hint small text-body-secondary">
                  {{
                    currentLayout.gauge
                      ? t('companion.settings.gauge_thresholds_hint_with_gauge')
                      : t('companion.settings.gauge_thresholds_hint')
                  }}
                </p>
              </div>
            </div>

            <!-- Les réglages de la jauge, sous la grille plutôt que dans
                 l'en-tête du groupe : ils n'apparaissent qu'une fois le jeton
                 « Jauge » posé, et le panneau se lit d'un coup au lieu de se
                 disperser au milieu des autres champs. -->
            <div v-if="!!currentLayout.gauge" class="cbpk-gauge-params">
              <p class="cbpk-subhead">{{ t('companion.settings.layout_tokens.gauge') }}</p>

              <label
                v-if="rangeEligible && dynamicEligible && !metricZoneEligible"
                class="cbpk-field small"
              >
                {{ t('companion.settings.gauge_kind') }}
                <select v-model="gaugeKindChoice" class="form-select form-select-sm">
                  <option value="range">{{ t('companion.settings.gauge_kinds.range') }}</option>
                  <option value="dynamic">{{ t('companion.settings.gauge_kinds.dynamic') }}</option>
                </select>
              </label>

              <template v-if="effectiveGaugeKind === 'range'">
                <label class="cbpk-field small">
                  {{ t('companion.settings.range_min') }}
                  <input v-model.number="min" type="number" class="form-control form-control-sm">
                </label>
                <label class="cbpk-field small">
                  {{ t('companion.settings.range_max') }}
                  <input v-model.number="max" type="number" class="form-control form-control-sm">
                </label>
              </template>

              <label v-if="gaugeColorModeChoice !== 'thresholds'" class="cbpk-field small">
                {{ t('companion.settings.gauge_fill') }}
                <select v-model="gaugeFillChoice" class="form-select form-select-sm">
                  <option value="segments">{{ t('companion.settings.gauge_fills.segments') }}</option>
                  <option value="full">{{ t('companion.settings.gauge_fills.full') }}</option>
                </select>
              </label>

              <label v-if="gaugeFillChoice === 'segments' && gaugeColorModeChoice !== 'thresholds'" class="cbpk-field small">
                {{ t('companion.settings.gauge_segments') }}
                <input
                  v-model.number="gaugeSegmentsChoice" type="number"
                  :min="GAUGE_SEGMENTS_MIN" :max="GAUGE_SEGMENTS_MAX"
                  class="form-control form-control-sm"
                >
              </label>

              <label v-if="!thresholdsEnabled" class="cbpk-field small">
                {{ t('companion.settings.gauge_color_mode') }}
                <select v-model="gaugeColorModeChoice" class="form-select form-select-sm">
                  <option value="fixed">{{ t('companion.settings.gauge_color_modes.fixed') }}</option>
                  <option value="auto">{{ t('companion.settings.gauge_color_modes.auto') }}</option>
                </select>
              </label>

              <label v-if="gaugeColorModeChoice === 'fixed' && !thresholdsEnabled" class="cbpk-field small">
                {{ t('companion.settings.gauge_color') }}
                <CompanionColorPicker
                  v-model="gaugeColorChoice" :fallback="RANGE_GAUGE_COLOR" :label="t('companion.settings.gauge_color')"
                />
              </label>

              <label class="cbpk-field small">
                {{ t('companion.settings.gauge_thickness') }}
                <select v-model="gaugeThicknessChoice" class="form-select form-select-sm">
                  <option v-for="th in (['small', 'normal', 'large'] as GaugeThickness[])" :key="th" :value="th">
                    {{ t(`companion.settings.gauge_thicknesses.${th}`) }}
                  </option>
                </select>
              </label>

              <p v-if="gaugeColorModeChoice === 'auto'" class="cbpk-gauge-hint small text-body-secondary">
                {{
                  metricZoneEligible
                    ? t('companion.settings.gauge_color_mode_hint_zone')
                    : t('companion.settings.gauge_color_mode_hint_gradient')
                }}
              </p>
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
              <!-- « Icône par défaut » : on dessine l'icône réelle de la mesure
                   (celle que l'appli prendra faute de choix), pas son libellé —
                   qui débordait de la case. Le point dans le coin (`--default`)
                   et l'infobulle disent que c'est le choix qui suit la mesure. -->
              <button
                type="button"
                class="cbpk-icon-btn cbpk-icon-btn--default"
                :class="{ 'cbpk-icon-btn--selected': !iconChoice }"
                :title="t('companion.settings.default_icon')"
                @click="iconChoice = undefined"
              >
                <i :class="metricSample(metric).icon" aria-hidden="true"></i>
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

            <!-- Les annotations de coin : une mesure dérivée (min/moyenne/max)
                 plus petite que le chiffre principal, avec son propre repère.
                 « Ajouter » met la mesure choisie en main comme un jeton de
                 palette — un tap sur une case libre la pose ensuite. Pas pour
                 l'horloge : `ClockCard` ne les dessine pas, même famille que
                 l'étiquette personnalisée ci-dessus. -->
            <div v-if="!isClockMetric" class="cbpk-secondary">
              <p class="cbpk-secondary-title small text-body-secondary mb-1">
                {{ t('companion.settings.secondary_values') }}
              </p>

              <div v-if="currentLayout.secondary?.length" class="cbpk-secondary-list mb-2">
                <div v-for="slot in currentLayout.secondary" :key="slot.position" class="cbpk-secondary-item">
                  <span class="cbpk-chip cbpk-chip--placed">{{ slot.label || metricLabel(slot.metric) }}</span>
                  <div class="cbpk-row-heights" role="group" :aria-label="t('companion.settings.secondary_size')">
                    <button
                      v-for="s in (['small', 'normal', 'large'] as const)"
                      :key="s"
                      type="button"
                      class="cbpk-row-height-btn"
                      :class="{ 'cbpk-row-height-btn--selected': secondarySizeOf(slot) === s }"
                      :title="t(`companion.settings.secondary_sizes.${s}`)"
                      @click="setSecondarySize(slot, s)"
                    >
                      {{ t(`companion.settings.secondary_sizes.${s}_short`) }}
                    </button>
                  </div>
                  <button
                    type="button"
                    class="cbpk-secondary-remove"
                    :aria-label="t('companion.settings.secondary_remove')"
                    @click="removeSecondarySlot(slot)"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div class="cbpk-secondary-form">
                <select v-model="newSecondaryMetric" class="form-select form-select-sm">
                  <option v-for="m in sortedMetrics" :key="m" :value="m">
                    {{ metricLabel(m) }}
                  </option>
                </select>
                <input
                  v-model="newSecondaryLabel"
                  type="text"
                  class="form-control form-control-sm"
                  :placeholder="t('companion.settings.secondary_label_placeholder')"
                  maxlength="6"
                >
                <button
                  type="button"
                  class="cbpk-chip"
                  :class="{ 'cbpk-chip--selected': !!pendingSecondary }"
                  :disabled="(currentLayout.secondary?.length || 0) >= MAX_SECONDARY_METRICS"
                  @click="addPendingSecondary"
                >
                  {{ t('companion.settings.secondary_add') }}
                </button>
              </div>
              <p v-if="pendingSecondary" class="cbpk-secondary-hint small text-body-secondary">
                {{ t('companion.settings.secondary_add_hint') }}
              </p>
            </div>

            <button type="button" class="btn btn-sm btn-outline-secondary" @click="saveLayoutPreset">
              {{ t('companion.settings.metric_layouts.save') }}
            </button>
            </template>
          </div>

          <div class="cbpk-tiles">
            <button
              v-for="tile in group.tiles"
              :key="tile.key"
              type="button"
              class="cbpk-tile"
              :class="{ 'cbpk-tile--current': isChoiceOf(block, tile.block) }"
              :ref="(el) => setCurrentTileRef(el as Element | null, tile.block)"
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
/* Les réglages de la mesure et de la jauge : une grille de champs étiquetés
   (libellé au-dessus du contrôle), là où l'en-tête du groupe les alignait à la
   file jusqu'à déborder sur trois lignes. Une seule règle pour les deux : même
   forme de champ, seul le cadre change. */
.cbpk-metric-params,
.cbpk-gauge-params {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.5rem 0.75rem;
  align-items: start;
}
.cbpk-metric-params {
  margin-bottom: 0.7rem;
}
/* La jauge : un cadre teinté comme sa barre dans la grille (`.cbpk-grid-gauge`),
   pour qu'on voie d'un coup que ce panneau va avec le jeton qu'on vient de poser. */
.cbpk-gauge-params {
  padding: 0.6rem;
  border: 1px solid var(--bs-primary-border-subtle, rgba(13, 110, 253, 0.4));
  border-radius: 0.4rem;
  background: var(--bs-primary-bg-subtle, rgba(13, 110, 253, 0.08));
}
.cbpk-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0;
  color: var(--bs-secondary-color);
}
.cbpk-field input,
.cbpk-field select {
  width: 100%;
}
.cbpk-subhead {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--bs-secondary-color);
}
.cbpk-gauge-hint {
  grid-column: 1 / -1;
  margin: 0;
}
/* Les jalons d'une jauge à tranches : une ligne par jalon (couleur de la
   tranche qui précède, valeur, retrait), dans l'ordre croissant — pleine
   largeur du panneau, comme `.cbpk-gauge-hint`. */
.cbpk-thresholds {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.cbpk-threshold-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.cbpk-threshold-input {
  width: 6rem;
}
.cbpk-threshold-remove {
  line-height: 1;
  padding: 0.15rem 0.5rem;
}
/* Le bouton qui active le fond par tranches : une case à cocher sur la même
   ligne que son libellé, contrairement à `.cbpk-field` (libellé au-dessus du
   contrôle) qui n'a pas de sens pour une case à cocher. */
.cbpk-threshold-toggle {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}
.cbpk-threshold-toggle .form-check-input {
  width: 1.1rem;
  height: 1.1rem;
  margin: 0;
}
/* Tester une valeur : le champ garde la forme `.cbpk-field` (libellé
   au-dessus), la pastille et le texte de résultat s'alignent à sa hauteur. */
.cbpk-threshold-test {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.cbpk-threshold-test-swatch {
  display: inline-block;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0.35rem;
  border: 1px solid var(--bs-border-color);
  /* Un damier discret tant qu'aucune couleur n'est posée dessus (`background`
     transparent) — comme un canal alpha vide, plutôt qu'un carré qui se
     confondrait avec le fond de la dialogue. */
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.25) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.25) 75%);
  background-size: 0.6rem 0.6rem;
  background-position: 0 0, 0 0.3rem, 0.3rem -0.3rem, -0.3rem 0;
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
   jetons, la grille d'icônes — dans cet ordre, celui où on les utilise. Le
   cadre n'entoure le contenu déplié que quand il est ouvert : replié, il ne
   reste que la barre (disposition enregistrée + « Configurer »), sans boîte
   autour d'un unique bouton. */
.cbpk-layout {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 0.8rem;
}
.cbpk-layout--open {
  padding: 0.6rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
}
/* La barre toujours visible de l'éditeur : le choix d'une disposition
   enregistrée à gauche, le bouton « Configurer » à droite. Le reste de
   `.cbpk-layout` ne se déplie qu'au clic. */
.cbpk-layout-bar {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.cbpk-layout-presets {
  flex: 1 1 14rem;
  margin-left: 0;
}
.cbpk-configure-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}
.cbpk-configure-btn--open {
  background: var(--bs-secondary-bg, #e9ecef);
  border-color: var(--bs-secondary-color, #6c757d);
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
/* Une annotation de coin se distingue des jetons classiques (icône/étiquette/
   unité/chiffre) par un liseré en plus du fond — c'est un chiffre d'une autre
   mesure, pas un simple élément de mise en forme du même chiffre. */
.cbpk-grid-token--secondary {
  border: 1px dashed var(--bs-primary);
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
.cbpk-icon-btn--selected {
  border-color: var(--bs-primary);
  outline: 2px solid var(--bs-primary);
  outline-offset: -2px;
}
/* Le bouton « suit la mesure » : même icône que la valeur par défaut, un point
   dans le coin pour le distinguer d'un choix explicite de la même icône. */
.cbpk-icon-btn--default::after {
  content: "";
  position: absolute;
  top: 2px;
  right: 2px;
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: var(--bs-primary);
}

/* Une annotation déjà posée, avec sa propre taille à côté — même disposition
   que `.cbpk-row-heights` à côté d'une rangée de la grille : un poids réglé
   sur l'élément lui-même, pas un des tiers qu'il occupe. */
.cbpk-secondary-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.cbpk-secondary-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.cbpk-secondary-item .cbpk-chip--placed {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cbpk-secondary-remove {
  flex: none;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.3rem;
  background: transparent;
  padding: 0.2rem 0.45rem;
  font-size: 0.75rem;
}

.cbpk-secondary-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.cbpk-secondary-form select {
  flex: 1 1 12rem;
}
.cbpk-secondary-form input {
  flex: 0 1 6rem;
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
