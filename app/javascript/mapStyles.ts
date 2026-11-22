import coverageJson from './styleCoverage.json'

export type MapStyleGroup = 'world' | 'swiss' | 'france' | 'austria' | 'germany'

export interface MapStyle {
  id: string
  icon: string
  group: MapStyleGroup
}

// Ordre d'affichage = ordre de ce tableau ; les en-têtes du dropdown suivent l'ordre
// d'apparition des groupes (voir MAP_STYLE_GROUPS).
export const MAP_STYLES: MapStyle[] = [
  { id: 'cyclosm',    icon: 'fa-bicycle',          group: 'world' },
  { id: 'topo',       icon: 'fa-mountain-sun',     group: 'world' },
  { id: 'liberty',    icon: 'fa-map',              group: 'world' },
  { id: 'detopplus',  icon: 'fa-mountain-sun',     group: 'world' },
  { id: 'swissgrau',  icon: 'fa-circle-half-stroke', group: 'swiss' },
  { id: 'swisstopo',  icon: 'fa-flag-checkered',   group: 'swiss' },
  { id: 'swissimage', icon: 'fa-satellite',        group: 'swiss' },
  { id: 'ignplan',    icon: 'fa-map-location-dot', group: 'france' },
  { id: 'ignortho',   icon: 'fa-satellite',        group: 'france' },
  { id: 'atbasemap',  icon: 'fa-map',              group: 'austria' },
  { id: 'atgrau',     icon: 'fa-circle-half-stroke', group: 'austria' },
  { id: 'atortho',    icon: 'fa-satellite',        group: 'austria' },
  { id: 'debasemap',  icon: 'fa-map',              group: 'germany' },
  { id: 'degrau',     icon: 'fa-circle-half-stroke', group: 'germany' },
]

// Emoji de chaque groupe, pour préfixer les choix là où les en-têtes <optgroup> ne se
// voient pas une fois l'option sélectionnée (fonds de secours du profil).
export const MAP_STYLE_GROUP_FLAG: Record<MapStyleGroup, string> = {
  world: '🌍', swiss: '🇨🇭', france: '🇫🇷', austria: '🇦🇹', germany: '🇩🇪',
}

// Ordre des en-têtes de groupe dans le dropdown.
export const MAP_STYLE_GROUPS: MapStyleGroup[] = ['world', 'swiss', 'france', 'austria', 'germany']

// ─── Couverture géographique approximative des groupes régionaux ─────────────
// Bbox large [minLng, minLat, maxLng, maxLat], pas les frontières réelles — sert
// uniquement à avertir que le fond sélectionné risque de s'afficher vide sur le
// tracé courant (cf. RouteBuilder.vue, notice « style_coverage »). `world` n'a pas
// d'entrée : couverture mondiale, jamais d'avertissement.
//
// Un seul rectangle par pays échoue près de la frontière franco-suisse : elle n'est pas
// verticale, donc tout `maxLng` assez large pour couvrir la Haute-Savoie (Chamonix,
// 6.87°) engloutit aussi le Plateau suisse (Sion 7.36°, Berne 7.45°, jusqu'à Zurich
// 8.54°) — vérifié en direct, Sion ressortait « couvert » par le fond France. La France
// prend donc deux rectangles disjoints en longitude : le gros du pays à l'ouest, la
// bande alsacienne (Mulhouse/Colmar/Strasbourg) séparée au nord-est, sans qu'aucun des
// deux n'ait besoin d'atteindre la Suisse. Genève/Lausanne (juste à l'ouest d'Annecy/
// Chamonix, presque à la même longitude) restent un angle mort assumé : aucun rectangle
// ne peut les distinguer de leur voisin français sans couper aussi la vraie frontière.
export const MAP_STYLE_GROUP_BBOX: Partial<Record<MapStyleGroup, [number, number, number, number][]>> = {
  swiss: [[5.9, 45.75, 10.55, 47.95]],
  france: [
    [-5.2, 41.2, 7.1, 51.2],   // le pays, hors bande alsacienne (voir ci-dessous)
    [6.7, 47.55, 8.3, 49.2],   // Alsace : au nord-est du rectangle principal
  ],
  austria: [[9.4, 46.3, 17.3, 49.1]],
  germany: [[5.8, 47.2, 15.1, 55.1]],
}

// Portions suisses de la bbox France (angle mort ci-dessus) : polygone grossier de la
// frontière de Genève au Jura (lng, lat). Un point dedans n'est PAS couvert par le fond
// France — c'est là que le plan IGN reste lisible à bas zoom (tuiles voisines) puis se vide
// en zoomant, sans que la bbox rectangulaire ne le signale.
const FRANCE_EXCLUDED_POLYGONS: [number, number][][] = [[
  [5.95, 46.12], [6.10, 46.38], [6.30, 46.62], [6.45, 46.85], [6.75, 47.08],
  [6.95, 47.30], [7.10, 47.35], [7.10, 45.95], [6.88, 46.05], [6.80, 46.20],
  [6.82, 46.38], [6.50, 46.44], [6.25, 46.30],
]]

