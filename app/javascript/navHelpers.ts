// Helpers purs de la navigation (RouteNavigation.vue). Aucune dépendance à l'état
// réactif ni à MapLibre : tout est passé en paramètre, pour rester testable et
// réutilisable par les sous-composants (NavTurnBanner, NavClimbCard, NavScreenOff…).
import { colorForGrade, gradeForIndex } from './routeHelpers'
import type { Climb, LngLat, Maneuver, TurnPoint } from './routeHelpers'
import { ARRIVAL_M, ARRIVAL_APPROACH_M } from './navConstants'

// ─── Types partagés des overlays de navigation ─────────────────────────────────

// Indice de virage affiché (bandeau éveillé / carte de veille).
// state : 'far' (lointain, bandeau discret) · 'near' (approche) · 'now' (atteint, vert).
export interface TurnHint {
  direction: 'left' | 'right'
  distM: number
  kind: Maneuver
  angle: number
  exitNumber?: number
  state: 'far' | 'near' | 'now'
}

export interface ProfilePoint { x: number; y: number }
export interface ProfileSegment { d: string; color: string }

// Profil d'altitude gradué d'un col (viewBox 0–100), construit une fois par col.
export interface ClimbProfile {
  segments: ProfileSegment[]   // polygones colorés par pente
  areaD: string                // aire remplie sous toute la ligne d'altitude (gris « fait »)
  pts: ProfilePoint[]          // points de la ligne d'altitude
  topY: number                 // y du sommet (point le plus haut)
}

// Données complètes de la carte de col (climbInfo).
export interface ClimbInfo {
  climb: Climb
  ratio: number
  remainingGainM: number
  segments: ProfileSegment[]
  areaD: string
  posX: number      // curseur x (% de la largeur du profil)
  posY: number      // curseur y (% de la hauteur)
  topY: number      // sommet y (%)
  grade: number     // pente instantanée au coureur (%)
  gradeColor: string  // couleur de fond du badge (par tranche de pente)
  gradeText: string   // couleur de texte contrastée (noir/blanc)
}

// ─── État publié à l'application mobile ────────────────────────────────────────

// Ce que la page dit de la navigation à l'appli qui l'héberge (cf. companionBridge).
// Volontairement plat et scalaire : l'appli le reçoit ~1 fois par seconde, et rien
// ici ne doit coûter une sérialisation lourde.
export interface CompanionNavTurn {
  state: TurnHint['state']
  distM: number
  direction: TurnHint['direction']
  kind: Maneuver
  exitNumber: number | null
  // Position du virage. C'est elle qui permet à l'appli de juger l'approche avec
  // son propre GPS quand la page ne parle plus (carte masquée, WebView ralenti) :
  // sans ça, une page silencieuse voudrait dire « aucun virage en vue ».
  lat: number | null
  lng: number | null
}

export interface CompanionNavClimb {
  ratio: number
  remainingGainM: number
  grade: number
  gain: number
  lengthM: number
  category: string | null
}

export interface CompanionNavState {
  type: 'nav'
  at: number
  // Suit-on un itinéraire ? Faux en navigation libre, où virages et arrivée
  // n'ont pas de sens.
  route: boolean
  turn: CompanionNavTurn | null
  offRoute: boolean
  arrived: boolean
  speedKmh: number
  remainingM: number
  remainingGainM: number
  climb: CompanionNavClimb | null
}

