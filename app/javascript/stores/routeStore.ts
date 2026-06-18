import { ref, computed } from 'vue'
import { haversine, detectClimbs, computeGainLoss, buildDistancesM, formatDuration } from '../routeHelpers'
import type { Coord, Climb, VoiceHint } from '../routeHelpers'
import { userPreferences, speedForSport } from '../userPreferences'
import type { Sport } from '../userPreferences'

// Plafond du nombre de waypoints — doit rester aligné sur MAX_WAYPOINTS côté
// serveur (RoutesController), qui tronque silencieusement au-delà à la sauvegarde.
export const MAX_WAYPOINTS = 51

class RouteStore {
  // ─── Core route data ────────────────────────────────────────────────────────
  readonly geometry = ref<Coord[]>([])
  readonly waypoints = ref<Array<{ lng: number; lat: number; free?: boolean }>>([])
  readonly voiceHints = ref<VoiceHint[]>([])
  readonly distanceM = ref(0)
  readonly elevGainM = ref(0)
  readonly elevLossM = ref(0)
  readonly isFetchingRoute = ref(false)
  readonly isFetchingElevation = ref(false)
  readonly name = ref('')
  readonly error = ref<string | null>(null)
  readonly currentId = ref<number | null>(null)
  // Mode lecture seule : itinéraire ouvert via un lien de partage. Désactive
  // toute édition (ajout/déplacement de points, sauvegarde, renommage) et
  // fonctionne pour les visiteurs non connectés.
  readonly readOnly = ref(false)
  // Catégorie d'activité de l'itinéraire — pilote la vitesse moyenne (via le
  // profil) et le fond de cartes de sentiers. Initialisée sur le sport par défaut
  // du profil.
  readonly sport = ref<Sport>(userPreferences().display.default_sport)
  // Vitesse moyenne (km/h) issue du profil pour le sport courant. Reste
  // modifiable ponctuellement dans le créateur, mais change de sport la réaligne
  // sur la valeur du profil.
  readonly avgSpeedKmh = ref(speedForSport(this.sport.value))

  // ─── Computed ───────────────────────────────────────────────────────────────
  readonly hasGeometry = computed(() => this.geometry.value.length >= 2)
  readonly isEditMode = computed(() => this.currentId.value != null)

  readonly estimatedSeconds = computed(() => {
    const d = this.distanceM.value
    const v = this.avgSpeedKmh.value
    if (!d || !Number.isFinite(v) || v <= 0) return 0
    return Math.round(((d / 1000) / v) * 3600)
  })

  readonly detectedClimbs = computed((): Climb[] => {
    const g = this.geometry.value
    if (g.length < 2) return []
    const altitudes = g.map((c) => c[2])
    const distances = buildDistancesM(g)
    return detectClimbs(altitudes, distances)
  })

  // Change la catégorie d'activité et réaligne la vitesse moyenne sur la valeur
  // configurée dans le profil pour ce sport.
  setSport(sport: Sport) {
    if (sport === this.sport.value) return
    this.sport.value = sport
    this.avgSpeedKmh.value = speedForSport(sport)
  }

  reset() {
    this.geometry.value = []
    this.waypoints.value = []
    this.voiceHints.value = []
    this.distanceM.value = 0
    this.elevGainM.value = 0
    this.elevLossM.value = 0
  }

  recomputeGain() {
    const { gain, loss } = computeGainLoss(this.geometry.value)
    this.elevGainM.value = gain
    this.elevLossM.value = loss
  }
}

export const routeStore = new RouteStore()
