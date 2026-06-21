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

// On mémorise l'id de l'appareil appairé pour le reconnecter en un clic à la
// session suivante, sans repasser par le sélecteur Bluetooth (cf. getDevices()).
// ⚠️ Web Bluetooth interdit la reconnexion 100 % automatique (sans geste
// utilisateur) ; on évite seulement le sélecteur, pas le clic.
const STORAGE_KEY = 'sportsScope.radarDeviceId'

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

function rememberDeviceId(id: string) {
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* stockage indisponible */ }
}

function storedDeviceId(): string | null {
  try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
}

// Retrouve, parmi les appareils déjà autorisés, le Varia mémorisé — sans rouvrir
// le sélecteur. Renvoie null si getDevices() n'est pas supporté, si aucun id
// n'est mémorisé, ou si l'autorisation a été révoquée entre-temps.
async function knownDevice(): Promise<BluetoothDevice | null> {
  const id = storedDeviceId()
  if (!id || !navigator.bluetooth?.getDevices) return null
  try {
    const devices = await navigator.bluetooth.getDevices()
    return devices.find((d) => d.id === id) ?? null
  } catch {
    return null
  }
}

// Y a-t-il un Varia déjà appairé qu'on pourra reconnecter en un seul clic ?
// Sert au libellé du bouton (« Reconnecter » plutôt que « Connecter »).
export async function hasKnownRadar(): Promise<boolean> {
  return (await knownDevice()) !== null
}

// Abonnement GATT commun aux deux chemins de connexion (sélecteur ou reconnexion
// silencieuse). Mémorise l'id en cas de succès pour la prochaine fois.
async function subscribe(target: BluetoothDevice): Promise<void> {
  device = target
  device.addEventListener('gattserverdisconnected', onDisconnected)

  const server = await device.gatt!.connect()
  const service = await server.getPrimaryService(VARIA_SERVICE)
  characteristic = await service.getCharacteristic(VARIA_MEASUREMENT)
  characteristic.addEventListener('characteristicvaluechanged', onMeasurement)
  await characteristic.startNotifications()

  rememberDeviceId(device.id)
  radarStore.deviceName.value = device.name ?? 'Varia'
  radarStore.status.value = 'connected'
  startWatchdog()
}

// Détache écouteurs et connexion GATT sans toucher au store — utilisé aussi bien
// pour la déconnexion explicite que pour nettoyer après un échec de reconnexion.
function cleanupDevice(): void {
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
}

// Lance la connexion puis l'abonnement aux menaces. DOIT être appelé depuis un
// vrai geste utilisateur (clic) — sinon le navigateur refuse requestDevice() (et
// même la reconnexion silencieuse n'est pas garantie hors interaction).
export async function connectRadar(): Promise<void> {
  if (!radarSupported()) {
    radarStore.status.value = 'unsupported'
    return
  }
  radarStore.error.value = null
  radarStore.status.value = 'connecting'
  try {
    // 1) Reconnexion directe à l'appareil déjà appairé, sans le sélecteur.
    const remembered = await knownDevice()
    if (remembered) {
      try {
        await subscribe(remembered)
        return
      } catch {
        // Varia hors de portée / éteint : on nettoie et on bascule sur le
        // sélecteur classique plutôt que d'échouer d'emblée.
        cleanupDevice()
      }
    }
    // 2) Premier appairage (ou repli) : sélecteur Bluetooth du navigateur.
    const picked = await navigator.bluetooth!.requestDevice({
      filters: [{ services: [VARIA_SERVICE] }],
      optionalServices: [VARIA_SERVICE],
    })
    await subscribe(picked)
  } catch (err) {
    // L'utilisateur a annulé le sélecteur, ou la connexion a échoué.
    const aborted = err instanceof DOMException && err.name === 'NotFoundError'
    radarStore.status.value = aborted ? 'idle' : 'error'
    radarStore.error.value = aborted ? null : (err instanceof Error ? err.message : String(err))
    radarStore.clearTargets()
  }
}

export function disconnectRadar(): void {
  cleanupDevice()
  radarStore.reset()
}

// Oublie l'appareil mémorisé : le prochain branchement repassera par le
// sélecteur. Révoque aussi l'autorisation navigateur si l'API est disponible.
export async function forgetRadar(): Promise<void> {
  const remembered = device ?? await knownDevice()
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* stockage indisponible */ }
  disconnectRadar()
  if (remembered?.forget) {
    try { await remembered.forget() } catch { /* déjà oublié / non supporté */ }
  }
}
