// Les profils de sortie de l'app compagnon, côté éditeur.
//
// Le contrat lui-même est décrit dans `app/models/companion_settings.rb` et repris
// à l'identique par `lib/dashboard/` du dépôt voisin. Ce fichier n'ajoute rien au
// format : il porte les types, et **le calcul de place dans une grille**.
//
// Pourquoi ce calcul est ici et pas seulement côté serveur : l'assainisseur retire
// les cellules qui se recouvrent, et il a raison de le faire — mais s'il était le
// seul garde-fou, l'éditeur laisserait étendre une cellule par-dessus sa voisine,
// et la voisine disparaîtrait à l'enregistrement. On calcule donc la place
// disponible **avant** de proposer l'étendue, si bien qu'on ne peut pas composer
// ce qui sera jeté.

import { colorForGrade } from './routeHelpers'

export interface Block {
  kind: string
  // Vestige d'avant ce chantier — un bloc `metric` n'en écrit plus, mais un
  // document enregistré avant ce chantier peut encore le porter (voir
  // `metricLayout`, qui le traduit en `layout`). Toujours actif pour les
  // autres genres de composants (`zones`, `radar`, …), qui gardent leurs
  // modes.
  mode?: string
  metric?: string
  source?: string
  // La série de tours qu'un bouton « Marquer un tour » (`mark_lap`) ouvre —
  // absente vaut `'default'`, la seule série que l'export `.fit` de l'appli
  // sait porter (une seule hiérarchie de tours possible dans le format).
  series?: string
  // `'hm'` (HH:MM) ou `'hms'` (HH:MM:SS) — seulement pour un bloc `metric` dont
  // la mesure est une durée (voir `isDurationMetric`). Absent vaut `'hm'`, le
  // seul format que l'appli connaissait avant ce réglage.
  format?: string
  // La disposition d'un bloc `metric` — voir `MetricLayout`/`metricLayout`.
  // Absente sur un document d'avant ce chantier, où c'était `mode` qui
  // décidait de tout.
  layout?: MetricLayout
  // Icône personnalisée, propre à ce bloc — une clé de `Catalog.icons`.
  // Absente : l'appli garde l'icône par défaut de la mesure (`MetricId.icon`).
  icon?: string
  // `'range'` (bornes réglées ci-dessous) ou `'dynamic'` (plage lue en
  // roulant) — seulement quand `layout.gauge` est réglé sur une mesure sans
  // zones d'entraînement éligible aux deux (voir `isRangeGaugeMetric`/
  // `isDynamicGaugeMetric`). Une mesure éligible à un seul des deux l'impose,
  // ce champ ne sert alors à rien.
  gauge_kind?: string
  // Bornes de la jauge à plage libre (`layout.gauge` réglé, `gauge_kind ===
  // 'range'`, sur une mesure sans zones d'entraînement — voir
  // `isRangeGaugeMetric`). Absentes, l'appli retombe sur le chiffre plein
  // cadre, comme avant que ce réglage existe pour ces mesures.
  min?: number
  max?: number
  // Couleur de fond de la carte et de son texte, en `#rrggbb` — valent pour
  // n'importe quel genre de composant, contrairement à `metric`/`source` qui
  // sont propres à un genre. Absentes, l'appli garde son calcul habituel
  // (couleur de zone si la mesure en porte une, gris des cartes sinon) ; un
  // fond réglé sans texte choisi retombe sur un texte calculé pour rester
  // lisible dessus (`foregroundOf`), jamais sur du blanc fixe.
  color?: string
  text_color?: string
}

// ── La disposition d'un bloc `metric` ───────────────────────────────────────
//
// Remplace les cinq anciens `mode` (`big`, `compact`, `zone`, `gauge`,
// `dynamic_gauge`) par une grille librement composable, à 3 colonnes et
// jusqu'à `MAX_LAYOUT_ROWS` rangées : chaque élément se pose dans une case
// `"<rangée>-<colonne>"` (`icon`/`label`/`unit`/`value`), `gauge` — une barre
// pleine largeur, pas un texte — sur une rangée entière (`"<rangée>"`, sans
// colonne). Une clé absente = élément masqué ; `value` est la seule
// obligatoire. Même contrat que `CompanionSettings::LAYOUT_*`/
// `sanitize_layout_positions` côté Rails — c'est lui qui fait foi, ce fichier
// ne fait qu'aider l'éditeur à ne pas composer ce que le serveur retirera.
export type RowHeight = 'small' | 'normal' | 'large'

export interface MetricLayout {
  icon?: string
  label?: string
  unit?: string
  value: string
  gauge?: string
  // Le poids de chaque rangée dans le partage de la hauteur réelle de la
  // case, ex. `{'1': 'large'}` pour mettre le chiffre plus en évidence que
  // son étiquette — clé = numéro de rangée, en chaîne (même format que les
  // positions). Une rangée absente d'ici vaut `'normal'`, jamais écrite pour
  // rester silencieuse (même contrat que `CompanionSettings::ROW_HEIGHTS`).
  row_heights?: Record<string, 'small' | 'large'>
}

export type LayoutToken = 'icon' | 'label' | 'unit' | 'value'

export const LAYOUT_TOKEN_ORDER: LayoutToken[] = ['icon', 'label', 'unit', 'value']

export const MAX_LAYOUT_ROWS = 4

// La disposition qu'un ancien `mode` de bloc `metric` dessinait — même table
// que `CompanionSettings::LEGACY_LAYOUTS` côté Rails, pour que l'aperçu d'un
// document enregistré avant ce chantier (jamais rouvert dans l'éditeur
// depuis) se dessine comme avant, sans que l'utilisateur ait à le retoucher.
const LEGACY_METRIC_LAYOUTS: Record<string, MetricLayout> = {
  big: { value: '0-center', unit: '1-center' },
  compact: { icon: '0-center', value: '1-center', unit: '2-center' },
  zone: { icon: '0-center', label: '0-center', value: '1-center' },
  gauge: { value: '0-center', gauge: '1', unit: '2-center' },
  dynamic_gauge: { value: '0-center', gauge: '1', unit: '2-center' },
}

// Le repli d'avant `big` : chiffre plein cadre, unité en dessous — même
// valeur que `CompanionSettings::DEFAULT_METRIC_LAYOUT`.
export const DEFAULT_METRIC_LAYOUT: MetricLayout = { value: '0-center', unit: '1-center' }

