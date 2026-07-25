import { describe, expect, it } from 'vitest'
import { bearingDelta, bearingBetween, buildDistancesM, detectTurns } from './routeHelpers'
import type { Coord, LngLat } from './routeHelpers'
// moveLngLat (navHelpers) sert à bâtir les tracés en MÈTRES : les seuils de detectTurns
// (35°, 18 m, 25 m) ne veulent rien dire exprimés en degrés de longitude.
import { moveLngLat } from './navHelpers'

// Écart de caps : partagé par la détection de virages (routeHelpers), le choix du point de
// raccord (navReroute), la flèche « retour au tracé » et le lissage du cap rendu. Le
// repliement autour du nord est LE piège de ce calcul.

describe('bearingDelta', () => {
  it('donne l’écart signé : positif à droite, négatif à gauche', () => {
    expect(bearingDelta(90, 120)).toBe(30)
    expect(bearingDelta(90, 60)).toBe(-30)
    expect(bearingDelta(90, 90)).toBe(0)
  })

  it('se replie autour du nord au lieu de faire le tour', () => {
    expect(bearingDelta(359, 1)).toBe(2)
    expect(bearingDelta(1, 359)).toBe(-2)
    expect(bearingDelta(350, 10)).toBe(20)
  })

  it('reste dans [−180, 180], demi-tour compris', () => {
    expect(bearingDelta(0, 180)).toBe(180)
    expect(bearingDelta(0, 181)).toBe(-179)
    // Un demi-tour garde le signe sous lequel il arrive : ±180 désignent la même
    // direction, et tous les appelants n'en lisent que la valeur absolue ou le produit.
    expect(bearingDelta(0, -180)).toBe(-180)
  })

  it('accepte des caps hors de [0, 360[ (relevés bruts, valeurs négatives)', () => {
    // bearingBetween rend des caps dans (−180, 180] : les comparer ne doit rien casser.
    expect(bearingDelta(-170, 170)).toBe(-20)
    expect(bearingDelta(170, -170)).toBe(20)
    expect(bearingDelta(720, 730)).toBe(10)
  })

  it('mesure un demi-tour comme tel, dans un sens comme dans l’autre', () => {
    // Sert au raccord de reroutage : au-delà de ±85°, rejoindre imposerait un demi-tour.
    const north: [number, number] = [6.0, 46.5]
    const south: [number, number] = [6.0, 46.4]
    expect(Math.abs(bearingDelta(bearingBetween(north, south), bearingBetween(south, north))))
      .toBeCloseTo(180, 6)
  })
})

// ─── detectTurns ───────────────────────────────────────────────────────────────

// Tracé fait de tronçons droits enchaînés : chaque tronçon avance de `lengthM` au cap
// `bearing`, avec un sommet tous les `stepM`. Le sommet de raccord est partagé par les deux
// tronçons — c'est lui, le « virage ». Longueurs multiples du pas, sinon le tronçon est
// arrondi et la géométrie ne dit plus ce qu'on croit.
function path(legs: Array<{ bearing: number; lengthM: number; stepM?: number }>): Coord[] {
  const start: LngLat = [6.0, 46.5]
  const out: Coord[] = [[start[0], start[1], 500]]
  let cur = start
  for (const leg of legs) {
    const step = leg.stepM ?? 25
    for (let k = 0; k < Math.round(leg.lengthM / step); k++) {
      cur = moveLngLat(cur, leg.bearing, step)
      out.push([cur[0], cur[1], 500])
    }
  }
  return out
}

function turnsOf(geometry: Coord[], minAngleDeg?: number, spanM?: number) {
  return detectTurns(geometry, buildDistancesM(geometry), minAngleDeg, spanM)
}

// Tracé en L : 100 m vers l'est, puis 100 m vers le sud → virage à DROITE de 90° au
// sommet 4 (à 100 m du départ).
const lShape = path([{ bearing: 90, lengthM: 100 }, { bearing: 180, lengthM: 100 }])

