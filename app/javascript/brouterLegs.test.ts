import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeLegs, clearLegCache, LegRoutingError } from './brouterLegs'
import type { LegWaypoint } from './brouterLegs'

// Le routage tronçon par tronçon (une requête à 2 points par paire de waypoints) remplace
// la requête unique à N waypoints, sur laquelle BRouter éliminait les demi-tours aux points
// de passage — au point de ne plus rien renvoyer sur une boucle. Ce qui compte ici : le
// recollage des tronçons (jonctions, distances, voicehints) et le cache qui rend l'édition
// incrémentale.

function wp(lng: number, lat: number, free?: boolean): LegWaypoint {
  return free ? { lng, lat, free } : { lng, lat }
}

// Réponse GeoJSON BRouter minimale mais fidèle : `coords` en [lng, lat, alt],
// voicehints en [indexInTrack, commande, sortie, distanceToNext, angle].
function brouterResponse(coords: number[][], lengthM: number, voicehints: number[][] = []) {
  return {
    ok: true,
    json: async () => ({
      features: [
        {
          properties: { 'track-length': String(lengthM), voicehints },
          geometry: { coordinates: coords },
        },
      ],
    }),
  }
}

// Enregistre les URL appelées et sert une réponse par tronçon, indexée sur le `lonlats`.
function mockBrouter(byLonlats: Record<string, ReturnType<typeof brouterResponse>>) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url)
    const lonlats = decodeURIComponent(new URL(url, 'http://x').searchParams.get('lonlats') || '')
    const res = byLonlats[lonlats]
    if (!res) throw new Error(`tronçon non mocké: ${lonlats}`)
    return res
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

const A = wp(6.0, 46.5)
const B = wp(6.01, 46.5)
const C = wp(6.02, 46.5)
const KEY_AB = '6.000000,46.500000|6.010000,46.500000'
const KEY_BC = '6.010000,46.500000|6.020000,46.500000'
const KEY_CA = '6.020000,46.500000|6.000000,46.500000'

beforeEach(() => clearLegCache())
afterEach(() => vi.unstubAllGlobals())