// La disposition d'un bloc `metric`, quelle que soit sa provenance : `layout`
// s'il en a un, sinon la traduction de son `mode` (document d'avant ce
// chantier), sinon le repli neutre. C'est elle que l'aperçu et l'éditeur
// doivent lire — jamais `block.layout`/`block.mode` directement, qui ne
// couvrent chacun qu'un des deux cas.
export function metricLayout(block: Block): MetricLayout {
  if (block.layout) return block.layout
  if (block.mode && LEGACY_METRIC_LAYOUTS[block.mode]) return LEGACY_METRIC_LAYOUTS[block.mode]
  return DEFAULT_METRIC_LAYOUT
}

// L'icône à dessiner pour un bloc `metric` : celle réglée sur le bloc, sinon
// celle par défaut de la mesure.
export function metricIcon(block: Block): string {
  return block.icon || metricSample(block.metric).icon
}

export interface GridPosition {
  row: number
  col: 'left' | 'center' | 'right'
}

// `undefined`/hors grille rendent `null` plutôt que de lever : ce fichier lit
// aussi bien un document tout juste composé qu'un document repris tel quel
// d'avant ce chantier, jamais garanti valide avant d'être passé par
// l'assainisseur Rails.
export function parsePosition(value: string | undefined): GridPosition | null {
  if (!value) return null
  const [rowPart, col] = value.split('-', 2)
  const row = Number(rowPart)
  if (!Number.isInteger(row) || row < 0 || row >= MAX_LAYOUT_ROWS) return null
  if (col !== 'left' && col !== 'center' && col !== 'right') return null
  return { row, col }
}

export function parseGaugeRow(value: string | undefined): number | null {
  if (!value) return null
  const row = Number(value)
  return Number.isInteger(row) && row >= 0 && row < MAX_LAYOUT_ROWS ? row : null
}

export interface MetricLayoutRow {
  row: number
  // Une rangée-jauge n'a pas de colonnes : la barre occupe toute sa largeur.
  gauge: boolean
  // Son poids dans le partage de la hauteur réelle de la case — voir
  // `MetricLayout.row_heights`.
  height: RowHeight
  // Toujours les 3 colonnes, y compris vides : c'est ce qui permet à
  // l'aperçu de réserver 3 tiers égaux (motif « barre d'outils »,
  // gauche/centre/droite) plutôt que de ne réserver que ce qui est occupé —
  // sinon une case seule à droite se retrouverait centrée, pas au bord.
  columns: { col: 'left' | 'center' | 'right'; tokens: LayoutToken[] }[]
}

// Le poids d'une rangée, en facteur `flex-grow`/`Expanded.flex` — même
// rapport des deux côtés (1 / 2 / 4), pour qu'une rangée « grande » prenne le
// même quadruple de place sur le site et sur le téléphone.
export const ROW_HEIGHT_WEIGHT: Record<RowHeight, number> = { small: 1, normal: 2, large: 4 }

// Les rangées effectivement utilisées, dans l'ordre — une rangée sans aucun
// occupant n'y figure pas (elle ne prend aucune place, ni dans l'appli ni
// dans l'aperçu). Partagée entre `CompanionBlockPreview` (dessiner) et
// `CompanionBlockPicker` (savoir quelles cases de la grille d'édition sont
// déjà prises).
export function layoutRows(layout: MetricLayout): MetricLayoutRow[] {
  const rows = new Map<number, { gauge: boolean; columns: Map<string, LayoutToken[]> }>()
  const ensure = (row: number) => {
    let entry = rows.get(row)
    if (!entry) {
      entry = { gauge: false, columns: new Map() }
      rows.set(row, entry)
    }
    return entry
  }

  for (const token of LAYOUT_TOKEN_ORDER) {
    const pos = parsePosition(layout[token])
    if (!pos) continue
    const entry = ensure(pos.row)
    const tokens = entry.columns.get(pos.col) || []
    tokens.push(token)
    entry.columns.set(pos.col, tokens)
  }

  const gaugeRow = parseGaugeRow(layout.gauge)
  if (gaugeRow != null) ensure(gaugeRow).gauge = true

  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, entry]) => ({
      row,
      gauge: entry.gauge,
      height: layout.row_heights?.[String(row)] || 'normal',
      columns: (['left', 'center', 'right'] as const)
        .map((col) => ({ col, tokens: entry.columns.get(col) || [] })),
    }))
}

// Série de tours que l'appli compagnon remplit toute seule, sur les fronts
// montant et descendant d'un col (voir `climbLapSeries` dans
// `lib/ride/climb_profile.dart` du dépôt voisin) : une page ou un bouton posé
// sur cette clé n'a besoin d'aucun geste du cycliste. Convention partagée
// entre les deux dépôts — un nom différent des deux côtés ferait un bouton
// muet.
export const climbLapSeries = 'cols'

export interface Cell {
  row: number
  col: number
  row_span: number
  col_span: number
  block: Block
}

export interface Page {
  kind: 'map' | 'grid' | 'list' | 'laps'
  title?: string
  rows?: number
  cols?: number
  cells?: Cell[]
  blocks?: Block[]
  // Rangée derrière le menu d'actions plutôt que dans le défilement. Absent vaut
  // « dans le défilement » — voir `canHideBehindMenu`.
  menu?: boolean
  // Seulement pour `kind: 'laps'` : la série de tours que cette page affiche
  // (liste déroulante + composants du tour choisi). Absente vaut `'default'`.
  series?: string
  // Seulement pour `kind: 'laps'` : liste défilante (absent, le cas
  // d'avant ce réglage) ou grille qui tient tout entière (`'grid'`, avec
  // `rows`/`cols`/`cells` comme une page `grid`). Une page `grid` n'a pas
  // besoin de cette clé — son genre le dit déjà.
  layout?: 'grid'
}

export interface Band {
  metrics: string[]
}

export interface Preset {
  key?: string
  name: string
  description?: string
  // Les types d'itinéraire pour lesquels ce profil est proposé. Absent vaut
  // « tous » : un profil qui n'a jamais touché à ce réglage continue de se
  // proposer partout, comme avant que la fonctionnalité existe.
  activities?: string[]
  // Le sous-ensemble d'`activities` pour lequel c'est le profil par défaut.
  // Un type ne peut être le défaut que d'un seul profil à la fois — voir
  // `setDefaultForActivity` dans CompanionDashboard.vue.
  default_for?: string[]
  pages: Page[]
  bands: Band[]
  sensors?: Record<string, boolean>
  radar?: Record<string, number | boolean>
  screen?: Record<string, number>
}

