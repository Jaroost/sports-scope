import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveNavSession, loadNavSession, clearNavSession } from './navSession'
import type { NavSession } from './navSession'

// La session de navigation persiste dans le localStorage ce QUE l'on suit (tracé complet)
// pour survivre à un rechargement de page. On simule le stockage : ces tests couvrent le
// contrat d'écriture/lecture, la péremption et la robustesse aux entrées corrompues.

const KEY = 'sportsScope.navSession'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => { map.set(k, v) }),
    removeItem: (k: string) => { map.delete(k) },
  }
}

let storage: ReturnType<typeof fakeStorage>

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function payload(over: Partial<Omit<NavSession, 'v' | 't'>> = {}): Omit<NavSession, 'v' | 't'> {
  return {
    name: 'Col du Marchairuz',
    token: 'abc123',
    routeId: 42,
    sport: 'cycling',
    profile: 'trekking',
    geometry: [[6.1, 46.5, 500], [6.2, 46.6, 700]],
    hints: [],
    waypoints: [{ lng: 6.1, lat: 46.5 }],
    vias: [],
    pois: [],
    markers: [],
    ...over,
  }
}

describe('saveNavSession / loadNavSession', () => {
  it('relit à l’identique ce qui a été enregistré', () => {
    saveNavSession(payload())
    const s = loadNavSession()

    expect(s).toMatchObject({ v: 1, name: 'Col du Marchairuz', token: 'abc123', routeId: 42 })
    expect(s!.geometry).toEqual([[6.1, 46.5, 500], [6.2, 46.6, 700]])
    expect(typeof s!.t).toBe('number')
  })

  it('renvoie null quand rien n’a été enregistré', () => {
    expect(loadNavSession()).toBeNull()
  })

  it('efface au lieu d’enregistrer un tracé trop court', () => {
    saveNavSession(payload())
    saveNavSession(payload({ geometry: [[6.1, 46.5, 500]] }))

    expect(storage.map.has(KEY)).toBe(false)
    expect(loadNavSession()).toBeNull()
  })

  it('efface plutôt que de laisser une entrée tronquée si le quota explose', () => {
    saveNavSession(payload())
    storage.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError') })
    saveNavSession(payload({ name: 'Trop long' }))

    expect(storage.map.has(KEY)).toBe(false)
  })

  it('ne casse pas si le stockage est indisponible (mode privé)', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => saveNavSession(payload())).not.toThrow()
    expect(loadNavSession()).toBeNull()
    expect(() => clearNavSession()).not.toThrow()
  })
})

describe('péremption', () => {
  it('rend la session d’une séance en cours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T08:00:00Z'))
    saveNavSession(payload())

    vi.setSystemTime(new Date('2026-07-25T19:00:00Z'))   // 11 h plus tard
    expect(loadNavSession()).not.toBeNull()
  })

  it('oublie (et efface) la session au-delà de 12 h', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T08:00:00Z'))
    saveNavSession(payload())

    vi.setSystemTime(new Date('2026-07-25T08:00:00Z'))   // le lendemain
    expect(loadNavSession()).toBeNull()
    expect(storage.map.has(KEY)).toBe(false)
  })
})

describe('entrées corrompues', () => {
  it.each([
    ['JSON illisible', '{pas du json'],
    ['version inconnue', JSON.stringify({ v: 2, t: Date.now(), geometry: [[0, 0], [1, 1]] })],
    ['horodatage absent', JSON.stringify({ v: 1, geometry: [[0, 0], [1, 1]] })],
    ['géométrie absente', JSON.stringify({ v: 1, t: Date.now() })],
    ['géométrie trop courte', JSON.stringify({ v: 1, t: Date.now(), geometry: [[0, 0]] })],
    ['contenu nul', 'null'],
  ])('rejette et efface : %s', (_label, raw) => {
    storage.map.set(KEY, raw)

    expect(loadNavSession()).toBeNull()
    expect(storage.map.has(KEY)).toBe(false)
  })
})

describe('clearNavSession', () => {
  it('supprime la session mémorisée', () => {
    saveNavSession(payload())
    clearNavSession()

    expect(storage.map.has(KEY)).toBe(false)
    expect(loadNavSession()).toBeNull()
  })
})