// Contour grossier de la Suisse (lng, lat), marge comprise : la bbox rectangulaire
// engloutissait la Haute-Savoie, le pays de Gex, le Doubs, le Haut-Rhin, le sud de
// l'Allemagne et la Lombardie — swisstopo y reste lisible à bas zoom puis se vide.
// Le tracé ouest reprend la frontière de FRANCE_EXCLUDED_POLYGONS.
const SWISS_OUTLINE: [number, number][] = [
  [5.95, 46.12], [6.10, 46.38], [6.30, 46.62], [6.45, 46.85], [6.75, 47.08],
  [6.95, 47.30], [7.05, 47.52], [7.60, 47.62], [8.40, 47.68], [8.65, 47.82],
  [9.20, 47.72], [9.55, 47.55], [9.60, 47.20], [9.65, 46.90], [10.10, 46.85],
  [10.55, 46.95], [10.55, 46.55], [10.20, 46.20], [9.40, 46.30], [9.20, 45.80],
  [8.70, 45.90], [8.40, 46.10], [7.70, 45.90], [7.10, 45.85], [6.88, 46.05],
  [6.80, 46.20], [6.82, 46.38], [6.50, 46.44], [6.25, 46.30],
  [6.28, 46.17], [6.15, 46.12], // canton de Genève : sans ces deux points l'arête coupait la ville
]

function pointInPolygon(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function groupForStyle(id: string): MapStyleGroup | undefined {
  return MAP_STYLES.find((s) => s.id === id)?.group ?? MAP_STYLE_COMBOS.find((c) => c.id === id)?.group
}

function pointInBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat
}

function pointInAnyBbox(lng: number, lat: number, bboxes: [number, number, number, number][]): boolean {
  return bboxes.some((bbox) => pointInBbox(lng, lat, bbox))
}

// En dessous de ce zoom, les trois services (WMTS geo.admin.ch, Géoplateforme IGN,
// basemap.at) servent quand même des tuiles hors de leur pays — vérifié en direct : à
// Paris, `swisstopo` reste servi jusqu'à z6 et `basemap.at` jusqu'à z4 ; à Vienne, le plan
// IGN reste servi jusqu'à z8. Comparer à une bbox fixe en dessous de ce seuil déclenche
// donc un faux positif (l'avertissement apparaît alors que rien n'est réellement vide à
// l'écran) — la marge dépend en plus de la distance à la frontière, donc pas de seuil
// exact possible sans interroger le serveur à chaque geste. z9 reste sous le zoom
// d'édition normal d'un itinéraire (z12+), donc sans effet là où l'avertissement compte
// réellement.
export const COVERAGE_WARN_MIN_ZOOM = 9

// Les fonds qui ont une table de couverture (cf. plus bas) n'ont pas ce problème : elle dit où
// de vraies tuiles existent, pas où le serveur en renvoie par politesse à bas zoom. Ils
// avertissent dès z7 ; en dessous, la vue dépasse le pays (la Suisse entière tient à z5,7 avec la moitié
// de l'Europe autour) et le tiers de points vides déclenchait la notice à tort.
export const PROBED_COVERAGE_WARN_MIN_ZOOM = 7

export function coverageWarnMinZoom(styleId: string): number {
  return hasCoverageTable(styleId) ? PROBED_COVERAGE_WARN_MIN_ZOOM : COVERAGE_WARN_MIN_ZOOM
}

export function styleCoversPoint(styleId: string, lng: number, lat: number): boolean {
  const index = coverageIndexFor(styleId)
  if (index) return coverageMaxZoomAt(index, lng, lat) > 0
  const group = groupForStyle(styleId) as MapStyleGroup
  const bboxes = MAP_STYLE_GROUP_BBOX[group]
  if (!bboxes) return true
  if (group === 'swiss') return pointInPolygon(lng, lat, SWISS_OUTLINE)
  if (group === 'france' && FRANCE_EXCLUDED_POLYGONS.some((poly) => pointInPolygon(lng, lat, poly))) return false
  return pointInAnyBbox(lng, lat, bboxes)
}

const BKG_BASE = 'https://sgx.geodatenzentrum.de'

