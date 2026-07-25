// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createScaledMarkerGroup, MARKER_SCALE_VAR } from './mapMarkerGroup'

// Les marqueurs mis à l'échelle sont des overlays HTML : MapLibre réécrit leur `transform` à
// chaque frame et efface le scale() posé par le CSS. Le groupe le ré-applique via un
// MutationObserver — un observateur qui s'emballerait (sa propre écriture le redéclenche) ou
// qu'on oublierait de débrancher laisserait la carte ramer.

class FakeMarker {
  el: HTMLElement
  lngLat: any = null
  options: any
  removed = false
  constructor(opts: any) { this.el = opts.element; this.options = opts }
  setLngLat(ll: any) { this.lngLat = ll; return this }
  addTo(map: any) { this.map = map; return this }
  map: any = null
  remove() { this.removed = true }
}

function setup(scale?: string) {
  const container = document.createElement('div')
  if (scale !== undefined) container.style.setProperty(MARKER_SCALE_VAR, scale)
  const map = { getContainer: () => container }
  const created: FakeMarker[] = []
  const maplibre = {
    Marker: class extends FakeMarker {
      constructor(o: any) { super(o); created.push(this) }
    },
  }
  const group = createScaledMarkerGroup({ getMap: () => map, getMaplibre: () => maplibre })
  return { group, created, container, map, maplibre }
}

/** Laisse le MutationObserver livrer ses enregistrements (microtâche). */
const flush = () => new Promise((r) => setTimeout(r, 0))

function el(): HTMLElement {
  const e = document.createElement('div')
  document.body.appendChild(e)
  return e
}

let s: ReturnType<typeof setup>
beforeEach(() => {
  document.body.innerHTML = ''
  s = setup('0.5')
})

describe('createScaledMarkerGroup', () => {
  it('pose le marqueur sur la carte avec ses options', () => {
    const e = el()
    const marker = s.group.add(e, [6.0, 46.5], { anchor: 'bottom-left', draggable: true })

    expect(marker).toBe(s.created[0])
    expect(marker.lngLat).toEqual([6.0, 46.5])
    expect(marker.options).toMatchObject({ element: e, anchor: 'bottom-left', draggable: true })
    expect(marker.map).toBe(s.map)
    expect(s.group.markers).toEqual([marker])
  })

  it('ne pose rien tant que la carte n’existe pas', () => {
    const group = createScaledMarkerGroup({ getMap: () => null, getMaplibre: () => null })
    expect(group.add(el(), [6.0, 46.5])).toBeNull()
    expect(group.markers).toEqual([])
  })

  it('réapplique l’échelle courante après un repositionnement de MapLibre', async () => {
    const e = el()
    s.group.add(e, [6.0, 46.5])

    // MapLibre repositionne le marqueur : notre scale() a disparu.
    e.style.transform = 'translate(10px, 20px)'
    await flush()

    expect(e.style.transform).toBe('translate(10px, 20px) scale(0.5)')
  })

  it('remplace l’échelle précédente au lieu de les empiler', async () => {
    const e = el()
    s.group.add(e, [6.0, 46.5])

    e.style.transform = 'translate(10px, 20px)'
    await flush()
    e.style.transform = 'translate(30px, 40px) scale(0.5)'   // repositionnement suivant
    await flush()

    expect(e.style.transform).toBe('translate(30px, 40px) scale(0.5)')
    expect(e.style.transform.match(/scale\(/g)).toHaveLength(1)
  })

  it('suit le zoom : chaque repositionnement reprend l’échelle publiée', async () => {
    const e = el()
    s.group.add(e, [6.0, 46.5])

    e.style.transform = 'translate(0px, 0px)'
    await flush()
    expect(e.style.transform).toContain('scale(0.5)')

    s.container.style.setProperty(MARKER_SCALE_VAR, '0.9')
    e.style.transform = 'translate(1px, 1px)'
    await flush()
    expect(e.style.transform).toBe('translate(1px, 1px) scale(0.9)')
  })

  it('ne s’emballe pas sur sa propre écriture', async () => {
    const e = el()
    s.group.add(e, [6.0, 46.5])
    const spy = vi.spyOn(e.style, 'transform', 'set')

    e.style.transform = 'translate(10px, 20px)'
    await flush()
    await flush()

    // Une seule réécriture par le groupe (la nôtre est ignorée à la passe suivante).
    expect(spy).toHaveBeenCalledTimes(2)      // l'écriture du test + celle du groupe
  })

  it('prend une échelle de 1 quand la carte n’en publie pas', async () => {
    const plain = setup()
    const e = el()
    plain.group.add(e, [6.0, 46.5])

    e.style.transform = 'translate(5px, 5px)'
    await flush()

    expect(e.style.transform).toBe('translate(5px, 5px) scale(1)')
  })

  it('retire tous les marqueurs et cesse d’observer', async () => {
    const a = el(), b = el()
    const ma = s.group.add(a, [6.0, 46.5])
    const mb = s.group.add(b, [6.1, 46.5])

    s.group.clear()

    expect(ma.removed).toBe(true)
    expect(mb.removed).toBe(true)
    expect(s.group.markers).toEqual([])

    // Plus d'observateur : un repositionnement ne se voit plus remettre d'échelle.
    a.style.transform = 'translate(9px, 9px)'
    await flush()
    expect(a.style.transform).toBe('translate(9px, 9px)')
  })

  it('se réinstalle proprement après un vidage', () => {
    s.group.add(el(), [6.0, 46.5])
    s.group.clear()
    const marker = s.group.add(el(), [6.2, 46.6])

    expect(s.group.markers).toEqual([marker])
  })
})