describe('routeLegs', () => {
  it('émet une requête à 2 points par tronçon', async () => {
    const { calls } = mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.02, 46.5, 520]], 700),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)

    expect(calls).toHaveLength(2)
    // C'est tout l'enjeu : jamais plus de 2 points par requête, donc BRouter n'a aucun
    // point de passage à élaguer.
    for (const url of calls) {
      const lonlats = decodeURIComponent(new URL(url, 'http://x').searchParams.get('lonlats')!)
      expect(lonlats.split('|')).toHaveLength(2)
    }
    expect(r.distanceM).toBe(1500)
  })

  it('dédoublonne la jonction entre deux tronçons, même si l’altitude diffère', async () => {
    // BRouter repart de la tuile du tronçon : le même lieu peut ressortir avec une
    // altitude différente d'un tronçon à l'autre (constaté : 1105.25 puis 1102.25).
    mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.005, 46.5, 505], [6.01, 46.5, 1105.25]], 800),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 1102.25], [6.02, 46.5, 520]], 700),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)

    expect(r.geometry).toEqual([
      [6.0, 46.5, 500],
      [6.005, 46.5, 505],
      [6.01, 46.5, 1105.25], // la première occurrence gagne, la seconde est écartée
      [6.02, 46.5, 520],
    ])
  })

  it('boucle fermée : le point de départ répété reste routé', async () => {
    // Le cas de l'itinéraire 67. En requête unique BRouter renvoyait 2 points et 1 m ;
    // découpé, chaque tronçon est honoré et la boucle se referme.
    mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 264),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.02, 46.5, 520]], 326),
      [KEY_CA]: brouterResponse([[6.02, 46.5, 520], [6.0, 46.5, 500]], 193),
    })

    const r = await routeLegs([A, B, C, A], 'trekking', new AbortController().signal)

    expect(r.distanceM).toBe(783)
    expect(r.geometry).toHaveLength(4)
    expect(r.geometry[0]).toEqual([6.0, 46.5, 500])
    expect(r.geometry[r.geometry.length - 1]).toEqual([6.0, 46.5, 500])
  })

  it('concatène les voicehints en les ancrant sur leur coordonnée', async () => {
    mockBrouter({
      [KEY_AB]: brouterResponse(
        [[6.0, 46.5, 500], [6.005, 46.5, 505], [6.01, 46.5, 510]],
        800,
        [[1, 5, 0, 86, 78]],
      ),
      [KEY_BC]: brouterResponse(
        [[6.01, 46.5, 510], [6.015, 46.5, 515], [6.02, 46.5, 520]],
        700,
        [[1, 3, 2, 112, -21]],
      ),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)

    // Les index de chaque tronçon sont résolus en coordonnées : aucun décalage à corriger
    // à la concaténation, et la densification ultérieure ne les invalidera pas.
    expect(r.voiceHints).toEqual([
      { lng: 6.005, lat: 46.5, cmd: 5, angle: 78, exit_number: 0 },
      { lng: 6.015, lat: 46.5, cmd: 3, angle: -21, exit_number: 2 },
    ])
  })

  it('trace en ligne droite le tronçon entrant d’un waypoint libre', async () => {
    const { calls } = mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5], [6.01, 46.5]], 800),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.02, 46.5, 520]], 700),
    })

    // B est libre → le tronçon A→B est droit ; C ne l'est pas → B→C reste routé.
    const r = await routeLegs([A, wp(6.01, 46.5, true), C], 'trekking', new AbortController().signal)

    const straightParams = calls.map((u) => new URL(u, 'http://x').searchParams.get('straight'))
    expect(straightParams).toEqual(['0', null])
    expect(r.hasStraight).toBe(true)
  })

  it('ne signale pas de tronçon droit quand aucun waypoint n’est libre', async () => {
    mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
    })

    const r = await routeLegs([A, B], 'trekking', new AbortController().signal)
    expect(r.hasStraight).toBe(false)
  })

  it('impute l’échec au tronçon fautif', async () => {
    mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
      // BRouter répond 200 avec une trace dégénérée quand il ne trouve rien.
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510]], 1),
    })

    const err = await routeLegs([A, B, C], 'trekking', new AbortController().signal).catch((e) => e)

    expect(err).toBeInstanceOf(LegRoutingError)
    // Tronçon 1 = waypoint[1] → waypoint[2], donc B → C.
    expect((err as LegRoutingError).legIndex).toBe(1)
  })

  it('réutilise les tronçons en cache : déplacer un waypoint n’en recalcule que deux', async () => {
    const D = wp(6.03, 46.5)
    const KEY_CD = '6.020000,46.500000|6.030000,46.500000'
    const responses = {
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.02, 46.5, 520]], 700),
      [KEY_CD]: brouterResponse([[6.02, 46.5, 520], [6.03, 46.5, 530]], 600),
    }
    const { fetchMock } = mockBrouter(responses)

    await routeLegs([A, B, C, D], 'trekking', new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // On déplace C : seuls les tronçons B→C' et C'→D changent, A→B sort du cache.
    const C2 = wp(6.025, 46.5)
    Object.assign(responses, {
      '6.010000,46.500000|6.025000,46.500000': brouterResponse([[6.01, 46.5, 510], [6.025, 46.5, 525]], 750),
      '6.025000,46.500000|6.030000,46.500000': brouterResponse([[6.025, 46.5, 525], [6.03, 46.5, 530]], 400),
    })
    fetchMock.mockClear()

    await routeLegs([A, B, C2, D], 'trekking', new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('le profil fait partie de la clé de cache', async () => {
    const { fetchMock } = mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
    })

    await routeLegs([A, B], 'trekking', new AbortController().signal)
    await routeLegs([A, B], 'trekking', new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(1) // même profil → cache

    await routeLegs([A, B], 'fastbike', new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(2) // profil différent → recalcul
  })

  it('ne route rien en dessous de deux waypoints', async () => {
    const { fetchMock } = mockBrouter({})

    const r = await routeLegs([A], 'trekking', new AbortController().signal)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ geometry: [], distanceM: 0, voiceHints: [], hasStraight: false })
  })
})