// Assemble l'état à publier. Pur : tout vient des paramètres, donc testable sans
// GPS ni carte.
//
// `turnCoord` est la position du virage annoncé (`geometry[turn.idx]`), pas celle
// du coureur. On ne publie pas le profil du col (segments / aire / points) : il est
// volumineux, statique pour tout le col, et le renvoyer chaque seconde ne servirait
// à rien — il aura son propre message le jour où l'appli le dessinera.
export function navStateFor(input: {
  hasRoute: boolean
  hint: TurnHint | null
  turnCoord: LngLat | null
  offRoute: boolean
  arrived: boolean
  speedKmh: number
  remainingM: number
  remainingGainM: number
  climb: ClimbInfo | null
  at?: number
}): CompanionNavState {
  const { hasRoute, hint, turnCoord, offRoute, arrived, climb } = input

  // Hors trajet, le virage annoncé porte sur un tracé qu'on a quitté : le publier
  // ferait ramener l'appli sur la carte pour une consigne qui ne s'applique plus.
  const turn: CompanionNavTurn | null = hasRoute && hint && !offRoute
    ? {
        state: hint.state,
        distM: hint.distM,
        direction: hint.direction,
        kind: hint.kind,
        exitNumber: hint.exitNumber ?? null,
        lat: turnCoord ? turnCoord[1] : null,
        lng: turnCoord ? turnCoord[0] : null,
      }
    : null

  return {
    type: 'nav',
    at: input.at ?? Date.now(),
    route: hasRoute,
    turn,
    offRoute: hasRoute && offRoute,
    arrived: hasRoute && arrived,
    speedKmh: input.speedKmh,
    remainingM: hasRoute ? input.remainingM : 0,
    remainingGainM: hasRoute ? input.remainingGainM : 0,
    climb: climb
      ? {
          ratio: climb.ratio,
          remainingGainM: climb.remainingGainM,
          grade: climb.grade,
          gain: climb.climb.gain,
          lengthM: climb.climb.lengthM,
          category: climb.climb.category,
        }
      : null,
  }
}

// ─── Couleurs / icônes ──────────────────────────────────────────────────────────

// Noir ou blanc, selon ce qui se lit le mieux sur `hex` (luminance perçue, BT.601).
export function textColorOn(hex: string): string {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111827' : '#ffffff'
}

// Icône FontAwesome de l'indicateur de virage : flèches directionnelles simples pour
// les virages, droit-devant quand la déviation est négligeable, icônes distinctes pour
// ronds-points et demi-tours.
export function turnIcon(h: { direction: 'left' | 'right'; kind: Maneuver; angle: number }): string {
  if (h.kind === 'roundabout') return h.direction === 'left' ? 'fa-rotate-left' : 'fa-rotate-right'
  if (h.kind === 'uturn') return 'fa-arrow-down'
  if (Math.abs(h.angle) < 20) return 'fa-arrow-up'
  return h.direction === 'left' ? 'fa-arrow-left' : 'fa-arrow-right'
}

// Rafale de virages enchaînés à partir du virage `ptr` : renvoie les virages SUIVANTS
// qui se succèdent de près (au plus `gapM` entre deux consécutifs). Le virage `ptr`
// lui-même reste le principal (affiché en grand) et n'est PAS inclus ; le tableau ne
// contient donc que les virages secondaires, chacun avec sa distance depuis la position
// courante `here`. Total plafonné à `max` virages (donc au plus `max - 1` suivants).
export function buildTurnChain(
  turns: TurnPoint[],
  ptr: number,
  here: number,
  gapM: number,
  max: number,
): TurnHint[] {
  const out: TurnHint[] = []
  if (ptr < 0 || ptr >= turns.length) return out
  let prevDistM = turns[ptr].distM
  for (let i = ptr + 1; i < turns.length && out.length < max - 1; i++) {
    const tn = turns[i]
    if (tn.distM - prevDistM > gapM) break
    out.push({
      direction: tn.direction,
      distM: tn.distM - here,
      kind: tn.kind,
      angle: tn.angle,
      exitNumber: tn.exitNumber,
      state: 'near',
    })
    prevDistM = tn.distM
  }
  return out
}

// Fenêtre de tolérance derrière le coureur (m) : un virage compte comme « encore devant »
// jusqu'à 5 m derrière la position projetée. Elle absorbe le bruit du snapping (la
// projection avance et recule de quelques mètres) — sans elle, le pointeur de virage
// avancerait puis l'alerte s'éteindrait pile au moment du virage.
export const TURN_PASSED_M = 5

// État des annonces sonores / vibratoires du virage courant, porté d'un fix au suivant.
export interface TurnAlertState {
  /** Rang du dernier virage annoncé (première détection) ; -1 si aucun. */
  announced: number
  /** Rang du dernier virage dont l'entrée en zone proche a été buzzée ; -1 si aucun. */
  urgentBuzzed: number
}

export const INITIAL_TURN_ALERT_STATE: TurnAlertState = { announced: -1, urgentBuzzed: -1 }

