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

export interface Block {
  kind: string
  mode?: string
  metric?: string
  source?: string
}

export interface Cell {
  row: number
  col: number
  row_span: number
  col_span: number
  block: Block
}

export interface Page {
  kind: 'map' | 'grid' | 'list'
  title?: string
  rows?: number
  cols?: number
  cells?: Cell[]
  blocks?: Block[]
  // Rangée derrière le menu d'actions plutôt que dans le défilement. Absent vaut
  // « dans le défilement » — voir `canHideBehindMenu`.
  menu?: boolean
}

export interface Band {
  metrics: string[]
}

export interface Preset {
  key?: string
  name: string
  pages: Page[]
  bands: Band[]
  sensors?: Record<string, boolean>
  radar?: Record<string, number | boolean>
  screen?: Record<string, number>
}

export interface CompanionDocument {
  v?: number
  presets: Preset[]
}

export interface Catalog {
  page_kinds: string[]
  blocks: Record<string, string[]>
  zone_sources: string[]
  metrics: string[]
  sensors: string[]
  max_band_metrics: number
  max_grid_side: number
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
  params: { metric?: string; source?: string },
): Block {
  const block: Block = { kind: choice.kind }
  if (choice.mode) block.mode = choice.mode
  if (choice.kind === 'metric') block.metric = params.metric
  if (choice.kind === 'zones') block.source = params.source
  return block
}

// Ce choix est-il celui du composant en cours d'édition ? Sert au liseré de la
// vignette. Le paramètre (mesure, source) n'entre pas dans la comparaison : il
// se règle dans la dialogue, à part, et vaut pour toutes les vignettes du genre.
export function isChoiceOf(block: Block | null, choice: BlockChoice): boolean {
  if (!block) return false
  return block.kind === choice.kind && (block.mode || undefined) === choice.mode
}

// ── Ce que le téléphone laissera dessiner ───────────────────────────────────
//
// Un profil décrit sa grille en lignes et en colonnes, jamais en pixels : c'est
// le téléphone qui sait ce que ça fait. Les composants s'y dégradent — une
// légende de zones cède la place à sa barre, une unité disparaît, les moyennes
// passent en liste — parce qu'autrement ils débordaient sur la case voisine.
//
// Ce bloc est la **recopie à la main** de `lib/dashboard/block_density.dart` du
// dépôt voisin, comme le sont déjà la palette des zones et le fond des cartes
// dans `CompanionBlockPreview`. Sans lui, l'éditeur montrerait une légende
// complète là où le téléphone n'affichera qu'une barre : on composerait à
// nouveau quelque chose qu'on ne verra jamais. **Quand les seuils bougent
// là-bas, ils bougent ici.**
//
// La géométrie de repli : un téléphone ordinaire (360 × 800 px logiques), une
// fois retirés la barre système, le bandeau du bas, l'en-tête de la page et les
// marges. **Recopiée dans `CompanionViewport::DEFAULT`.**
//
// Elle ne sert que tant que l'appli n'a rien dit. Dès qu'elle a posé une page de
// grille, elle renvoie ce qu'elle a **mesuré** (`/api/companion_settings?grid=`),
// le site le retient, et l'éditeur travaille sur le vrai téléphone — un
// avertissement vrai plutôt que plausible.
export const PHONE_GRID = { width: 328, height: 598 }

// La gouttière entre deux cases, en dur des deux côtés (`gridRectFor`). Elle ne
// dépend pas de l'écran : c'est une valeur de dessin, pas une mesure.
export const GRID_GAP = 8

export interface Viewport {
  width: number
  height: number
}

export type BlockDensity = 'comfortable' | 'normal' | 'tight' | 'minimal'

export interface CellSize {
  width: number
  height: number
}

export interface BlockMetrics {
  padding: number
  gap: number
  titleSize: number
  lineSize: number
  showTitle: boolean
  showUnit: boolean
  showIcon: boolean
}

