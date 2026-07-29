import { describe, expect, it } from 'vitest'
import {
  blockPointsAlong, equivalentGeometry, usableWidenLevels, widenRadiusForStep,
  BLOCK_RADIUS_M, WIDEN_STEP_M, WIDEN_LEVELS,
} from './routeAlternatives'
import { haversine } from './routeHelpers'
import type { Coord } from './routeHelpers'

// Placement des disques interdits qui servent à faire ressortir les vraies bifurcations
// (cf. fetchBlockedAlternatives). C'est la seule logique pure du module — le reste appelle
// BRouter. Un disque posé trop près d'une extrémité l'engloberait et rendrait le routage
// impossible : BRouter ne renverrait alors aucune route, et le tronçon paraîtrait à tort
// sans variante.

// Tracé rectiligne d'ouest en est, ~760 m entre sommets à cette latitude.
const line: Coord[] = Array.from({ length: 11 }, (_, i) => [6.0 + i * 0.01, 46.5, 500] as Coord)

describe('blockPointsAlong', () => {
  it('répartit les disques le long du tracé, extrémités exclues', () => {
    const pts = blockPointsAlong(line, 150)

    expect(pts.length).toBe(5)
    for (const p of pts) {
      expect(haversine(p, line[0])).toBeGreaterThan(150)
      expect(haversine(p, line[line.length - 1])).toBeGreaterThan(150)
    }
    // Ordonnés du départ vers l'arrivée.
    const lngs = pts.map((p) => p[0])
    expect([...lngs].sort((a, b) => a - b)).toEqual(lngs)
  })

  it('écarte les positions qu’un grand rayon ferait déborder sur une extrémité', () => {
    const wide = blockPointsAlong(line, 2000)

    expect(wide.length).toBeLessThan(blockPointsAlong(line, 150).length)
    for (const p of wide) {
      expect(haversine(p, line[0])).toBeGreaterThan(2000)
      expect(haversine(p, line[line.length - 1])).toBeGreaterThan(2000)
    }
  })

  it('ne propose rien sur un tronçon plus court que le disque', () => {
    const tiny: Coord[] = [[6.0, 46.5, 500], [6.001, 46.5, 500]]

    expect(blockPointsAlong(tiny, 150)).toEqual([])
  })

  it('ne propose rien sur une géométrie dégénérée', () => {
    expect(blockPointsAlong([], 150)).toEqual([])
    expect(blockPointsAlong([[6.0, 46.5, 500]], 150)).toEqual([])
    // Tous les points confondus : longueur nulle, aucune position à échantillonner.
    expect(blockPointsAlong([[6.0, 46.5, 500], [6.0, 46.5, 500]], 150)).toEqual([])
  })
})

describe('widenRadiusForStep', () => {
  it('part du rayon automatique et ajoute un pas par palier', () => {
    expect(widenRadiusForStep(0)).toBe(BLOCK_RADIUS_M + WIDEN_STEP_M)
    expect(widenRadiusForStep(1)).toBe(BLOCK_RADIUS_M + 2 * WIDEN_STEP_M)
    expect(widenRadiusForStep(WIDEN_LEVELS - 1)).toBe(BLOCK_RADIUS_M + WIDEN_LEVELS * WIDEN_STEP_M)
  })
})

describe('usableWidenLevels', () => {
  // ~7,7 km de tracé : les premiers paliers passent, les plus grands finissent par
  // englober une extrémité où qu'on les pose.
  it('s’arrête au premier palier qui ne peut plus rien bloquer', () => {
    const levels = usableWidenLevels(line)

    expect(levels).toBeGreaterThan(0)
    expect(levels).toBeLessThan(WIDEN_LEVELS)
    for (let step = 0; step < levels; step++) {
      expect(blockPointsAlong(line, widenRadiusForStep(step)).length).toBeGreaterThan(0)
    }
    expect(blockPointsAlong(line, widenRadiusForStep(levels)).length).toBe(0)
  })

  it('offre tous les paliers sur un tronçon assez long', () => {
    const long: Coord[] = Array.from({ length: 101 }, (_, i) => [6.0 + i * 0.01, 46.5, 500] as Coord)

    expect(usableWidenLevels(long)).toBe(WIDEN_LEVELS)
  })

  it('n’en offre aucun sur un tronçon trop court', () => {
    const tiny: Coord[] = [[6.0, 46.5, 500], [6.001, 46.5, 500]]

    expect(usableWidenLevels(tiny)).toBe(0)
  })
})

describe('equivalentGeometry', () => {
  it('reconnaît deux tracés identiques', () => {
    expect(equivalentGeometry(
      { coords: line, distanceM: 7600 },
      { coords: line, distanceM: 7600 },
    )).toBe(true)
  })

  it('sépare deux tracés parallèles de même longueur', () => {
    // Même longueur, mais décalé de ~1,1 km vers le nord : c'est une autre route.
    const shifted = line.map(([lng, lat, ele]) => [lng, lat + 0.01, ele] as Coord)

    expect(equivalentGeometry(
      { coords: line, distanceM: 7600 },
      { coords: shifted, distanceM: 7600 },
    )).toBe(false)
  })

  it('sépare deux tracés de longueurs nettement différentes', () => {
    expect(equivalentGeometry(
      { coords: line, distanceM: 2710 },
      { coords: line, distanceM: 3871 },
    )).toBe(false)
  })
})
