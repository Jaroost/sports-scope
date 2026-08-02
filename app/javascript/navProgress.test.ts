import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { progressKey, loadProgress, saveProgress, clearProgress, clearAllProgress } from './navProgress'

// La progression mémorisée dit OÙ l'on en est le long du tracé : c'est elle qui, après un
// rechargement, fait repartir sur le bon passage d'un tracé qui se recoupe. Une entrée
// périmée, hors-tracé ou corrompue doit se traduire par « pas d'indice » (-1, recherche
// globale) et jamais par un indice faux, qui déraillerait virages et arrivée.

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    get length() { return map.size },
    key: (i: number) => [...map.keys()][i] ?? null,
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

describe('progressKey', () => {
  it('donne une entrée par trajet, et une entrée dédiée hors itinéraire', () => {
    expect(progressKey('abc123')).toBe('sportsScope.navProgress.abc123')
    // Navigation libre / destination ad hoc : pas de token, mais on mémorise quand même.
    expect(progressKey(null)).toBe('sportsScope.navProgress.none')
  })
})

describe('saveProgress / loadProgress', () => {
  it('relit l’indice enregistré pour ce trajet', () => {
    saveProgress('abc123', 42, 0)
    expect(loadProgress('abc123', 100)).toBe(42)
  })

  it('ne mélange pas les trajets', () => {
    saveProgress('abc123', 42, 0)
    expect(loadProgress('autre', 100)).toBe(-1)
  })

  it('n’écrit qu’une fois toutes les 3 s (la progression change à chaque fix)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T10:00:00Z'))

    const t1 = saveProgress('abc123', 10, 0)
    expect(storage.setItem).toHaveBeenCalledTimes(1)

    // Fix suivant, 1 s plus tard : trop tôt, rien n'est écrit et le jalon ne bouge pas.
    vi.advanceTimersByTime(1000)
    const t2 = saveProgress('abc123', 11, t1)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(t2).toBe(t1)
    expect(loadProgress('abc123', 100)).toBe(10)

    vi.advanceTimersByTime(2500)
    const t3 = saveProgress('abc123', 12, t2)
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(t3).toBeGreaterThan(t2)
    expect(loadProgress('abc123', 100)).toBe(12)
  })

  it('oublie une progression de plus de 30 min (et purge l’entrée)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T10:00:00Z'))
    saveProgress('abc123', 42, 0)

    vi.setSystemTime(new Date('2026-07-25T10:29:00Z'))
    expect(loadProgress('abc123', 100)).toBe(42)

    vi.setSystemTime(new Date('2026-07-25T10:31:00Z'))
    expect(loadProgress('abc123', 100)).toBe(-1)
    expect(storage.map.has(progressKey('abc123'))).toBe(false)
  })

  it('écarte un indice hors du tracé (tracé recalculé depuis l’écriture)', () => {
    saveProgress('abc123', 900, 0)
    // Le tracé rerouté ne fait plus que 100 sommets : mieux vaut une recherche globale.
    expect(loadProgress('abc123', 100)).toBe(-1)
    expect(loadProgress('abc123', 901)).toBe(900)
  })

  it('rend -1 sans entrée, sur JSON illisible ou sur charge incomplète', () => {
    expect(loadProgress('abc123', 100)).toBe(-1)

    storage.map.set(progressKey('abc123'), 'pas du json')
    expect(loadProgress('abc123', 100)).toBe(-1)

    storage.map.set(progressKey('abc123'), JSON.stringify({ idx: 5 }))
    expect(loadProgress('abc123', 100)).toBe(-1)

    storage.map.set(progressKey('abc123'), JSON.stringify({ t: Date.now() }))
    expect(loadProgress('abc123', 100)).toBe(-1)
  })

  it('ne casse pas la séance quand le stockage est indisponible', () => {
    vi.stubGlobal('localStorage', {
      get length(): number { throw new Error('SecurityError') },
      key: () => { throw new Error('SecurityError') },
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => { throw new Error('SecurityError') },
    })

    expect(() => saveProgress('abc123', 42, 0)).not.toThrow()
    expect(loadProgress('abc123', 100)).toBe(-1)
    expect(() => clearProgress('abc123')).not.toThrow()
    expect(() => clearAllProgress()).not.toThrow()
  })
})

describe('clearProgress / clearAllProgress', () => {
  it('oublie la progression du seul trajet visé', () => {
    saveProgress('abc123', 42, 0)
    saveProgress('autre', 7, 0)

    clearProgress('abc123')

    expect(loadProgress('abc123', 100)).toBe(-1)
    expect(loadProgress('autre', 100)).toBe(7)
  })

  it('oublie toutes les progressions sans toucher au reste du stockage', () => {
    saveProgress('abc123', 42, 0)
    saveProgress('autre', 7, 0)
    saveProgress(null, 3, 0)
    storage.map.set('sportsScope.navSession', '{"v":1}')
    storage.map.set('autreCle', 'valeur')

    clearAllProgress()

    expect(loadProgress('abc123', 100)).toBe(-1)
    expect(loadProgress('autre', 100)).toBe(-1)
    expect(loadProgress(null, 100)).toBe(-1)
    // La session (QUEL tracé) et les clés étrangères survivent.
    expect(storage.map.get('sportsScope.navSession')).toBe('{"v":1}')
    expect(storage.map.get('autreCle')).toBe('valeur')
  })
})