// ─── Table de couverture précalculée ──────────────────────────────────────────
// `styleCoverage.json` (généré par `script/build-style-coverage.mjs`) dit, pour chaque fond
// régional, où il distribue de vraies tuiles et jusqu'à quel zoom : un quadtree de cellules
// z8 à z11, chacune avec le plus haut zoom qui a du contenu. Mesuré une fois, hors ligne, avec
// des délais et des essais que le navigateur ne peut pas se permettre — plutôt que de sonder
// des tuiles en roulant, avec un résultat qui dépend du temps de réponse du serveur.
// Les fonds mondiaux et ceux absents de la table retombent sur les bbox ci-dessus.
interface CoverageTable { startZoom: number; endZoom: number; styles: Record<string, number[]> }

const COVERAGE = coverageJson as CoverageTable

interface CoverageIndex { cells: Map<number, number>; maxZoom: number }
const COVERAGE_INDEX = new Map<string, CoverageIndex>()
const cellKey = (z: number, x: number, y: number) => (z * 16384 + x) * 16384 + y

function coverageIndexFor(styleId: string): CoverageIndex | null {
  const name = baseStyleId(styleId)
  const cached = COVERAGE_INDEX.get(name)
  if (cached) return cached
  const flat = COVERAGE.styles?.[name]
  if (!flat?.length) return null
  const cells = new Map<number, number>()
  let maxZoom = 0
  for (let i = 0; i < flat.length; i += 4) {
    cells.set(cellKey(flat[i], flat[i + 1], flat[i + 2]), flat[i + 3])
    if (flat[i + 3] > maxZoom) maxZoom = flat[i + 3]
  }
  const index = { cells, maxZoom }
  COVERAGE_INDEX.set(name, index)
  return index
}

function baseStyleId(id: string): string {
  return MAP_STYLE_COMBOS.find((c) => c.id === id)?.style ?? id
}

// Les fonds pour lesquels on a une table (les régionaux). Les autres : bbox, ou mondial.
export function hasCoverageTable(styleId: string): boolean {
  return coverageIndexFor(styleId) !== null
}

