import { describe, expect, it } from 'vitest'
import {
  assignWaypointGeomIndices, waypointPosForEdge, waypointPosForVertex, inheritsFree,
  insertionPasses,
} from './routeInsert'
import type { InsertWaypoint, ScreenPoint } from './routeInsert'
import type { Coord } from './routeHelpers'

// Insertion d'un point dans un itinéraire : à quel sommet de la géométrie routée correspond
// chaque point d'ancrage, et dans quel tronçon tombe un point cliqué. Se tromper ici insère
// le point au mauvais rang et le tracé recalculé fait des allers-retours.

const wp = (lng: number, lat = 46.5, free?: boolean): InsertWaypoint =>
  free === undefined ? { lng, lat } : { lng, lat, free }

// Géométrie rectiligne d'ouest en est, un sommet tous les 0,01°.
const line = (n: number, lat = 46.5): Coord[] =>
  Array.from({ length: n }, (_, i) => [6.0 + i * 0.01, lat, 500] as Coord)

describe('assignWaypointGeomIndices', () => {
  it('affecte chaque point d’ancrage à son sommet, dans l’ordre', () => {
    const geom = line(11)                       // sommets 6.00 … 6.10
    const wps = [wp(6.0), wp(6.05), wp(6.1)]

    expect(assignWaypointGeomIndices(wps, geom)).toEqual([0, 5, 10])
  })

  it('rend des index strictement croissants', () => {
    const geom = line(21)
    const wps = [wp(6.0), wp(6.04), wp(6.08), wp(6.12), wp(6.2)]
    const wgi = assignWaypointGeomIndices(wps, geom)

    for (let i = 1; i < wgi.length; i++) expect(wgi[i]).toBeGreaterThan(wgi[i - 1])
  })

  it('ne colle pas un point du début à la fin d’une boucle', () => {
    // Aller vers l'est puis retour par une ligne 0,0005° au nord : le sommet de FIN est à
    // ~50 m du DÉPART. Un glouton « plus proche voisin » y accrocherait le 1er point
    // d'ancrage, et tout le tracé tomberait dans le premier tronçon.
    const out = line(11)
    const back = line(11, 46.5005).reverse()
    const loop = out.concat(back)
    const wps = [wp(6.0), wp(6.1), wp(6.0, 46.5005)]   // départ, point le plus loin, retour

    const wgi = assignWaypointGeomIndices(wps, loop)

    expect(wgi[0]).toBe(0)                       // le départ reste au départ
    expect(wgi[1]).toBe(10)                      // le point du bout, au bout de l'aller
    expect(wgi[2]).toBe(loop.length - 1)         // le retour, à la fin
  })

  it('gère un aller-retour sur la même trace', () => {
    // Le retour repasse EXACTEMENT sur les mêmes sommets : seul l'ordre permet de trancher.
    const out = line(11)
    const there = out.concat([...out].reverse())
    const wps = [wp(6.0), wp(6.1), wp(6.0)]
    const wgi = assignWaypointGeomIndices(wps, there)

    expect(wgi[0]).toBeLessThan(wgi[1])
    expect(wgi[1]).toBeLessThan(wgi[2])
    expect(wgi[2]).toBe(there.length - 1)
  })

  it('retombe sur un glouton monotone quand les sommets manquent', () => {
    // Cas dégénéré : moins de sommets que de points d'ancrage (routage à peine commencé).
    const geom = line(2)
    const wgi = assignWaypointGeomIndices([wp(6.0), wp(6.005), wp(6.01)], geom)

    expect(wgi).toHaveLength(3)
    for (const idx of wgi) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(geom.length)
    }
  })

  it('renvoie une liste vide sans ancrage ou sans géométrie', () => {
    expect(assignWaypointGeomIndices([], line(5))).toEqual([])
    expect(assignWaypointGeomIndices([wp(6.0)], [])).toEqual([])
  })
})

describe('waypointPosForEdge', () => {
  // Trois ancrages aux sommets 0, 5 et 10 : tronçon 1 = arêtes 0–4, tronçon 2 = arêtes 5–9.
  const wgi = [0, 5, 10]

  it('insère dans le tronçon qui contient l’arête', () => {
    expect(waypointPosForEdge(0, wgi, 3)).toBe(1)
    expect(waypointPosForEdge(4, wgi, 3)).toBe(1)
    expect(waypointPosForEdge(5, wgi, 3)).toBe(2)
    expect(waypointPosForEdge(9, wgi, 3)).toBe(2)
  })

  it('ajoute en fin pour une arête au-delà du dernier ancrage', () => {
    expect(waypointPosForEdge(10, wgi, 3)).toBe(3)
    expect(waypointPosForEdge(99, wgi, 3)).toBe(3)
  })

  it('ajoute en fin quand les index sont désynchronisés du tracé', () => {
    // Après un échec BRouter, les index peuvent ne plus correspondre : on n'invente rien.
    expect(waypointPosForEdge(2, wgi, 4)).toBe(4)
    expect(waypointPosForEdge(2, [], 2)).toBe(2)
  })
})

describe('waypointPosForVertex', () => {
  const wgi = [0, 5, 10]

  it('range un sommet dans son tronçon', () => {
    expect(waypointPosForVertex(2, wgi, 3)).toBe(1)
    expect(waypointPosForVertex(7, wgi, 3)).toBe(2)
  })

  it('attribue une borne partagée au premier tronçon', () => {
    // Le sommet 5 est celui du 2e ancrage : il ferme le tronçon 1 et ouvre le tronçon 2.
    expect(waypointPosForVertex(5, wgi, 3)).toBe(1)
    // Le tout dernier sommet ferme le dernier tronçon (borne inclusive, ≠ arêtes).
    expect(waypointPosForVertex(10, wgi, 3)).toBe(2)
  })

  it('ajoute en fin hors des tronçons', () => {
    expect(waypointPosForVertex(11, wgi, 3)).toBe(3)
    expect(waypointPosForVertex(3, wgi, 5)).toBe(5)
  })
})