export interface TurnAlertDecision {
  state: TurnAlertState
  /** Virage armé pour la répétition cadencée (tickTurnRepeat), ou null hors zone d'alerte. */
  active: { urgent: boolean } | null
  /** Jouer un paquet d'annonce maintenant. */
  announce: boolean
  /** Ce paquet est celui de la zone proche (compte de lectures différent). */
  urgentBurst: boolean
  /** Double buzz d'entrée en zone proche — une seule fois par virage. */
  buzzApproach: boolean
  /** Vibration de manœuvre : à la première détection seulement. */
  buzzManeuver: boolean
}

// Décide ce qu'il faut annoncer pour le prochain virage, à un fix donné. Deux déclencheurs
// par virage, chacun rejoué UNE fois à l'entrée de sa zone : la première détection (zone
// lointaine) et le passage en zone proche. Chaque zone joue son propre paquet,
// indépendamment de la répétition périodique — sans quoi, répétition coupée, la zone proche
// resterait muette. Si le virage apparaît déjà dans la zone proche, les deux déclencheurs
// coïncident : une seule annonce (celle de la zone proche), pas de doublon.
//
// Rien n'est joué ici : l'appelant filtre par ses sourdines (son coupé, sourdine manuelle,
// tiroir ouvert…) puis émet. `ptr` identifie le virage — c'est son changement, et non la
// distance, qui réarme les annonces.
export function turnAlertStep(
  state: TurnAlertState,
  opts: { ptr: number; distM: number; alertM: number; urgentM: number },
): TurnAlertDecision {
  const { ptr, distM, alertM, urgentM } = opts
  const inRange = distM <= alertM && distM > -TURN_PASSED_M
  if (!inRange) {
    // Pas encore assez proche, ou virage franchi : on coupe la répétition jusqu'au suivant.
    return { state, active: null, announce: false, urgentBurst: false, buzzApproach: false, buzzManeuver: false }
  }
  const urgent = distM <= urgentM
  const enteringUrgent = urgent && state.urgentBuzzed !== ptr
  const firstAnnounce = state.announced !== ptr
  const announce = firstAnnounce || enteringUrgent
  return {
    state: {
      announced: announce ? ptr : state.announced,
      urgentBuzzed: enteringUrgent ? ptr : state.urgentBuzzed,
    },
    active: { urgent },
    announce,
    urgentBurst: urgent,
    buzzApproach: enteringUrgent,
    buzzManeuver: announce && firstAnnounce,
  }
}

// Virage tout juste franchi, retenu pour le maintien vert (confirmation « c'est fait »).
export interface ReachedTurn {
  direction: 'left' | 'right'
  kind: Maneuver
  angle: number
  exitNumber?: number
  /** Distance le long du tracé du virage franchi, pour mesurer la longueur du maintien. */
  distM: number
}

export interface TurnBannerInput {
  /** Prochain virage non franchi, ou undefined en fin de tracé. */
  turn?: TurnPoint
  /** Distance jusqu'à lui (négative juste après l'avoir passé, tant que le pointeur n'a pas avancé). */
  distM: number
  /** Virages qui le suivent de près (cf. buildTurnChain). */
  chain: TurnHint[]
  /** Dernier virage franchi et son maintien vert encore actif ? */
  reached: ReachedTurn | null
  greenActive: boolean
  /** Seuils du sport : « on est dessus » et « on l'affiche en grand » (profil). */
  nowM: number
  hintM: number
}