// Une disposition de bloc `metric` enregistrée pour être réutilisée sur une
// prochaine mesure — un **arrangement**, pas un bloc : ni icône choisie, ni
// type de jauge, ni min/max, propres à une mesure précise et pas à sa
// disposition.
export interface MetricLayoutPreset {
  key?: string
  name: string
  layout: MetricLayout
}

export interface CompanionDocument {
  v?: number
  presets: Preset[]
  metric_layouts?: MetricLayoutPreset[]
}

export interface Catalog {
  page_kinds: string[]
  blocks: Record<string, string[]>
  zone_sources: string[]
  metrics: string[]
  sensors: string[]
  activities: string[]
  max_band_metrics: number
  max_grid_side: number
  icons: string[]
}

// ── Derrière le menu, ou dans le défilement ─────────────────────────────────
//
// Une page marquée `menu` ne passe plus sous les yeux à chaque glissé : on va la
// chercher dans le menu d'actions, comme on va chercher « changer d'itinéraire ».
// C'est ce qui rend composable une page qu'on ne lit pas en roulant — un bilan,
// des répartitions — sans encombrer le défilement de qui roule.
//
// Deux règles, recopiées de l'assainisseur (`sanitize_pages`) pour la même raison
// que `maxSpan` : borner ici, c'est empêcher de composer ce que l'enregistrement
// défera sous les yeux de l'utilisateur.

// Cette page peut-elle changer de côté ?
//
// La carte, jamais : c'est le WebView peint au fond de la pile pour toute la
// sortie, pas une page qu'on ouvre et qu'on referme.
//
// Et il doit rester au défilement une page **qui ne soit pas la carte** : c'est
// l'en-tête d'une page de données qui porte le menu, la carte n'en dessine pas.
// Sans elle, ce qu'on aurait rangé ne serait atteignable par aucun geste — le
// serveur le repêcherait (`keep_one_swipeable`), mais l'éditeur aurait entre-temps
// montré une composition qui n'existe pas.
export function canHideBehindMenu(page: Page, pages: Page[]): boolean {
  if (page.kind === 'map') return false
  // La ramener dans le défilement est toujours permis : c'est le sens qui ne
  // peut rien vider.
  if (page.menu) return true

  return pages.some(
    (other) => other !== page && !other.menu && other.kind !== 'map',
  )
}

// Cette page se compose-t-elle en grille — `rows`/`cols`/`cells` — plutôt
// qu'en liste défilante ?
//
// Une page `grid` l'est toujours ; une page `laps` seulement si elle porte
// `layout: 'grid'` (absent vaut liste, le cas d'avant ce réglage — même repli
// que `LapPageLayout.parse` côté Dart). Centralisé ici plutôt que répété à
// chaque endroit de l'éditeur qui doit choisir entre l'éditeur de grille et
// celui de liste : les deux ne doivent jamais se découvrir sur des critères
// différents.
export function isGridLayout(page: Page): boolean {
  return page.kind === 'grid' || (page.kind === 'laps' && page.layout === 'grid')
}

// ── Le profil par défaut d'un type d'itinéraire ─────────────────────────────
//
// Utilisé par CompanionNavigateModal pour présélectionner le bon profil quand
// on lance une navigation depuis un itinéraire dont on connaît le type — sinon
// le premier profil de la liste, comme l'appli retombe sur `presets.first`
// quand aucune clé n'est choisie (`CompanionSettings.select`, dépôt voisin).
export function defaultPresetKey(
  presets: { key?: string; default_for?: string[] }[],
  activity?: string | null,
): string | undefined {
  if (activity) {
    const match = presets.find((p) => p.default_for?.includes(activity))
    if (match?.key) return match.key
  }
  return presets[0]?.key
}

// ── Choisir un composant ────────────────────────────────────────────────────
//
// Le catalogue dit « ce genre accepte ces modes » ; la dialogue de choix, elle,
// montre **une vignette par façon de dessiner** — c'est le mode qui décide du
// dessin, pas le genre. D'où ce dépliage : une entrée par couple genre × mode,
// dans l'ordre du catalogue (le premier mode d'un genre est son mode par défaut,
// celui sur lequel l'appli retombe).
export interface BlockChoice {
  kind: string
  mode?: string
}

export function blockChoices(catalog: Catalog): BlockChoice[] {
  return Object.entries(catalog.blocks).flatMap(([kind, modes]) =>
    // La case vide n'a aucun mode : une entrée quand même, sinon le seul moyen
    // de dire « je ne mets rien ici » disparaîtrait de la dialogue.
    modes.length === 0 ? [{ kind }] : modes.map((mode) => ({ kind, mode })),
  )
}

// Le composant que fabrique un choix, **avec les seules clés que son genre
// réclame**.
//
// C'est ici que se joue la règle de l'éditeur : on ne compose pas ce que
// l'assainisseur jettera. Garder `metric` sur un bloc devenu `zones` laisserait
// une clé morte dans le document, que le serveur retirerait — donc une
// différence entre ce qu'on voit et ce qui part.
export function blockFor(
  choice: BlockChoice,
  params: {
    metric?: string; source?: string; series?: string; format?: string; min?: number; max?: number
    layout?: MetricLayout; icon?: string; gaugeKind?: string
    color?: string | null; textColor?: string | null
  },
): Block {
  const block: Block = { kind: choice.kind }
  if (choice.mode) block.mode = choice.mode
  if (choice.kind === 'metric') block.metric = params.metric
  if (choice.kind === 'metric' && isDurationMetric(params.metric)) block.format = params.format || 'hm'
  if (choice.kind === 'metric') block.layout = params.layout || DEFAULT_METRIC_LAYOUT
  if (choice.kind === 'metric' && params.icon) block.icon = params.icon
  // Seulement quand la jauge est effectivement posée, et seulement sur une
  // plage réglée dans l'éditeur — la dynamique se lit dans la sortie en
  // cours, poser min/max dessus laisserait une clé morte que l'assainisseur
  // retirerait.
  if (choice.kind === 'metric' && params.layout?.gauge) {
    if (params.gaugeKind) block.gauge_kind = params.gaugeKind
    if (params.gaugeKind !== 'dynamic' && isRangeGaugeMetric(params.metric)) {
      block.min = params.min
      block.max = params.max
    }
  }
  if (choice.kind === 'zones' || choice.kind === 'lap_zones') block.source = params.source
  if (choice.kind === 'mark_lap') block.series = params.series || 'default'
  // Contrairement à `metric`/`source`, valent pour n'importe quel genre : le
  // réglage se fait une fois dans la dialogue, pas par groupe.
  if (params.color) block.color = params.color
  if (params.textColor) block.text_color = params.textColor
  return block
}

