export interface MapStyle {
  id: string
  icon: string
}

export const MAP_STYLES: MapStyle[] = [
  { id: 'cyclosm', icon: 'fa-bicycle' },
  { id: 'topo',    icon: 'fa-mountain-sun' },
  { id: 'liberty', icon: 'fa-map' },
]

export const ROUTE_LINE_LAYOUT = { 'line-join': 'round', 'line-cap': 'round' } as const
export const ROUTE_BORDER_PAINT = { 'line-color': 'rgba(0,0,0,0.28)', 'line-width': 8 } as const

export function mapStyleFor(id: string): string | object {
  if (id === 'liberty') return 'https://tiles.openfreemap.org/styles/liberty'
  if (id === 'topo') return openTopoMapStyle()
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
