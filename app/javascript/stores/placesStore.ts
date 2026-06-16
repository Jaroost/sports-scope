import { ref, computed } from 'vue'

const RADIUS_KEY = 'sportsScope.placeRadiusM'
const RADIUS_MIN = 200
const RADIUS_MAX = 5000
const RADIUS_DEFAULT = 1500

function loadRadius(): number {
  try {
    const raw = localStorage.getItem(RADIUS_KEY)
    const v = raw != null ? parseFloat(raw) : NaN
    return Number.isFinite(v) && v >= RADIUS_MIN && v <= RADIUS_MAX ? v : RADIUS_DEFAULT
  } catch { return RADIUS_DEFAULT }
}

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
  readonly placeShowBakeries = ref(true)
  readonly placeShowLocalities = ref(false)
  readonly placesExpanded = ref(true)
  // Rayon de détection (m) partagé par les cimetières et les boulangeries.
  readonly placeRadiusM = ref(loadRadius())

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

  persistRadius() {
    const v = this.placeRadiusM.value
    if (!Number.isFinite(v) || v < RADIUS_MIN || v > RADIUS_MAX) return
    try { localStorage.setItem(RADIUS_KEY, String(v)) } catch { /* ignore */ }
  }

  reset() {
    this.token++
    this.importantPlaces.value = []
    this.isFetchingPlaces.value = false
    this.placeHoverKm = null
    this.placeSelectedKm = null
  }
}

export const placesStore = new PlacesStore()