// Ce choix est-il celui du composant en cours d'édition ? Sert au liseré de la
// vignette. Le paramètre (mesure, source) n'entre pas dans la comparaison : il
// se règle dans la dialogue, à part, et vaut pour toutes les vignettes du genre.
export function isChoiceOf(block: Block | null, choice: BlockChoice): boolean {
  if (!block) return false
  return block.kind === choice.kind && (block.mode || undefined) === choice.mode
}

// ── Ce que le téléphone dessinera, et à quelle échelle ──────────────────────
//
// Un profil décrit sa grille en lignes et en colonnes, jamais en pixels : c'est
// le téléphone qui sait ce que ça fait. **Le mode choisi est un ordre, pas un
// plafond** : icône, unité, légende des zones, contexte du budget de charge sont
// toujours dessinés, quelle que soit la case — c'est `ScaleToFit` (dépôt voisin,
// `block_card.dart`) qui réduit la carte entière pour qu'elle y tienne, plutôt
// que de retirer un de ses éléments.
//
// Ici, `previewScale` en est le pendant : au lieu d'un plafond en quatre paliers
// (`BLOCK_METRICS`, aujourd'hui disparu), une échelle continue, calculée comme
// `ScaleToFit` calcule la sienne — le rapport entre la case réelle et une taille
// de référence, jamais agrandi au-delà de 1. Plus de table de seuils à garder
// synchronisée entre les deux dépôts : l'aperçu mesure sa propre case, comme le
// téléphone mesure la sienne.
//
// La géométrie de repli : un téléphone ordinaire (360 × 800 px logiques), une
// fois retirés la barre système, le bandeau du bas, l'en-tête de la page et les
// marges. **Recopiée dans `CompanionViewport::DEFAULT`.**
//
// Elle ne sert que tant que l'appli n'a rien dit. Dès qu'elle a posé une page de
// grille, elle renvoie ce qu'elle a **mesuré** (`/api/companion_settings?grid=`),
// le site le retient, et l'éditeur travaille sur le vrai téléphone.
export const PHONE_GRID = { width: 328, height: 598 }

// La gouttière entre deux cases, en dur des deux côtés (`gridRectFor`). Elle ne
// dépend pas de l'écran : c'est une valeur de dessin, pas une mesure.
export const GRID_GAP = 8

export interface Viewport {
  width: number
  height: number
}

export interface CellSize {
  width: number
  height: number
}

// La place qu'une cellule prendra sur le téléphone. Même calcul que `gridRectFor`
// côté appli, fusions comprises : la gouttière intérieure d'une cellule fusionnée
// lui revient.
//
// [grid] est la grille de *ce* téléphone quand il l'a dite, celle du téléphone
// ordinaire sinon. Passée en argument et non lue d'une variable de module : les
// aperçus se dessinent avant que les props n'arrivent, et un état global qui
// change sous les pieds d'un `computed` est le meilleur moyen d'afficher une
// échelle et d'en calculer une autre.
export function phoneCell(
  rows: number,
  cols: number,
  rowSpan = 1,
  colSpan = 1,
  grid: Viewport = PHONE_GRID,
): CellSize {
  const cellWidth = (grid.width - GRID_GAP * (cols - 1)) / cols
  const cellHeight = (grid.height - GRID_GAP * (rows - 1)) / rows

  return {
    width: cellWidth * colSpan + GRID_GAP * (colSpan - 1),
    height: cellHeight * rowSpan + GRID_GAP * (rowSpan - 1),
  }
}

// La ligne de texte, en pixels du téléphone, à laquelle un composant se dessine
// **avant** mise à l'échelle — la même valeur que `BlockMetrics.natural.lineSize`
// du dépôt voisin.
export const NATURAL_LINE_SIZE = 16

// La case à laquelle un composant tient à sa taille naturelle, sans être réduit.
// Une seule référence pour tous les genres : l'aperçu est un fac-similé et non un
// rendu partagé (cf. `CompanionBlockPreview`), donc une approximation commune
// suffit là où le dépôt voisin détaille une taille par genre.
const NATURAL_CELL_WIDTH = 220
const NATURAL_CELL_HEIGHT = 180

// Le rapport entre la case réelle et la taille naturelle d'un composant : ce que
// `ScaleToFit` calcule côté appli, en continu et non par palier. **Jamais
// au-delà de 1** — une case généreuse ne grossit pas le contenu, pour ne pas
// afficher un chiffre disproportionné à côté de cases voisines restées à leur
// taille normale.
//
// **Une case absente vaut 1** : c'est une page qui défile, ou la dialogue de
// choix, où le composant prend la hauteur qu'il lui faut et où rien ne peut
// déborder.
export function previewScale(cell?: CellSize): number {
  if (!cell) return 1
  return Math.min(cell.width / NATURAL_CELL_WIDTH, cell.height / NATURAL_CELL_HEIGHT, 1)
}

// Combien de zones le téléphone dessinera. Le site connaît les seuils du
// cycliste, mais l'aperçu doit valoir pour le profil qu'il aura le jour de la
// sortie : on prend donc la liste la plus longue de chaque source — sept paliers
// en puissance, cinq en cardio.
export function zoneCount(source?: string): number {
  return source === 'power' ? 7 : 5
}

