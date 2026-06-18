import { ref, computed } from 'vue'
import { userPreferences } from '../userPreferences'

export interface Place {
  name: string
  type: string
  distanceM: number
  distFromRouteM: number
  lng: number
  lat: number
  markerLng: number
  markerLat: number
}

class PlacesStore {
  readonly importantPlaces = ref<Place[]>([])
  readonly isFetchingPlaces = ref(false)
  readonly placeShowCemeteries = ref(userPreferences().points_of_interest.show_cemeteries)
  readonly placeShowBakeries = ref(userPreferences().points_of_interest.show_bakeries)
  readonly placeShowLocalities = ref(userPreferences().points_of_interest.show_localities)
  readonly placesExpanded = ref(true)
  // Rayon de détection (m) des cimetières et boulangeries — piloté uniquement par
  // les préférences du profil (plus de réglage dans le créateur d'itinéraire).
  readonly placeRadiusM = ref(userPreferences().points_of_interest.radius_m)

  // Non-reactive — read synchronously by Chart.js plugins
  token = 0
  placeHoverKm: number | null = null
  placeSelectedKm: number | null = null

  readonly hasCemeteryPlaces = computed(() =>
    this.importantPlaces.value.some((p) => p.type === 'cemetery'),
  )
  readonly hasBakeryPlaces = computed(() =>
    this.importantPlaces.value.some((p) => p.type === 'bakery'),
  )
  readonly hasLocalityPlaces = computed(() =>
    this.importantPlaces.value.some((p) => p.type !== 'cemetery' && p.type !== 'bakery'),
  )
  readonly filteredPlaces = computed(() =>
    this.importantPlaces.value.filter((p) => {
      if (p.type === 'cemetery') return this.placeShowCemeteries.value
      if (p.type === 'bakery') return this.placeShowBakeries.value
      return this.placeShowLocalities.value
    }),
  )

  reset() {
    this.token++
    this.importantPlaces.value = []
    this.isFetchingPlaces.value = false
    this.placeHoverKm = null
    this.placeSelectedKm = null
  }
}

export const placesStore = new PlacesStore()