// Plus haut zoom servi au point : 0 = rien, null = pas de table pour ce fond.
function coverageMaxZoomAt(index: CoverageIndex, lng: number, lat: number): number {
  const y = Math.min(1, Math.max(0, (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2))
  const x = ((lng + 180) / 360)
  if (x < 0 || x >= 1) return 0
  for (let z = COVERAGE.startZoom; z <= COVERAGE.endZoom; z++) {
    const n = 2 ** z
    const mz = index.cells.get(cellKey(z, Math.floor(x * n), Math.min(n - 1, Math.floor(y * n))))
    if (mz !== undefined) return mz
  }
  return 0
}

// Cellules de la table du fond, en GeoJSON, pour les dessiner sur la carte (couche « couverture »
// du créateur d'itinéraire). `served` : la cellule a des tuiles au niveau que MapLibre va
// demander au zoom courant (même règle que styleUsableForView) ; sinon elle en a, mais pas
// aussi profond. Ce qui n'est pas dans la table n'a aucune tuile : pas de polygone.
export function styleCoverageGeoJSON(styleId: string, zoom: number): { type: 'FeatureCollection'; features: any[] } | null {
  const index = coverageIndexFor(styleId)
  const flat = COVERAGE.styles?.[baseStyleId(styleId)]
  if (!index || !flat) return null
  const need = Math.min(Math.max(Math.round(zoom) + 1, 0), index.maxZoom)
  const lng = (x: number, z: number) => (x / 2 ** z) * 360 - 180
  const lat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI
  const features: any[] = []
  for (let i = 0; i < flat.length; i += 4) {
    const [z, x, y, maxZoom] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]
    const w = lng(x, z), e = lng(x + 1, z), n = lat(y, z), s = lat(y + 1, z)
    features.push({
      type: 'Feature',
      properties: { served: maxZoom >= need, maxZoom },
      geometry: { type: 'Polygon', coordinates: [[[w, n], [e, n], [e, s], [w, s], [w, n]]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

export interface ViewBounds { west: number; south: number; east: number; north: number }

// Part des points échantillonnés sans tuile à partir de laquelle on déclare la vue hors zone :
// une vue à cheval sur la frontière dont la moitié reste lisible n'est pas « hors zone »,
// mais un tiers de blanc se voit.
const COVERAGE_BLANK_SHARE = 1 / 3

// Le fond est-il lisible sous la vue ? Consultation locale de la table, sans requête : on
// échantillonne une grille 3 × 3 de la vue (pas son seul centre : à la frontière, le centre est
// souvent plein alors que le bord de l'écran est blanc) et on exige que chaque point soit servi
// au niveau de tuile que MapLibre va demander. Les sources raster sont en tuiles de 256 px
// (une tuile de 512 px logiques = deux de 256, d'où le +1) et MapLibre ARRONDIT leur niveau :
// à z15.6 il charge du z17. Fond sans table : bbox du groupe, au centre de la vue.
export function styleUsableForView(styleId: string, bounds: ViewBounds, zoom: number): boolean {
  const index = coverageIndexFor(styleId)
  if (!index) return styleCoversPoint(styleId, (bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2)
  const need = Math.min(Math.max(Math.round(zoom) + 1, 0), index.maxZoom)
  let blank = 0
  for (const fx of [0.1, 0.5, 0.9]) {
    for (const fy of [0.1, 0.5, 0.9]) {
      const lng = bounds.west + (bounds.east - bounds.west) * fx
      const lat = bounds.south + (bounds.north - bounds.south) * fy
      if (coverageMaxZoomAt(index, lng, lat) < need) blank++
    }
  }
  return blank / 9 < COVERAGE_BLANK_SHARE
}

// Fond « représentant » de chaque groupe régional, proposé par le bouton de la notice
// « fond hors zone » (RouteBuilder.vue) — un par pays plutôt que tous les combiner, pour
// un geste à un seul choix. `cyclosm` (groupe Monde) sert de repli quand la vue ne tombe
// dans aucune bbox connue.
export const MAP_STYLE_GROUP_DEFAULT: Partial<Record<MapStyleGroup, string>> = {
  swiss:   'swisstopo',
  france:  'ignplan',
  austria: 'atbasemap',
  germany: 'debasemap',
}
export const DEFAULT_WORLD_STYLE = 'cyclosm'

// Groupe dont la bbox contient le centre de la vue courante — repli sur `DEFAULT_WORLD_STYLE`
// si `point` est nul (carte pas encore rendue) ou hors de toute bbox connue.
export function suggestedStyleForPoint(point: { lng: number; lat: number } | null): string {
  if (!point) return DEFAULT_WORLD_STYLE
  const group = (Object.keys(MAP_STYLE_GROUP_BBOX) as MapStyleGroup[])
    .find((g) => styleCoversPoint(MAP_STYLE_GROUP_DEFAULT[g]!, point.lng, point.lat))
  return (group && MAP_STYLE_GROUP_DEFAULT[group]) || DEFAULT_WORLD_STYLE
}

// Fond à proposer pour la vue courante : parmi les fonds « représentants » de chaque pays, celui
// qui sert les tuiles au niveau demandé et va le plus profond sous le centre (à égalité, l'ordre
// de MAP_STYLE_GROUP_DEFAULT). Contrairement à suggestedStyleForPoint, qui ne regarde que la
// présence de tuiles à n'importe quel zoom, tient compte du zoom : à la frontière, swisstopo
// « couvre » un point français mais seulement jusqu'à z16, là où le plan IGN va à z19.
export function suggestedStyleForView(bounds: ViewBounds | null, zoom: number | null): string {
  if (!bounds || zoom === null) return DEFAULT_WORLD_STYLE
  const lng = (bounds.west + bounds.east) / 2, lat = (bounds.south + bounds.north) / 2
  let best: string | null = null
  let bestDepth = -1
  for (const id of Object.values(MAP_STYLE_GROUP_DEFAULT)) {
    if (!id || !styleUsableForView(id, bounds, zoom)) continue
    const index = coverageIndexFor(id)
    const depth = index ? coverageMaxZoomAt(index, lng, lat) : 0
    if (depth > bestDepth) { best = id; bestDepth = depth }
  }
  return best ?? DEFAULT_WORLD_STYLE
}

// ─── Entrées composées du menu « fond de carte » ──────────────────────────────
// Raccourcis « fond + overlay » : leur `id` est virtuel, il n'est jamais persisté —
// l'état réel reste un fond (`default_style`) plus un overlay actif. Rendues à la fin
// de leur groupe, et seulement là où l'appelant sait piloter les overlays (le créateur
// d'itinéraire) : les autres cartes passent `activeOverlays` à null et ne les voient pas.
export interface MapStyleCombo {
  id: string
  style: string   // fond appliqué
  overlay: string // overlay activé en même temps
  icon: string
  group: MapStyleGroup
}

export const MAP_STYLE_COMBOS: MapStyleCombo[] = [
  { id: 'swissimage_paths', style: 'swissimage', overlay: 'paths', icon: 'fa-layer-group', group: 'swiss' },
]

export function mapStyleComboFor(id: string): MapStyleCombo | undefined {
  return MAP_STYLE_COMBOS.find((c) => c.id === id)
}

// Overlays qu'une entrée composée gouverne pour un fond donné : sélectionner « Satellite »
// doit retirer ce que « Satellite + chemins » avait ajouté, sans quoi les deux entrées
// seraient indiscernables.
export function combosOverlaysForStyle(styleId: string): string[] {
  return MAP_STYLE_COMBOS.filter((c) => c.style === styleId).map((c) => c.overlay)
}

// ─── Overlays (couches transparentes superposables) ───────────────────────────
// Couches empilées par-dessus le fond actif quel qu'il soit — utiles surtout sur
// l'imagerie satellite, qui ne porte aucun tracé. Deux familles :
//   - `wmts`   : tuiles PNG transparentes swisstopo/ASTRA (SuisseMobile), Suisse seule
//   - `raster` : tuiles PNG transparentes d'un service tiers à URL libre (Waymarked Trails)
//   - `vector` : tuiles vectorielles OpenFreeMap (OpenMapTiles), couverture mondiale
// Plusieurs peuvent être actives simultanément — cf. le menu « Affichage » de
// RouteBuilderMap. Le groupe ne sert qu'à l'affichage (en-têtes du menu).
export type MapOverlayGroup = 'world' | 'swiss'

export interface MapOverlay {
  id: string
  icon: string
  group: MapOverlayGroup
  kind: 'wmts' | 'vector' | 'raster'
  layer?: string // identifiant de couche WMTS geo.admin.ch (kind: 'wmts')
  url?: string // gabarit d'URL de tuiles {z}/{x}/{y} (kind: 'raster')
  attribution?: string
}

export const MAP_OVERLAYS: MapOverlay[] = [
  { id: 'paths',            icon: 'fa-road',          group: 'world', kind: 'vector' },
  { id: 'labels',           icon: 'fa-font',          group: 'world', kind: 'vector' },
  // Waymarked Trails : itinéraires cyclables balisés d'OpenStreetMap, Europe entière (service
  // bénévole, sans garantie de disponibilité). Tuiles transparentes jusqu'en z18.
  { id: 'waymarked_cycling', icon: 'fa-route', group: 'world', kind: 'raster',
    url: 'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png',
    attribution: '© <a href="https://waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a> | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
  { id: 'veloland',         icon: 'fa-bicycle',       group: 'swiss', kind: 'wmts', layer: 'ch.astra.veloland' },
  { id: 'mountainbikeland', icon: 'fa-person-biking', group: 'swiss', kind: 'wmts', layer: 'ch.astra.mountainbikeland' },
  { id: 'wanderland',       icon: 'fa-person-hiking', group: 'swiss', kind: 'wmts', layer: 'ch.astra.wanderland' },
  { id: 'wanderwege',       icon: 'fa-shoe-prints',   group: 'swiss', kind: 'wmts', layer: 'ch.swisstopo.swisstlm3d-wanderwege' },
]

// Ordre des en-têtes de groupe dans le menu « Affichage ».
export const MAP_OVERLAY_GROUPS: MapOverlayGroup[] = ['world', 'swiss']

export function overlaysInGroup(group: MapOverlayGroup): MapOverlay[] {
  return MAP_OVERLAYS.filter((o) => o.group === group)
}

// Tuiles vectorielles OpenMapTiles servies par OpenFreeMap — la même source que le
// style `liberty`, réutilisée ici en surimpression.
const OPENMAPTILES_URL = 'https://tiles.openfreemap.org/planet'

// MapLibre lit `glyphs` sur le style, pas sur la couche : tout style de fond susceptible
// d'accueillir l'overlay « chemins » (qui porte des libellés) doit le déclarer, sans quoi
// la couche symbole échoue. D'où sa présence dans chaque style maison ci-dessous.
export const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'

const OSM_ATTRIBUTION =
  '© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'

export function overlaySourceId(id: string): string { return `overlay-${id}-src` }
export function overlayLayerId(id: string, suffix = ''): string {
  return suffix ? `overlay-${id}-${suffix}` : `overlay-${id}`
}

// Spec de source MapLibre pour un overlay donné.
export function overlaySource(overlay: MapOverlay): object {
  if (overlay.kind === 'vector') {
    return { type: 'vector', url: OPENMAPTILES_URL, attribution: OSM_ATTRIBUTION }
  }
  if (overlay.kind === 'raster') {
    return { type: 'raster', tiles: [overlay.url], tileSize: 256, maxzoom: 18, attribution: overlay.attribution }
  }
  return {
    type: 'raster',
    tiles: [
      `https://wmts.geo.admin.ch/1.0.0/${overlay.layer}/default/current/3857/{z}/{x}/{y}.png`,
    ],
    tileSize: 256,
    maxzoom: 19,
    attribution:
      '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>',
  }
}

// Couches MapLibre d'un overlay, dans l'ordre de dessin. `spec` est la définition sans
// `id` ni `source` (ajoutés à l'installation) ; `opacityProp` est la propriété de peinture
// que pilote le slider d'opacité — elle dépend du type de couche.
export interface OverlayLayerSpec {
  id: string
  opacityProp: 'raster-opacity' | 'line-opacity' | 'text-opacity'
  spec: Record<string, any>
}

export function overlayLayers(overlay: MapOverlay): OverlayLayerSpec[] {
  if (overlay.id === 'labels') return streetNameLabelLayers(overlay.id)
  if (overlay.kind === 'vector') return pathsOverlayLayers(overlay.id)
  return [{ id: overlayLayerId(overlay.id), opacityProp: 'raster-opacity', spec: { type: 'raster' } }]
}

// ─── Overlay « chemins » (mondial) ────────────────────────────────────────────
// Rendu « hybride » minimal : routes et sentiers en blanc sur un liseré sombre, pour
// rester lisibles sur imagerie satellite sans concurrencer la couleur du tracé. Chemins
// et pistes en tireté, comme sur une carte topographique.

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']
const TRACK_CLASSES = ['track']
const PATH_CLASSES = ['path', 'pedestrian']

// `transportation` contient aussi des polygones (zones piétonnes) : on ne garde que les lignes.
const IS_LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false]
const inClasses = (classes: string[]) => ['all', IS_LINE, ['match', ['get', 'class'], classes, true, false]]

// Épaisseur par classe de voie, interpolée sur le zoom. `extra` élargit chaque palier —
// c'est ainsi qu'on obtient le liseré, `zoom` ne pouvant apparaître que dans un
// `interpolate` de premier niveau (donc pas de `['+', width, 2.5]`).
const widthExpr = (extra = 0) => [
  'interpolate', ['linear'], ['zoom'],
  10, ['match', ['get', 'class'], ['motorway', 'trunk'], 1.6 + extra, ['primary', 'secondary'], 1.1 + extra, 0.5 + extra],
  14, ['match', ['get', 'class'], ['motorway', 'trunk'], 3.5 + extra, ['primary', 'secondary'], 2.6 + extra, ['tertiary', 'minor'], 1.8 + extra, 1.1 + extra],
  18, ['match', ['get', 'class'], ['motorway', 'trunk'], 9 + extra, ['primary', 'secondary'], 7 + extra, ['tertiary', 'minor'], 5 + extra, 3 + extra],
]

// Les tiretés se mesurent en multiples de l'épaisseur du trait : avec un bout arrondi ils
// se rejoignent et le motif disparaît, d'où `line-cap: butt` sur les couches tiretées.
function pathsOverlayLayers(id: string): OverlayLayerSpec[] {
  const line = (
    suffix: string,
    classes: string[],
    paint: Record<string, any>,
    cap: 'round' | 'butt' = 'round',
  ): OverlayLayerSpec => ({
    id: overlayLayerId(id, suffix),
    opacityProp: 'line-opacity',
    spec: {
      type: 'line',
      'source-layer': 'transportation',
      filter: inClasses(classes),
      layout: { 'line-join': 'round', 'line-cap': cap },
      paint,
    },
  })

  return [
    line('casing', [...ROAD_CLASSES, ...TRACK_CLASSES, ...PATH_CLASSES], {
      'line-color': 'rgba(15,15,15,0.55)',
      'line-width': widthExpr(2.5),
    }),
    line('road', ROAD_CLASSES, { 'line-color': '#ffffff', 'line-width': widthExpr() }),
    line('track', TRACK_CLASSES, {
      'line-color': '#ffffff', 'line-width': widthExpr(), 'line-dasharray': [2.5, 1.4],
    }, 'butt'),
    line('path', PATH_CLASSES, {
      'line-color': '#ffffff', 'line-width': widthExpr(), 'line-dasharray': [1.4, 1.2],
    }, 'butt'),
    nameLabelLayer(id),
  ]
}

// Couche symbole des libellés de routes/chemins (transportation_name), en tête de
// `pathsOverlayLayers` — blanc sur liseré sombre comme le tracé qu'elle nomme, pensée
// pour l'imagerie satellite (seul fond où cet overlay s'utilise, via le raccourci
// « Satellite + chemins »).
function nameLabelLayer(id: string): OverlayLayerSpec {
  return {
    id: overlayLayerId(id, 'label'),
    opacityProp: 'text-opacity',
    spec: {
      type: 'symbol',
      'source-layer': 'transportation_name',
      minzoom: 13,
      filter: IS_LINE,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 250,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-max-angle': 30,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.8)',
        'text-halo-width': 1.4,
      },
    },
  }
}

// ─── Overlay « noms des rues » (mondial) ──────────────────────────────────────
// Étagée par classe/zoom comme le fait tout style de fond digne de ce nom (cf. le style
// `liberty`, dont ces paliers sont directement inspirés) : sans ça, motorway et service
// partagent la même densité dès le zoom minimal et le texte sature l'écran. Fond
// sombre/halo clair — l'inverse de `nameLabelLayer` — car ce fond-ci est du texte SEUL,
// posé sur des fonds pour l'essentiel clairs (cyclosm, topo, swissgrau…) : un
// remplissage blanc y serait invisible sans un halo si épais qu'il mange le glyphe
// (lettres qui « pâtent »), surtout sur les voies courbes où les glyphes tournent d'un
// caractère à l'autre et où les halos adjacents se recouvrent.
const LABEL_MAJOR_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']
const LABEL_MINOR_CLASSES = ['minor', 'service', 'track']
const LABEL_PATH_CLASSES = ['path', 'pedestrian']

function streetNameLabelLayers(id: string): OverlayLayerSpec[] {
  const tier = (suffix: string, classes: string[], minzoom: number): OverlayLayerSpec => ({
    id: overlayLayerId(id, `label-${suffix}`),
    opacityProp: 'text-opacity',
    spec: {
      type: 'symbol',
      'source-layer': 'transportation_name',
      minzoom,
      filter: ['all', IS_LINE, ['match', ['get', 'class'], classes, true, false]],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 300,
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 17,
        'text-max-angle': 30,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 0.8,
        'text-halo-blur': 0
      },
    },
  })

  return [
    tier('major', LABEL_MAJOR_CLASSES, 12),
    tier('minor', LABEL_MINOR_CLASSES, 15),
    tier('path', LABEL_PATH_CLASSES, 16),
  ]
}

// Tile metadata used by the image export to render at the finest available detail.
// `maxzoom` = zoom des plus petites tuiles disponibles pour la source ; `tileSize` = taille
// native d'une tuile (256 pour les sources raster, 512 pour le vectoriel OpenFreeMap).
export interface ExportTileInfo { maxzoom: number; tileSize: number }
export const EXPORT_TILE_INFO: Record<string, ExportTileInfo> = {
  cyclosm:    { maxzoom: 18, tileSize: 256 },
  topo:       { maxzoom: 17, tileSize: 256 },
  swisstopo:  { maxzoom: 18, tileSize: 256 },
  swissgrau:  { maxzoom: 18, tileSize: 256 },
  swissimage: { maxzoom: 18, tileSize: 256 },
  liberty:    { maxzoom: 16, tileSize: 512 },
  ignplan:    { maxzoom: 19, tileSize: 256 },
  ignortho:   { maxzoom: 19, tileSize: 256 },
  atbasemap:  { maxzoom: 19, tileSize: 256 },
  atgrau:     { maxzoom: 19, tileSize: 256 },
  atortho:    { maxzoom: 19, tileSize: 256 },
  debasemap:  { maxzoom: 18, tileSize: 256 },
  degrau:     { maxzoom: 18, tileSize: 256 },
  detopplus:  { maxzoom: 18, tileSize: 256 },
}
export function exportTileInfoFor(id: string): ExportTileInfo {
  return EXPORT_TILE_INFO[id] ?? { maxzoom: 17, tileSize: 256 }
}

export const ROUTE_LINE_LAYOUT = { 'line-join': 'round', 'line-cap': 'round' } as const
export const ROUTE_BORDER_PAINT = { 'line-color': 'rgba(0,0,0,0.28)', 'line-width': 12 } as const

export function mapStyleFor(id: string): string | object {
  if (id === 'liberty')    return 'https://tiles.openfreemap.org/styles/liberty'
  if (id === 'topo')       return openTopoMapStyle()
  if (id === 'swisstopo')  return swissTopoStyle()
  if (id === 'swissgrau')  return swissGrauStyle()
  if (id === 'swissimage') return swissImageStyle()
  if (id === 'ignplan')    return ignPlanStyle()
  if (id === 'ignortho')   return ignOrthoStyle()
  if (id === 'atbasemap')  return atBasemapStyle()
  if (id === 'atgrau')     return atGrauStyle()
  if (id === 'atortho')    return atOrthoStyle()
  if (id === 'debasemap')  return bkgRasterStyle('debasemap', 'wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR')
  if (id === 'degrau')     return bkgRasterStyle('degrau', 'wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_grau/default/GLOBAL_WEBMERCATOR')
  if (id === 'detopplus')  return bkgRasterStyle('detopplus', 'wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR')
  return cyclOsmStyle()
}

export function cyclOsmStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'cyclosm-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution:
          '© <a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: 'cyclosm-base',
        type: 'raster',
        source: 'cyclosm-raster',
        // Pulled back so the gradient-coloured route stays the visual focal point.
        paint: { 'raster-saturation': 0.1, 'raster-contrast': -0.1, 'raster-opacity': 0.85 },
      },
    ],
  }
}

export function openTopoMapStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'topo-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution:
          'Map: © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>) · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM',
      },
    },
    layers: [{ id: 'topo-base', type: 'raster', source: 'topo-raster' }],
  }
}

