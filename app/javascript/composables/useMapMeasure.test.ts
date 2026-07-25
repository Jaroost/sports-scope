// @vitest-environment happy-dom
// Le mode règle pose de vraies poignées (éléments DOM) et écoute leurs gestes : on le teste
// dans un DOM, avec une fausse carte MapLibre. Le composable est monté dans un composant
// minimal, pour que son nettoyage au démontage soit exercé lui aussi.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { useMapMeasure, MEASURE_SOURCE } from './useMapMeasure'
import { i18n } from '../i18n'
import { moveLngLat } from '../navHelpers'
import { haversine } from '../routeHelpers'
import type { LngLat } from '../routeHelpers'

i18n.store({ en: { routes: { measure_start: 'Départ', measure_remove_point: 'Retirer' } } })
i18n.locale = 'en'
i18n.enableFallback = true

const START: LngLat = [6.0, 46.5]

class FakeMarker {
  el: HTMLElement
  lngLat: LngLat = [0, 0]
  removed = false
  constructor(opts: { element: HTMLElement }) { this.el = opts.element }
  setLngLat(ll: LngLat) { this.lngLat = ll; return this }
  addTo() { return this }
  getElement() { return this.el }
  remove() { this.removed = true }
}

function setup() {
  const markers: FakeMarker[] = []
  const maplibre = {
    Marker: class extends FakeMarker {
      constructor(o: any) { super(o); markers.push(this) }
    },
  }

  let sourceData: any = null
  const dragPan = { enable: vi.fn(), disable: vi.fn() }
  const map = {
    dragPan,
    getSource: (id: string) => (id === MEASURE_SOURCE ? { setData: (d: any) => { sourceData = d } } : undefined),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    // Projection bouchonnée : 1 px = 1 mètre vers l'est / le sud depuis START.
    unproject: ([x, y]: [number, number]) => {
      const [lng, lat] = moveLngLat(moveLngLat(START, 90, x), 180, y)
      return { lng, lat }
    },
  }

  const suppressNextMapClick = vi.fn()
  let api!: ReturnType<typeof useMapMeasure>
  const app = createApp(defineComponent({
    setup() {
      api = useMapMeasure({ getMap: () => map, getMaplibre: () => maplibre, suppressNextMapClick })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))

  return {
    m: api, app, markers, map, dragPan, suppressNextMapClick,
    sourceData: () => sourceData,
    /** Poignées de points (les « + » d'insertion sont créés après elles). */
    dots: () => markers.filter((mk) => !mk.removed && mk.el.className.includes('measure-marker')),
    mids: () => markers.filter((mk) => !mk.removed && mk.el.className.includes('measure-mid-marker')),
  }
}

// Point situé à `m` mètres à l'est du départ (les distances restent lisibles).
const east = (m: number): LngLat => moveLngLat(START, 90, m)

let s: ReturnType<typeof setup>
beforeEach(() => { s = setup() })

describe('useMapMeasure', () => {
  it('pose un point par clic et une poignée par point', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))

    expect(s.m.points.value).toHaveLength(2)
    expect(s.dots()).toHaveLength(2)
    // Une seule poignée « + », au milieu de l'unique segment.
    expect(s.mids()).toHaveLength(1)
  })

  it('cumule les distances à vol d’oiseau', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))
    s.m.addPoint(...east(250))

    expect(s.m.cumM.value[0]).toBe(0)
    expect(s.m.cumM.value[1]).toBeCloseTo(100, 1)
    expect(s.m.cumM.value[2]).toBeCloseTo(250, 1)
    expect(s.m.totalM.value).toBeCloseTo(250, 1)
  })

  it('ne totalise rien sans point', () => {
    expect(s.m.totalM.value).toBe(0)
    expect(s.m.cumM.value).toEqual([0])
  })

  it('écrit la polyligne dans la source de la carte', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))

    expect(s.sourceData().geometry).toEqual({ type: 'LineString', coordinates: s.m.points.value })
  })

  it('annule le dernier point posé', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))
    s.m.undoPoint()

    expect(s.m.points.value).toHaveLength(1)
    expect(s.dots()).toHaveLength(1)
    expect(s.mids()).toHaveLength(0)
  })

  it('efface toute la mesure', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))
    s.m.clear()

    expect(s.m.points.value).toEqual([])
    expect(s.dots()).toHaveLength(0)
    expect(s.sourceData().geometry.coordinates).toEqual([])
  })

  it('retire un point par sa tooltip', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))
    s.m.addPoint(...east(200))

    s.dots()[1].el.querySelector<HTMLElement>('.measure-tooltip-delete')!.dispatchEvent(new Event('click'))

    expect(s.m.points.value.map((p) => p[0])).toEqual([east(0)[0], east(200)[0]])
  })

  it('retire un point au clic droit', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))

    s.dots()[0].el.dispatchEvent(new Event('contextmenu'))

    expect(s.m.points.value).toHaveLength(1)
  })

  it('ouvre puis referme la tooltip d’un point au clic', () => {
    s.m.addPoint(...east(0))
    const marker = s.dots()[0]

    marker.el.dispatchEvent(new Event('click'))
    expect(marker.el.className).toContain('measure-marker--selected')

    marker.el.dispatchEvent(new Event('click'))
    expect(marker.el.className).not.toContain('measure-marker--selected')
  })

  it('un clic carte referme d’abord une tooltip ouverte, sans poser de point', () => {
    s.m.addPoint(...east(0))
    s.dots()[0].el.dispatchEvent(new Event('click'))     // tooltip ouverte

    s.m.onMapClick(...east(100))
    expect(s.m.points.value).toHaveLength(1)             // rien de posé

    s.m.onMapClick(...east(100))
    expect(s.m.points.value).toHaveLength(2)             // le clic suivant, si
  })

  it('insère un point au milieu d’un segment via la poignée « + »', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(200))

    s.mids()[0].el.dispatchEvent(new Event('click'))

    expect(s.m.points.value).toHaveLength(3)
    // Le nouveau point s'insère ENTRE les deux, à leur milieu.
    expect(s.m.cumM.value[1]).toBeCloseTo(100, 1)
    expect(haversine(s.m.points.value[1], east(100))).toBeLessThan(1)
    // Deux segments désormais, donc deux poignées « + ».
    expect(s.mids()).toHaveLength(2)
  })

  it('déplace un point au glisser-déposer', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))
    const marker = s.dots()[1]

    marker.el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }))
    expect(s.dragPan.disable).toHaveBeenCalledOnce()     // la carte ne se déplace pas
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 0 }))
    window.dispatchEvent(new MouseEvent('mouseup'))

    // 300 px = 300 m à l'est dans la projection bouchonnée.
    expect(s.m.totalM.value).toBeCloseTo(300, 0)
    expect(s.dragPan.enable).toHaveBeenCalledOnce()
    // Le clic de relâchement ne doit pas poser un point de plus.
    expect(s.suppressNextMapClick).toHaveBeenCalledOnce()
    expect(s.m.points.value).toHaveLength(2)
  })

  it('un appui sans glissement ne déplace rien (souris)', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))

    s.dots()[1].el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }))
    window.dispatchEvent(new MouseEvent('mouseup'))

    expect(s.m.totalM.value).toBeCloseTo(100, 1)
    expect(s.dragPan.enable).toHaveBeenCalledOnce()
    expect(s.suppressNextMapClick).not.toHaveBeenCalled()
  })

  it('ignore le clic droit comme début de glissement', () => {
    s.m.addPoint(...east(0))
    s.dots()[0].el.dispatchEvent(new MouseEvent('mousedown', { button: 2 }))

    expect(s.dragPan.disable).not.toHaveBeenCalled()
  })

  it('glisser une poignée « + » la promeut en point et l’emmène', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(200))
    const mid = s.mids()[0]

    mid.el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 50 }))
    window.dispatchEvent(new MouseEvent('mouseup'))

    expect(s.m.points.value).toHaveLength(3)
    // Le point promu a suivi le curseur (100 m est, 50 m sud), pas le milieu du segment.
    expect(haversine(s.m.points.value[1], moveLngLat(moveLngLat(START, 90, 100), 180, 50))).toBeLessThan(1)
  })

  it('retire ses poignées au démontage du composant', () => {
    s.m.addPoint(...east(0))
    s.m.addPoint(...east(100))
    const before = [...s.dots(), ...s.mids()]
    expect(before.length).toBe(3)

    s.app.unmount()

    expect(before.every((mk) => mk.removed)).toBe(true)
  })
})
