import { describe, expect, it } from 'vitest'
import { bearingDelta, bearingBetween, buildDistancesM, buildOffsetDisplayLine, detectTurns, turnsFromVoiceHints, nearestGeomIndex, sliceLineBetween, maneuverEndIdx } from './routeHelpers'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'
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

// ─── Tracés qui se recoupent (aller-retour) ────────────────────────────────────

// Un aller-retour repasse EXACTEMENT par les sommets de l'aller : c'est le cas qui piège
// à la fois l'appariement des virages aux voicehints et le suivi de position, les deux
// s'appuyant sur des distances qui deviennent rigoureusement égales entre deux passages.
//
// Le tracé, au pas de 25 m : 300 m vers l'est jusqu'à une intersection, puis un éperon
// de 200 m vers le sud en cul-de-sac, demi-tour, retour par la même intersection, et
// 300 m vers l'ouest. L'éperon est court À DESSEIN — 8 sommets — car c'est ce qui met
// en défaut un recul de curseur compté en sommets plutôt qu'en mètres.
const outAndBack = path([
  { bearing: 90, lengthM: 300 },
  { bearing: 180, lengthM: 200 },
  { bearing: 0, lengthM: 200 },
  { bearing: 270, lengthM: 300 },
])
const outAndBackCum = buildDistancesM(outAndBack)
const JUNCTION_OUT = 12   // l'intersection, à 300 m
const DEAD_END = 20       // le bout de l'éperon, à 500 m
const JUNCTION_BACK = 28  // la même intersection au retour, à 700 m

describe('turnsFromVoiceHints sur un aller-retour', () => {
  const at = (i: number, cmd: number, angle: number): VoiceHint =>
    ({ lng: outAndBack[i][0], lat: outAndBack[i][1], cmd, angle, exit_number: 0 })

  it('ancre les deux passages d’une même intersection sur des sommets distincts', () => {
    // Ordre de parcours : virage à l'aller, demi-tour au cul-de-sac, virage au retour.
    const hints = [at(JUNCTION_OUT, 5, 90), at(DEAD_END, 15, 180), at(JUNCTION_BACK, 2, -90)]

    const turns = turnsFromVoiceHints(hints, outAndBack, outAndBackCum)

    // Le troisième hint porte sur le passage du RETOUR. Ancré sur celui de l'aller, il
    // produirait deux virages au même endroit et laisserait le virage du retour muet.
    expect(turns.map((t) => t.idx)).toEqual([JUNCTION_OUT, DEAD_END, JUNCTION_BACK])
    expect(turns.map((t) => Math.round(t.distM))).toEqual([300, 500, 700])
  })

  it('tolère un léger dépassement du curseur entre deux hints proches', () => {
    // Deux hints à 25 m d'écart, le second légèrement EN ARRIÈRE du premier : le recul
    // autorisé doit encore permettre de l'apparier au bon sommet.
    const turns = turnsFromVoiceHints([at(5, 5, 45), at(4, 5, 45)], outAndBack, outAndBackCum)

    expect(turns.map((t) => t.idx)).toEqual([4, 5])
  })

  it('ignore un hint étranger au tracé sans décrocher les suivants', () => {
    // Un hint hors tracé (portion remplacée par un détour, tracé recalculé depuis
    // l'enregistrement) ne doit ni produire un virage fantôme, ni faire avancer le
    // curseur : sinon tous les hints suivants s'apparient depuis un curseur trop avancé et
    // se retrouvent entassés en fin de tracé.
    const alien: VoiceHint = { lng: outAndBack[0][0] + 0.5, lat: outAndBack[0][1] + 0.5, cmd: 2, angle: -90, exit_number: 0 }
    const hints = [alien, at(JUNCTION_OUT, 5, 90), at(DEAD_END, 15, 180), at(JUNCTION_BACK, 2, -90)]

    const turns = turnsFromVoiceHints(hints, outAndBack, outAndBackCum)

    expect(turns.map((t) => t.idx)).toEqual([JUNCTION_OUT, DEAD_END, JUNCTION_BACK])
  })
})

