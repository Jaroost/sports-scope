// @vitest-environment happy-dom
// Le sous-système pose de vrais marqueurs (éléments DOM numérotés) et une tooltip : on le
// teste dans un DOM, avec une fausse carte MapLibre et BRouter bouchonné.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useDestinationNav } from './useDestinationNav'
import { i18n } from '../i18n'
import { fetchRouteVia } from '../navRoute'
import type { Coord, LngLat, VoiceHint } from '../routeHelpers'

vi.mock('../navRoute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../navRoute')>()),
  fetchRouteVia: vi.fn(),
}))

// Le contenu de la tooltip d'une étape appartient à mapCoordPopup (et sonde Street View
// via un script Google) : ici on ne vérifie que l'ouverture et la fermeture du popup.
vi.mock('../mapCoordPopup', () => ({
  buildDestPointPopupContent: () => document.createElement('div'),
}))

const fetchMock = vi.mocked(fetchRouteVia)

i18n.store({
  en: {
    routes: {
      navigate_here: 'Naviguer ici',
      navigate_via_points: 'Naviguer (%{count} points)',
      destination: 'Destination',
      error_routing: 'Routage impossible',
      waypoint: 'Étape',
      copy: 'Copier',
      google_maps: 'Google Maps',
      street_view: 'Street View',
      delete: 'Supprimer',
      close: 'Fermer',
    },
  },
})
i18n.locale = 'en'
i18n.enableFallback = true

// ─── Doublures MapLibre ────────────────────────────────────────────────────────

class FakeMarker {
  el: HTMLElement
  lngLat: LngLat = [0, 0]
  removed = false
  handlers: Record<string, ((...args: any[]) => void)[]> = {}
  constructor(opts: { element: HTMLElement }) { this.el = opts.element }
  setLngLat(ll: LngLat) { this.lngLat = ll; return this }
  addTo() { return this }
  on(ev: string, fn: (...args: any[]) => void) { (this.handlers[ev] ||= []).push(fn); return this }
  emit(ev: string) { (this.handlers[ev] ?? []).forEach((fn) => fn()) }
  getElement() { return this.el }
  getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] } }
  remove() { this.removed = true }
}

class FakePopup {
  removed = false
  content: HTMLElement | null = null
  setLngLat() { return this }
  setDOMContent(el: HTMLElement) { this.content = el; return this }
  addTo() { return this }
  remove() { this.removed = true }
}

// Route BRouter bouchonnée : segment droit de `n` sommets d'ouest en est.
function fakeRoute(n = 11): { geometry: Coord[]; hints: VoiceHint[] } {
  return {
    geometry: Array.from({ length: n }, (_, i) => [6.0 + i * 0.01, 46.5, 500] as Coord),
    hints: [],
  }
}

function setup(opts: { lastPos?: LngLat | null } = {}) {
  const markers: FakeMarker[] = []
  const popups: FakePopup[] = []
  const maplibre = {
    Marker: class extends FakeMarker {
      constructor(o: any) { super(o); markers.push(this) }
    },
    Popup: class extends FakePopup {
      constructor() { super(); popups.push(this) }
    },
  }

  const sources = new Map<string, { data: any; setData: (d: any) => void }>()
  const layers = new Set<string>()
  let onLine: any[] = []
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, cfg: any) => {
      const src = { data: cfg.data, setData(d: any) { this.data = d } }
      sources.set(id, src)
    },
    addLayer: (cfg: any) => { layers.add(cfg.id) },
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    queryRenderedFeatures: () => onLine,
    setPaintProperty: vi.fn(),
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
  }

  let lastPos: LngLat | null = opts.lastPos === undefined ? [6.0, 46.5] : opts.lastPos
  const navError = ref<string | null>(null)
  const routeSport = ref('cycling' as any)
  const routeProfile = ref('trekking')
  const routeName = ref('')
  const routeToken = ref<string | null>('tok')
  const following = ref(true)
  const cameraUnlocked = ref(false)
  const applyReroute = vi.fn()
  const setRouteVias = vi.fn()
  const persistSession = vi.fn()
  const hideControls = vi.fn()

  const nav = useDestinationNav({
    getMap: () => map,
    getMaplibre: () => maplibre,
    getLastPos: () => lastPos,
    navError,
    routeSport, routeProfile, routeName, routeToken, following, cameraUnlocked,
    lineWidthExpr: () => 6,
    applyReroute,
    setRouteVias,
    persistSession,
    hideControls,
  })

  return {
    nav, map, markers, popups, sources, navError, routeSport, routeProfile, routeName,
    routeToken, following, cameraUnlocked, applyReroute, setRouteVias, persistSession,
    hideControls,
    setLastPos: (p: LngLat | null) => { lastPos = p },
    setOnLine: (features: any[]) => { onLine = features },
    previewData: () => sources.get('nav-place-preview')?.data,
  }
}