describe('remontée des erreurs', () => {
  it('impute aussi une erreur réseau au tronçon fautif', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    const err = await routeLegs([A, B], 'trekking', new AbortController().signal).catch((e) => e)

    expect(err).toBeInstanceOf(LegRoutingError)
    expect((err as LegRoutingError).legIndex).toBe(0)
  })

  it('laisse remonter l’annulation telle quelle', async () => {
    // Un recalcul supplanté annule ses requêtes : l'appelant doit pouvoir distinguer
    // cette annulation d'un vrai échec de routage, sans quoi il afficherait une erreur.
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }))

    const err = await routeLegs([A, B], 'trekking', new AbortController().signal).catch((e) => e)

    expect(err).not.toBeInstanceOf(LegRoutingError)
    expect(err.name).toBe('AbortError')
  })
})

describe('demi-tour à la jonction de deux tronçons', () => {
  // BRouter n'émet aucun voicehint aux extrémités d'un tronçon : sans synthèse, le
  // demi-tour d'un waypoint posé dans une impasse — le motif même que les avertissements
  // de sauvegarde traquent — deviendrait invisible.

  it('synthétise un hint de demi-tour quand le tracé repart en sens inverse', async () => {
    mockBrouter({
      // On va vers l'est jusqu'à B…
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.005, 46.5, 505], [6.01, 46.5, 510]], 800),
      // …puis on repart vers l'ouest : demi-tour sur B.
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.005, 46.5, 505], [6.02, 46.5, 520]], 700),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)

    const uturns = r.voiceHints.filter((h) => h.cmd === 15)
    expect(uturns).toHaveLength(1)
    // Ancré sur la jonction elle-même, donc sur le waypoint : c'est ce qui permet à
    // detectUturnAnomalies de l'imputer au bon point d'étape.
    expect(uturns[0].lng).toBe(6.01)
    expect(uturns[0].lat).toBe(46.5)
    expect(Math.abs(uturns[0].angle)).toBeGreaterThanOrEqual(150)
  })

  it('n’en synthétise pas quand le tracé continue tout droit', async () => {
    mockBrouter({
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.02, 46.5, 520]], 700),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)
    expect(r.voiceHints.filter((h) => h.cmd === 15)).toHaveLength(0)
  })

  it('n’en synthétise pas pour un simple virage à angle droit', async () => {
    mockBrouter({
      // Vers l'est, puis plein nord : 90°, ce n'est pas un demi-tour.
      [KEY_AB]: brouterResponse([[6.0, 46.5, 500], [6.01, 46.5, 510]], 800),
      [KEY_BC]: brouterResponse([[6.01, 46.5, 510], [6.01, 46.51, 520]], 700),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)
    expect(r.voiceHints.filter((h) => h.cmd === 15)).toHaveLength(0)
  })

  it('conserve l’ordre de parcours des hints', async () => {
    mockBrouter({
      [KEY_AB]: brouterResponse(
        [[6.0, 46.5, 500], [6.005, 46.5, 505], [6.01, 46.5, 510]], 800, [[1, 5, 0, 86, 78]],
      ),
      [KEY_BC]: brouterResponse(
        [[6.01, 46.5, 510], [6.005, 46.5, 505], [6.02, 46.5, 520]], 700, [[1, 3, 0, 50, -21]],
      ),
    })

    const r = await routeLegs([A, B, C], 'trekking', new AbortController().signal)

    // turnsFromVoiceHints apparie les hints au tracé avec un curseur monotone : le hint de
    // jonction doit s'intercaler entre ceux des deux tronçons, pas être ajouté en fin.
    expect(r.voiceHints.map((h) => h.cmd)).toEqual([5, 15, 3])
  })
})
