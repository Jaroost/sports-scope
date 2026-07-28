import { companionStore, type CompanionGears } from './stores/companionStore'
import { radarStore } from './stores/radarStore'

// Réception des capteurs de l'application mobile (sports-scope-companion).
//
// L'appli affiche cette page dans un WebView et y pousse l'état de ses capteurs
// BLE en appelant `window.sportsScopeCompanion.push(payload)`. C'est elle qui
// tient les connexions Bluetooth — le navigateur ne sait pas ouvrir le Di2, et
// rien du tout sur iOS.
//
// Le pont est installé sur toutes les pages : dans un navigateur ordinaire il
// n'est jamais appelé, et ne coûte que l'objet global.

interface CompanionPayload {
  at?: string
  source?: string
  heartRate?: number | null
  power?: number | null
  cadence?: number | null
  gears?: CompanionGears | null
  radar?: { connected?: boolean; targets?: { id: number; distanceM: number; speedMps: number }[] }
  sensors?: { name: string; connected: boolean; kinds: string[] }[]
}

// Canal JavaScript injecté par le WebView de l'appli. Sa seule présence dit
// qu'on tourne dans l'appli, ce qui vaut mieux qu'un reniflage d'user-agent.
interface CompanionChannel { postMessage(message: string): void }

function channel(): CompanionChannel | null {
  const injected = (window as unknown as { SportsScopeCompanion?: CompanionChannel }).SportsScopeCompanion
  return injected ?? null
}

// Vrai quand la page tourne dans l'application mobile.
export function inCompanionApp(): boolean {
  return channel() != null
}

// Veille de la navigation : la page noircit ses pixels mais garde son verrou
// d'écran, donc la dalle reste alimentée — de loin le premier poste de
// consommation sur un guidon, devant le GPS et le BLE. L'appli, elle, peut
// couper le rétroéclairage, ce qu'un navigateur ne sait pas faire.
//
// On envoie l'intention (« je suis en veille »), pas un niveau : le choix du
// réglage appartient à l'appli, qui seule connaît la plateforme. Rien n'est
// endormi au passage — JavaScript, position et détection de virage continuent
// de tourner, et c'est ce qui permet à la page de redemander `normal` d'elle-même
// à l'approche d'un virage.
export function companionScreen(state: 'dimmed' | 'normal'): void {
  channel()?.postMessage(JSON.stringify({ type: 'screen', state }))
}

// Le radar de l'appli alimente le store existant : le bandeau d'alerte, les
// bips et les seuils marchent alors à l'identique, qu'il vienne d'ici ou de Web
// Bluetooth.
function applyRadar(radar: CompanionPayload['radar']): void {
  // Clé absente : l'appli ne dit rien du radar, ce qui n'est pas la même chose
  // que « pas de radar ». On ne touche alors pas au store — sinon un radar
  // connecté en Web Bluetooth par la page serait coupé par le premier message
  // venu.
  if (radar === undefined || radar === null) return

  if (!radar.connected) {
    // Radar débranché côté appli : on ne laisse pas un bandeau figé annoncer
    // une voie dégagée qu'on ne surveille plus.
    if (radarStore.status.value === 'connected') radarStore.reset()
    return
  }

  if (radarStore.status.value !== 'connected') {
    radarStore.status.value = 'connected'
    radarStore.deviceName.value = 'Varia'
  }

  const targets = (radar.targets ?? []).map((t) => ({
    id: t.id,
    distanceM: t.distanceM,
    speedMps: t.speedMps,
  }))
  if (targets.length) radarStore.setTargets(targets)
  else radarStore.clearTargets()
}

// Affiche les liens « ouvrir dans l'application » (`sportsscope://`), masqués par
// défaut dans le HTML.
//
// Une page web ne peut pas savoir si l'appli est installée : au mieux on sait
// qu'elle *pourrait* l'être. On se limite donc à Android, et on ne montre rien
// quand on tourne déjà dans l'appli, où le lien n'aurait aucun sens.
export function revealCompanionLinks(): void {
  if (inCompanionApp()) return
  if (!/Android/i.test(navigator.userAgent)) return

  document.querySelectorAll('[data-companion-link]').forEach((el) => {
    el.classList.remove('d-none')
  })
}

export function installCompanionBridge(): void {
  const target = window as unknown as { sportsScopeCompanion?: { push(payload: CompanionPayload): void } }

  target.sportsScopeCompanion = {
    push(payload: CompanionPayload) {
      try {
        companionStore.update({
          heartRate: payload.heartRate,
          power: payload.power,
          cadence: payload.cadence,
          gears: payload.gears,
        })
        applyRadar(payload.radar)
      } catch {
        // Une charge utile inattendue ne doit jamais casser la navigation :
        // mieux vaut des valeurs figées qu'une carte morte.
      }
    },
  }

  // On annonce que le pont est prêt : l'appli répond par un état complet, sans
  // attendre la prochaine trame d'un capteur. Indispensable après un
  // rechargement de la page en pleine sortie.
  channel()?.postMessage(JSON.stringify({ type: 'ready' }))
}