describe('inheritsFree', () => {
  it('hérite du tronçon libre, de chaque côté', () => {
    const wps = [wp(6.0), wp(6.1, 46.5, true), wp(6.2)]
    expect(inheritsFree(wps, 1)).toBe(true)     // voisin de droite libre
    expect(inheritsFree(wps, 2)).toBe(true)     // voisin de gauche libre
  })

  it('reste routé entre deux points routés', () => {
    const wps = [wp(6.0), wp(6.1), wp(6.2)]
    expect(inheritsFree(wps, 1)).toBe(false)
    expect(inheritsFree(wps, 2)).toBe(false)
  })

  it('reste routé aux extrémités du tableau', () => {
    const wps = [wp(6.0), wp(6.1)]
    expect(inheritsFree(wps, 0)).toBe(false)     // rien à gauche
    expect(inheritsFree([], 0)).toBe(false)
  })
})

describe('insertionPasses', () => {
  const px = (x: number, y = 100): ScreenPoint => ({ x, y })

  it('rend une seule passe sur un tracé simple, à l’arête cliquée', () => {
    // Cinq sommets alignés, un tous les 100 px ; ancrages aux sommets 0 et 4.
    const screen = [px(0), px(100), px(200), px(300), px(400)]
    const passes = insertionPasses(screen, { x: 250, y: 104 }, [0, 4], 2)

    expect(passes).toHaveLength(1)
    expect(passes[0].edgeIdx).toBe(2)            // arête 200 → 300
    expect(passes[0].t).toBeCloseTo(0.5, 6)      // à mi-arête
    expect(passes[0].insertAt).toBe(1)
  })

  it('propose une passe par tronçon quand le tracé se superpose', () => {
    // Aller (arêtes 0–3) puis retour EXACTEMENT dessus (arêtes 4–7) : deux tronçons
    // d'ancrages, donc deux rangs d'insertion possibles sous le même pixel.
    const out = [px(0), px(100), px(200), px(300), px(400)]
    const back = [px(300), px(200), px(100), px(0)]
    const screen = out.concat(back)
    const passes = insertionPasses(screen, { x: 150, y: 100 }, [0, 4, 8], 3)

    expect(passes.map((p) => p.insertAt)).toEqual([1, 2])
    // Chaque passe garde SON arête, celle qui appartient à son tronçon.
    expect(passes[0].edgeIdx).toBe(1)            // aller
    expect(passes[1].edgeIdx).toBe(6)            // retour
  })

  it('ne garde qu’une arête par passe : la plus proche du clic', () => {
    // Épingle à cheveux DANS UN SEUL tronçon : les deux branches (arêtes 0 et 2) passent
    // près du clic, à 1 px et 5 px. Une seule entrée doit sortir, celle de la branche
    // effectivement cliquée — sinon l'utilisateur se verrait proposer un choix de passe
    // alors qu'il n'y a qu'un rang d'insertion possible.
    const screen = [px(0), px(100), px(100, 106), px(0, 106)]
    const passes = insertionPasses(screen, { x: 50, y: 101 }, [0, 3], 2)

    expect(passes).toHaveLength(1)
    expect(passes[0].edgeIdx).toBe(0)            // la branche aller, à 1 px du clic
    expect(passes[0].insertAt).toBe(1)
  })

  it('écarte les arêtes nettement plus loin que la plus proche', () => {
    // Deuxième passe à 40 px : hors tolérance (8 px), elle n'est pas proposée.
    const out = [px(0), px(100), px(200)]
    const back = [px(200, 140), px(100, 140), px(0, 140)]
    const screen = out.concat(back)
    const passes = insertionPasses(screen, { x: 100, y: 100 }, [0, 2, 5], 3)

    expect(passes.map((p) => p.insertAt)).toEqual([1])
  })

  it('élargit ou resserre la sélection selon la tolérance', () => {
    const out = [px(0), px(100), px(200)]
    const back = [px(200, 120), px(100, 120), px(0, 120)]
    const screen = out.concat(back)
    const click = { x: 100, y: 100 }

    // 20 px d'écart entre les deux passes : hors tolérance par défaut, dans la tolérance
    // si on l'élargit.
    expect(insertionPasses(screen, click, [0, 2, 5], 3)).toHaveLength(1)
    expect(insertionPasses(screen, click, [0, 2, 5], 3, 25)).toHaveLength(2)
  })

  it('projette sur l’extrémité d’une arête quand le clic la dépasse', () => {
    const screen = [px(0), px(100)]
    expect(insertionPasses(screen, { x: -50, y: 100 }, [0, 1], 2)[0].t).toBe(0)
    expect(insertionPasses(screen, { x: 150, y: 100 }, [0, 1], 2)[0].t).toBe(1)
  })

  it('tient les arêtes dégénérées (deux sommets au même pixel)', () => {
    const screen = [px(100), px(100), px(200)]
    const passes = insertionPasses(screen, { x: 100, y: 100 }, [0, 2], 2)

    expect(passes).toHaveLength(1)
    expect(Number.isFinite(passes[0].t)).toBe(true)
  })

  it('ne propose rien sans tracé exploitable ni avec des index désynchronisés', () => {
    expect(insertionPasses([px(0)], { x: 0, y: 0 }, [0, 1], 2)).toEqual([])
    expect(insertionPasses([px(0), px(100)], { x: 50, y: 100 }, [0, 1], 3)).toEqual([])
  })
})