export const BLOCK_METRICS: Record<BlockDensity, BlockMetrics> = {
  comfortable: { padding: 16, gap: 12, titleSize: 13, lineSize: 16, showTitle: true, showUnit: true, showIcon: true },
  normal: { padding: 12, gap: 8, titleSize: 12, lineSize: 15, showTitle: true, showUnit: true, showIcon: true },
  tight: { padding: 8, gap: 6, titleSize: 11, lineSize: 13, showTitle: true, showUnit: true, showIcon: false },
  minimal: { padding: 6, gap: 4, titleSize: 11, lineSize: 12, showTitle: false, showUnit: false, showIcon: false },
}

const MINIMAL_HEIGHT = 96
const TIGHT_HEIGHT = 148
const NORMAL_HEIGHT = 232
const MINIMAL_WIDTH = 88

// Ce qu'il faut de largeur à une ligne de légende : la pastille, la clé de zone,
// la durée et le pourcentage. En dessous, elle déborde **sur le côté** — l'autre
// façon de sortir de sa case, celle qu'on oublie parce qu'une grille se pense en
// hauteur.
const LEGEND_WIDTH = 150

// La place qu'une cellule prendra sur le téléphone. Même calcul que `gridRectFor`
// côté appli, fusions comprises : la gouttière intérieure d'une cellule fusionnée
// lui revient.
//
// [grid] est la grille de *ce* téléphone quand il l'a dite, celle du téléphone
// ordinaire sinon. Passée en argument et non lue d'une variable de module : les
// aperçus se dessinent avant que les props n'arrivent, et un état global qui
// change sous les pieds d'un `computed` est le meilleur moyen d'afficher une
// densité et d'en calculer une autre.
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

// **Une case absente vaut `comfortable`** : c'est une page qui défile, ou la
// dialogue de choix, où le composant prend la hauteur qu'il lui faut et où rien
// ne peut déborder.
export function densityFor(cell?: CellSize): BlockDensity {
  if (!cell) return 'comfortable'
  if (cell.height < MINIMAL_HEIGHT || cell.width < MINIMAL_WIDTH) return 'minimal'
  if (cell.height < TIGHT_HEIGHT) return 'tight'
  if (cell.height < NORMAL_HEIGHT) return 'normal'
  return 'comfortable'
}

// Combien de zones le téléphone dessinera. Le site connaît les seuils du
// cycliste, mais l'aperçu doit valoir pour le profil qu'il aura le jour de la
// sortie : on prend donc la liste la plus longue de chaque source — sept paliers
// en puissance, cinq en cardio — pour ne jamais promettre une légende que le
// téléphone retirerait.
export function zoneCount(source?: string): number {
  return source === 'power' ? 7 : 5
}

// La légende tient-elle ? **Tout ou rien** : une légende amputée de ses deux
// dernières zones se lit comme une légende complète — on croirait n'avoir jamais
// touché la Z5, ce qui est l'inverse de la vérité.
export function legendFits(
  cell: CellSize | undefined,
  { zones, withBar }: { zones: number; withBar: boolean },
): boolean {
  if (!cell) return true

  const m = BLOCK_METRICS[densityFor(cell)]
  if (cell.width - m.padding * 2 < LEGEND_WIDTH) return false

  let room = cell.height - m.padding * 2
  if (m.showTitle) room -= Math.round(m.titleSize * 1.35) + m.gap
  if (withBar) room -= barHeightFor(cell) + m.gap

  return room >= zones * (Math.round(m.lineSize * 1.35) + 14)
}

function barHeightFor(cell: CellSize): number {
  return { comfortable: 22, normal: 18, tight: 14, minimal: 10 }[densityFor(cell)]
}