const tap = (lngLat: LngLat): [any, LngLat] => [{ x: 0, y: 0 }, lngLat]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(fakeRoute())
})

describe('useDestinationNav', () => {
  it('ouvre le mode cible sur les réglages de la séance et referme le tiroir', () => {
    const { nav, hideControls, routeSport, routeProfile, navError } = setup()
    routeSport.value = 'running' as any
    routeProfile.value = 'hiking-mountain'
    navError.value = 'vieille erreur'

    nav.startPlaceNav()

    expect(nav.placeNavActive.value).toBe(true)
    expect(nav.navSport.value).toBe('running')
    expect(nav.navProfile.value).toBe('hiking-mountain')
    expect(navError.value).toBeNull()
    expect(hideControls).toHaveBeenCalledOnce()
  })

  it('pose des points d’étape numérotés au tap et n’en garde aucun après annulation', async () => {
    const { nav, markers } = setup()
    nav.startPlaceNav()

    expect(nav.handleMapTap(...tap([6.03, 46.5]))).toBe(true)
    nav.handleMapTap(...tap([6.07, 46.5]))
    await vi.waitFor(() => expect(nav.previewDistM.value).not.toBeNull())

    expect(nav.destPoints.value).toEqual([[6.03, 46.5], [6.07, 46.5]])
    expect(markers.map((m) => m.el.querySelector('.nav-dest-num')?.textContent)).toEqual(['1', '2'])

    nav.cancelPlaceNav()
    expect(nav.placeNavActive.value).toBe(false)
    expect(nav.destPoints.value).toEqual([])
    expect(markers.every((m) => m.removed)).toBe(true)
    expect(nav.previewDistM.value).toBeNull()
  })

  it('ignore le tap hors mode cible (il met l’écran en veille)', () => {
    const { nav } = setup()
    expect(nav.handleMapTap(...tap([6.03, 46.5]))).toBe(false)
    expect(nav.destPoints.value).toEqual([])
  })

  it('insère l’étape au bon rang quand le tap tombe sur le trajet d’aperçu', async () => {
    const { nav, setOnLine, markers } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.05, 46.5]))
    nav.handleMapTap(...tap([6.1, 46.5]))
    await vi.waitFor(() => expect(nav.previewDistM.value).not.toBeNull())

    // Tap SUR la ligne, entre la position GPS (6.0) et la 1re étape (6.05).
    setOnLine([{ id: 1 }])
    nav.handleMapTap(...tap([6.02, 46.5]))

    expect(nav.destPoints.value).toEqual([[6.02, 46.5], [6.05, 46.5], [6.1, 46.5]])
    // Les marqueurs suivent la séquence : le dernier créé porte le n° 1.
    expect(markers[2].el.querySelector('.nav-dest-num')?.textContent).toBe('1')
  })

  it('retire la dernière étape posée', async () => {
    const { nav, markers } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.03, 46.5]))
    nav.handleMapTap(...tap([6.07, 46.5]))

    nav.removeLastDestPoint()
    expect(nav.destPoints.value).toEqual([[6.03, 46.5]])
    expect(markers[1].removed).toBe(true)

    nav.removeLastDestPoint()
    expect(nav.destPoints.value).toEqual([])
    nav.removeLastDestPoint()          // sans étape : sans effet
    expect(nav.destPoints.value).toEqual([])
  })

  it('un tap referme d’abord la tooltip d’une étape ouverte', async () => {
    const { nav, markers, popups } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.03, 46.5]))
    // Clic sur le marqueur (pas un glissement) → tooltip du point.
    markers[0].el.dispatchEvent(new Event('click'))
    expect(popups).toHaveLength(1)

    // Le tap suivant ne pose PAS de point : il referme la tooltip.
    expect(nav.handleMapTap(...tap([6.08, 46.5]))).toBe(true)
    expect(popups[0].removed).toBe(true)
    expect(nav.destPoints.value).toEqual([[6.03, 46.5]])
  })

  it('déplacer un marqueur met à jour son étape et recalcule l’aperçu', async () => {
    const { nav, markers } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.03, 46.5]))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    markers[0].setLngLat([6.06, 46.5])
    markers[0].emit('dragend')

    expect(nav.destPoints.value).toEqual([[6.06, 46.5]])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith([[6.0, 46.5], [6.06, 46.5]], 'trekking')
  })

  it('trace l’aperçu depuis la position GPS et en affiche la distance', async () => {
    const { nav, previewData } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.1, 46.5]))

    await vi.waitFor(() => expect(nav.previewLoading.value).toBe(false))
    expect(fetchMock).toHaveBeenCalledWith([[6.0, 46.5], [6.1, 46.5]], 'trekking')
    expect(nav.previewDistM.value).toBeGreaterThan(0)
    expect(previewData().features[0].geometry.coordinates).toHaveLength(11)
  })

  it('n’essaie pas de tracer d’aperçu sans fix GPS', async () => {
    const { nav } = setup({ lastPos: null })
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.1, 46.5]))

    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(nav.previewDistM.value).toBeNull()
  })

  it('écarte une réponse d’aperçu devenue obsolète', async () => {
    const { nav, previewData } = setup()
    nav.startPlaceNav()

    // Première réponse volontairement lente : elle arrivera après un second changement.
    let resolveSlow: (r: any) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((res) => { resolveSlow = res }))
    nav.handleMapTap(...tap([6.2, 46.5]))       // aperçu lent, encore en vol
    nav.handleMapTap(...tap([6.05, 46.5]))      // second changement → aperçu à jour
    await vi.waitFor(() => expect(nav.previewDistM.value).not.toBeNull())
    const fresh = previewData()

    resolveSlow(fakeRoute(3))
    await new Promise((r) => setTimeout(r, 0))
    // L'aperçu affiché reste celui du dernier changement (11 sommets, pas 3).
    expect(previewData()).toBe(fresh)
    expect(previewData().features[0].geometry.coordinates).toHaveLength(11)
  })

  it('le changement de profil du trajet relance l’aperçu', async () => {
    const { nav } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.1, 46.5]))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    nav.applyNavRouting({ sport: 'running' as any, profile: 'hiking-mountain' })
    expect(nav.navProfile.value).toBe('hiking-mountain')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenLastCalledWith([[6.0, 46.5], [6.1, 46.5]], 'hiking-mountain')
  })

  it('libellé de validation : « ici » pour une étape, compté au-delà', () => {
    const { nav } = setup()
    nav.startPlaceNav()
    nav.handleMapTap(...tap([6.03, 46.5]))
    expect(nav.confirmLabel.value).toBe('Naviguer ici')
    nav.handleMapTap(...tap([6.07, 46.5]))
    expect(nav.confirmLabel.value).toBe('Naviguer (2 points)')
  })

  it('la validation réutilise l’aperçu et installe le trajet comme tracé suivi', async () => {
    const s = setup()
    const { nav } = s
    nav.startPlaceNav()
    nav.applyNavRouting({ sport: 'running' as any, profile: 'hiking-mountain' })
    nav.handleMapTap(...tap([6.1, 46.5]))
    await vi.waitFor(() => expect(nav.previewDistM.value).not.toBeNull())
    const callsBefore = fetchMock.mock.calls.length

    await nav.confirmPlaceNav()

    // Pas de second appel BRouter : c'est l'aperçu qui devient le tracé.
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)
    expect(s.applyReroute).toHaveBeenCalledOnce()
    expect(s.applyReroute.mock.calls[0][0]).toHaveLength(11)
    // Le trajet reverse ses réglages dans la séance…
    expect(s.routeSport.value).toBe('running')
    expect(s.routeProfile.value).toBe('hiking-mountain')
    // … et devient une destination ad hoc : pas de token (ni hors-ligne ni reprise).
    expect(s.routeToken.value).toBeNull()
    expect(s.routeName.value).toBe('Destination')
    expect(s.setRouteVias).toHaveBeenCalledWith([[6.1, 46.5]])
    expect(s.persistSession).toHaveBeenCalled()
    // Mode cible refermé, suivi caméra réarmé.
    expect(nav.placeNavActive.value).toBe(false)
    expect(nav.destPoints.value).toEqual([])
    expect(s.following.value).toBe(true)
    expect(s.cameraUnlocked.value).toBe(false)
  })

  it('reprend le nom du lieu cherché comme nom du trajet', async () => {
    const s = setup()
    s.nav.startPlaceNav()
    s.nav.onLocate({ display_name: 'Gruyères, Fribourg, Suisse', lat: '46.58', lon: '7.08' } as any)
    // La recherche ne fait que recadrer : elle ne fixe aucune étape.
    expect(s.nav.destPoints.value).toEqual([])
    expect(s.following.value).toBe(false)
    expect(s.cameraUnlocked.value).toBe(true)
    expect(s.map.flyTo).toHaveBeenCalledOnce()

    s.nav.handleMapTap(...tap([7.08, 46.58]))
    await s.nav.confirmPlaceNav()
    expect(s.routeName.value).toBe('Gruyères')
  })

  it('« Naviguer ici » depuis un POI route avec le profil de la séance', async () => {
    const s = setup()
    // Mode cible fermé : ce sont les réglages de la séance qui pilotent le calcul.
    await s.nav.navigateTo('Boulangerie', [6.12, 46.5])

    expect(fetchMock).toHaveBeenCalledWith([[6.0, 46.5], [6.12, 46.5]], 'trekking')
    expect(s.applyReroute).toHaveBeenCalledOnce()
    expect(s.routeName.value).toBe('Boulangerie')
    expect(s.setRouteVias).toHaveBeenCalledWith([[6.12, 46.5]])
  })

  it('ne lance rien sans fix GPS', async () => {
    const s = setup({ lastPos: null })
    await s.nav.navigateTo('Boulangerie', [6.12, 46.5])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(s.applyReroute).not.toHaveBeenCalled()
  })

  it('signale un échec BRouter sans toucher au tracé suivi', async () => {
    const s = setup()
    fetchMock.mockRejectedValueOnce(new Error('BRouter HTTP 500'))

    await s.nav.navigateTo('Boulangerie', [6.12, 46.5])

    expect(s.navError.value).toBe('Routage impossible')
    expect(s.applyReroute).not.toHaveBeenCalled()
    expect(s.nav.navStarting.value).toBe(false)
  })

  it('repeint la largeur de la ligne d’aperçu au changement de sport', async () => {
    const s = setup()
    s.nav.startPlaceNav()
    s.nav.handleMapTap(...tap([6.1, 46.5]))
    await vi.waitFor(() => expect(s.nav.previewDistM.value).not.toBeNull())

    s.nav.applyPreviewLinePaint()
    expect(s.map.setPaintProperty).toHaveBeenCalledWith('nav-place-preview', 'line-width', 6)
  })
})
