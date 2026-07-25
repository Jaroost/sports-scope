import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { usePlaceSearch, placeShortName, flyToPlace } from './usePlaceSearch'
import type { PlaceResult } from './usePlaceSearch'

// Recherche de lieu partagée par le créateur d'itinéraire et la navigation. Elle interroge
// Nominatim en privilégiant les pays du profil : c'est ce filtrage, l'anti-rebond et le
// repli mondial qui sont testés ici — le réseau est bouchonné.

const prefs = { search: { country_codes: ['ch', 'fr'], worldwide_fallback: false } }

vi.mock('../userPreferences', () => ({ userPreferences: () => prefs }))

let nextId = 1
function result(name: string, cc?: string, over: Partial<PlaceResult> = {}): PlaceResult {
  return {
    place_id: nextId++,
    display_name: name,
    lat: '46.5',
    lon: '6.0',
    address: cc ? { country_code: cc } : undefined,
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

/** Réponses successives de Nominatim (une par appel). */
function respondWith(...batches: PlaceResult[][]) {
  batches.forEach((batch) => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => batch })
  })
}

const urlOf = (call: number) => String(fetchMock.mock.calls[call][0])

// Saisit une requête et laisse filer l'anti-rebond (350 ms). La variante async d'avance
// des minuteurs vide aussi la file des microtâches : sans elle, les promesses de fetch ne
// seraient pas résolues au moment des assertions.
async function type(searchQuery: { value: string }, q: string, waitMs = 400) {
  searchQuery.value = q
  await nextTick()              // le watcher arme le minuteur
  await vi.advanceTimersByTimeAsync(waitMs)
}

