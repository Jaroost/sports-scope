import type { LngLat } from './routeHelpers'

// Groupe de marqueurs MapLibre mis à l'échelle du zoom (cols, POI, repères…).
//
// Ces marqueurs sont des overlays HTML : MapLibre réécrit leur `transform` à chaque frame
// pour les positionner, ce qui écrase tout `scale()` posé en CSS. On observe donc l'attribut
// `style` de chaque élément et on ré-applique le facteur d'échelle courant — publié par la
// carte dans la propriété CSS `--wp-scale` — juste après chaque réécriture.
//
// Le pattern « un tableau de marqueurs + un tableau d'observateurs + tout vider avant de
// réinstaller » était recopié pour chaque famille de marqueurs du créateur d'itinéraire : ce
// groupe le porte une fois pour toutes. Un groupe se vide et se réinstalle en entier — les
// marqueurs sont peu nombreux et leurs gestionnaires capturent des index qui doivent suivre.

/** Propriété CSS où la carte publie le facteur d'échelle courant des marqueurs. */
export const MARKER_SCALE_VAR = '--wp-scale'

export interface ScaledMarkerGroup {
  /** Marqueurs du groupe, dans l'ordre d'ajout. */
  readonly markers: any[]
  /** Crée un marqueur pour `el`, le pose sur la carte et le suit à l'échelle. */
  add(el: HTMLElement, lngLat: LngLat, options?: Record<string, unknown>): any
  /** Retire tous les marqueurs et débranche leurs observateurs. */
  clear(): void
}

export interface MarkerGroupDeps {
  getMap: () => any
  getMaplibre: () => any
}

// Réapplique le facteur d'échelle après chaque réécriture du `transform` par MapLibre.
// `lastSet` évite la boucle infinie : notre propre écriture redéclenche l'observateur.
function observeMarkerScale(el: HTMLElement, getMap: () => any): MutationObserver {
  let lastSet = ''
  const obs = new MutationObserver(() => {
    const raw = el.style.transform
    if (!raw || raw === lastSet) return
    const base = raw.replace(/ scale\([^)]+\)$/, '')
    const s = parseFloat(getMap()?.getContainer().style.getPropertyValue(MARKER_SCALE_VAR) || '1')
    lastSet = `${base} scale(${s})`
    el.style.transform = lastSet
  })
  obs.observe(el, { attributes: true, attributeFilter: ['style'] })
  return obs
}

export interface MarkerScreenPoint { x: number; y: number }

/**
 * Regroupe des marqueurs qui se chevauchent à l'écran. Rend, pour chaque marqueur :
 *  - `mergedInto[i]` : l'index du marqueur qui le représente, ou −1 s'il reste affiché ;
 *  - `hides[i]`      : le nombre de marqueurs qu'il représente en plus de lui-même.
 *
 * Un marqueur « prend » tous ceux qui tombent à moins de `minGapPx` de LUI (pas de chaîne
 * de proche en proche : sinon une file de points serrés s'effondrerait en un seul amas d'un
 * bout à l'autre du tracé). Un marqueur qui en représente déjà d'autres ne peut plus être
 * pris par un troisième — il resterait masqué tout en portant un badge.
 *
 * `priority` passe en tête : c'est le marqueur qu'on veut voir survivre à son amas (le point
 * sélectionné, dont la tooltip est ouverte). Pure : tout est en pixels écran.
 */
export function mergeOverlappingMarkers(
  points: Array<MarkerScreenPoint | null>,
  minGapPx: number,
  priority = -1,
): { mergedInto: number[]; hides: number[] } {
  const n = points.length
  const mergedInto = new Array<number>(n).fill(-1)
  const hides = new Array<number>(n).fill(0)
  const minGapSq = minGapPx * minGapPx
  const order = Array.from({ length: n }, (_, i) => i)
  if (priority >= 0 && priority < n) order.unshift(priority)
  for (const i of order) {
    const a = points[i]
    if (!a || mergedInto[i] >= 0 || hides[i] > 0) continue
    for (let j = 0; j < n; j++) {
      const b = points[j]
      if (j === i || !b || mergedInto[j] >= 0 || hides[j] > 0) continue
      const dx = b.x - a.x, dy = b.y - a.y
      if (dx * dx + dy * dy > minGapSq) continue
      mergedInto[j] = i
      hides[i]++
    }
  }
  return { mergedInto, hides }
}

export function createScaledMarkerGroup(deps: MarkerGroupDeps): ScaledMarkerGroup {
  const { getMap, getMaplibre } = deps
  const markers: any[] = []
  const observers: MutationObserver[] = []

  return {
    markers,
    add(el, lngLat, options = {}) {
      const map = getMap()
      const maplibre = getMaplibre()
      if (!map || !maplibre) return null
      const marker = new maplibre.Marker({ element: el, ...options }).setLngLat(lngLat).addTo(map)
      observers.push(observeMarkerScale(el, getMap))
      markers.push(marker)
      return marker
    },
    clear() {
      while (observers.length) observers.pop()!.disconnect()
      while (markers.length) markers.pop().remove()
    },
  }
}
