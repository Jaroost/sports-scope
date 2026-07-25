import { describe, expect, it } from 'vitest'
import { rejoinIndexAhead, viasAhead, detourAnchors, spliceDetour } from './navReroute'
import { moveLngLat } from './navHelpers'
import { buildDistancesM } from './routeHelpers'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'

// Géométrie de test bâtie en mètres (moveLngLat) pour raisonner en distances réelles :
// les seuils de navReroute (40 m, 30 m, 2000 m) ne veulent rien dire en degrés.

const START: LngLat = [6.0, 46.5]

// Tracé rectiligne vers l'est, `n` sommets espacés de `stepM`.
function straight(n: number, stepM = 50, bearing = 90): Coord[] {
  return Array.from({ length: n }, (_, i) => {
    const [lng, lat] = moveLngLat(START, bearing, i * stepM)
    return [lng, lat, 500] as Coord
  })
}

// Position décalée de `offsetM` vers le nord depuis le sommet `idx`.
function besideVertex(geometry: Coord[], idx: number, offsetM: number): LngLat {
  return moveLngLat([geometry[idx][0], geometry[idx][1]], 0, offsetM)
}

describe('rejoinIndexAhead', () => {
  // 41 sommets tous les 50 m : 2000 m de tracé, pile la fenêtre de raccord.
  const geometry = straight(41)
  const cum = buildDistancesM(geometry)

  it('raccorde au sommet le plus proche DEVANT, un peu au-delà (lookahead)', () => {
    // 20 m au nord du sommet 10, cap à l'est : le sommet 10 est trop près (< 40 m), le 11
    // est le premier utilisable devant, et on vise 30 m plus loin → sommet 12.
    const pos = besideVertex(geometry, 10, 20)
    expect(rejoinIndexAhead(geometry, cum, pos, 90, 10)).toBe(12)
  })

  it('ignore les sommets derrière soi (pas de demi-tour) et retombe sur le plus proche', () => {
    // Même position, mais cap à l'ouest : tout le tracé restant est derrière → aucun
    // candidat dans l'arc. Repli sur le sommet le plus proche depuis la progression (10),
    // puis lookahead → 11. BRouter, lui, recevra le cap pour éviter le demi-tour collé.
    const pos = besideVertex(geometry, 10, 20)
    expect(rejoinIndexAhead(geometry, cum, pos, 270, 10)).toBe(11)
  })

  it('ne regarde jamais en arrière de la progression', () => {
    // Coureur au niveau du sommet 10 mais progression déclarée au sommet 20 : le raccord
    // est cherché à partir de 20, même si des sommets plus proches existent avant.
    const pos = besideVertex(geometry, 10, 20)
    expect(rejoinIndexAhead(geometry, cum, pos, 90, 20)).toBeGreaterThanOrEqual(20)
  })

  it('n’escamote pas une portion entière du tracé (plafond de saut)', () => {
    // Cas de la boucle : le coureur se trouve géographiquement près du sommet à 4000 m,
    // alors que sa progression est encore au départ. Sans plafond, on raccorderait là-bas
    // et le parcours serait aussitôt « presque fini ». Le raccord reste dans les 2000 m.
    const long = straight(101)                  // 5000 m
    const longCum = buildDistancesM(long)
    const pos = besideVertex(long, 80, 20)      // à 4000 m le long du tracé

    const idx = rejoinIndexAhead(long, longCum, pos, 90, 0)

    expect(longCum[idx]).toBeLessThanOrEqual(2000 + 60)
  })

  it('après un virage manqué, raccorde au virage et non plus loin sur la branche', () => {
    // Le tracé part vers l'est puis tourne au nord au sommet 10 ; le coureur a raté le
    // virage et continue 100 m à l'est. Plus rien n'est dans l'arc devant lui (le virage
    // est derrière, la branche nord sur son flanc) : on retombe sur le sommet le plus
    // proche — le virage — au lieu de viser un point de la branche nord, qui ferait
    // escamoter le début de celle-ci.
    const east = straight(11)                                  // 0 → 500 m vers l'est
    const corner: LngLat = [east[10][0], east[10][1]]
    const north = Array.from({ length: 10 }, (_, i) => {
      const [lng, lat] = moveLngLat(corner, 0, (i + 1) * 50)   // 550 → 1000 m vers le nord
      return [lng, lat, 500] as Coord
    })
    const bent = east.concat(north)
    const bentCum = buildDistancesM(bent)
    const pos = moveLngLat(corner, 90, 100)                    // 100 m au-delà du virage

    // Sommet 10 = le virage, + lookahead → premier sommet de la branche nord.
    expect(rejoinIndexAhead(bent, bentCum, pos, 90, 8)).toBe(11)
  })

  it('reste dans les bornes du tracé', () => {
    const pos = besideVertex(geometry, 40, 20)
    const idx = rejoinIndexAhead(geometry, cum, pos, 90, 38)
    expect(idx).toBeLessThanOrEqual(geometry.length - 1)
    expect(idx).toBeGreaterThanOrEqual(0)
  })
})

describe('viasAhead', () => {
  const geometry = straight(21)   // 1000 m

  const via = (idx: number): LngLat => [geometry[idx][0], geometry[idx][1]]

  it('ne garde que les étapes situées devant la progression', () => {
    const vias = [via(5), via(10), via(20)]
    expect(viasAhead(vias, geometry, 7)).toEqual([via(10), via(20)])
  })

  it('garde tout au départ', () => {
    const vias = [via(5), via(20)]
    expect(viasAhead(vias, geometry, 0)).toEqual(vias)
  })

  it('retombe sur la destination quand toutes les étapes sont dépassées', () => {
    const vias = [via(5), via(10)]
    // Le GPS a « dépassé » les deux : il reste au moins la destination où aller.
    expect(viasAhead(vias, geometry, 15)).toEqual([via(10)])
  })

  it('renvoie une liste vide sans étape (tracé qui n’en a pas)', () => {
    expect(viasAhead([], geometry, 3)).toEqual([])
  })
})