describe('nearestGeomIndex sur un aller-retour', () => {
  it('ne fait jamais reculer la progression quand on suit le tracé', () => {
    // Le coureur passe par chaque sommet, dans l'ordre. Sans départage, le retour
    // s'apparie aux sommets de l'aller (mêmes coordonnées, distance égale) : la flèche
    // redescend le tracé de l'aller et la progression baisse.
    let lastIdx = -1
    const backwards: number[] = []
    for (let truth = 0; truth < outAndBack.length; truth++) {
      const here: LngLat = [outAndBack[truth][0], outAndBack[truth][1]]
      const { idx } = nearestGeomIndex(here, outAndBack, lastIdx)
      if (lastIdx >= 0 && outAndBackCum[idx] < outAndBackCum[lastIdx] - 1) backwards.push(truth)
      lastIdx = idx
    }

    expect(backwards).toEqual([])
  })

  it('suit la voie du retour après le demi-tour', () => {
    // Juste après le cul-de-sac, le sommet réel et son miroir sur l'aller sont la MÊME
    // coordonnée : seul le suivi du curseur peut les distinguer.
    expect(outAndBack[DEAD_END - 2].slice(0, 2)).toEqual(outAndBack[DEAD_END + 2].slice(0, 2))

    const here: LngLat = [outAndBack[DEAD_END + 2][0], outAndBack[DEAD_END + 2][1]]
    expect(nearestGeomIndex(here, outAndBack, DEAD_END + 1).idx).toBe(DEAD_END + 2)
  })

  it('reste sur la voie de l’aller tant qu’on ne l’a pas quittée', () => {
    // Le départage ne doit pas propulser le coureur sur le retour dès l'aller.
    const here: LngLat = [outAndBack[16][0], outAndBack[16][1]]
    expect(nearestGeomIndex(here, outAndBack, 15).idx).toBe(16)
  })

  it('sans indice précédent, garde la recherche globale', () => {
    // Aucune direction de marche connue : le premier passage reste la réponse.
    const here: LngLat = [outAndBack[DEAD_END + 2][0], outAndBack[DEAD_END + 2][1]]
    expect(nearestGeomIndex(here, outAndBack).idx).toBe(DEAD_END - 2)
  })
})

// Tronçon surligné autour d'un virage (RouteNavigation) : ce qui compte est que les deux
// extrémités tombent EXACTEMENT à la distance demandée — sinon le bout de couleur sauterait
// d'un sommet à l'autre au lieu de rester centré sur le virage.

describe('sliceLineBetween', () => {
  // Ligne droite est-ouest, un sommet tous les 10 m, wscale décroissant pour vérifier
  // l'alignement index-pour-index.
  const line: LngLat[] = Array.from({ length: 11 }, (_, i) => moveLngLat([6, 46], 90, i * 10))
  const cum = buildDistancesM(line)
  const wscale = line.map((_, i) => 1 - i * 0.01)

  it('interpole les deux extrémités à la distance demandée', () => {
    const { line: cut } = sliceLineBetween(line, cum, wscale, 25, 55)
    const cutCum = buildDistancesM(cut)
    expect(cutCum[cutCum.length - 1]).toBeCloseTo(30, 1)
    // Sommets intérieurs : 30, 40, 50 → 3, plus les deux extrémités interpolées.
    expect(cut.length).toBe(5)
  })

  it('rend autant de wscale que de sommets', () => {
    const { line: cut, wscale: w } = sliceLineBetween(line, cum, wscale, 25, 55)
    expect(w.length).toBe(cut.length)
    expect(w[1]).toBeCloseTo(1 - 3 * 0.01, 5)   // le sommet à 30 m garde SON échelle
  })

  it('borne aux extrémités du tracé (virage en début ou fin de parcours)', () => {
    const { line: cut } = sliceLineBetween(line, cum, wscale, -40, 20)
    expect(cut[0]).toEqual(line[0])
    const cutCum = buildDistancesM(cut)
    expect(cutCum[cutCum.length - 1]).toBeCloseTo(20, 1)
  })

  it('rend un tronçon vide quand la plage est nulle ou inversée', () => {
    expect(sliceLineBetween(line, cum, wscale, 50, 50).line).toEqual([])
    expect(sliceLineBetween(line, cum, wscale, 60, 20).line).toEqual([])
    expect(sliceLineBetween([line[0]], [0], [1], 0, 10).line).toEqual([])
  })
})