export function swissGrauStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'swissgrau-raster': {
        type: 'raster',
        tiles: [
          'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>',
      },
    },
    layers: [
      {
        id: 'swissgrau-base',
        type: 'raster',
        source: 'swissgrau-raster',
      },
    ],
  }
}

export function swissImageStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'swissimage-raster': {
        type: 'raster',
        tiles: [
          'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>',
      },
    },
    layers: [
      {
        id: 'swissimage-base',
        type: 'raster',
        source: 'swissimage-raster',
      },
    ],
  }
}

export function swissTopoStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'swisstopo-raster': {
        type: 'raster',
        tiles: [
          'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>',
      },
    },
    layers: [
      {
        id: 'swisstopo-base',
        type: 'raster',
        source: 'swisstopo-raster',
        paint: { 'raster-opacity': 0.9 },
      },
    ],
  }
}

// ─── France — Géoplateforme IGN ────────────────────────────────────────────
// data.geopf.fr a remplacé wxs.ign.fr (obsolète depuis janvier 2024) : les couches
// grand public (plan, orthophotos) y sont servies en WMTS sans clé API, contrairement
// à l'ancien service qui exigeait une clé même pour les fonds « découverte ».
const IGN_ATTRIBUTION =
  '© <a href="https://www.geoportail.gouv.fr" target="_blank" rel="noopener">IGN</a>'