describe('detourAnchors', () => {
  const geometry = straight(21)          // 1000 m, un sommet tous les 50 m
  const cum = buildDistancesM(geometry)

  it('écarte les ancrages d’environ le jeu demandé de part et d’autre', () => {
    const { a, b } = detourAnchors(geometry, cum, 10, 40)
    // Premier sommet à 40 m ou plus de part et d'autre du sommet 10 (pas 50 m pile : la
    // boucle s'arrête au premier qui atteint le jeu).
    expect(a).toBe(9)
    expect(b).toBe(11)
    expect(cum[10] - cum[a]).toBeGreaterThanOrEqual(40)
    expect(cum[b] - cum[10]).toBeGreaterThanOrEqual(40)
  })

  it('remonte plus de sommets quand ils sont serrés', () => {
    const dense = straight(41, 10)       // un sommet tous les 10 m
    const denseCum = buildDistancesM(dense)
    const { a, b } = detourAnchors(dense, denseCum, 20, 40)
    // Le jeu se compte en mètres, pas en sommets : il faut en remonter ~4 au lieu d'un.
    expect(denseCum[20] - denseCum[a]).toBeGreaterThanOrEqual(40)
    expect(denseCum[b] - denseCum[20]).toBeGreaterThanOrEqual(40)
    expect(20 - a).toBeGreaterThanOrEqual(4)
    expect(b - 20).toBeGreaterThanOrEqual(4)
  })

  it('se borne aux extrémités du tracé', () => {
    expect(detourAnchors(geometry, cum, 0, 40)).toEqual({ a: 0, b: 1 })
    expect(detourAnchors(geometry, cum, 20, 40)).toEqual({ a: 19, b: 20 })
  })
})

describe('spliceDetour', () => {
  // Tracé nommé par ses coordonnées pour suivre l'épissage à l'œil.
  const geometry: Coord[] = Array.from({ length: 10 }, (_, i) => [6.0 + i, 46.5, 500] as Coord)
  const hint = (lng: number, cmd = 2): VoiceHint => ({ lng, lat: 46.5, cmd, angle: 90, exit_number: 0 })
  const hints = geometry.map((c) => hint(c[0]))
  const detour: Coord[] = [[10.1, 47.0, 400], [10.2, 47.0, 400]]
  const detourHints = [hint(10.1, 4)]

  it('remplace la tête jusqu’au raccord (reroutage hors-trace)', () => {
    const out = spliceDetour(geometry, hints, detour, detourHints, 0, 6)

    expect(out.geometry).toEqual(detour.concat(geometry.slice(6)))
    // Les hints des sommets 0–5 disparaissent avec eux ; ceux de la queue subsistent.
    expect(out.hints.map((h) => h.lng)).toEqual([10.1, 6.0 + 6, 6.0 + 7, 6.0 + 8, 6.0 + 9])
  })

  it('remplace une portion au milieu (insertion d’un point intermédiaire)', () => {
    const out = spliceDetour(geometry, hints, detour, detourHints, 3, 6)

    expect(out.geometry).toEqual(geometry.slice(0, 3).concat(detour, geometry.slice(6)))
    // Ordre tête → détour → queue, comme l'attend turnsFromVoiceHints.
    expect(out.hints.map((h) => h.lng)).toEqual([6.0, 7.0, 8.0, 10.1, 12.0, 13.0, 14.0, 15.0])
  })

  it('ne conserve aucun hint des sommets remplacés', () => {
    const out = spliceDetour(geometry, hints, detour, detourHints, 2, 8)
    const dropped = geometry.slice(2, 8).map((c) => c[0])
    expect(out.hints.some((h) => dropped.includes(h.lng))).toBe(false)
  })

  it('ne garde que le détour quand il remplace tout le tracé', () => {
    const out = spliceDetour(geometry, hints, detour, detourHints, 0, geometry.length)
    expect(out.geometry).toEqual(detour)
    expect(out.hints).toEqual(detourHints)
  })

  it('apparie les hints sur les coordonnées exactes, pas sur le rang', () => {
    // Un hint dont les coordonnées ne correspondent à aucun sommet conservé (tracé
    // recalculé entre-temps) est écarté au lieu d'être ré-attaché au hasard.
    const orphan = [hint(99.9)]
    const out = spliceDetour(geometry, orphan, detour, detourHints, 0, 6)
    expect(out.hints).toEqual(detourHints)
  })

  it('un tracé qui repasse au même endroit ne duplique pas ses hints', () => {
    // Deux sommets identiques (aller-retour sur le même segment) : une seule entrée de
    // hint doit ressortir par sommet conservé, pas une par occurrence de la clé.
    const doubled: Coord[] = [[6.0, 46.5, 500], [6.1, 46.5, 500], [6.0, 46.5, 500], [6.2, 46.5, 500]]
    const out = spliceDetour(doubled, [hint(6.0)], detour, [], 0, 2)
    // Le sommet 6.0 conservé (rang 2) réhabilite son hint, une fois.
    expect(out.hints.map((h) => h.lng)).toEqual([6.0])
  })
})
