import { ref, computed } from 'vue'

// Mesures poussées par l'application mobile (sports-scope-companion) quand la
// navigation tourne dans son WebView.
//
// Pourquoi passer par elle plutôt que par Web Bluetooth : le navigateur ne sait
// ouvrir qu'une partie des capteurs (pas de Di2 Shimano, rien sur iOS, rien en
// arrière-plan), là où l'appli tient les connexions BLE pour toute la sortie et
// les enregistre. La page reçoit donc un état déjà décodé et ne fait que
// l'afficher.

export interface CompanionGears {
  // Positions brutes publiées par le Di2 (1 = plus facile).
  front: number
  rear: number
  frontCount: number
  rearCount: number
  // Dents et braquet, calculés côté appli à partir de la transmission
  // configurée. `null` si la position sort de la transmission connue : on
  // affiche alors la position seule plutôt qu'un braquet faux.
  frontTeeth: number | null
  rearTeeth: number | null
  ratio: number | null
  developmentM: number | null
}

// Au-delà de ce délai sans message, on considère l'appli muette (WebView mis en
// veille, appli tuée) et on cesse d'afficher des valeurs qui ne bougent plus.
const STALE_MS = 10_000

class CompanionStore {
  // L'appli a-t-elle publié son pont ? Faux dans un navigateur ordinaire.
  readonly present = ref(false)
  readonly heartRate = ref<number | null>(null)
  readonly power = ref<number | null>(null)
  readonly cadence = ref<number | null>(null)
  readonly gears = ref<CompanionGears | null>(null)
  // Cap du téléphone (degrés, nord géographique), publié UNIQUEMENT à l'arrêt et
  // seulement si l'appli a pu vérifier sa boussole contre la course GPS. C'est
  // la seule mesure d'ici qui ne vient pas d'un capteur du vélo, et la seule que
  // la page consomme au lieu de l'afficher — cf. updateBearing.
  readonly headingDeg = ref<number | null>(null)
  // Le cycliste a explicitement forcé la boussole (pastille de l'appli, utile
  // sous un couvert forestier où sa propre vitesse GPS reste rarement nulle).
  // `updateBearing` doit alors la prioriser avant son propre GPS, pas
  // seulement en dernier recours comme d'habitude.
  readonly headingForced = ref(false)
  // Horodatage (ms) du dernier message reçu.
  readonly lastUpdate = ref(0)

  // Au moins une mesure à afficher.
  readonly hasValues = computed(() =>
    this.heartRate.value != null ||
    this.power.value != null ||
    this.cadence.value != null ||
    this.gears.value != null,
  )

  readonly stale = computed(() =>
    this.lastUpdate.value > 0 && Date.now() - this.lastUpdate.value > STALE_MS,
  )

  update(values: {
    heartRate?: number | null
    power?: number | null
    cadence?: number | null
    gears?: CompanionGears | null
    headingDeg?: number | null
    headingForced?: boolean | null
  }): void {
    this.present.value = true
    this.heartRate.value = values.heartRate ?? null
    this.power.value = values.power ?? null
    this.cadence.value = values.cadence ?? null
    this.gears.value = values.gears ?? null
    this.headingDeg.value = values.headingDeg ?? null
    this.headingForced.value = values.headingForced ?? false
    this.lastUpdate.value = Date.now()
  }

  reset(): void {
    this.present.value = false
    this.heartRate.value = null
    this.power.value = null
    this.cadence.value = null
    this.gears.value = null
    this.headingDeg.value = null
    this.headingForced.value = false
    this.lastUpdate.value = 0
  }
}

export const companionStore = new CompanionStore()
