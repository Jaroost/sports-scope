import { ref, reactive, computed } from 'vue'
import { userPreferences } from '../userPreferences'
import { POI_CATEGORIES, categoryForType } from '../poiCategories'

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
  // Passe à true quand la recherche Overpass échoue (réseau / serveur). Permet
  // d'afficher un message d'erreur et un bouton « réessayer » dans le créateur.
  readonly placesFetchFailed = ref(false)
  // Recherche activée par catégorie (depuis le profil) : pilote les catégories
  // qu'on interroge sur Overpass. Statique pour la durée de la page.
  readonly search: Record<string, boolean> = {}
  // État du filtre d'affichage par catégorie dans le créateur (réactif). Actif par
  // défaut quand la catégorie est recherchée.
  readonly show = reactive<Record<string, boolean>>({})
  readonly placesExpanded = ref(true)
  // Rayon de détection (m) des POI ponctuels — piloté uniquement par les
  // préférences du profil (plus de réglage dans le créateur d'itinéraire).
  readonly placeRadiusM = ref(userPreferences().points_of_interest.radius_m)

  // Non-reactive — read synchronously by Chart.js plugins
  token = 0
  placeHoverKm: number | null = null
  placeSelectedKm: number | null = null

  constructor() {
    const poi = userPreferences().points_of_interest
    for (const cat of POI_CATEGORIES) {
      const on = !!poi[cat.prefField]
      this.search[cat.key] = on
      this.show[cat.key] = on
    }
  }

  // Catégories effectivement présentes dans les résultats — pour n'afficher que
  // les boutons de filtre pertinents (dans l'ordre du registre).
  readonly presentCategories = computed(() =>
    POI_CATEGORIES.filter((cat) =>
      this.importantPlaces.value.some((p) => cat.serverTypes.includes(p.type)),
    ),
  )

  readonly filteredPlaces = computed(() =>
    this.importantPlaces.value.filter((p) => {
      const cat = categoryForType(p.type)
      return cat ? this.show[cat.key] : true
    }),
  )

  reset() {
    this.token++
    this.importantPlaces.value = []
    this.isFetchingPlaces.value = false
    this.placesFetchFailed.value = false
    this.placeHoverKm = null
    this.placeSelectedKm = null
  }
}

export const placesStore = new PlacesStore()
