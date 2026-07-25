import { ref, computed, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { haversine, formatDistancePrecise } from '../routeHelpers'
import type { LngLat } from '../routeHelpers'

// Mode « règle » du créateur d'itinéraire. Extrait de RouteBuilderMap.vue.
//
// Chaque clic pose un point ; on affiche la distance directe (orthodromie) cumulée le long
// des segments posés. Les points sont déplaçables, supprimables, et une poignée « + » au
// milieu de chaque segment permet d'en insérer un. Purement éphémère : rien n'est enregistré
// avec l'itinéraire et le tracé n'est jamais modifié — d'où un sous-système qui ne touche ni
// au routeStore ni aux points d'ancrage.

// Source et calque MapLibre de la ligne de mesure. Le calque est posé par le composant
// (qui gouverne l'ordre d'empilement) ; le composable n'écrit que les données.
export const MEASURE_SOURCE = 'builder-measure'
export const MEASURE_LINE_LAYER = 'builder-measure-line'

// Seuil anti-tremblement d'un appui tactile (px²) : en dessous, c'est un appui, pas un glissé.
const TOUCH_DRAG_SLOP_SQ = 25

export interface UseMapMeasureOptions {
  getMap: () => any
  getMaplibre: () => any
  /** Neutralise le clic carte qui suit un relâchement de poignée (il poserait un point). */
  suppressNextMapClick: () => void
}

export function useMapMeasure(opts: UseMapMeasureOptions) {
  const { getMap, getMaplibre, suppressNextMapClick } = opts

  const points = ref<LngLat[]>([])
  const markers: any[] = []
  // Poignées « + » au milieu de chaque segment (insertion d'un point intermédiaire).
  const midMarkers: any[] = []
  // Point dont la tooltip (suppression) est ouverte, ou -1. Piloté en DOM comme les
  // waypoints : une classe sur le marqueur, pas de re-rendu.
  let selectedIdx = -1

  // Distances cumulées, index par index (cumM[0] === 0).
  const cumM = computed(() => {
    const out = [0]
    for (let i = 1; i < points.value.length; i++) {
      out.push(out[i - 1] + haversine(points.value[i - 1], points.value[i]))
    }
    return out
  })
  const totalM = computed(() => cumM.value[cumM.value.length - 1] ?? 0)

  function addPoint(lng: number, lat: number) {
    points.value.push([lng, lat])
    render()
  }

  function undoPoint() {
    points.value.pop()
    selectedIdx = -1
    render()
  }

  function clear() {
    if (!points.value.length) return
    points.value = []
    selectedIdx = -1
    render()
  }

  function removePoint(idx: number) {
    points.value.splice(idx, 1)
    selectedIdx = -1
    render()
  }

  // Ouvre la tooltip du point `idx` (-1 = aucune). Les index changent à chaque
  // insertion/suppression : on referme plutôt que de tenter de suivre le point.
  function selectPoint(idx: number) {
    selectedIdx = idx
    markers.forEach((m, i) => m.getElement().classList.toggle('measure-marker--selected', i === idx))
  }

  // Insère un point au milieu du segment `idx` (entre les points idx et idx+1) et renvoie
  // son index. Sert au clic comme au glisser d'une poignée « + ».
  function insertPoint(idx: number): number {
    points.value.splice(idx + 1, 0, midOfSegment(idx))
    selectedIdx = -1
    render()
    return idx + 1
  }

  function midOfSegment(i: number): LngLat {
    const [a, b] = [points.value[i], points.value[i + 1]]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  }

  // Clic sur la carte en mode mesure : une tooltip ouverte se referme d'abord, sinon on
  // pose un point. À n'appeler que quand le mode est actif (le composant en est le maître).
  function onMapClick(lng: number, lat: number) {
    if (selectedIdx >= 0) { selectPoint(-1); return }
    addPoint(lng, lat)
  }

  function updateLayer() {
    const src = getMap()?.getSource(MEASURE_SOURCE)
    if (!src) return
    src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.value } })
  }

  // Mise à jour légère pendant un glissement : les marqueurs restent en place (les
  // recréer casserait le geste), seuls leur libellé et la position des « + » changent.
  function refreshLabels() {
    markers.forEach((m, idx) => {
      const lbl = m.getElement().querySelector('.measure-marker-label')
      if (lbl) lbl.textContent = idx === 0 ? t('routes.measure_start') : formatDistancePrecise(cumM.value[idx])
    })
    midMarkers.forEach((m, i) => {
      if (i < points.value.length - 1) m.setLngLat(midOfSegment(i))
    })
  }

  // Redessine ligne + poignées. Tout est recréé (poignées peu nombreuses) : les libellés
  // dépendent de la distance cumulée, donc de tous les points qui précèdent, et les index
  // capturés dans les gestionnaires doivent suivre les insertions/suppressions.
  function render() {
    updateLayer()
    while (markers.length) markers.pop().remove()
    while (midMarkers.length) midMarkers.pop().remove()
    const map = getMap()
    const maplibre = getMaplibre()
    if (!map || !maplibre) return
    points.value.forEach((p, idx) => {
      const el = document.createElement('div')
      el.className = idx === selectedIdx ? 'measure-marker measure-marker--selected' : 'measure-marker'
      el.innerHTML = `
      <span class="measure-marker-dot"></span>
      <span class="measure-marker-label"></span>
      <div class="measure-tooltip">
        <button type="button" class="measure-tooltip-delete">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
          <span>${t('routes.measure_remove_point')}</span>
        </button>
        <div class="measure-tooltip-arrow"></div>
      </div>`
      const marker = new maplibre.Marker({ element: el, anchor: 'center' }).setLngLat(p).addTo(map)
      // Un clic sur la poignée ne doit pas traverser jusqu'à la carte (qui poserait un
      // point de plus) : il ouvre/ferme la tooltip de suppression. Le clic droit supprime
      // directement.
      el.addEventListener('click', (ev: Event) => {
        ev.stopPropagation()
        if ((ev.target as Element).closest('.measure-tooltip')) return
        selectPoint(idx === selectedIdx ? -1 : idx)
      })
      el.querySelector('.measure-tooltip-delete')!.addEventListener('click', (ev: Event) => {
        ev.stopPropagation(); ev.preventDefault()
        removePoint(idx)
      })
      el.addEventListener('contextmenu', (ev: Event) => {
        ev.preventDefault(); ev.stopPropagation()
        removePoint(idx)
      })
      attachDrag(el, marker, {
        start: () => { selectPoint(-1); return marker },
        move: (lng, lat) => { points.value[idx] = [lng, lat]; updateLayer(); refreshLabels() },
        end: render,
        // Tactile seulement (cf. attachDrag) : l'appui n'y produit pas de `click`.
        tap: () => selectPoint(idx === selectedIdx ? -1 : idx),
      })
      markers.push(marker)
    })
    // Poignées « + » au milieu de chaque segment : clic = insérer un point là, glisser =
    // insérer et emmener le nouveau point sous le curseur.
    for (let i = 0; i < points.value.length - 1; i++) {
      const el = document.createElement('div')
      el.className = 'measure-mid-marker'
      el.innerHTML = '<i class="fa-solid fa-plus"></i>'
      const marker = new maplibre.Marker({ element: el, anchor: 'center' }).setLngLat(midOfSegment(i)).addTo(map)
      el.addEventListener('click', (ev: Event) => { ev.stopPropagation(); insertPoint(i) })
      let dragIdx = -1
      attachDrag(el, marker, {
        // Le glissement promeut la poignée en vrai point : render recrée les marqueurs, on
        // rend le nouveau pour que le glissement continue sur lui.
        start: () => { dragIdx = insertPoint(i); return markers[dragIdx] },
        move: (lng, lat) => { points.value[dragIdx] = [lng, lat]; updateLayer(); refreshLabels() },
        end: render,
        tap: () => insertPoint(i),
      })
      midMarkers.push(marker)
    }
  }

  // Glisser-déposer d'une poignée de mesure (souris + tactile), calqué sur
  // attachWaypointDrag : pan de la carte désactivé le temps du geste, suivi du curseur en
  // direct, et neutralisation du clic de relâchement (il poserait un point de plus).
  // `start` peut renvoyer un autre marqueur à déplacer que celui saisi (poignée « + »).
  function attachDrag(
    el: HTMLElement,
    marker: any,
    hooks: { start?: () => any; move: (lng: number, lat: number) => void; end: () => void; tap?: () => void },
  ) {
    const map = getMap()
    const unproject = (clientX: number, clientY: number) => {
      const rect = map.getContainer().getBoundingClientRect()
      return map.unproject([clientX - rect.left, clientY - rect.top])
    }
    // `isTouch` : sur un appui tactile, `touchstart` est annulé (preventDefault) donc
    // aucun `click` n'est émis — c'est `tap` qui rend l'appui. À la souris, le `click`
    // arrive normalement et c'est lui qui agit : déclencher `tap` en plus ferait double.
    const endDrag = (moved: boolean, isTouch: boolean) => {
      map.dragPan.enable()
      el.style.cursor = ''
      if (!moved) { if (isTouch) hooks.tap?.(); return }
      suppressNextMapClick()
      hooks.end()
    }

    el.addEventListener('mousedown', (ev: MouseEvent) => {
      if (ev.button !== 0) return
      ev.preventDefault(); ev.stopPropagation()
      let moved = false
      let target = marker
      map.dragPan.disable()
      el.style.cursor = 'grabbing'
      const onMove = (e: MouseEvent) => {
        if (!moved) { moved = true; target = hooks.start?.() ?? marker }
        const ll = unproject(e.clientX, e.clientY)
        target.setLngLat([ll.lng, ll.lat])
        hooks.move(ll.lng, ll.lat)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        endDrag(moved, false)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })

    el.addEventListener('touchstart', (ev: TouchEvent) => {
      if (ev.touches.length !== 1) return
      ev.preventDefault(); ev.stopPropagation()
      const start = ev.touches[0]
      let moved = false
      let target = marker
      map.dragPan.disable()
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length !== 1) return
        e.preventDefault()
        const touch = e.touches[0]
        const dx = touch.clientX - start.clientX, dy = touch.clientY - start.clientY
        if (!moved && dx * dx + dy * dy < TOUCH_DRAG_SLOP_SQ) return
        if (!moved) { moved = true; target = hooks.start?.() ?? marker }
        const ll = unproject(touch.clientX, touch.clientY)
        target.setLngLat([ll.lng, ll.lat])
        hooks.move(ll.lng, ll.lat)
      }
      const onTouchEnd = () => {
        el.removeEventListener('touchmove', onTouchMove)
        el.removeEventListener('touchend', onTouchEnd)
        el.removeEventListener('touchcancel', onTouchEnd)
        endDrag(moved, true)
      }
      el.addEventListener('touchmove', onTouchMove, { passive: false })
      el.addEventListener('touchend', onTouchEnd)
      el.addEventListener('touchcancel', onTouchEnd)
    }, { passive: false })
  }

  // Les poignées sont des marqueurs MapLibre (éléments DOM) : elles doivent partir avant
  // la carte. Le composable est créé dans le setup du composant, donc ce hook s'exécute
  // avant celui du composant, qui détruit l'instance de carte.
  onBeforeUnmount(() => {
    while (markers.length) markers.pop().remove()
    while (midMarkers.length) midMarkers.pop().remove()
  })

  return { points, cumM, totalM, addPoint, undoPoint, clear, onMapClick, updateLayer }
}