describe('detectTurns', () => {
  it('ne voit aucun virage sur un tracé rectiligne', () => {
    expect(turnsOf(path([{ bearing: 90, lengthM: 300 }]))).toEqual([])
  })

  it('renvoie une liste vide sous trois sommets', () => {
    expect(turnsOf([[6.0, 46.5, 500], [6.1, 46.5, 500]])).toEqual([])
    expect(turnsOf([])).toEqual([])
  })

  it('détecte un angle droit une seule fois, au bon sommet', () => {
    const turns = turnsOf(lShape)

    expect(turns).toHaveLength(1)
    expect(turns[0].idx).toBe(4)
    expect(turns[0].distM).toBeCloseTo(100, 0)
    expect(turns[0].direction).toBe('right')
    expect(turns[0].angle).toBeCloseTo(90, 0)
    expect(turns[0].kind).toBe('turn')
  })

  it('signe l’angle : positif à droite, négatif à gauche', () => {
    // Est puis nord : même angle, dans l'autre sens.
    const left = turnsOf(path([{ bearing: 90, lengthM: 100 }, { bearing: 0, lengthM: 100 }]))
    expect(left).toHaveLength(1)
    expect(left[0].direction).toBe('left')
    expect(left[0].angle).toBeCloseTo(-90, 0)
  })

  it('classe le virage par sa vivacité', () => {
    const kindFor = (deg: number) =>
      turnsOf(path([{ bearing: 90, lengthM: 100 }, { bearing: 90 + deg, lengthM: 100 }]))[0]?.kind

    expect(kindFor(40)).toBe('slight')     // < 45°
    expect(kindFor(60)).toBe('turn')       // 45–95°
    expect(kindFor(120)).toBe('sharp')     // ≥ 95°
  })

  it('rapporte un demi-tour géométrique comme un virage très vif', () => {
    // Le genre « uturn » n'existe que dans les instructions BRouter (turnsFromVoiceHints) ;
    // la détection géométrique, elle, ne voit qu'un angle extrême.
    const hairpin = turnsOf(path([{ bearing: 90, lengthM: 100 }, { bearing: 270, lengthM: 100 }]))
    expect(hairpin).toHaveLength(1)
    expect(Math.abs(hairpin[0].angle)).toBeCloseTo(180, 0)
    expect(hairpin[0].kind).toBe('sharp')
  })

  it('ignore une inflexion sous le seuil, sauf si on abaisse celui-ci', () => {
    const bend = path([{ bearing: 90, lengthM: 100 }, { bearing: 120, lengthM: 100 }])
    expect(turnsOf(bend)).toEqual([])              // 30° < 35° par défaut
    expect(turnsOf(bend, 25)).toHaveLength(1)
  })

  it('garde deux virages distincts', () => {
    // Est 100 m, sud 75 m, est 100 m : droite puis gauche, à 75 m l'un de l'autre.
    const chicane = path([
      { bearing: 90, lengthM: 100 }, { bearing: 180, lengthM: 75 }, { bearing: 90, lengthM: 100 },
    ])
    const turns = turnsOf(chicane)

    expect(turns.map((t) => t.direction)).toEqual(['right', 'left'])
    expect(turns[0].distM).toBeCloseTo(100, 0)
    expect(turns[1].distM).toBeCloseTo(175, 0)
  })

  it('ne compte qu’un virage quand un même coude s’étale sur plusieurs sommets', () => {
    // Géométrie dense (un sommet tous les 2 m, comme après densification) : le coude est
    // vu par une dizaine de sommets voisins, tous repliés sur le plus marqué.
    const dense = path([
      { bearing: 90, lengthM: 60, stepM: 2 }, { bearing: 180, lengthM: 60, stepM: 2 },
    ])
    const turns = turnsOf(dense)

    expect(turns).toHaveLength(1)
    expect(turns[0].distM).toBeCloseTo(60, 0)
    expect(turns[0].angle).toBeCloseTo(90, 0)
  })

  it('détecte un virage pris juste après le départ', () => {
    // La fenêtre amont est tronquée au départ du tracé, mais le virage compte quand même.
    const early = path([{ bearing: 90, lengthM: 5, stepM: 5 }, { bearing: 180, lengthM: 100 }])
    const turns = turnsOf(early)

    expect(turns).toHaveLength(1)
    expect(turns[0].idx).toBe(1)
  })

  it('n’attribue jamais un virage aux sommets extrêmes', () => {
    // Le premier et le dernier sommet n'ont pas de fenêtre de part et d'autre.
    for (const geom of [lShape, path([{ bearing: 90, lengthM: 50 }, { bearing: 200, lengthM: 50 }])]) {
      const turns = turnsOf(geom)
      expect(turns.length).toBeGreaterThan(0)      // sinon le test ne prouve rien
      for (const t of turns) {
        expect(t.idx).toBeGreaterThan(0)
        expect(t.idx).toBeLessThan(geom.length - 1)
      }
    }
  })

  it('rend des virages ordonnés, dont la distance colle à leur sommet', () => {
    const cum = buildDistancesM(lShape)
    const winding = path([
      { bearing: 90, lengthM: 100 }, { bearing: 180, lengthM: 75 },
      { bearing: 90, lengthM: 75 }, { bearing: 0, lengthM: 100 },
    ])
    const turns = turnsOf(winding)
    const cumW = buildDistancesM(winding)

    expect(turns.length).toBeGreaterThan(1)
    for (const t of turns) expect(t.distM).toBe(cumW[t.idx])
    const dists = turns.map((t) => t.distM)
    expect([...dists].sort((a, b) => a - b)).toEqual(dists)
    // Cohérence du repère sur le L simple aussi.
    expect(turnsOf(lShape)[0].distM).toBe(cum[4])
  })

  it('lisse le bruit de la géométrie via la fenêtre de comparaison', () => {
    // Ligne droite aux sommets serrés, avec ±0,5 m de bruit latéral alterné (précision d'un
    // tracé enregistré) : d'un sommet au suivant, le cap saute de ~26°.
    const jittery: Coord[] = []
    for (let k = 0; k <= 60; k++) {
      const [lng, lat] = moveLngLat([6.0, 46.5], 90, k * 2)
      const [jLng, jLat] = moveLngLat([lng, lat], k % 2 === 0 ? 0 : 180, 0.5)
      jittery.push([jLng, jLat, 500])
    }

    // Comparé de proche en proche (fenêtre d'un sommet), ce bruit fabrique des virages…
    expect(turnsOf(jittery, 35, 1).length).toBeGreaterThan(0)
    // … que la fenêtre par défaut (18 m) absorbe : la route est droite.
    expect(turnsOf(jittery)).toEqual([])
  })
})