// Les quatre cartes des moyennes demandent une pleine hauteur — deux rangées de
// trois lignes — et une pleine largeur : chaque rangée coupe la case en deux, et
// une demi-case étroite ne laisse ni à « Cadence (tr/min) » ni à « Moyen 84 » de
// quoi s'écrire. Sinon, le téléphone les rend en liste.
export function averagesCardsFit(cell?: CellSize): boolean {
  if (!cell) return true
  if (cell.width < 280) return false

  const m = BLOCK_METRICS[densityFor(cell)]
  const card =
    m.padding * 2 + Math.round(m.titleSize * 1.35) + m.gap + 3 * (Math.round(m.lineSize * 1.35) + 4)

  return cell.height >= card * 2 + m.gap
}

// Ce qu'il faut de largeur aux deux pastilles du budget de charge (fraîcheur,
// risque) posées côte à côte : une icône, un chiffre, et la gouttière entre elles.
// En dessous, elles se marchent dessus — la case reste alors au chiffre et à sa
// barre, qui portent l'essentiel.
const BUDGET_CHIPS_WIDTH = 120

// La troisième ligne du budget de charge : les pastilles fraîcheur / risque en mode
// « aujourd'hui », le reste à placer en mode « la semaine ».
//
// Elle se lit **en diagonale** — c'est le contexte du chiffre principal, pas le
// chiffre — donc elle part la première quand la case se resserre, comme la légende
// des zones. Ce qui reste (« 62 / 85 » et sa barre) répond encore à la question
// qu'on se pose au guidon ; une pastille de couleur toute seule, non.
export function budgetContextFits(cell?: CellSize): boolean {
  if (!cell) return true

  const m = BLOCK_METRICS[densityFor(cell)]
  if (cell.width - m.padding * 2 < BUDGET_CHIPS_WIDTH) return false

  let room = cell.height - m.padding * 2
  if (m.showTitle) room -= Math.round(m.titleSize * 1.35) + m.gap
  room -= budgetFigureHeight(m) + m.gap
  room -= barHeightFor(cell) + m.gap

  return room >= Math.round(m.lineSize * 1.35) + 4
}

// La hauteur du « 62 / 85 » : le chiffre du budget, plus gros qu'une ligne
// ordinaire sans aller jusqu'au plein cadre — il se lit d'un coup d'œil, mais il en
// faut deux (le fait et la cible) et une barre en dessous.
//
// Les deux arrondis se suivent dans cet ordre-là parce que le dépôt voisin les fait
// dans cet ordre-là (`budgetFigureSize` puis `budgetFigureHeight`) : arrondir une
// seule fois donne les mêmes quatre valeurs aujourd'hui, et divergerait au premier
// seuil qu'on touche.
export function budgetFigureHeight(m: BlockMetrics): number {
  return Math.round(Math.round(m.lineSize * 1.6) * 1.35)
}

// « Démarrer l'enregistrement » ne tient pas sur la ligne d'un bouton étroit, et
// le libellé ne se tronque pas : un bouton qui déclenche un enregistrement dit
// ce qu'il fait, ou ne dit rien — c'est alors l'icône seule.
export function recordingIsCompact(cell?: CellSize): boolean {
  if (!cell) return false
  const density = densityFor(cell)
  return cell.width < 200 || density === 'tight' || density === 'minimal'
}

// Même seuil que `recordingIsCompact`, pour la même raison : « Changer
// d'itinéraire » et « Retirer l'itinéraire » ne sont, eux aussi, que des
// boutons — un libellé qui ne tient pas devient l'icône seule plutôt que de
// se tronquer.
export function changeRouteIsCompact(cell?: CellSize): boolean {
  return recordingIsCompact(cell)
}

export function clearRouteIsCompact(cell?: CellSize): boolean {
  return recordingIsCompact(cell)
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
  unit: string
  // La clé de zone (`z1`…`z7`), pour les seules mesures qui en portent une :
  // l'appli peint alors l'aplat de la zone du moment sous le chiffre.
  zone?: string
  // L'icône du mode compact, transposée de `MetricId.icon` en FontAwesome.
  icon: string
}