// Que montrer dans le bandeau de virage : l'instruction principale (`hint`) et la rafale
// affichée en petit dessous (`follow`). Priorité au prochain virage s'il est proche
// (« sauf s'il y a une autre instruction plus proche »), sinon au maintien vert du virage
// tout juste franchi, sinon au prochain virage en mode lointain.
export function turnBanner(input: TurnBannerInput): { hint: TurnHint | null; follow: TurnHint[] } {
  const { turn, distM, chain, reached, greenActive, nowM, hintM } = input
  const hintOf = (t: TurnPoint, d: number, state: TurnHint['state']): TurnHint => ({
    direction: t.direction, distM: d, kind: t.kind, angle: t.angle, exitNumber: t.exitNumber, state,
  })

  if (turn && distM > nowM && distM <= hintM) {
    // Approche classique : prochain virage en grand + sa rafale en dessous.
    return { hint: hintOf(turn, distM, 'near'), follow: chain }
  }
  if (turn && distM <= nowM && chain.length) {
    // On est SUR le virage (zone verte), mais un autre le suit de près : on affiche déjà le
    // suivant (plus utile qu'un maintien vert du virage qu'on est en train de prendre). Cela
    // couvre aussi la fenêtre distM ∈ [−5, 0] (virage tout juste passé, pointeur pas encore
    // avancé) — sinon le vert flasherait le premier virage à cet instant précis.
    return { hint: chain[0], follow: chain.slice(1) }
  }
  if (turn && distM <= nowM) {
    // Virage sur nous, sans virage rapproché derrière : confirmation verte.
    return { hint: hintOf(turn, 0, 'now'), follow: [] }
  }
  if (greenActive && reached) {
    return {
      hint: {
        direction: reached.direction, distM: 0, kind: reached.kind,
        angle: reached.angle, exitNumber: reached.exitNumber, state: 'now',
      },
      follow: [],
    }
  }
  if (turn && distM > 0) {
    // Encore loin : bandeau discret, sans rafale.
    return { hint: hintOf(turn, distM, 'far'), follow: [] }
  }
  return { hint: null, follow: [] }
}

// ─── Recalage manuel sur un virage ─────────────────────────────────────────────

// Rayon de la zone tactile d'une pastille de virage, en pixels d'écran. Bien plus large
// que la pastille (22 px de diamètre au zoom par défaut, et elle rétrécit encore en
// dézoom) : on vise au pouce, en roulant. Constant en pixels, donc indépendant du zoom.
export const TURN_TAP_RADIUS_PX = 26

// Virages sous le doigt, du plus proche au plus loin. Rendu en pixels d'écran et non en
// mètres : c'est la taille APPARENTE qui décide de ce qu'on peut viser, et deux virages à
// 40 m l'un de l'autre sont deux cibles distinctes en zoom serré, une seule en zoom large.
//
// Renvoie une LISTE et non le meilleur candidat, parce qu'un tracé qui repasse au même
// endroit (aller-retour, boucle en huit) y superpose deux virages à quelques pixels près :
// le plus proche du doigt n'est pas forcément le passage que le coureur a en tête, et
// choisir à sa place le priverait de l'autre — celui-là même qu'il vient de faire.
export function turnsNearTap(
  projected: { ptr: number; x: number; y: number }[],
  tap: { x: number; y: number },
  radiusPx = TURN_TAP_RADIUS_PX,
): number[] {
  return projected
    .map((p) => ({ ptr: p.ptr, d: Math.hypot(p.x - tap.x, p.y - tap.y) }))
    .filter((c) => c.d <= radiusPx)
    .sort((a, b) => a.d - b.d || a.ptr - b.ptr)
    .map((c) => c.ptr)
}

// Où repartir quand le coureur déclare lui-même un virage fait (ou pas encore fait).
export interface TurnResync {
  /** Sommet de la géométrie où ré-ancrer la projection. */
  idx: number
  /** Distance le long du tracé à ce sommet. */
  distAlongM: number
  /** Nouveau pointeur de prochain virage. */
  nextTurnPtr: number
}

// Pourquoi cette commande existe : un aller-retour REPASSE PAR LES MÊMES SOMMETS —
// autour du demi-tour, geometry[k−n] et geometry[k+n] sont la même coordonnée. Tant que
// le coureur atteint la pointe, le départage de nearestGeomIndex (l'indice le plus proche
// du précédent) le fait basculer sur la voie du retour. Mais un demi-tour pris EN AVANCE
// — on a compris avant le GPS qu'on était au bout — laisse la projection sur la voie de
// l'aller : au retour, les sommets de l'aller restent les plus proches du dernier indice
// connu, la progression RECULE, le pointeur ne franchit jamais le demi-tour, et la
// navigation ne repart plus de la sortie. Aucun reroutage ne rattrape ça : on est pile
// sur le tracé, donc jamais hors-trajet.
//
// Le pointeur de virage n'est pas l'essentiel du recalage : c'est l'ANCRE DE PROJECTION
// (`idx`). La fenêtre de ±60 sommets de nearestGeomIndex repart de là au fix suivant, donc
// la poser d'un sommet APRÈS le virage déclaré fait (ou d'un sommet AVANT s'il reste à
// faire) suffit à faire basculer la fenêtre sur le bon passage ; le fix suivant affine la
// position. Poser le pointeur sans l'ancre ne servirait à rien — la projection le
// ramènerait en arrière au fix d'après.
export function resyncOnTurn(
  turns: TurnPoint[],
  cumDistM: number[],
  ptr: number,
  done: boolean,
): TurnResync | null {
  const tp = turns[ptr]
  if (!tp || cumDistM.length === 0) return null
  const idx = Math.min(cumDistM.length - 1, Math.max(0, done ? tp.idx + 1 : tp.idx - 1))
  return { idx, distAlongM: cumDistM[idx] ?? tp.distM, nextTurnPtr: done ? ptr + 1 : ptr }
}