// ── De quoi dessiner un aperçu ──────────────────────────────────────────────
//
// Ce que la vignette écrit dans la case : une valeur plausible, l'unité, et la
// zone quand la mesure en porte une (c'est elle qui colore l'aplat).
//
// **Les unités ne sont pas traduites, et c'est voulu** : ce sont celles que le
// téléphone écrira, or l'appli est en français et ne connaît que le métrique
// (`MetricId`, dépôt voisin). Une unité traduite ferait un aperçu que l'écran ne
// dessinera jamais.
export interface MetricSample {
  value: string
  // Le nom de la mesure, ex. « Cardio » — même valeur que `MetricId.name`
  // côté appli (français en dur, l'appli ne traduit pas ce document — voir
  // plus bas).
  name: string
  // L'unité physique, ex. « bpm » — vide pour les mesures qui n'en ont pas
  // (une durée, une position de plateau…). Distincte de `name` depuis ce
  // chantier : avant, un seul champ (`unit`) faisait les deux, tantôt un nom
  // tantôt une unité selon la mesure.
  unit: string
  // La clé de zone (`z1`…`z7`), pour les seules mesures qui en portent une :
  // l'appli peint alors l'aplat de la zone du moment sous le chiffre.
  zone?: string
  // Couleur de fond directe, pour les mesures qui ne se rangent pas en zones
  // d'entraînement — la pente, dont la couleur vient de sa tranche de
  // difficulté (`colorForGrade`, mêmes seuils que le profil altimétrique) et
  // non des seuils du cycliste. Mutuellement exclusif avec `zone` : côté
  // appli (`MetricReading.background`, dépôt voisin), aucune mesure n'a
  // besoin des deux.
  background?: string
  // L'icône par défaut de la mesure, transposée de `MetricId.icon` en
  // FontAwesome — remplacée par `block.icon` quand il est réglé.
  icon: string
  // La même valeur que `value`, non mise en forme — seulement pour les mesures
  // de `RANGE_GAUGE_METRICS`, où la jauge à plage libre en a besoin pour situer
  // le chiffre entre `min` et `max` (`value` porte une unité ou une virgule
  // française, inutilisables pour une position).
  numeric?: number
}

// **Les noms et unités ne sont pas traduits, et c'est voulu** : ce sont ceux
// que le téléphone écrira, or l'appli est en français et ne connaît pas
// d'i18n (`MetricId.name`/`MetricId.unit`, dépôt voisin) — un nom traduit
// ferait un aperçu que l'écran ne dessinera jamais. Mêmes chaînes des deux
// côtés, à tenir synchronisées à la main.
const METRIC_SAMPLES: Record<string, MetricSample> = {
  duration: { value: '01:12', name: 'Durée', unit: '', icon: 'fa-regular fa-clock' },
  moving_time: { value: '01:08', name: 'Temps en mouvement', unit: '', icon: 'fa-solid fa-person-biking' },
  pause_time: { value: '00:04', name: 'Durée pause', unit: '', icon: 'fa-regular fa-circle-pause' },
  // `unit` vide : côté appli, `read()` écrit déjà l'unité dans la valeur
  // elle-même (`formatDistanceKm`/`'${…} m'`) pour ces quatre mesures — un
  // jeton `unit` séparé la redirait en double plutôt que de la compléter,
  // comme `sample.value` le montre déjà ici.
  distance: { value: '38,42 km', name: 'Distance', unit: '', icon: 'fa-solid fa-ruler-horizontal', numeric: 38.42 },
  speed: { value: '32', name: 'Vitesse', unit: 'km/h', icon: 'fa-solid fa-gauge-high', numeric: 32 },
  speed_avg: { value: '27', name: 'Vitesse moyenne', unit: 'km/h', icon: 'fa-solid fa-gauge-high', numeric: 27 },
  speed_max: { value: '61', name: 'Vitesse max', unit: 'km/h', icon: 'fa-solid fa-gauge-high', numeric: 61 },
  heart_rate: { value: '154', name: 'Cardio', unit: 'bpm', zone: 'z3', icon: 'fa-solid fa-heart' },
  hr_zone: { value: 'Z3', name: 'Zone cardio', unit: 'bpm', zone: 'z3', icon: 'fa-solid fa-heart' },
  hr_avg: { value: '141', name: 'Cardio moyen', unit: 'bpm', icon: 'fa-regular fa-heart', numeric: 141 },
  hr_max: { value: '178', name: 'Cardio max', unit: 'bpm', icon: 'fa-regular fa-heart', numeric: 178 },
  power: { value: '248', name: 'Puissance', unit: 'W', zone: 'z3', icon: 'fa-solid fa-bolt' },
  power_zone: { value: 'Z3', name: 'Zone de puissance', unit: 'W', zone: 'z3', icon: 'fa-solid fa-bolt' },
  power_avg: { value: '212', name: 'Puissance moyenne', unit: 'W', icon: 'fa-solid fa-bolt', numeric: 212 },
  power_np: { value: '236', name: 'Puissance normalisée', unit: 'W', icon: 'fa-solid fa-bolt', numeric: 236 },
  power_max: { value: '744', name: 'Puissance max', unit: 'W', icon: 'fa-solid fa-bolt', numeric: 744 },
  cadence: { value: '88', name: 'Cadence', unit: 'tr/min', icon: 'fa-solid fa-rotate', numeric: 88 },
  cadence_avg: { value: '84', name: 'Cadence moyenne', unit: 'tr/min', icon: 'fa-solid fa-rotate', numeric: 84 },
  cadence_max: { value: '112', name: 'Cadence max', unit: 'tr/min', icon: 'fa-solid fa-rotate', numeric: 112 },
  ascent: { value: '640 m', name: 'Dénivelé positif', unit: '', icon: 'fa-solid fa-arrow-trend-up', numeric: 640 },
  altitude: { value: '1204', name: 'Altitude', unit: 'm', icon: 'fa-solid fa-mountain', numeric: 1204 },
  grade: {
    value: '7', name: 'Pente', unit: '%', background: colorForGrade(7), icon: 'fa-solid fa-arrow-up-right-dots',
    numeric: 7,
  },
  grade_avg: {
    value: '5', name: 'Pente moyenne', unit: '%', background: colorForGrade(5),
    icon: 'fa-solid fa-arrow-up-right-dots', numeric: 5,
  },
  grade_max: {
    value: '14', name: 'Pente max', unit: '%', background: colorForGrade(14),
    icon: 'fa-solid fa-arrow-up-right-dots', numeric: 14,
  },
  calories: { value: '612', name: 'Calories', unit: 'kcal', icon: 'fa-solid fa-fire', numeric: 612 },
  calories_per_hour: {
    value: '510', name: 'Calories par heure', unit: 'kcal/h', icon: 'fa-solid fa-fire', numeric: 510,
  },
  tss: { value: '54', name: 'TSS', unit: 'TSS', icon: 'fa-solid fa-chart-column', numeric: 54 },
  gears: { value: '50×15', name: 'Braquet', unit: '', icon: 'fa-solid fa-gear' },
  chainring_position: { value: '2', name: 'Plateau', unit: '', icon: 'fa-solid fa-circle-notch', numeric: 2 },
  sprocket_position: { value: '5', name: 'Pignon', unit: '', icon: 'fa-solid fa-record-vinyl', numeric: 5 },
  gear_ratio: { value: '3,3', name: 'Rapport', unit: '', icon: 'fa-solid fa-arrows-left-right', numeric: 3.3 },
  route_remaining: {
    value: '21,40 km', name: 'Distance restante', unit: '', icon: 'fa-regular fa-flag', numeric: 21.4,
  },
  route_remaining_gain: {
    value: '380 m', name: 'D+ restant', unit: '', icon: 'fa-solid fa-arrow-trend-up', numeric: 380,
  },
  route_eta: { value: '00:48', name: 'Temps restant', unit: '', icon: 'fa-regular fa-clock' },
}

