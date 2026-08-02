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
  calories: { value: '612', unit: 'kcal', icon: 'fa-solid fa-fire' },
  gears: { value: '50×15', unit: 'braquet', icon: 'fa-solid fa-gear' },
  route_remaining: { value: '21,4 km', unit: 'restant', icon: 'fa-regular fa-flag' },
  route_remaining_gain: { value: '380', unit: 'D+ restant', icon: 'fa-solid fa-arrow-trend-up' },
}

// Le tiret et pas un chiffre inventé quand la mesure est inconnue de cette
// version : c'est **exactement** ce que le téléphone affichera d'une mesure
// qu'il ne sait pas lire, et la règle du dépôt voisin — jamais un zéro.
export function metricSample(metric: string | undefined): MetricSample {
  return METRIC_SAMPLES[metric || ''] || { value: '—', unit: '', icon: 'fa-solid fa-question' }
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
