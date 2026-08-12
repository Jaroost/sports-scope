import { ref, computed, watch, type Ref } from 'vue'
import { companionStore, type CompanionGears } from './stores/companionStore'
import type { CompanionClimbProfile, CompanionNavState, CompanionRouteClimbs } from './navHelpers'
import { csrfToken } from './csrf'
import {
  useTrainingPlan,
  athleteFromSummary,
  type LoadSummary,
  type TrainingBudget,
} from './composables/useTrainingPlan'
import { usePlannedRides, usePlannedLoads } from './composables/usePlannedRides'

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
  headingDeg?: number | null
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

// ─── Veille demandée par l'appli ───────────────────────────────────────────
//
// L'appui long ne marche que sur la carte : une page de données de l'appli
// peut vouloir la même veille sans avoir de geste à faire sur cette carte-là,
// qu'elle ne montre pas. `sleepEnter()` (installCompanionBridge, plus bas) lui
// donne donc une porte d'entrée, sur le même modèle que les commandes hors
// ligne ci-dessous : RouteNavigation.vue s'enregistre tant que la page de
// navigation est montée, et l'appli n'a qu'à appeler le geste, jamais à
// dupliquer la logique de veille.
interface SleepBridgeHandlers {
  enter(): void
}

let sleepHandlers: SleepBridgeHandlers | null = null

