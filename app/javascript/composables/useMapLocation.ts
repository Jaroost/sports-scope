import { ref, onBeforeUnmount } from 'vue'
import { generateCircle } from '../routeHelpers'
import type { LngLat } from '../routeHelpers'

// « Ma position » sur la carte du créateur d'itinéraire. Extrait de RouteBuilderMap.vue.
//
// Un simple repère ponctuel : le point bleu et le disque d'incertitude du fix GPS, obtenus
// à la demande (bouton) et non suivis en continu — le suivi temps réel, c'est la page de
// navigation. Le refus de la géolocalisation est silencieux : le bouton retombe, sans
// message d'erreur qui masquerait la carte.

const SOURCE = 'user-location'
const FILL_LAYER = 'user-location-fill'
const STROKE_LAYER = 'user-location-stroke'

// Un fix « frais » est réutilisé tel quel (30 s), et on n'attend pas indéfiniment.
const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 8000,
  maximumAge: 30000,
}

export interface UseMapLocationOptions {
  getMap: () => any
  getMaplibre: () => any
}

export function useMapLocation(opts: UseMapLocationOptions) {
  const { getMap, getMaplibre } = opts

  /** La position est-elle affichée ? Pilote l'état enfoncé du bouton. */
  const locationVisible = ref(false)
  /** Fix GPS en cours d'acquisition (peut prendre quelques secondes en ville). */
  const locating = ref(false)

  let marker: any = null
  let lastCoords: LngLat | null = null
  let lastAccuracy = 0

  // Disque d'incertitude (rayon = précision annoncée du fix). Recréé après un changement de
  // fond de carte, qui emporte sources et calques : d'où l'appel depuis le composant.
  function installLayers(coords: LngLat, accuracyM: number) {
    const map = getMap()
    if (!map) return
    const data = {
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [generateCircle(coords, accuracyM)] },
    }
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data })
      map.addLayer({ id: FILL_LAYER, type: 'fill', source: SOURCE, paint: { 'fill-color': '#4285f4', 'fill-opacity': 0.12 } })
      map.addLayer({ id: STROKE_LAYER, type: 'line', source: SOURCE, paint: { 'line-color': '#4285f4', 'line-width': 1.5, 'line-opacity': 0.5 } })
    } else {
      map.getSource(SOURCE).setData(data)
    }
  }

  /** Réinstalle le repère après un changement de fond de carte, s'il était affiché. */
  function reinstallLayers() {
    if (locationVisible.value && lastCoords) installLayers(lastCoords, lastAccuracy)
  }

  function show(coords: LngLat, accuracyM: number) {
    const map = getMap()
    const maplibre = getMaplibre()
    if (!map || !maplibre) return
    lastCoords = coords
    lastAccuracy = accuracyM
    installLayers(coords, accuracyM)
    if (marker) {
      marker.setLngLat(coords)
    } else {
      const el = document.createElement('div')
      el.className = 'user-location-dot'
      marker = new maplibre.Marker({ element: el, anchor: 'center' }).setLngLat(coords).addTo(map)
    }
    locationVisible.value = true
  }

  function hide() {
    if (marker) { marker.remove(); marker = null }
    lastCoords = null
    const map = getMap()
    if (map) {
      if (map.getLayer(STROKE_LAYER)) map.removeLayer(STROKE_LAYER)
      if (map.getLayer(FILL_LAYER)) map.removeLayer(FILL_LAYER)
      if (map.getSource(SOURCE)) map.removeSource(SOURCE)
    }
    locationVisible.value = false
  }

  // Bouton « ma position » : affiche le repère et cadre dessus, ou l'efface s'il l'était
  // déjà. Un refus de permission (ou un fix qui n'arrive pas) laisse simplement la carte
  // en l'état.
  async function toggle() {
    if (locationVisible.value) { hide(); return }
    locating.value = true
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, GEOLOCATION_OPTIONS)
      })
      const coords: LngLat = [pos.coords.longitude, pos.coords.latitude]
      getMap()?.flyTo({ center: coords, zoom: 14, duration: 800 })
      show(coords, pos.coords.accuracy)
    } catch { /* permission refusée ou fix indisponible */ }
    finally { locating.value = false }
  }

  // Le point est un marqueur MapLibre (élément DOM) : il doit partir avant la carte.
  onBeforeUnmount(() => {
    if (marker) { marker.remove(); marker = null }
  })

  return { locationVisible, locating, toggle, reinstallLayers }
}