// La même vignette en `HH:MM:SS`, pour le réglage de format des mesures de
// durée — uniquement les valeurs, les autres champs (unité, icône, zone) ne
// changent pas avec le format.
const DURATION_SAMPLES_HMS: Record<string, string> = {
  duration: '01:12:47',
  moving_time: '01:08:32',
  pause_time: '00:04:15',
  route_eta: '00:48:20',
}

// Les quatre mesures du bloc « Moyennes », et leurs trois chiffres — les mêmes
// que le dépôt voisin dessine (`AveragesCard`), dans le même ordre : cardio et
// puissance sur la première rangée, cadence et vitesse sur la seconde.
//
// Le minimum de la puissance et celui de la cadence sont à zéro, et ce n'est pas
// un chiffre choisi au hasard : ils portent sur **la même population que la
// moyenne**, zéros compris, donc la première roue libre les y met pour le reste
// de la sortie. La vignette le montre plutôt que de laisser la surprise pour la
// route.
export const AVERAGES_SAMPLE = [
  { name: 'Cardio', unit: 'bpm', avg: '141', min: '96', max: '178' },
  { name: 'Puissance', unit: 'W', avg: '212', min: '0', max: '744' },
  { name: 'Cadence', unit: 'tr/min', avg: '84', min: '0', max: '112' },
  { name: 'Vitesse', unit: 'km/h', avg: '27,4', min: '0,0', max: '61,2' },
]

// Le budget de charge d'une sortie ordinaire, pour la vignette. Les chiffres sont
// plausibles et faux, comme ceux des mesures — mais leurs **proportions** comptent,
// puisque c'est ce que la barre dessine : une sortie en cours qui a déjà dépassé la
// moitié de la cible du jour, une semaine aux trois quarts faite.
//
// `ride` n'est pas dans le document que le site envoie : c'est le TSS que le
// téléphone calcule en roulant et ajoute par-dessus ce qui est déjà enregistré. La
// vignette le montre parce que c'est le segment qui bouge — celui qu'on regarde.
export const BUDGET_SAMPLE = {
  day: { done: 24, ride: 38, target: 85, max: 120 },
  week: { done: 418, planned: 62, target: 620, remaining: 140 },
  form: { tsb: -12, zone: 'productive' },
  risk: { acwr: 1.18, zone: 'optimal' },
}

// Le bilan d'un tour, pour la vignette : cinq lignes, exactement celles que
// dessine `LapSummaryCard` (dépôt voisin) — durée, distance, D+, calories,
// TSS *du tour*, jamais de la sortie entière.
export const LAP_SUMMARY_SAMPLE = [
  { label: 'Durée', value: '00:18' },
  { label: 'Distance', value: '5,2 km' },
  { label: 'D+', value: '142 m' },
  { label: 'Calories', value: '210' },
  { label: 'TSS', value: '24' },
]

// Trois cols plausibles pour la vignette : un déjà grimpé (grisé), un en
// cours (repère plein), un à venir (repère en liseré) — les trois états que
// `climbStatusOf` distingue côté appli (route_climbs.dart).
export const CLIMB_LIST_SAMPLE = [
  { label: 'Col 1', figures: '4,1 km · 260 m D+ · 6 % moy', grade: 6, status: 'done' as const },
  { label: 'Col 2 · Cat. 2', figures: '6,8 km · 480 m D+ · 7 % moy', grade: 7, status: 'current' as const },
  { label: 'Col 3', figures: '2,3 km · 140 m D+ · 6 % moy', grade: 6, status: 'next' as const },
]

// Le tiret et pas un chiffre inventé quand la mesure est inconnue de cette
// version : c'est **exactement** ce que le téléphone affichera d'une mesure
// qu'il ne sait pas lire, et la règle du dépôt voisin — jamais un zéro.
export function metricSample(metric: string | undefined, format?: string): MetricSample {
  const sample = METRIC_SAMPLES[metric || ''] || { value: '—', name: '', unit: '', icon: 'fa-solid fa-question' }
  if (format === 'hms' && metric && metric in DURATION_SAMPLES_HMS) {
    return { ...sample, value: DURATION_SAMPLES_HMS[metric] }
  }
  return sample
}

// ── Le libellé d'une mesure dans une liste déroulante ───────────────────────
//
// Deux listes la proposent — le choix d'un composant (CompanionBlockPicker) et
// le bandeau du bas (CompanionDashboard) — et les deux doivent se lire pareil,
// sinon la même mesure change de nom selon l'endroit où on la choisit.
//
// Le libellé traduit (`companion.settings.metrics.*`) reste seul partout
// ailleurs — vignette, résumé de page : ces raccourcis n'existent que pour une
// option de select, trop étroite pour une phrase complète.

// Les mesures qui viennent du dérailleur électronique : préfixées pour se
// regrouper au même endroit une fois triées par libellé, plutôt que
// dispersées selon leur nom (« Braquet », « Pignon », « Plateau », « Rapport »).
const DI2_METRICS = new Set(['gears', 'chainring_position', 'sprocket_position', 'gear_ratio'])

// Les mesures de durée, seules à proposer le réglage HH:MM / HH:MM:SS dans
// la dialogue de choix — même liste que `CompanionSettings::DURATION_METRICS`
// côté serveur.
const DURATION_METRICS = new Set(['duration', 'moving_time', 'pause_time', 'route_eta'])

export function isDurationMetric(metric: string | undefined): boolean {
  return !!metric && DURATION_METRICS.has(metric)
}

