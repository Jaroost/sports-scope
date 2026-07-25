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