// Clé i18n (et paramètres) nommant une manœuvre en toutes lettres, pour la tooltip de la
// carte. Le bandeau, lui, se contente d'une flèche (turnIcon) : à l'arrêt devant la
// tooltip on a le temps de lire, et « Demi-tour » lève l'ambiguïté d'une flèche vers le
// bas que rien ne distingue d'un virage serré sur une pastille de 22 px.
export function turnLabel(
  t: { kind: Maneuver; direction: 'left' | 'right'; exitNumber?: number },
): { key: string; params?: Record<string, unknown> } {
  if (t.kind === 'roundabout') return { key: 'routes.turn_roundabout', params: { exit: t.exitNumber ?? 0 } }
  if (t.kind === 'uturn') return { key: 'routes.turn_uturn' }
  return { key: t.direction === 'right' ? 'routes.turn_right' : 'routes.turn_left' }
}

// Temps estimé jusqu'au prochain virage, à la vitesse actuelle. Renvoie null tant
// qu'on est quasi à l'arrêt (vitesse < 1 km/h) : l'estimation exploserait et n'aurait
// aucun sens. Format horloge m:ss au-delà d'une minute, « N s » en deçà.
export function turnEta(distM: number, speedKmh: number): string | null {
  if (speedKmh < 1) return null
  const sec = distM / (speedKmh / 3.6)
  if (sec < 60) return `${Math.round(sec)} s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Lissage exponentiel de la vitesse servant à l'ETA : la vitesse instantanée saute trop
// pour une estimation stable, et tomber à 0 à chaque feu rouge la ferait exploser. On
// n'alimente donc la moyenne qu'en roulant, et on l'amorce sur la première vitesse
// exploitable (sans quoi elle rattraperait la réalité en plusieurs minutes).
const ETA_SMOOTH = 0.05
const ETA_SPEED_FLOOR = 3   // km/h — en dessous, on considère l'arrêt et on ne moyenne pas
export function smoothEtaSpeed(avgKmh: number, kmh: number): number {
  if (kmh <= ETA_SPEED_FLOOR) return avgKmh
  return avgKmh > 0 ? avgKmh + (kmh - avgKmh) * ETA_SMOOTH : kmh
}

// Durée restante estimée (en secondes) à `speedKmh`. Renvoie null sous 1 km/h :
// l'estimation exploserait à l'arrêt et n'aurait aucun sens. À alimenter avec une
// vitesse lissée (et non instantanée) pour une ETA stable feu rouge / relance.
export function remainingSeconds(distM: number, speedKmh: number): number | null {
  if (speedKmh < 1) return null
  return distM / (speedKmh / 3.6)
}

// Format compact d'une durée : « 12 min » en deçà d'une heure, « 1 h 05 » au-delà.
export function formatDuration(sec: number): string {
  const totalMin = Math.max(0, Math.round(sec / 60))
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  return `${h} h ${String(totalMin % 60).padStart(2, '0')}`
}

// Heure d'arrivée estimée au format horloge « 14:32 », soit maintenant + `sec`.
export function arrivalClock(sec: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() + sec * 1000)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ─── Zoom de découverte du prochain virage ─────────────────────────────────────

// Fractions de la hauteur de l'écran délimitant la bande où l'on veut voir le virage :
// au-dessus de `TOP_SAFE`, il est trop haut (voire hors champ) → dézoomer ; en dessous de
// `COMFY_MAX`, il reste trop d'espace vide devant → resserrer. La bande morte entre les
// deux est large exprès : sans elle, la vue oscillerait d'une frame à l'autre.
const REVEAL_TOP_SAFE = 0.18
const REVEAL_COMFY_MAX = 0.30
// Pas de zoom par frame : petit, pour que le cumul donne un dézoom progressif et fluide.
const REVEAL_ZOOM_STEP = 0.2

// Prochain zoom de découverte, à partir de la position À L'ÉCRAN du virage (`y`, en pixels
// depuis le haut d'une vue de hauteur `h`). `base` est le zoom courant de la découverte (ou
// celui du profil au premier pas). Le résultat ne dépasse jamais le zoom du profil
// (`camZoom`) — on ne fait que dézoomer — ni le plancher caméra.
export function revealZoomStep(
  opts: { y: number; h: number; base: number; camZoom: number; minZoom: number },
): number {
  const { y, h, base, camZoom, minZoom } = opts
  let z = base
  if (y < h * REVEAL_TOP_SAFE) z = base - REVEAL_ZOOM_STEP
  else if (y > h * REVEAL_COMFY_MAX) z = base + REVEAL_ZOOM_STEP
  return Math.min(camZoom, Math.max(minZoom, z))
}

// ─── Détection d'arrivée ───────────────────────────────────────────────────────

// Marge au-delà de la zone d'arrivée à partir de laquelle on considère le coureur
// franchement « en route ». Sans marge, osciller autour d'ARRIVAL_M suffirait à armer la
// détection alors qu'on n'a jamais vraiment quitté la destination.
const ARRIVAL_EN_ROUTE_MARGIN_M = 50

// État de la détection d'arrivée, porté d'un fix GPS au suivant.
export interface ArrivalState {
  /** Vrai dès qu'on a été franchement en route (au-delà de la zone d'arrivée). */
  seenEnRoute: boolean
  /** Distance restante au fix précédent (sur le tracé) : sert à juger du rapprochement. */
  lastRemainingM: number | null
}

export const INITIAL_ARRIVAL_STATE: ArrivalState = { seenEnRoute: false, lastRemainingM: null }

// Fait avancer la détection d'arrivée d'un fix GPS. L'arrivée n'est retenue que si :
//   • on a d'abord été clairement en route (`seenEnRoute`) — sans quoi un tracé minuscule,
//     ou une boucle dont le départ se projette près de la fin, s'annoncerait « arrivé » au
//     tout premier fix ;
//   • le fix précédent était DÉJÀ dans les derniers ARRIVAL_APPROACH_M — on ne franchit pas
//     30 km en une seconde, donc un saut brutal du restant vers zéro trahit une projection
//     qui a changé de passage (tracé qui se recoupe), pas un coureur arrivé ;
//   • on est sur le tracé : hors-trajet, la progression n'est pas fiable.
// Un trou GPS ne retarde donc l'annonce que d'un fix. `arrived` (déjà annoncé) coupe court :
// on n'annonce qu'une fois par tracé.
export function arrivalStep(
  state: ArrivalState,
  opts: { remainingM: number; hasRoute: boolean; onRoute: boolean; arrived: boolean },
): ArrivalState & { justArrived: boolean } {
  const { remainingM, hasRoute, onRoute, arrived } = opts
  const seenEnRoute = state.seenEnRoute || (hasRoute && remainingM > ARRIVAL_M + ARRIVAL_EN_ROUTE_MARGIN_M)
  const approaching = state.lastRemainingM != null && state.lastRemainingM <= ARRIVAL_M + ARRIVAL_APPROACH_M
  return {
    seenEnRoute,
    // Référence du prochain fix : seulement sur le tracé.
    lastRemainingM: onRoute ? remainingM : state.lastRemainingM,
    justArrived: !arrived && seenEnRoute && approaching && onRoute && remainingM <= ARRIVAL_M,
  }
}

// ─── Géométrie ────────────────────────────────────────────────────────────────

// Déplace un lng/lat de `distM` selon `bearingDeg` (équirectangulaire — précis au
// centimètre près sur les quelques mètres extrapolés entre deux fixes GPS).
export function moveLngLat([lng, lat]: LngLat, bearingDeg: number, distM: number): LngLat {
  const R = 6371000
  const br = (bearingDeg * Math.PI) / 180
  const dLat = (distM * Math.cos(br)) / R
  const dLng = (distM * Math.sin(br)) / (R * Math.cos((lat * Math.PI) / 180))
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]
}

// ─── Profil de col ───────────────────────────────────────────────────────────

// Construit le profil d'altitude gradué d'un col. Chaque segment est un polygone rempli
// de la ligne d'altitude jusqu'à la base, coloré par sa pente. Coordonnées dans un
// viewBox 0–100 : x couvre la distance du col, y est l'altitude normalisée sur la plage.
// Pur : la mise en cache par startIdx reste à la charge de l'appelant.
export function buildClimbProfile(
  climb: Climb,
  alts: (number | null)[],
  cumDistM: number[],
): ClimbProfile {
  const { startIdx: s, endIdx: e } = climb
  const startM = cumDistM[s]
  const span = (cumDistM[e] - startM) || 1
  let minA = Infinity
  let maxA = -Infinity
  for (let i = s; i <= e; i++) { const a = alts[i] ?? 0; if (a < minA) minA = a; if (a > maxA) maxA = a }
  const range = (maxA - minA) || 1
  const xOf = (i: number) => ((cumDistM[i] - startM) / span) * 100
  const yOf = (i: number) => 96 - (((alts[i] ?? 0) - minA) / range) * 88  // 4–96, sommet en haut
  const pts: ProfilePoint[] = []
  for (let i = s; i <= e; i++) pts.push({ x: xOf(i), y: yOf(i) })
  const topY = Math.min(...pts.map((p) => p.y))
  // Aire remplie sous toute la ligne d'altitude — réutilisée (clippée) pour le gris « fait ».
  let areaD = `M${pts[0].x},100`
  for (const p of pts) areaD += ` L${p.x},${p.y}`
  areaD += ` L${pts[pts.length - 1].x},100 Z`
  const segments: ProfileSegment[] = []
  for (let i = s; i < e; i++) {
    const x1 = xOf(i)
    const x2 = xOf(i + 1)
    segments.push({
      d: `M${x1},${yOf(i)} L${x2},${yOf(i + 1)} L${x2},100 L${x1},100 Z`,
      color: colorForGrade(gradeForIndex(i, alts, cumDistM)),
    })
  }
  return { segments, areaD, pts, topY }
}

// Altitude (y, % de hauteur) à un x donné (% de largeur), interpolée entre points.
export function profileYAt(pts: ProfilePoint[], x: number): number {
  if (!pts.length) return 100
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x >= x) {
      const a = pts[i - 1]
      const b = pts[i]
      const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0
      return a.y + t * (b.y - a.y)
    }
  }
  return pts[pts.length - 1].y
}

// ─── Profil de col pour l'appli compagnon ──────────────────────────────────────

// Plafond de points republiés par col : un col dense (point GPX tous les 5-10 m
// sur 8-10 km) ferait un message de plusieurs centaines de sommets ; l'appli n'a
// besoin que d'assez de résolution pour un graphique large de quelques centaines
// de pixels. Rééchantillonné par pas fixe plutôt que tronqué : les deux
// extrémités du col (départ, sommet) sont toujours gardées.
export const COMPANION_CLIMB_MAX_POINTS = 200

export interface CompanionClimbPoint { distM: number; altM: number }

// Ce que l'appli reçoit pour dessiner elle-même le profil gradué (voir
// grade_colors.dart côté Dart) : des points bruts + une pente déjà lissée par
// segment, jamais un chemin SVG ni une couleur toute faite — l'appli recalcule
// sa propre mise à l'échelle 0-100 et sa propre table de couleurs, à la manière
// de zone_colors.dart pour le cardio/la puissance.
export interface CompanionClimbProfile {
  type: 'climb_profile'
  id: number                    // = climb.startIdx, clé de dédoublonnage stable pour ce col
  gainM: number
  lengthM: number
  avgGrade: number
  category: string | null
  points: CompanionClimbPoint[]  // s..e ré-échantillonnés, distM relatif au départ du col
  segmentGrades: number[]        // length = points.length - 1, pente lissée entre points[i] et points[i+1]
}

// Ré-échantillonne un profil dense par pas fixe, en gardant toujours les deux
// extrémités. Pur, testable indépendamment de la géométrie de l'itinéraire.
function decimateClimbProfile(
  points: CompanionClimbPoint[],
  grades: number[],
  maxPoints: number,
): { points: CompanionClimbPoint[]; segmentGrades: number[] } {
  if (points.length <= maxPoints) return { points, segmentGrades: grades }
  const step = Math.ceil((points.length - 1) / (maxPoints - 1))
  const idx: number[] = []
  for (let i = 0; i < points.length - 1; i += step) idx.push(i)
  idx.push(points.length - 1)
  const outPoints = idx.map((i) => points[i])
  // La pente d'un segment fusionné est la pente moyenne du tronçon fusionné (delta
  // altitude / delta distance entre les deux points retenus) — une fenêtre plus
  // large que gradeForIndex, cohérente avec la résolution affichée, pas un
  // nouveau calcul de lissage.
  const outGrades: number[] = []
  for (let k = 0; k < idx.length - 1; k++) {
    const a = points[idx[k]]
    const b = points[idx[k + 1]]
    const dd = b.distM - a.distM
    outGrades.push(dd > 0 ? ((b.altM - a.altM) / dd) * 100 : 0)
  }
  return { points: outPoints, segmentGrades: outGrades }
}

// Construit le message publié à l'appli à l'entrée d'un col (voir climbProfileFor
// dans RouteNavigation.vue, qui le pousse une seule fois par col — au cache-miss
// sur climb.startIdx). Pur, comme buildClimbProfile.
export function buildCompanionClimbProfile(
  climb: Climb,
  alts: (number | null)[],
  cumDistM: number[],
): CompanionClimbProfile {
  const { startIdx: s, endIdx: e } = climb
  const startM = cumDistM[s]
  const rawPoints: CompanionClimbPoint[] = []
  for (let i = s; i <= e; i++) rawPoints.push({ distM: cumDistM[i] - startM, altM: alts[i] ?? 0 })
  const rawGrades: number[] = []
  for (let i = s; i < e; i++) rawGrades.push(gradeForIndex(i, alts, cumDistM))
  const { points, segmentGrades } = decimateClimbProfile(rawPoints, rawGrades, COMPANION_CLIMB_MAX_POINTS)
  return {
    type: 'climb_profile',
    id: s,
    gainM: climb.gain,
    lengthM: climb.lengthM,
    avgGrade: climb.avgGrade,
    category: climb.category,
    points,
    segmentGrades,
  }
}

// ─── Débug ────────────────────────────────────────────────────────────────────

// Profil de col synthétique pour la carte de col (climbInfo). Reproduit la forme des
// données réelles (segments colorés par pente, aire remplie, curseur « vous êtes ici »)
// sans dépendre de la géométrie de l'itinéraire.
export function buildDebugClimb(): ClimbInfo {
  const n = 28
  const pts: ProfilePoint[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    pts.push({ x: f * 100, y: 96 - Math.pow(f, 1.5) * 90 })   // altitude haute = y bas
  }
  const segments: ProfileSegment[] = []
  for (let i = 0; i < n; i++) {
    const g = 3 + (i / n) * 11   // 3 % en bas → 14 % au sommet
    segments.push({
      d: `M${pts[i].x},${pts[i].y} L${pts[i + 1].x},${pts[i + 1].y} L${pts[i + 1].x},100 L${pts[i].x},100 Z`,
      color: colorForGrade(g),
    })
  }
  let areaD = `M${pts[0].x},100`
  for (const p of pts) areaD += ` L${p.x},${p.y}`
  areaD += ` L${pts[n].x},100 Z`
  const ratio = 0.42
  const posX = ratio * 100
  // y de la ligne d'altitude au curseur (interpolation linéaire entre points).
  const posY = profileYAt(pts, posX)
  const grade = 9
  const gradeColor = colorForGrade(grade)
  const climb: Climb = { startIdx: 0, endIdx: 0, gain: 560, lengthM: 8400, avgGrade: 6.7, category: '2', startKm: 0, endKm: 8.4 }
  return {
    climb, ratio, remainingGainM: climb.gain * (1 - ratio),
    segments, areaD, posX, posY,
    topY: Math.min(...pts.map((p) => p.y)),
    grade, gradeColor, gradeText: textColorOn(gradeColor),
  }
}
