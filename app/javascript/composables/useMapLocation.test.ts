// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { useMapLocation } from './useMapLocation'

// « Ma position » sur la carte du créateur : un fix GPS à la demande, un point bleu et son
// disque d'incertitude. Le refus de permission doit rester silencieux et laisser le bouton
// retomber — sans quoi il resterait bloqué en « acquisition ».

class FakeMarker {
  el: HTMLElement
  lngLat: any = null
  removed = false
  constructor(opts: any) { this.el = opts.element }
  setLngLat(ll: any) { this.lngLat = ll; return this }
  addTo() { return this }
  remove() { this.removed = true }
}

function setup() {
  const sources = new Map<string, { data: any; setData: (d: any) => void }>()
  const layers = new Set<string>()
  const markers: FakeMarker[] = []
  const maplibre = {
    Marker: class extends FakeMarker {
      constructor(o: any) { super(o); markers.push(this) }
    },
  }
  const map = {
    flyTo: vi.fn(),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, cfg: any) => {
      sources.set(id, { data: cfg.data, setData(d: any) { this.data = d } })
    },
    addLayer: (cfg: any) => { layers.add(cfg.id) },
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    removeLayer: (id: string) => { layers.delete(id) },
    removeSource: (id: string) => { sources.delete(id) },
  }

  let api!: ReturnType<typeof useMapLocation>
  const app = createApp(defineComponent({
    setup() {
      api = useMapLocation({ getMap: () => map, getMaplibre: () => maplibre })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))

  return { loc: api, app, map, markers, sources, layers }
}

/** Réponse de la géolocalisation du navigateur. */
function grant(lng: number, lat: number, accuracy = 20) {
  const getCurrentPosition = vi.fn((ok: any) => {
    ok({ coords: { longitude: lng, latitude: lat, accuracy } })
  })
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
  return getCurrentPosition
}

function deny() {
  const getCurrentPosition = vi.fn((_ok: any, ko: any) => ko(new Error('permission denied')))
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
  return getCurrentPosition
}

let s: ReturnType<typeof setup>
beforeEach(() => { s = setup() })
afterEach(() => { vi.unstubAllGlobals() })

describe('useMapLocation', () => {
  it('affiche le point et son disque d’incertitude, et cadre dessus', async () => {
    grant(6.1, 46.5, 35)

    await s.loc.toggle()

    expect(s.loc.locationVisible.value).toBe(true)
    expect(s.loc.locating.value).toBe(false)
    expect(s.map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [6.1, 46.5] }))
    expect(s.markers[0].lngLat).toEqual([6.1, 46.5])
    expect(s.markers[0].el.className).toBe('user-location-dot')
    // Le disque est un polygone fermé au rayon de la précision annoncée.
    expect(s.sources.get('user-location')!.data.geometry.type).toBe('Polygon')
    expect(s.layers.has('user-location-fill')).toBe(true)
    expect(s.layers.has('user-location-stroke')).toBe(true)
  })

  it('demande un fix récent plutôt qu’un fix parfait', async () => {
    const getCurrentPosition = grant(6.1, 46.5)
    await s.loc.toggle()

    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function), expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }),
    )
  })

  it('efface le repère au second appui', async () => {
    grant(6.1, 46.5)
    await s.loc.toggle()
    await s.loc.toggle()

    expect(s.loc.locationVisible.value).toBe(false)
    expect(s.markers[0].removed).toBe(true)
    expect(s.sources.has('user-location')).toBe(false)
    expect(s.layers.size).toBe(0)
  })

  it('ne redemande pas de fix pour masquer le repère', async () => {
    grant(6.1, 46.5)
    await s.loc.toggle()
    const getCurrentPosition = grant(6.2, 46.6)

    await s.loc.toggle()

    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('réutilise le même point quand on réaffiche la position', async () => {
    grant(6.1, 46.5)
    await s.loc.toggle()
    await s.loc.toggle()
    grant(6.3, 46.7)
    await s.loc.toggle()

    // Le premier marqueur a été retiré, un seul nouveau est posé.
    expect(s.markers).toHaveLength(2)
    expect(s.markers[1].lngLat).toEqual([6.3, 46.7])
  })

  it('reste silencieux quand la permission est refusée', async () => {
    deny()

    await expect(s.loc.toggle()).resolves.toBeUndefined()

    expect(s.loc.locationVisible.value).toBe(false)
    expect(s.loc.locating.value).toBe(false)     // le bouton ne reste pas bloqué
    expect(s.markers).toHaveLength(0)
    expect(s.map.flyTo).not.toHaveBeenCalled()
  })

  it('signale l’acquisition en cours', async () => {
    let resolveFix: (p: any) => void = () => {}
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (ok: any) => { resolveFix = ok } },
    })

    const pending = s.loc.toggle()
    expect(s.loc.locating.value).toBe(true)

    resolveFix({ coords: { longitude: 6.1, latitude: 46.5, accuracy: 20 } })
    await pending
    expect(s.loc.locating.value).toBe(false)
  })

  it('repose le disque après un changement de fond de carte', async () => {
    grant(6.1, 46.5)
    await s.loc.toggle()

    // setStyle emporte sources et calques : le composant rappelle reinstallLayers.
    s.sources.clear(); s.layers.clear()
    s.loc.reinstallLayers()

    expect(s.sources.has('user-location')).toBe(true)
    expect(s.layers.has('user-location-fill')).toBe(true)
  })

  it('ne repose rien si la position n’était pas affichée', () => {
    s.loc.reinstallLayers()
    expect(s.sources.size).toBe(0)
  })

  it('retire le point au démontage', async () => {
    grant(6.1, 46.5)
    await s.loc.toggle()

    s.app.unmount()

    expect(s.markers[0].removed).toBe(true)
  })
})