// ── Jauge à plage libre ──────────────────────────────────────────────────────
//
// Le mode `gauge` existait déjà, mais seulement pour une mesure qui porte des
// zones d'entraînement (cardio, puissance) : la plage, ce sont elles, et sans
// elles l'appli retombait sur le chiffre plein cadre plutôt que d'inventer un
// maximum. Ici on laisse justement composer ce maximum — min et max se règlent
// dans la dialogue de choix, pour toute mesure numérique qui n'a pas déjà de
// zones. Exclues : les mesures de durée (déjà un autre réglage, `format`, et
// une plage de temps n'a pas le même sens qu'une plage de chiffre), et
// `gears`, dont la valeur (« 50 × 15 ») n'est pas un nombre unique.
const RANGE_GAUGE_METRICS = new Set([
  'distance', 'speed', 'speed_avg', 'speed_max',
  'hr_avg', 'hr_max', 'power_avg', 'power_np', 'power_max',
  'cadence', 'cadence_avg', 'cadence_max',
  'ascent', 'altitude', 'grade', 'grade_avg', 'grade_max',
  'calories', 'calories_per_hour', 'tss',
  'chainring_position', 'sprocket_position', 'gear_ratio',
  'route_remaining', 'route_remaining_gain',
])

export function isRangeGaugeMetric(metric: string | undefined): boolean {
  return !!metric && RANGE_GAUGE_METRICS.has(metric)
}

// ── Jauge dynamique ──────────────────────────────────────────────────────────
//
// Le pendant de la jauge à plage libre pour une plage qui ne se règle pas dans
// l'éditeur : le min et le max observés depuis le départ de la sortie
// (cadence, cardio, puissance, vitesse, pente), ou la progression vers
// l'itinéraire chargé (distance, durée) — voir `MetricId.liveRangeOf` côté
// appli. D'où l'absence de `min`/`max` sur le bloc : rien à régler ici,
// contrairement à `RANGE_GAUGE_METRICS`.
const DYNAMIC_GAUGE_METRICS = new Set(['cadence', 'heart_rate', 'power', 'speed', 'grade', 'distance', 'duration'])

export function isDynamicGaugeMetric(metric: string | undefined): boolean {
  return !!metric && DYNAMIC_GAUGE_METRICS.has(metric)
}

// La position du curseur dans la vignette : purement illustrative, l'éditeur
// n'a pas de sortie en cours pour en tirer une vraie — même esprit que
// `METRIC_SAMPLES`, qui invente déjà les valeurs affichées.
export const DYNAMIC_GAUGE_PREVIEW_FRACTION: Record<string, number> = {
  cadence: 0.55,
  heart_rate: 0.65,
  power: 0.5,
  speed: 0.6,
  grade: 0.7,
  distance: 0.4,
  duration: 0.3,
}

// Le min/max proposé au premier réglage — un point de départ plausible plutôt
// que des champs vides, ajusté ensuite par qui compose son tableau de bord.
export const METRIC_RANGE_DEFAULTS: Record<string, { min: number; max: number }> = {
  distance: { min: 0, max: 100 },
  speed: { min: 0, max: 60 },
  speed_avg: { min: 0, max: 40 },
  speed_max: { min: 0, max: 80 },
  hr_avg: { min: 40, max: 200 },
  hr_max: { min: 40, max: 200 },
  power_avg: { min: 0, max: 400 },
  power_np: { min: 0, max: 400 },
  power_max: { min: 0, max: 1000 },
  cadence: { min: 0, max: 120 },
  cadence_avg: { min: 0, max: 120 },
  cadence_max: { min: 0, max: 150 },
  ascent: { min: 0, max: 2000 },
  altitude: { min: 0, max: 3000 },
  grade: { min: -15, max: 15 },
  grade_avg: { min: -10, max: 10 },
  grade_max: { min: -20, max: 20 },
  calories: { min: 0, max: 3000 },
  calories_per_hour: { min: 0, max: 1000 },
  tss: { min: 0, max: 150 },
  chainring_position: { min: 1, max: 2 },
  sprocket_position: { min: 1, max: 12 },
  gear_ratio: { min: 0.5, max: 5 },
  route_remaining: { min: 0, max: 100 },
  route_remaining_gain: { min: 0, max: 2000 },
}

// Le nombre de paliers de la jauge à plage libre — même dessin que la jauge de
// zones (`gaugeCells`), mais répartis également entre `min` et `max` plutôt
// que sur des seuils réels. Cinq, comme les zones cardio : c'est la jauge la
// plus familière de l'appli.
export const RANGE_GAUGE_SEGMENTS = 5

// Une seule couleur pour tous les paliers allumés : contrairement aux zones,
// une plage libre n'a pas de teinte propre à chaque tranche — juste « on y
// est », donc un accent unique. Le vert-bleu du thème appli
// (`ColorScheme.fromSeed(Colors.teal)`), déjà utilisé pour les boutons
// d'action, mais éclairci pour rester lisible sur les cases éteintes.
export const RANGE_GAUGE_COLOR = '#26A69A'

const METRIC_LABEL_OVERRIDES: Record<string, string> = {
  ascent: 'D+',
  moving_time: 'Durée en mouvement',
  route_eta: 'Durée restante',
}

export function metricDropdownLabel(metric: string, translate: (key: string) => string): string {
  const label = METRIC_LABEL_OVERRIDES[metric] || translate(`companion.settings.metrics.${metric}`)
  return DI2_METRICS.has(metric) ? `Di2 - ${label}` : label
}

// ── Ce que ce composant dessine ──────────────────────────────────────────────
//
// Toutes les branches que prend l'aperçu, rassemblées : purement celles du mode
// demandé — la case ne décide plus de rien ici, elle ne fait plus que mettre le
// résultat à l'échelle (`previewScale`). C'étaient dix `computed` dans la
// vignette, ce qui suffisait tant qu'elle était seule à s'en servir ; la
// dialogue de choix s'en sert aussi maintenant.
export interface BlockShape {
  kind: string
  zonesBar: boolean
  zonesLegend: boolean
  averagesCards: boolean
  lapSummaryCards: boolean
  markLapCompact: boolean
  recordingCompact: boolean
  changeRouteCompact: boolean
  clearRouteCompact: boolean
  routeCompact: boolean
  navFull: boolean
  radarGauge: boolean
  radarCount: boolean
  radarIcons: boolean
  radarCompact: boolean
  budgetWeek: boolean
  climbListFull: boolean
}

