import { companionStore, type CompanionGears } from './stores/companionStore'
import type { CompanionNavState } from './navHelpers'
import { csrfToken } from './csrf'

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

// Dernier état de navigation publié, pour n'envoyer que ce qui change.
let lastNavJson = ''
let lastNavAt = 0

// Publie l'état de la navigation (virage en cours, hors-trace, arrivée, col) vers
// l'application mobile.
//
// L'appli n'affiche pas forcément la carte : elle peut avoir une page de données
// par-dessus, et c'est ce message qui lui dit de revenir à la carte quand un
// virage approche. Elle n'est donc pas seulement spectatrice — d'où la position du
// virage dans la charge utile, qui lui permet de juger l'approche elle-même si la
// page se tait.
//
// `at` change à chaque fix, donc on compare la charge utile SANS lui : deux fixes
// identiques à l'arrêt ne valent pas deux messages. Le plancher d'une seconde
// garantit malgré tout un signe de vie régulier, sur lequel l'appli s'appuie pour
// savoir si l'information est encore fraîche.
export function companionNav(state: CompanionNavState): void {
  const target = channel()
  if (!target) return

  const { at, ...stable } = state
  const json = JSON.stringify(stable)
  if (json === lastNavJson && at - lastNavAt < 1000) return

  lastNavJson = json
  lastNavAt = at
  target.postMessage(JSON.stringify(state))
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
    el.addEventListener('click', onCompanionLinkClick as EventListener)
  })
}

// Passe la session du navigateur à l'appli au moment du tap.
//
// Le WebView de l'appli a son propre pot de cookies : sans ça, un utilisateur connecté
// ici rouvrirait la navigation en anonyme dans l'appli — sans ses itinéraires, sans son
// fond de carte, sans ses POI — et devrait se connecter une deuxième fois. On demande
// donc un jeton à usage unique (cf. SessionHandoff côté Rails) et on le joint au lien ;
// l'appli l'échange contre une vraie session avant d'ouvrir la page.
//
// Le jeton est demandé ici, et pas au rendu de la page : il ne vaut que quelques
// minutes, alors qu'une page de partage peut rester ouverte bien plus longtemps.
//
// Tout échec (hors ligne, session expirée entre-temps) laisse simplement le lien
// d'origine s'ouvrir : la navigation partagée est publique, elle marchera en anonyme.
// Le transfert de session est un confort, jamais une condition.
async function onCompanionLinkClick(event: MouseEvent): Promise<void> {
  const link = (event.currentTarget as HTMLAnchorElement | null)
  // L'attribut n'est posé que pour un utilisateur connecté : sans session à passer,
  // le lien s'ouvre tel quel.
  if (!link || link.dataset.companionHandoff === undefined) return

  event.preventDefault()
  window.location.href = await companionLinkTarget(link.href)
}

// Le lien à ouvrir réellement : celui de la page, plus le jeton de passage si le
// serveur veut bien en émettre un. Séparé du gestionnaire de clic pour être
// testable sans provoquer de navigation.
export async function companionLinkTarget(href: string): Promise<string> {
  let token = ''
  try {
    const res = await fetch('/api/session_handoff', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (res.ok) token = (await res.json()).token ?? ''
  } catch {
    // Réseau absent : on ouvre l'appli sans passer la session.
  }

  if (!token) return href

  const url = new URL(href)
  url.searchParams.set('handoff', token)
  return url.toString()
}

export function installCompanionBridge(): void {
  // Pont (ré)installé = page (re)chargée : le prochain état de navigation doit
  // partir, même s'il est identique à celui d'avant le rechargement. L'appli n'a
  // gardé aucun contexte, elle attend un état complet.
  lastNavJson = ''
  lastNavAt = 0

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

  void pushRiderProfile()
}

// Envoie à l'appli les seuils et zones du cycliste (FTP, LTHR, bornes en watts et
// en bpm).
//
// C'est la page qui va les chercher, et pas l'appli : la session vit dans le pot de
// cookies du WebView, donc l'appli n'a aucun identifiant à présenter. Elle recevrait
// une réponse anonyme là où la page est déjà connectée.
//
// Tout échec est silencieux, et volontairement : sans profil, l'appli affiche
// « FTP inconnue » plutôt que des zones inventées. Une sortie sans réseau ne doit
// pas rater à cause d'un chiffre de confort.
export async function pushRiderProfile(): Promise<void> {
  const target = channel()
  if (!target) return

  try {
    const res = await fetch('/api/rider_profile', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    // 401 sur une navigation partagée ouverte en anonyme : cas normal, pas une panne.
    if (!res.ok) return
    target.postMessage(JSON.stringify({ type: 'rider_profile', profile: await res.json() }))
  } catch {
    // Hors ligne, ou service worker sans copie en cache : on s'en passe.
  }
}