export function ignPlanStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'ignplan-raster': {
        type: 'raster',
        tiles: [
          'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: IGN_ATTRIBUTION,
      },
    },
    layers: [{ id: 'ignplan-base', type: 'raster', source: 'ignplan-raster' }],
  }
}

export function ignOrthoStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'ignortho-raster': {
        type: 'raster',
        tiles: [
          'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: IGN_ATTRIBUTION,
      },
    },
    layers: [{ id: 'ignortho-base', type: 'raster', source: 'ignortho-raster' }],
  }
}

// ─── Autriche — basemap.at ─────────────────────────────────────────────────
// Fond officiel autrichien (BEV / Land Austria / Ville de Vienne), gratuit et sans
// clé, licence CC-BY. Vérifié en direct (tuiles servies, 200) — contrairement à la
// carte IGN classique française, pas d'équivalent "SCAN25" gratuit ici non plus ;
// `topo` (OpenTopoMap, groupe Monde) reste la seule couche à courbes de niveau.
//
// Ordre de tuile inversé par rapport aux autres sources de ce fichier : le service
// attend `{TileMatrix}/{TileRow}/{TileCol}`, donc `{z}/{y}/{x}` et non `{z}/{x}/{y}`.
const AT_ATTRIBUTION =
  '© <a href="https://basemap.at" target="_blank" rel="noopener">basemap.at</a>'

