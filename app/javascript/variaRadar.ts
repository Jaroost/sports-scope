// ─── Connexion BLE au radar arrière Garmin Varia (POC) ──────────────────────────
//
// Le Varia (RTL515, RVR315, RTL510…) diffuse les véhicules détectés sur un service
// GATT *propriétaire* — non documenté par Garmin, mais décodé par la communauté.
// On s'y connecte via l'API Web Bluetooth, qui fonctionne dans Chrome/Edge sur
// Android et desktop. ⚠️ iOS Safari n'implémente PAS Web Bluetooth : sur iPhone il
// faudrait une app native (Capacitor/Flutter) — voir la discussion d'architecture.
//
// UUIDs et format de trame issus du reverse engineering communautaire. Le décodage
// peut nécessiter une calibration contre l'appareil réel ; tout est isolé ici pour
// faciliter l'ajustement.

import { radarStore, type RadarTarget } from './stores/radarStore'

// Service radar Garmin et caractéristiques (minuscules — requis par Web Bluetooth).
const VARIA_SERVICE = '6a4e3200-667b-11e3-949a-0800200c9a66'
const VARIA_MEASUREMENT = '6a4e3203-667b-11e3-949a-0800200c9a66' // notify : menaces
// Point de contrôle (write) — non utilisé par le POC, listé pour optionalServices.
// const VARIA_CONTROL = '6a4e3204-667b-11e3-949a-0800200c9a66'

// Si aucune trame n'arrive pendant ce délai, on considère que la voie est dégagée
// (les voitures ont dépassé / quitté la portée) et on vide l'affichage.
const STALE_MS = 2500

let device: BluetoothDevice | null = null
let characteristic: BluetoothRemoteGATTCharacteristic | null = null
let watchdog: ReturnType<typeof setInterval> | null = null

// Décodage d'une trame de mesure Varia.
//
// Format (consensus du reverse engineering) :
//   octet 0          : compteur de page (incrémente à chaque trame, ignoré ici)
//   puis, par cible, un triplet de 3 octets :
//     +0 : id de menace  (suivi de la même voiture entre les trames)
//     +1 : distance en mètres (0–255)
//     +2 : vitesse d'approche (unité dépendante du firmware → approximée)
//
// On ignore les triplets à distance 0 (emplacements vides).
function parseMeasurement(view: DataView): RadarTarget[] {
  const targets: RadarTarget[] = []
  for (let i = 1; i + 2 < view.byteLength; i += 3) {
    const id = view.getUint8(i)
    const distanceM = view.getUint8(i + 1)
    const rawSpeed = view.getUint8(i + 2)
    if (distanceM === 0) continue
    targets.push({ id, distanceM, speedMps: rawSpeed })
  }
  return targets
}

function onMeasurement(event: Event) {
  const ch = event.target as BluetoothRemoteGATTCharacteristic
  if (!ch.value) return
  radarStore.setTargets(parseMeasurement(ch.value))
}

function startWatchdog() {
  stopWatchdog()
  watchdog = setInterval(() => {
    if (radarStore.targets.value.length && Date.now() - radarStore.lastUpdate.value > STALE_MS) {
      radarStore.clearTargets()
    }
  }, 1000)
}

function stopWatchdog() {
  if (watchdog) { clearInterval(watchdog); watchdog = null }
}

function onDisconnected() {
  stopWatchdog()
  characteristic = null
  radarStore.status.value = 'idle'
  radarStore.clearTargets()
}

// Le navigateur supporte-t-il Web Bluetooth ? (faux sur iOS Safari notamment)
export function radarSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth
}

// Lance l'appairage puis l'abonnement aux menaces. DOIT être appelé depuis un
// vrai geste utilisateur (clic) — sinon le navigateur refuse requestDevice().
export async function connectRadar(): Promise<void> {
  if (!radarSupported()) {
    radarStore.status.value = 'unsupported'
    return
  }
  radarStore.error.value = null
  radarStore.status.value = 'connecting'
  try {
    device = await navigator.bluetooth!.requestDevice({
      filters: [{ services: [VARIA_SERVICE] }],
      optionalServices: [VARIA_SERVICE],
    })
    device.addEventListener('gattserverdisconnected', onDisconnected)

    const server = await device.gatt!.connect()
    const service = await server.getPrimaryService(VARIA_SERVICE)
    characteristic = await service.getCharacteristic(VARIA_MEASUREMENT)
    characteristic.addEventListener('characteristicvaluechanged', onMeasurement)
    await characteristic.startNotifications()

    radarStore.deviceName.value = device.name ?? 'Varia'
    radarStore.status.value = 'connected'
    startWatchdog()
  } catch (err) {
    // L'utilisateur a annulé le sélecteur, ou la connexion a échoué.
    const aborted = err instanceof DOMException && err.name === 'NotFoundError'
    radarStore.status.value = aborted ? 'idle' : 'error'
    radarStore.error.value = aborted ? null : (err instanceof Error ? err.message : String(err))
    radarStore.clearTargets()
  }
}

export function disconnectRadar(): void {
  stopWatchdog()
  if (characteristic) {
    characteristic.removeEventListener('characteristicvaluechanged', onMeasurement)
    void characteristic.stopNotifications().catch(() => { /* déjà déconnecté */ })
    characteristic = null
  }
  if (device) {
    device.removeEventListener('gattserverdisconnected', onDisconnected)
    if (device.gatt?.connected) device.gatt.disconnect()
    device = null
  }
  radarStore.reset()
}