const METRIC_SAMPLES: Record<string, MetricSample> = {
  duration: { value: '1:12:34', unit: 'durée', icon: 'fa-regular fa-clock' },
  moving_time: { value: '1:08:20', unit: 'en mouvement', icon: 'fa-solid fa-person-biking' },
  distance: { value: '38,42 km', unit: 'distance', icon: 'fa-solid fa-ruler-horizontal' },
  speed: { value: '32', unit: 'km/h', icon: 'fa-solid fa-gauge-high' },
  speed_avg: { value: '27', unit: 'km/h moy', icon: 'fa-solid fa-gauge-high' },
  speed_max: { value: '61', unit: 'km/h max', icon: 'fa-solid fa-gauge-high' },
  heart_rate: { value: '154', unit: 'bpm', zone: 'z3', icon: 'fa-solid fa-heart' },
  hr_zone: { value: 'Z3', unit: 'zone bpm', zone: 'z3', icon: 'fa-solid fa-heart' },
  hr_avg: { value: '141', unit: 'bpm moy', icon: 'fa-regular fa-heart' },
  hr_max: { value: '178', unit: 'bpm max', icon: 'fa-regular fa-heart' },
  power: { value: '248', unit: 'W', zone: 'z3', icon: 'fa-solid fa-bolt' },
  power_zone: { value: 'Z3', unit: 'zone W', zone: 'z3', icon: 'fa-solid fa-bolt' },
  power_avg: { value: '212', unit: 'W moy', icon: 'fa-solid fa-bolt' },
  power_np: { value: '236', unit: 'W NP', icon: 'fa-solid fa-bolt' },
  power_max: { value: '744', unit: 'W max', icon: 'fa-solid fa-bolt' },
  cadence: { value: '88', unit: 'tr/min', icon: 'fa-solid fa-rotate' },
  cadence_avg: { value: '84', unit: 'tr/min moy', icon: 'fa-solid fa-rotate' },
  ascent: { value: '640', unit: 'm D+', icon: 'fa-solid fa-arrow-trend-up' },
  altitude: { value: '1204', unit: 'm', icon: 'fa-solid fa-mountain' },
  grade: { value: '7', unit: '% pente', icon: 'fa-solid fa-arrow-up-right-dots' },
  calories: { value: '612', unit: 'kcal', icon: 'fa-solid fa-fire' },
  gears: { value: '50×15', unit: 'braquet', icon: 'fa-solid fa-gear' },
  route_remaining: { value: '21,4 km', unit: 'restant', icon: 'fa-regular fa-flag' },
  route_remaining_gain: { value: '380', unit: 'D+ restant', icon: 'fa-solid fa-arrow-trend-up' },
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

// Le tiret et pas un chiffre inventé quand la mesure est inconnue de cette
// version : c'est **exactement** ce que le téléphone affichera d'une mesure
// qu'il ne sait pas lire, et la règle du dépôt voisin — jamais un zéro.
export function metricSample(metric: string | undefined): MetricSample {
  return METRIC_SAMPLES[metric || ''] || { value: '—', unit: '', icon: 'fa-solid fa-question' }
}

// ── Ce que la case laisse dessiner de ce composant ──────────────────────────
//
// Toutes les branches que prend l'aperçu, rassemblées : le mode demandé, ce que
// la place en laisse. C'étaient dix `computed` dans la vignette, ce qui suffisait
// tant qu'elle était seule à s'en servir.
//
// La dialogue de choix en a besoin pour autre chose : **dire quand deux modes
// donnent le même écran**. Dans une case de six colonnes, « Chiffre plein
// cadre », « Jauge » et « Aplat de zone » dessinent tous les trois le même
// chiffre — le téléphone n'a la place de rien d'autre, et l'aperçu a raison de
// le montrer. Mais trois vignettes identiques sans un mot se lisent comme un
// bogue de l'éditeur, et on repart en cherchant laquelle était la bonne.
//
// Comparer les formes le dit **sans redire** les règles de repli : deux
// composants qui prennent les mêmes branches dessinent la même chose, par
// construction. Une règle qui bouge ne peut donc pas mentir ici.
//
// Les vignettes comparées sont celles d'un même genre, où la mesure et la source
// sont les mêmes — c'est le mode seul qui varie. La forme porte quand même le
// genre, pour qu'une comparaison de travers ne rapproche jamais deux dessins qui
// n'ont rien à voir.
export interface BlockShape {
  kind: string
  density: BlockDensity
  showTitle: boolean
  showUnit: boolean
  showIcon: boolean
  metricGauge: boolean
  metricCompact: boolean
  metricZone: string | null
  zonesBar: boolean
  zonesLegend: boolean
  averagesCards: boolean
  recordingCompact: boolean
  changeRouteCompact: boolean
  clearRouteCompact: boolean
  navFull: boolean
  radarGauge: boolean
  radarVertical: boolean
  budgetWeek: boolean
  budgetContext: boolean
}

export function blockShape(block: Block, cell?: CellSize): BlockShape {
  const density = densityFor(cell)
  const m = BLOCK_METRICS[density]
  const zone = block.kind === 'metric' ? metricSample(block.metric).zone : undefined

  // La légende part la première : une proportion se lit dans une longueur
  // partagée, donc la barre survit à des tailles où le tableau ne se lirait
  // plus. Et si c'est la légende seule qu'on avait demandée, on rend la barre
  // plutôt qu'une carte vide — le doublon se voit et se corrige, la case vide se
  // lit comme une panne.
  const zonesLegend =
    block.kind === 'zones' &&
    block.mode !== 'bar_only' &&
    legendFits(cell, {
      zones: zoneCount(block.source),
      withBar: block.mode !== 'legend',
    })

  return {
    kind: block.kind,
    density,
    showTitle: m.showTitle,
    showUnit: m.showUnit,
    showIcon: m.showIcon,
    // La jauge n'existe que pour une mesure qui a des zones — sans plage, l'appli
    // retombe sur le chiffre plein cadre. Et dans une case minuscule, sept
    // paliers ne se distinguent plus les uns des autres : même repli.
    metricGauge:
      block.kind === 'metric' &&
      block.mode === 'gauge' &&
      !!zone &&
      density !== 'minimal',
    metricCompact: block.kind === 'metric' && block.mode === 'compact',
    // C'est elle qui colore l'aplat, du mode `zone` comme du mode `big` : côté
    // appli, `MetricView` peint le fond dès que la mesure porte une zone.
    metricZone: zone || null,
    zonesBar: block.kind === 'zones' && (block.mode !== 'legend' || !zonesLegend),
    zonesLegend,
    averagesCards:
      block.kind === 'averages' && block.mode !== 'list' && averagesCardsFit(cell),
    recordingCompact:
      block.kind === 'recording' &&
      (block.mode === 'compact' || recordingIsCompact(cell)),
    changeRouteCompact:
      block.kind === 'change_route' &&
      (block.mode === 'compact' || changeRouteIsCompact(cell)),
    clearRouteCompact:
      block.kind === 'clear_route' &&
      (block.mode === 'compact' || clearRouteIsCompact(cell)),
    navFull: block.kind === 'nav_state' && block.mode !== 'compact',
    // Les deux sens de la jauge radar : le dessin est le même, tourné d'un quart
    // de tour.
    radarGauge:
      block.kind === 'radar' && (block.mode === 'gauge' || block.mode === 'gauge_vertical'),
    radarVertical: block.kind === 'radar' && block.mode === 'gauge_vertical',
    budgetWeek: block.kind === 'training_budget' && block.mode === 'week',
    budgetContext: block.kind === 'training_budget' && budgetContextFits(cell),
  }
}

// Deux formes, le même écran. La comparaison est textuelle et c'est sans risque :
// les deux objets sortent de la même fonction, donc dans le même ordre de clés.
export function sameDrawing(a: BlockShape, b: BlockShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
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