// Appelé par RouteNavigation.vue au montage et au démontage (`null` alors) : un
// bouton pressé après que la page de navigation a disparu ne doit rien faire.
export function registerSleepHandlers(handlers: SleepBridgeHandlers | null): void {
  sleepHandlers = handlers
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

// Publie le profil gradué d'un col, une fois à l'entrée (voir climbProfileFor
// dans RouteNavigation.vue). Volumineux et statique pour tout le col — c'est
// pourquoi il n'est PAS republié à chaque position comme companionNav, et
// pourquoi il porte son propre `id` (startIdx) : l'appli s'en sert pour ignorer
// un message qui répéterait le col déjà affiché.
export function companionClimbProfile(profile: CompanionClimbProfile): void {
  channel()?.postMessage(JSON.stringify(profile))
}

// Publie la liste ordonnée des cols du tracé, une fois par (re)chargement (voir
// buildCompanionRouteClimbs, appelé depuis RouteNavigation.vue). Vidée
// (climbs: []) quand le tracé est retiré, pour que l'appli n'affiche pas les
// cols d'un tracé qu'on a quitté.
export function companionRouteClimbs(climbs: CompanionRouteClimbs): void {
  channel()?.postMessage(JSON.stringify(climbs))
}

// Une page web ne peut pas savoir si l'appli est installée : au mieux on sait
// qu'elle *pourrait* l'être. On se limite donc à Android, et on ne propose rien
// quand on tourne déjà dans l'appli, où le lien n'aurait aucun sens.
export function shouldOfferCompanionApp(): boolean {
  if (inCompanionApp()) return false
  return /Android/i.test(navigator.userAgent)
}

// Affiche les liens « ouvrir dans l'application » (`sportsscope://`), masqués par
// défaut dans le HTML.
export function revealCompanionLinks(): void {
  if (!shouldOfferCompanionApp()) return

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

// ─── Cartes hors-ligne : commandes venues de l'appli ──────────────────────────
//
// Le panneau qui pilote normalement le téléchargement (NavControlsPanel, dans
// RouteNavigation.vue) est masqué dans l'appli mobile (`appOwnsChrome` :
// useControlsHide y est `enabled: false`) — elle a son propre tiroir de commandes
// natif, sous le WebView. On ne réécrit pas le téléchargement côté Dart pour
// autant : RouteNavigation.vue s'enregistre ici tant qu'un trajet est affiché, et
// l'appli se contente d'appeler les trois gestes que son propre menu propose déjà
// (démarrer, annuler, supprimer) et d'écouter l'état pour afficher une entrée de
// menu à jour.
export interface OfflineMapsBridgeState {
  supported: boolean
  ready: boolean
  stale: boolean
  downloading: boolean
  pct: number
  mb: number
  tiles: number
  errored: boolean
}

interface OfflineMapsBridgeHandlers {
  start(): void
  cancel(): void
  remove(): void
}

let offlineHandlers: OfflineMapsBridgeHandlers | null = null

// Appelé par RouteNavigation.vue au montage et au démontage (`null` alors) : un
// geste de l'appli qui arriverait après que la page de navigation a disparu (choix
// d'un itinéraire, autre page) ne doit rien faire, plutôt qu'agir sur un trajet
// qu'on ne regarde plus.
export function registerOfflineMapsHandlers(handlers: OfflineMapsBridgeHandlers | null): void {
  offlineHandlers = handlers
}

// Publie l'état des cartes hors-ligne du trajet affiché. Silencieux hors appli,
// comme companionNav.
export function pushOfflineMapsState(state: OfflineMapsBridgeState): void {
  channel()?.postMessage(JSON.stringify({ type: 'offline', ...state }))
}

export function installCompanionBridge(): void {
  // Pont (ré)installé = page (re)chargée : le prochain état de navigation doit
  // partir, même s'il est identique à celui d'avant le rechargement. L'appli n'a
  // gardé aucun contexte, elle attend un état complet.
  lastNavJson = ''
  lastNavAt = 0

  const target = window as unknown as {
    sportsScopeCompanion?: {
      push(payload: CompanionPayload): void
      offlineStart(): void
      offlineCancel(): void
      offlineRemove(): void
      sleepEnter(): void
    }
  }

  target.sportsScopeCompanion = {
    push(payload: CompanionPayload) {
      try {
        companionStore.update({
          heartRate: payload.heartRate,
          power: payload.power,
          cadence: payload.cadence,
          gears: payload.gears,
          headingDeg: payload.headingDeg,
        })
      } catch {
        // Une charge utile inattendue ne doit jamais casser la navigation :
        // mieux vaut des valeurs figées qu'une carte morte.
      }
    },
    // `?.` : aucun trajet affiché (page de navigation démontée, ou pas encore
    // montée) veut dire aucun geste possible — pas une erreur.
    offlineStart() { offlineHandlers?.start() },
    offlineCancel() { offlineHandlers?.cancel() },
    offlineRemove() { offlineHandlers?.remove() },
    sleepEnter() { sleepHandlers?.enter() },
  }

  // On annonce que le pont est prêt : l'appli répond par un état complet, sans
  // attendre la prochaine trame d'un capteur. Indispensable après un
  // rechargement de la page en pleine sortie.
  channel()?.postMessage(JSON.stringify({ type: 'ready' }))

  void pushRiderProfile()
  void pushTrainingBudget()
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

// Envoie à l'appli le budget de charge du jour : ce qu'il reste à faire, le plafond
// que la fatigue autorise, l'état de la semaine et le risque (ACWR).
//
// Même raison que `pushRiderProfile` de le faire ici : la session vit dans le pot de
// cookies du WebView, l'appli n'a aucun identifiant à présenter. Mais aussi une raison
// qui lui est propre — **le calcul reste du côté qui le fait déjà**. La cible hebdo,
// l'affûtage et le plancher de fatigue sont un morceau de logique qu'on ne veut pas
// voir vivre en deux exemplaires (ici et en Ruby, puis en Dart) : le premier réglage
// qui bouge d'un côté ferait diverger le chiffre du guidon de celui de la page
// Performances, et c'est précisément le chiffre sur lequel on décide de rentrer.
//
// Le coût est une requête sur une analyse déjà en cache côté serveur, une fois par
// chargement de page dans l'appli. Silencieux comme le profil : sans budget, le
// composant affiche son état vide, la sortie n'en dépend pas.
export async function pushTrainingBudget(): Promise<void> {
  const target = channel()
  if (!target) return

  try {
    const res = await fetch('/api/performance/training_load', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    // 401 sur une navigation partagée ouverte en anonyme : cas normal, pas une panne.
    if (!res.ok) return

    const budget = await computeTrainingBudget(await res.json())
    // Un compte sans une seule sortie n'a ni forme ni cible : il n'y a rien à dire, et
    // un budget à zéro se lirait comme « repos complet », ce qui est un conseil.
    if (!budget) return

    target.postMessage(JSON.stringify({ type: 'training_budget', budget }))
  } catch {
    // Hors ligne : l'appli garde le dernier budget reçu, daté, et sait le dire.
  }
}

// Le budget, dérivé de la charge par le composable de la page Performances.
//
// Instancié hors composant, ce qui est permis : `useTrainingPlan` ne fait aucun fetch
// et n'a pas de cycle de vie. On attend en revanche les itinéraires prévus — sans eux,
// une sortie déjà planifiée aujourd'hui ne compterait pas dans la cible du jour, et le
// guidon annoncerait un objectif que le site n'affiche pas.
async function computeTrainingBudget(payload: LoadSummary): Promise<TrainingBudget | null> {
  const data = ref<LoadSummary | null>(payload)
  const athlete = computed(() => athleteFromSummary(data.value))
  const { loaded } = usePlannedRides()
  const { plannedLoads, plannedDistances } = usePlannedLoads(athlete)

  await whenTrue(loaded)

  return useTrainingPlan(data, plannedLoads, plannedDistances).budget.value
}

// Attend qu'un drapeau passe à vrai. `usePlannedRides` lance sa requête au premier
// appel et n'en expose que l'aboutissement.
function whenTrue(flag: Ref<boolean>): Promise<void> {
  if (flag.value) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(flag, (value) => {
      if (!value) return
      stop()
      resolve()
    })
  })
}