export function blockShape(block: Block): BlockShape {
  return {
    kind: block.kind,
    // Le mode dit exactement ce qu'on dessine : `bar` les deux, `bar_only` la
    // barre seule, `legend` la légende seule. `lap_zones`/`lap_averages`
    // dessinent la même chose que `zones`/`averages` — seul le titre change
    // (« ce tour » plutôt que « depuis le départ »), pas la forme.
    zonesBar: (block.kind === 'zones' || block.kind === 'lap_zones') && block.mode !== 'legend',
    zonesLegend: (block.kind === 'zones' || block.kind === 'lap_zones') && block.mode !== 'bar_only',
    averagesCards: (block.kind === 'averages' || block.kind === 'lap_averages') && block.mode !== 'list',
    // Le bilan d'un tour : cinq lignes (durée, distance, D+, calories, TSS),
    // en carte ou en liste — une forme neuve, pas une variante de `averages`.
    lapSummaryCards: block.kind === 'lap_summary' && block.mode !== 'list',
    markLapCompact: block.kind === 'mark_lap' && block.mode === 'compact',
    recordingCompact: block.kind === 'recording' && block.mode === 'compact',
    changeRouteCompact: block.kind === 'change_route' && block.mode === 'compact',
    clearRouteCompact: block.kind === 'clear_route' && block.mode === 'compact',
    routeCompact: block.kind === 'route' && block.mode === 'compact',
    navFull: block.kind === 'nav_state' && block.mode !== 'compact',
    radarGauge: block.kind === 'radar' && block.mode === 'gauge',
    radarCount: block.kind === 'radar' && block.mode === 'count',
    radarIcons: block.kind === 'radar' && block.mode === 'icons',
    radarCompact: block.kind === 'radar' && block.mode === 'compact',
    budgetWeek: block.kind === 'training_budget' && block.mode === 'week',
    // La liste entière, ou une seule ligne (le col en cours / prochain) —
    // même distinction que `navFull` pour `nav_state`.
    climbListFull: block.kind === 'climb_list' && block.mode !== 'compact',
  }
}

// Ce qu'on garde d'un champ « lignes », « colonnes » ou « sur X lignes » : un
// entier d'au moins 1. Le plafond, lui, dépend de l'appelant (le catalogue pour
// une grille, la place libre pour une étendue).
//
// **Un champ vide vaut 1 et jamais 0** : `Number('')` rend 0, et une grille de
// zéro ligne perdrait toutes ses cellules d'un coup (`fitCells` ne garde pas une
// origine hors grille). C'est ce qui arrivait au doigt, où l'on efface avant de
// retaper.
export function gridSideOf(raw: string): number {
  return Math.max(Math.round(Number(raw)) || 1, 1)
}

// Les cases occupées par une cellule, en coordonnées « ligne:colonne ».
function covered(cell: Cell): string[] {
  const keys: string[] = []
  for (let r = cell.row; r < cell.row + cell.row_span; r++) {
    for (let c = cell.col; c < cell.col + cell.col_span; c++) keys.push(`${r}:${c}`)
  }
  return keys
}

// Quelle cellule occupe chaque case, pour dessiner la grille et savoir où l'on
// peut encore poser quelque chose.
export function occupancy(cells: Cell[]): Map<string, Cell> {
  const map = new Map<string, Cell>()
  cells.forEach((cell) => covered(cell).forEach((key) => map.set(key, cell)))
  return map
}

// Jusqu'où [cell] peut s'étendre sans mordre sur une voisine ni sortir de la
// grille. On ignore la cellule elle-même : elle a le droit d'occuper sa propre
// place.
export function maxSpan(
  cell: Cell,
  cells: Cell[],
  rows: number,
  cols: number,
  axis: 'row' | 'col',
): number {
  const others = cells.filter((other) => other !== cell)
  const busy = occupancy(others)
  const limit = axis === 'row' ? rows - cell.row : cols - cell.col

  for (let span = 1; span <= limit; span++) {
    const probe: Cell = {
      ...cell,
      row_span: axis === 'row' ? span : cell.row_span,
      col_span: axis === 'col' ? span : cell.col_span,
    }
    if (covered(probe).some((key) => busy.has(key))) return span - 1
  }
  return limit
}

// [cell] peut-elle se déplacer de [drow]/[dcol] sans sortir de la grille ni
// mordre sur une voisine ? Même principe que `maxSpan` — la cellule ne compte
// pas comme un obstacle pour elle-même — mais on teste ici une case d'arrivée
// entière plutôt qu'une étendue croissante.
export function canMoveCell(
  cell: Cell,
  cells: Cell[],
  rows: number,
  cols: number,
  drow: number,
  dcol: number,
): boolean {
  const row = cell.row + drow
  const col = cell.col + dcol
  if (row < 0 || col < 0 || row + cell.row_span > rows || col + cell.col_span > cols) {
    return false
  }
  const busy = occupancy(cells.filter((other) => other !== cell))
  return !covered({ ...cell, row, col }).some((key) => busy.has(key))
}

// Échange le composant posé dans [a] avec celui posé dans [b] — position et
// étendue de chacune restent les leurs, c'est le contenu qui change de case.
//
// C'est délibéré, et pas seulement plus simple : permuter aussi la position
// et l'étendue serait indiscernable d'un no-op une fois rendu, puisque la
// grille n'affiche que des couples (position, étendue, composant), jamais
// l'identité de l'objet qui les porte — échanger les trois à la fois entre
// deux cellules revient donc à ne rien changer à ce qui s'affiche (constaté
// en pratique : le bug qui a motivé cette réécriture).
//
// Un composant échangé dans une case plus grande ou plus petite que la
// sienne s'y affiche donc à cette taille-là, jamais à la sienne — sans
// aucune vérification à faire, la case existait déjà valablement avant
// l'échange.
export function swapCells(a: Cell, b: Cell): void {
  const block = a.block
  a.block = b.block
  b.block = block
}

// Les cellules qui tiennent encore dans une grille de [rows] × [cols].
//
// Appelé quand on réduit la grille. Les étendues sont **rognées** — réduire une
// grille ne doit pas faire disparaître ce qu'on y avait posé — mais une cellule
// dont l'origine sort est perdue, faute d'endroit raisonnable où la remettre.
// Même arbitrage que l'assainisseur, pour que l'écran et l'enregistrement disent
// la même chose.
export function fitCells(cells: Cell[], rows: number, cols: number): Cell[] {
  return cells
    .filter((cell) => cell.row < rows && cell.col < cols)
    .map((cell) => ({
      ...cell,
      row_span: Math.min(cell.row_span, rows - cell.row),
      col_span: Math.min(cell.col_span, cols - cell.col),
    }))
}
