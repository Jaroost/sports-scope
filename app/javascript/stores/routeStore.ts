import { ref, computed } from 'vue'
import { haversine, detectClimbs, computeGainLoss, buildDistancesM, formatDuration } from '../routeHelpers'
import type { Coord, Climb, VoiceHint } from '../routeHelpers'
import { userPreferences, speedForSport, routeProfileForSport, setActiveSport } from '../userPreferences'
import type { Sport } from '../userPreferences'
import { isProfileValidForSport } from '../brouter'

// Plafond du nombre de waypoints — doit rester ≤ MAX_WAYPOINTS côté serveur
// (RoutesController = 500), qui tronque silencieusement au-delà à la sauvegarde.
export const MAX_WAYPOINTS = 200

class RouteStore {
  // ─── Core route data ────────────────────────────────────────────────────────
  readonly geometry = ref<Coord[]>([])
  // `free` : le tronçon ENTRANT du point est tracé en ligne droite (cf. reverseWaypoints).
  // `uturn_ok` : l'utilisateur assume le demi-tour que ce point provoque (aller-retour
  // délibéré) — purement informatif, n'affecte pas le routage (cf. detectUturnAnomalies).
  readonly waypoints = ref<Array<{ lng: number; lat: number; free?: boolean; uturn_ok?: boolean }>>([])
  readonly voiceHints = ref<VoiceHint[]>([])
  readonly distanceM = ref(0)
  readonly elevGainM = ref(0)
  readonly elevLossM = ref(0)
  readonly isFetchingRoute = ref(false)
  readonly isFetchingElevation = ref(false)
  readonly name = ref('')
  readonly error = ref<string | null>(null)
  readonly currentId = ref<number | null>(null)
  // Mode lecture seule : désactive toute édition (ajout/déplacement de points,
  // sauvegarde, renommage). Activé en permanence pour un itinéraire ouvert via un
  // lien de partage (cf. shareLocked), ou basculé manuellement depuis la carte.
  readonly readOnly = ref(false)
  // Verrou permanent : l'itinéraire est ouvert via un lien de partage. Dans ce cas
  // la lecture seule ne peut pas être désactivée, donc le toggle est masqué.
  readonly shareLocked = ref(false)
  // Catégorie d'activité de l'itinéraire — pilote la vitesse moyenne (via le
  // profil) et le fond de cartes de sentiers. Initialisée sur le sport par défaut
  // du profil.
  readonly sport = ref<Sport>(userPreferences().display.default_sport)
  // Vitesse moyenne (km/h) issue du profil pour le sport courant. Reste
  // modifiable ponctuellement dans le créateur, mais change de sport la réaligne
  // sur la valeur du profil.
  readonly avgSpeedKmh = ref(speedForSport(this.sport.value))
  // Profil de routage BRouter courant (cf. brouter.ts / PROFILES_BY_SPORT).
  // Envoyé à BRouter au recalcul et enregistré avec l'itinéraire (Route#profile).
  // Réaligné sur le défaut du sport à chaque changement de sport (setSport).
  readonly profile = ref<string>(routeProfileForSport(this.sport.value))

  constructor() {
    // Les réglages par sport lus hors composant (détection de cols dans routeHelpers)
    // suivent le sport du créateur, pas celui du profil.
    setActiveSport(this.sport.value)
  }

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
    // Les seuils de détection viennent du sport courant (via setActiveSport) : on le lit
    // ici pour que le calcul soit refait au changement de sport, detectClimbs allant
    // chercher les seuils hors du graphe réactif.
    void this.sport.value
    const altitudes = g.map((c) => c[2])
    const distances = buildDistancesM(g)
    return detectClimbs(altitudes, distances)
  })

  // Change la catégorie d'activité et réaligne sur les réglages du profil pour ce
  // sport : vitesse moyenne, profil de routage, et tout ce que lisent les modules
  // hors composants (seuils de détection de cols) via le sport courant.
  setSport(sport: Sport) {
    if (sport === this.sport.value) return
    this.sport.value = sport
    setActiveSport(sport)
    this.avgSpeedKmh.value = speedForSport(sport)
    // Le profil de routage est filtré par sport : on retombe sur le défaut du
    // nouveau sport (préférence compte ou défaut catalogue).
    this.profile.value = routeProfileForSport(sport)
  }

  // Change le profil de routage BRouter. Ignore silencieusement un profil non
  // proposé pour le sport courant (ex. valeur héritée d'un ancien itinéraire) :
  // le défaut du sport, déjà en place, est alors conservé.
  setProfile(profile: string) {
    if (!isProfileValidForSport(profile, this.sport.value)) return
    this.profile.value = profile
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