// Fin de manœuvre : c'est ce qui permet de colorer un rond-point ENTIER (l'anneau + la
// branche de sortie). Les hints BRouter n'ancrent qu'un point à l'entrée : la sortie ne
// peut venir que de la géométrie.

describe('maneuverEndIdx', () => {
  // Rond-point de 25 m de rayon : approche vers l'est, 3/4 d'anneau, sortie vers le nord.
  // Points tous les ~5 m, comme une géométrie BRouter.
  const RADIUS = 25
  const center = moveLngLat([6, 46], 0, RADIUS)   // l'entrée est au sud de l'anneau
  const roundabout = (arcDeg: number): { geom: LngLat[]; entry: number; exit: number } => {
    const geom: LngLat[] = []
    for (let d = 60; d > 0; d -= 5) geom.push(moveLngLat([6, 46], 270, d))   // approche est
    const entry = geom.length
    geom.push([6, 46])
    // Anneau parcouru dans le sens horaire (rond-point à droite) depuis le sud.
    const stepDeg = 5 / RADIUS * 180 / Math.PI
    for (let a = stepDeg; a <= arcDeg; a += stepDeg) geom.push(moveLngLat(center, 180 - a, RADIUS))
    const exit = geom.length - 1
    const last = geom[exit]
    const outB = bearingBetween(geom[exit - 1], last)
    for (let d = 5; d <= 120; d += 5) geom.push(moveLngLat(last, outB, d))   // branche de sortie
    return { geom, entry, exit }
  }

  it('suit l’anneau jusqu’à la sortie (3/4 de tour)', () => {
    const { geom, entry, exit } = roundabout(270)
    const cum = buildDistancesM(geom)
    const end = maneuverEndIdx(geom, cum, entry)
    // La détection se fait sur une fenêtre de 25 m : on tolère cet ordre de grandeur.
    expect(Math.abs(cum[end] - cum[exit])).toBeLessThan(30)
    // ... et surtout, on est bien allé au-delà des 40 m du surlignage de base.
    expect(cum[end] - cum[entry]).toBeGreaterThan(80)
  })

  it('s’arrête à la sortie d’un petit rond-point (quart de tour)', () => {
    const { geom, entry, exit } = roundabout(90)
    const cum = buildDistancesM(geom)
    const end = maneuverEndIdx(geom, cum, entry)
    expect(Math.abs(cum[end] - cum[exit])).toBeLessThan(30)
  })

  it('rend le sommet lui-même quand rien ne tourne (tracé droit)', () => {
    const straight: LngLat[] = Array.from({ length: 40 }, (_, i) => moveLngLat([6, 46], 90, i * 5))
    const cum = buildDistancesM(straight)
    expect(maneuverEndIdx(straight, cum, 10)).toBe(10)
  })

  it('respecte le garde-fou maxM sur une courbe qui n’en finit pas', () => {
    // Cercle complet et répété : jamais de portion droite.
    const loop: LngLat[] = []
    for (let a = 0; a < 720; a += 5) loop.push(moveLngLat(center, a, RADIUS))
    const cum = buildDistancesM(loop)
    const end = maneuverEndIdx(loop, cum, 0, { maxM: 120 })
    expect(cum[end]).toBeGreaterThan(120)
    expect(cum[end]).toBeLessThan(140)
  })

  it('ne déborde pas en fin de tracé', () => {
    const { geom, entry } = roundabout(270)
    const cut = geom.slice(0, entry + 12)   // le tracé s'arrête DANS l'anneau
    const cum = buildDistancesM(cut)
    expect(maneuverEndIdx(cut, cum, entry)).toBe(cut.length - 1)
  })
})

