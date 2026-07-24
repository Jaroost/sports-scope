import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { usePoiBrowse } from './usePoiBrowse'
import { haversine } from '../routeHelpers'
import { POI_CATEGORIES } from '../poiCategories'
import type { NavPlace } from './useNavPois'

const POI_CATS = POI_CATEGORIES.filter((c) => c.point)

const place = (name: string, type: string, lng: number, lat: number): NavPlace => ({ name, type, lng, lat })

function setup(opts: { places?: NavPlace[]; lastPos?: [number, number] | null } = {}) {
  const places = opts.places ?? []
  let lastPos = opts.lastPos ?? null
  const flyTo = vi.fn()
  const openPlacePopup = vi.fn()
  const closePlacePopup = vi.fn()
  const hideControls = vi.fn()
  const following = ref(true)
  const cameraUnlocked = ref(false)
  const map = { flyTo, getContainer: () => ({ clientHeight: 800 }) }
  const browse = usePoiBrowse({
    getMap: () => map,
    getVisiblePlaces: () => places,
    poiCats: POI_CATS,
    openPlacePopup,
    closePlacePopup,
    following,
    cameraUnlocked,
    getContainerH: () => 800,
    getLastPos: () => lastPos,
    hideControls,
  })
  return { browse, flyTo, openPlacePopup, closePlacePopup, hideControls, following, cameraUnlocked,
    setLastPos: (p: [number, number] | null) => { lastPos = p } }
}

describe('usePoiBrowse', () => {
  it('ne démarre pas le parcours sans POI visible', () => {
    const { browse, hideControls } = setup({ places: [] })
    browse.startPoiBrowse()
    expect(browse.poiBrowseActive.value).toBe(false)
    expect(hideControls).not.toHaveBeenCalled()
  })

  it('démarre le parcours, trie par distance et cadre le POI le plus proche', () => {
    const far = place('loin', 'bakery', 0, 0.1)
    const near = place('proche', 'bakery', 0, 0.001)
    const { browse, hideControls, openPlacePopup, following, cameraUnlocked, flyTo } =
      setup({ places: [far, near], lastPos: [0, 0] })

    browse.startPoiBrowse()

    expect(browse.poiBrowseActive.value).toBe(true)
    expect(browse.poiBrowseIndex.value).toBe(0)
    expect(hideControls).toHaveBeenCalledOnce()
    expect(following.value).toBe(false)      // caméra débrayée
    expect(cameraUnlocked.value).toBe(true)
    expect(flyTo).toHaveBeenCalledOnce()
    expect(openPlacePopup).toHaveBeenLastCalledWith(near)   // le plus proche d'abord
    expect(browse.poiBrowseHint.value?.name).toBe('proche')
    expect(browse.poiBrowseHint.value?.icon).toBe('fa-bread-slice')   // catégorie bakery
  })

  it('enchaîne suivant / précédent en boucle', () => {
    const a = place('a', 'bakery', 0, 0.001)
    const b = place('b', 'bakery', 0, 0.002)
    const c = place('c', 'bakery', 0, 0.003)
    const { browse } = setup({ places: [a, b, c], lastPos: [0, 0] })

    browse.startPoiBrowse()          // trié [a, b, c], index 0
    expect(browse.poiBrowseHint.value?.name).toBe('a')
    browse.browseNext()
    expect(browse.poiBrowseIndex.value).toBe(1)
    expect(browse.poiBrowseHint.value?.name).toBe('b')
    browse.browsePrev()
    browse.browsePrev()              // 1 → 0 → boucle vers 2
    expect(browse.poiBrowseIndex.value).toBe(2)
    expect(browse.poiBrowseHint.value?.name).toBe('c')
    browse.browseNext()              // 2 → boucle vers 0
    expect(browse.poiBrowseIndex.value).toBe(0)
  })

  it('filtre par catégorie, remet l’index à zéro et recense les catégories présentes', () => {
    const bakery = place('boul', 'bakery', 0, 0.001)
    const view = place('vue', 'viewpoint', 0, 0.002)
    const bakery2 = place('boul2', 'bakery', 0, 0.003)
    const { browse } = setup({ places: [bakery, view, bakery2], lastPos: [0, 0] })

    browse.startPoiBrowse()
    expect(browse.poiBrowseList.value).toHaveLength(3)
    // Catégories présentes, dans l'ordre du registre (bakeries avant viewpoints).
    const cats = browse.poiBrowseCats.value
    expect(cats.map((c) => c.key)).toEqual(['bakeries', 'viewpoints'])
    expect(cats.find((c) => c.key === 'bakeries')?.count).toBe(2)

    browse.browseNext()              // index 1
    browse.setPoiBrowseFilter('bakeries')
    expect(browse.poiBrowseIndex.value).toBe(0)   // remis à zéro
    expect(browse.poiBrowseList.value.map((p) => p.name)).toEqual(['boul', 'boul2'])
  })

  it('recalcule la distance live du POI courant à chaque fix GPS (bumpPosTick)', () => {
    const p = place('p', 'bakery', 0, 0.01)
    const { browse, setLastPos } = setup({ places: [p], lastPos: [0, 0] })

    browse.startPoiBrowse()
    expect(browse.poiBrowseDistM.value).toBeCloseTo(haversine([0, 0], [0, 0.01]), 3)

    // Sans bumpPosTick le computed ne se recalcule pas (lastPos non réactif) …
    setLastPos([0, 0.005])
    browse.bumpPosTick()
    expect(browse.poiBrowseDistM.value).toBeCloseTo(haversine([0, 0.005], [0, 0.01]), 3)
  })

  it('arrête le parcours et referme le popup', () => {
    const { browse, closePlacePopup } = setup({ places: [place('a', 'bakery', 0, 0.001)], lastPos: [0, 0] })
    browse.startPoiBrowse()
    browse.stopPoiBrowse()
    expect(browse.poiBrowseActive.value).toBe(false)
    expect(closePlacePopup).toHaveBeenCalledOnce()
  })
})
