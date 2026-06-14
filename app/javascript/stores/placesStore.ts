import { ref, computed } from 'vue'

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
  readonly placeShowCemeteries = ref(true)
  readonly placeShowLocalities = ref(false)
  readonly placesExpanded = ref(true)

  // Non-reactive — read synchronously by Chart.js plugins
  token = 0
  placeHoverKm: number | null = null
  placeSelectedKm: number | null = null

  readonly hasCemeteryPlaces = computed(() =>
    this.importantPlaces.value.some((p) => p.type === 'cemetery'),
  )
  readonly hasLocalityPlaces = computed(() =>
    this.importantPlaces.value.some((p) => p.type !== 'cemetery'),
  )
  readonly filteredPlaces = computed(() =>
    this.importantPlaces.value.filter((p) => {
      if (p.type === 'cemetery') return this.placeShowCemeteries.value
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
