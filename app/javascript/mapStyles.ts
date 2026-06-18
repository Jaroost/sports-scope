export interface MapStyle {
  id: string
  icon: string
}

export const MAP_STYLES: MapStyle[] = [
  { id: 'cyclosm',    icon: 'fa-bicycle' },
  { id: 'topo',       icon: 'fa-mountain-sun' },
  { id: 'swisstopo',  icon: 'fa-flag-checkered' },
  { id: 'swissimage', icon: 'fa-satellite' },
  { id: 'liberty',    icon: 'fa-map' },
]

// Tile metadata used by the image export to render at the finest available detail.
// `maxzoom` = zoom des plus petites tuiles disponibles pour la source ; `tileSize` = taille
// native d'une tuile (256 pour les sources raster, 512 pour le vectoriel OpenFreeMap).
export interface ExportTileInfo { maxzoom: number; tileSize: number }
export const EXPORT_TILE_INFO: Record<string, ExportTileInfo> = {
  cyclosm:    { maxzoom: 18, tileSize: 256 },
  topo:       { maxzoom: 17, tileSize: 256 },
  swisstopo:  { maxzoom: 18, tileSize: 256 },
  swissimage: { maxzoom: 18, tileSize: 256 },
  liberty:    { maxzoom: 16, tileSize: 512 },
}
export function exportTileInfoFor(id: string): ExportTileInfo {
  return EXPORT_TILE_INFO[id] ?? { maxzoom: 17, tileSize: 256 }
}

export const ROUTE_LINE_LAYOUT = { 'line-join': 'round', 'line-cap': 'round' } as const
export const ROUTE_BORDER_PAINT = { 'line-color': 'rgba(0,0,0,0.28)', 'line-width': 8 } as const

export function mapStyleFor(id: string): string | object {
  if (id === 'liberty')    return 'https://tiles.openfreemap.org/styles/liberty'
  if (id === 'topo')       return openTopoMapStyle()
  if (id === 'swisstopo')  return swissTopoStyle()
  if (id === 'swissimage') return swissImageStyle()
  return cyclOsmStyle()
}

export function cyclOsmStyle(): object {
  return {
    version: 8,
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

export function swissImageStyle(): object {
  return {
    version: 8,
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
