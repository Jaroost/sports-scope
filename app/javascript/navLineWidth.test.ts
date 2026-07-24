import { describe, it, expect } from 'vitest'
import { useNavLineWidth, widthRunsCollection, type NavLineWidthConfig } from './navLineWidth'

const CFG: NavLineWidthConfig = { refZoom: 16, minScale: 0.4, maxScale: 2.4, zoomMin: 12, zoomMax: 19 }

// Extrait la largeur associée à un zoom donné dans une expression MapLibre
// ['interpolate', ['linear'], ['zoom'], z0, w0, z1, w1, …].
function valueAt(expr: any[], zoom: number): any {
  const stops = expr.slice(3)
  for (let i = 0; i < stops.length; i += 2) {
    if (stops[i] === zoom) return stops[i + 1]
  }
  return undefined
}

describe('useNavLineWidth / zoomWidthScale', () => {
  const { zoomWidthScale } = useNavLineWidth(CFG)

  it('vaut 1 au zoom de référence', () => {
    expect(zoomWidthScale(16)).toBe(1)
  })

  it('suit une loi base 2 autour de la référence (dans les bornes)', () => {
    expect(zoomWidthScale(17)).toBe(2)     // 2^1
    expect(zoomWidthScale(15)).toBe(0.5)   // 2^-1
  })

  it('clampe en haut à maxScale', () => {
    expect(zoomWidthScale(18)).toBe(2.4)   // 2^2 = 4 → clampé
    expect(zoomWidthScale(22)).toBe(2.4)
  })

  it('clampe en bas à minScale', () => {
    expect(zoomWidthScale(14)).toBe(0.4)   // 2^-2 = 0.25 → clampé
    expect(zoomWidthScale(13)).toBe(0.4)   // 2^-3 = 0.125 → clampé
  })
})

describe('useNavLineWidth / zoomWidthExpr', () => {
  const { zoomWidthExpr } = useNavLineWidth(CFG)

  it("produit une expression interpolate avec un stop par zoom entier de la plage", () => {
    const expr = zoomWidthExpr(4)
    expect(expr[0]).toBe('interpolate')
    expect(expr[1]).toEqual(['linear'])
    expect(expr[2]).toEqual(['zoom'])
    // 8 zooms (12..19) → 8 paires → 3 + 16 = 19 éléments.
    expect(expr).toHaveLength(19)
    expect(valueAt(expr, 12)).toBeDefined()
    expect(valueAt(expr, 19)).toBeDefined()
  })

  it('applique base × échelle (arrondi au centième) à chaque stop', () => {
    const expr = zoomWidthExpr(4)
    expect(valueAt(expr, 16)).toBe(4)      // base × 1
    expect(valueAt(expr, 17)).toBe(8)      // base × 2
    expect(valueAt(expr, 15)).toBe(2)      // base × 0.5
    expect(valueAt(expr, 18)).toBe(9.6)    // base × 2.4 (clampé)
    expect(valueAt(expr, 13)).toBe(1.6)    // base × 0.4 (clampé)
  })

  it('en mode perFeature, multiplie chaque palier par la propriété wscale', () => {
    const expr = zoomWidthExpr(4, true)
    expect(valueAt(expr, 16)).toEqual(['*', 4, ['get', 'wscale']])
    expect(valueAt(expr, 17)).toEqual(['*', 8, ['get', 'wscale']])
  })
})

describe('widthRunsCollection', () => {
  it('renvoie une collection vide pour moins de deux points', () => {
    expect(widthRunsCollection([], [])).toEqual({ type: 'FeatureCollection', features: [] })
    expect(widthRunsCollection([[0, 0]], [1])).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('produit une seule feature quand la largeur est uniforme', () => {
    const coords = [[0, 0], [1, 1], [2, 2]]
    const fc = widthRunsCollection(coords, [1, 1, 1])
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].properties.wscale).toBe(1)
    expect(fc.features[0].geometry.coordinates).toEqual(coords)
  })

  it('découpe à chaque changement de palier, sommet frontière partagé', () => {
    const coords = [[0, 0], [1, 1], [2, 2], [3, 3]]
    const fc = widthRunsCollection(coords, [1, 1, 2, 2])
    expect(fc.features).toHaveLength(2)
    expect(fc.features[0].properties.wscale).toBe(1)
    expect(fc.features[0].geometry.coordinates).toEqual([[0, 0], [1, 1], [2, 2]]) // inclut la frontière
    expect(fc.features[1].properties.wscale).toBe(2)
    expect(fc.features[1].geometry.coordinates).toEqual([[2, 2], [3, 3]])
  })

  it('quantifie les échelles par paliers de 0,05', () => {
    // 1.02 → palier 1.00 ; 1.04 → palier 1.05 → deux runs distincts.
    const fc = widthRunsCollection([[0, 0], [1, 1]], [1.02, 1.04])
    expect(fc.features).toHaveLength(2)
    expect(fc.features[0].properties.wscale).toBeCloseTo(1.0, 10)
    expect(fc.features[1].properties.wscale).toBeCloseTo(1.05, 10)
  })

  it('traite une échelle manquante comme 1', () => {
    const coords = [[0, 0], [1, 1], [2, 2]]
    const fc = widthRunsCollection(coords, [])
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].properties.wscale).toBe(1)
  })
})