beforeEach(() => {
  prefs.search = { country_codes: ['ch', 'fr'], worldwide_fallback: false }
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usePlaceSearch', () => {
  it('restreint la recherche aux pays du profil', async () => {
    const search = usePlaceSearch()
    respondWith([result('Gruyères', 'ch')])

    await type(search.searchQuery, 'gruyeres')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(urlOf(0)).toContain('q=gruyeres')
    expect(urlOf(0)).toContain('countrycodes=ch,fr')
    expect(search.searchResults.value.map((r) => r.display_name)).toEqual(['Gruyères'])
    expect(search.searchOpen.value).toBe(true)
    expect(search.searching.value).toBe(false)
  })

  it('ordonne les résultats selon la priorité des pays du profil', async () => {
    const search = usePlaceSearch()
    // Nominatim les renvoie dans son propre ordre : France, pays hors liste, Suisse.
    respondWith([result('Bourg-FR', 'fr'), result('Bourg-IT', 'it'), result('Bourg-CH', 'ch')])

    await type(search.searchQuery, 'bourg')

    // 'ch' d'abord (1er du profil), puis 'fr', puis les pays hors liste.
    expect(search.searchResults.value.map((r) => r.display_name))
      .toEqual(['Bourg-CH', 'Bourg-FR', 'Bourg-IT'])
  })

  it('plafonne la liste à six résultats', async () => {
    const search = usePlaceSearch()
    respondWith(Array.from({ length: 10 }, (_, i) => result(`Lieu ${i}`, 'ch')))

    await type(search.searchQuery, 'lieu')

    expect(search.searchResults.value).toHaveLength(6)
  })

  it('élargit au monde entier quand le profil l’autorise et que rien n’est trouvé', async () => {
    prefs.search = { country_codes: ['ch', 'fr'], worldwide_fallback: true }
    const search = usePlaceSearch()
    respondWith([], [result('Kyoto', 'jp')])

    await type(search.searchQuery, 'kyoto')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(urlOf(1)).not.toContain('countrycodes')
    expect(search.searchResults.value.map((r) => r.display_name)).toEqual(['Kyoto'])
  })

  it('n’élargit pas quand le profil ne l’autorise pas', async () => {
    const search = usePlaceSearch()          // worldwide_fallback: false
    respondWith([])

    await type(search.searchQuery, 'kyoto')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(search.searchResults.value).toEqual([])
    expect(search.searchOpen.value).toBe(false)
  })

  it('cherche d’emblée dans le monde entier si le profil ne privilégie aucun pays', async () => {
    prefs.search = { country_codes: [], worldwide_fallback: true }
    const search = usePlaceSearch()
    respondWith([])

    await type(search.searchQuery, 'kyoto')

    // Pas de second appel : le premier était déjà mondial.
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(urlOf(0)).not.toContain('countrycodes')
  })

  it('attend trois caractères avant d’interroger le service', async () => {
    const search = usePlaceSearch()

    await type(search.searchQuery, 'gr')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(search.searchOpen.value).toBe(false)

    respondWith([result('Gruyères', 'ch')])
    await type(search.searchQuery, 'gru')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('ne lance qu’une requête pour une saisie au fil de la frappe', async () => {
    const search = usePlaceSearch()
    respondWith([result('Gruyères', 'ch')])

    search.searchQuery.value = 'gru'
    await nextTick()
    vi.advanceTimersByTime(200)             // avant l'échéance
    search.searchQuery.value = 'gruye'
    await nextTick()
    vi.advanceTimersByTime(200)             // le minuteur précédent a été annulé
    expect(fetchMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(urlOf(0)).toContain('q=gruye')
  })

  it('effacer la recherche annule une requête encore en attente', async () => {
    const search = usePlaceSearch()

    search.searchQuery.value = 'gruyeres'
    await nextTick()
    search.clearSearch()
    vi.advanceTimersByTime(1000)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(search.searchQuery.value).toBe('')
    expect(search.searchResults.value).toEqual([])
    expect(search.searchOpen.value).toBe(false)
  })

  it('reste silencieuse sur une erreur du service', async () => {
    const search = usePlaceSearch()
    respondWith([result('Gruyères', 'ch')])
    await type(search.searchQuery, 'gruyeres')
    expect(search.searchOpen.value).toBe(true)

    // Service en panne (HTTP 5xx) : la liste se vide au lieu de rester sur d'anciens
    // résultats, et l'indicateur de chargement retombe.
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => [] })
    await type(search.searchQuery, 'lausanne')

    expect(search.searchResults.value).toEqual([])
    expect(search.searchOpen.value).toBe(false)
    expect(search.searching.value).toBe(false)
  })

  it('survit à une coupure réseau', async () => {
    const search = usePlaceSearch()
    fetchMock.mockRejectedValueOnce(new Error('offline'))

    await type(search.searchQuery, 'gruyeres')

    expect(search.searchResults.value).toEqual([])
    expect(search.searchOpen.value).toBe(false)
    expect(search.searching.value).toBe(false)
  })
})

describe('placeShortName', () => {
  it('ne garde que la tête de l’adresse Nominatim', () => {
    expect(placeShortName(result('Gruyères, District de la Gruyère, Fribourg, Suisse')))
      .toBe('Gruyères')
  })

  it('rend le libellé tel quel s’il n’a qu’un segment', () => {
    expect(placeShortName(result('Matterhorn'))).toBe('Matterhorn')
  })
})

describe('flyToPlace', () => {
  function fakeMap() {
    return { fitBounds: vi.fn(), flyTo: vi.fn() }
  }

  it('cadre sur l’emprise du lieu quand Nominatim en donne une', () => {
    const map = fakeMap()
    // boundingbox Nominatim : [latMin, latMax, lngMin, lngMax], en chaînes.
    flyToPlace(map, result('Lac Léman', 'ch', { boundingbox: ['46.2', '46.5', '6.1', '6.9'] }))

    expect(map.fitBounds).toHaveBeenCalledWith(
      [[6.1, 46.2], [6.9, 46.5]],
      expect.objectContaining({ maxZoom: 14 }),
    )
    expect(map.flyTo).not.toHaveBeenCalled()
  })

  it('vole vers le point à défaut d’emprise', () => {
    const map = fakeMap()
    flyToPlace(map, result('Sommet', 'ch', { lat: '46.55', lon: '6.75' }))

    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [6.75, 46.55] }))
    expect(map.fitBounds).not.toHaveBeenCalled()
  })

  it('ignore une emprise incomplète et retombe sur le point', () => {
    const map = fakeMap()
    flyToPlace(map, result('Bizarre', 'ch', { boundingbox: ['46.2', '46.5'] }))

    expect(map.fitBounds).not.toHaveBeenCalled()
    expect(map.flyTo).toHaveBeenCalledOnce()
  })

  it('ne bouge pas la carte sur des coordonnées illisibles', () => {
    const map = fakeMap()
    flyToPlace(map, result('Cassé', 'ch', { lat: 'n/a', lon: 'n/a' }))

    expect(map.flyTo).not.toHaveBeenCalled()
    expect(map.fitBounds).not.toHaveBeenCalled()
  })

  it('ne fait rien sans carte (composant pas encore monté)', () => {
    expect(() => flyToPlace(null, result('Gruyères', 'ch'))).not.toThrow()
  })
})
