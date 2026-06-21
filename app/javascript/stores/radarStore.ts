import { ref, computed } from 'vue'

// État de la connexion au radar Varia.
//   idle        — pas encore connecté
//   unsupported — le navigateur n'expose pas Web Bluetooth (iOS Safari, etc.)
//   connecting  — appairage / connexion GATT en cours
//   connected   — flux de menaces actif
//   error       — échec (voir error.value)
export type RadarStatus = 'idle' | 'unsupported' | 'connecting' | 'connected' | 'error'

// Un véhicule détecté par le radar. Les valeurs viennent du décodage de la trame
// BLE du Varia (voir variaRadar.ts) — distance la plus fiable, vitesse approximée.
export interface RadarTarget {
  // Identifiant de cible renvoyé par l'appareil : permet de suivre la même
  // voiture d'une trame à l'autre (il « réutilise » l'id tant que la cible existe).
  id: number
  // Distance derrière le cycliste, en mètres (0–255 d'après le protocole).
  distanceM: number
  // Vitesse d'approche approximée (m/s). Le décodage exact varie selon le firmware ;
  // à calibrer contre l'appareil réel.
  speedMps: number
}

class RadarStore {
  readonly status = ref<RadarStatus>('idle')
  readonly error = ref<string | null>(null)
  readonly deviceName = ref<string | null>(null)
  // Cibles courantes, triées de la plus proche à la plus lointaine.
  readonly targets = ref<RadarTarget[]>([])
  // Horodatage (ms) de la dernière trame reçue — sert au watchdog d'effacement.
  readonly lastUpdate = ref(0)

  readonly isConnected = computed(() => this.status.value === 'connected')
  readonly nearest = computed<RadarTarget | null>(() => this.targets.value[0] ?? null)
  readonly threatCount = computed(() => this.targets.value.length)

  setTargets(targets: RadarTarget[]) {
    this.targets.value = [...targets].sort((a, b) => a.distanceM - b.distanceM)
    this.lastUpdate.value = Date.now()
  }

  // Plus aucune voiture détectée (toutes ont dépassé / dépassé la portée).
  clearTargets() {
    if (this.targets.value.length) this.targets.value = []
  }

  reset() {
    this.status.value = 'idle'
    this.error.value = null
    this.deviceName.value = null
    this.targets.value = []
    this.lastUpdate.value = 0
  }
}

export const radarStore = new RadarStore()