function atTileUrl(layer: string, ext: 'png' | 'jpeg'): string {
  return `https://maps.wien.gv.at/basemap/${layer}/normal/google3857/{z}/{y}/{x}.${ext}`
}

export function atBasemapStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'atbasemap-raster': {
        type: 'raster',
        tiles: [atTileUrl('geolandbasemap', 'png')],
        tileSize: 256,
        maxzoom: 19,
        attribution: AT_ATTRIBUTION,
      },
    },
    layers: [{ id: 'atbasemap-base', type: 'raster', source: 'atbasemap-raster' }],
  }
}

export function atGrauStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'atgrau-raster': {
        type: 'raster',
        tiles: [atTileUrl('bmapgrau', 'png')],
        tileSize: 256,
        maxzoom: 19,
        attribution: AT_ATTRIBUTION,
      },
    },
    layers: [{ id: 'atgrau-base', type: 'raster', source: 'atgrau-raster' }],
  }
}

// ─── Allemagne — BKG (basemap.de, TopPlusOpen) ─────────────────────────────
// Géoservices du BKG, libres avec mention de la source. Les tuiles sont en {z}/{y}/{x}.
const BKG_ATTRIBUTION =
  '© GeoBasis-DE / <a href="https://www.bkg.bund.de" target="_blank" rel="noopener">BKG</a>'

function bkgRasterStyle(id: string, path: string): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      [`${id}-raster`]: {
        type: 'raster',
        tiles: [`${BKG_BASE}/${path}/{z}/{y}/{x}.png`],
        tileSize: 256,
        maxzoom: 18,
        attribution: BKG_ATTRIBUTION,
      },
    },
    layers: [{ id: `${id}-base`, type: 'raster', source: `${id}-raster` }],
  }
}

export function atOrthoStyle(): object {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'atortho-raster': {
        type: 'raster',
        tiles: [atTileUrl('bmaporthofoto30cm', 'jpeg')],
        tileSize: 256,
        maxzoom: 19,
        attribution: AT_ATTRIBUTION,
      },
    },
    layers: [{ id: 'atortho-base', type: 'raster', source: 'atortho-raster' }],
  }
}