// Dédoublement des portions parcourues plusieurs fois : c'est ce décalage qui rend chaque
// passage lisible séparément sur la carte (couleurs de pente notamment). Le premier passage
// reste sur le tracé réel (voie 0) ; chaque passage suivant décale d'une voie de plus vers
// la droite de sa propre direction. `off` dit OÙ l'affichage s'écarte du tracé — l'éditeur
// d'itinéraire s'en sert pour n'y dessiner sa ligne de repère que là.

describe('buildOffsetDisplayLine', () => {
  // Aller-retour plein est sur 300 m : un sommet tous les 10 m à l'aller, puis les mêmes
  // sommets en sens inverse. Tout se superpose, sauf autour du demi-tour où les deux
  // passages sont trop proches LE LONG du parcours pour compter comme un recouvrement.
  const out: LngLat[] = Array.from({ length: 31 }, (_, i) => moveLngLat([6, 46], 90, i * 10))
  const outAndBack: LngLat[] = [...out, ...out.slice(0, -1).reverse()]
  const cum = buildDistancesM(outAndBack)

  it('rend un décalage et une largeur par sommet', () => {
    const { line, wscale, off } = buildOffsetDisplayLine(outAndBack, cum)
    expect(line.length).toBe(outAndBack.length)
    expect(wscale.length).toBe(outAndBack.length)
    expect(off.length).toBe(outAndBack.length)
  })

  it('laisse le premier passage sur le tracé réel et décale le second', () => {
    const { line, off } = buildOffsetDisplayLine(outAndBack, cum)
    // Sommet 5 (50 m à l'aller) et son jumeau au retour : même position réelle…
    const back = outAndBack.length - 1 - 5
    expect(outAndBack[back]).toEqual(outAndBack[5])
    // …le premier passage (l'aller) reste la voie 0, sans décalage…
    expect(off[5]).toBe(0)
    expect(line[5]).toEqual(outAndBack[5])
    // …le second (le retour) est la voie 1, décalée à droite de SA direction de parcours
    // (donc à l'opposé de ce qu'aurait été le décalage de l'aller).
    expect(off[back]).toBeGreaterThan(0)
    const dBack = line[back][1] - outAndBack[back][1]
    expect(dBack).not.toBe(0)
  })

  it('laisse le demi-tour sur le tracé réel', () => {
    // Autour du sommet 30 (le point de rebroussement), aller et retour sont à moins de
    // minSeparationM l'un de l'autre le long du parcours : de simples voisins, pas un
    // recouvrement. Les décaler y creuserait une boucle parasite.
    const { line, off } = buildOffsetDisplayLine(outAndBack, cum)
    expect(off[30]).toBeLessThan(0.5)
    expect(line[30][1]).toBeCloseTo(outAndBack[30][1], 6)
  })

  it('ne touche pas un tracé qui ne se recoupe pas', () => {
    const cumOut = buildDistancesM(out)
    const { line, off, wscale } = buildOffsetDisplayLine(out, cumOut)
    expect(off.every((o) => o === 0)).toBe(true)
    expect(wscale.every((w) => w === 1)).toBe(true)
    expect(line).toEqual(out)
  })

  it('rend le tracé tel quel quand il est trop court pour se superposer', () => {
    const two: LngLat[] = [out[0], out[1]]
    expect(buildOffsetDisplayLine(two, buildDistancesM(two))).toEqual({
      line: two, wscale: [1, 1], off: [0, 0],
    })
  })
})
