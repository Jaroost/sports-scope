export type MapStyleGroup = 'world' | 'swiss'

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
  { id: 'swissgrau',  icon: 'fa-circle-half-stroke', group: 'swiss' },
  { id: 'swisstopo',  icon: 'fa-flag-checkered',   group: 'swiss' },
  { id: 'swissimage', icon: 'fa-satellite',        group: 'swiss' },
]

// Ordre des en-têtes de groupe dans le dropdown.
export const MAP_STYLE_GROUPS: MapStyleGroup[] = ['world', 'swiss']

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
//   - `vector` : tuiles vectorielles OpenFreeMap (OpenMapTiles), couverture mondiale
// Plusieurs peuvent être actives simultanément — cf. le menu « Affichage » de
// RouteBuilderMap. Le groupe ne sert qu'à l'affichage (en-têtes du menu).
export type MapOverlayGroup = 'world' | 'swiss'

export interface MapOverlay {
  id: string
  icon: string
  group: MapOverlayGroup
  kind: 'wmts' | 'vector'
  layer?: string // identifiant de couche WMTS geo.admin.ch (kind: 'wmts')
}

export const MAP_OVERLAYS: MapOverlay[] = [
  { id: 'paths',            icon: 'fa-road',          group: 'world', kind: 'vector' },
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
    {
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
    },
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
