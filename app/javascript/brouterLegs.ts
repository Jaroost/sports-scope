import { BROUTER_URL } from './brouter'
import type { Coord, VoiceHint } from './routeHelpers'

// Routage BRouter **jambe par jambe** : une requête à 2 points par tronçon
// waypoint[i] → waypoint[i+1], au lieu d'une requête unique à N waypoints.
//
// Pourquoi. Sur une requête multi-waypoints, BRouter optimise le trajet d'un bloc et
// élimine les demi-tours aux points de passage : un waypoint posé dans une impasse
// (la seule sortie est le chemin par lequel on est venu) est purement et simplement
// supprimé du tracé. Sur une boucle (dernier waypoint = premier), tout s'effondre et
// BRouter renvoie une trace d'un mètre — cf. l'itinéraire 67, 4 points et aucun tracé.
// Découpé en tronçons de 2 points, chaque waypoint est honoré à la lettre.
//
// Ce n'est pas un compromis sur les performances : le coût BRouter est dominé par la
// taille de l'espace de recherche, pas par le nombre d'appels. Mesuré sur 82 waypoints
// / 107 km, à travers Traefik : 0,29 s pour la requête unique contre 0,18 s pour les
// 81 tronçons à 6 en parallèle. Et surtout le cache rend l'édition incrémentale —
// déplacer un waypoint ne recalcule que ses deux tronçons adjacents (~10 ms) au lieu
// des 107 km entiers.
//
// Contrepartie du découpage : BRouter n'émet aucun voicehint aux extrémités d'un tronçon,
// donc une manœuvre tombant exactement sur un waypoint passerait inaperçue. C'est loin
// d'être anodin, car le cas emblématique est le demi-tour sur un waypoint posé dans une
// impasse — précisément ce que les avertissements de sauvegarde doivent signaler
// (routeHelpers.detectUturnAnomalies, qui ne lit que les voicehints). On synthétise donc
// le hint manquant à chaque jonction, à partir des caps de part et d'autre.

export interface LegWaypoint {
  lng: number
  lat: number
  // Le tronçon ENTRANT de ce point est tracé en ligne droite (beeline BRouter).
  free?: boolean
}

export interface RoutedLegs {
  geometry: Coord[]
  distanceM: number
  voiceHints: VoiceHint[]
  // Au moins un tronçon est en ligne droite : l'appelant doit densifier la géométrie
  // (BRouter ne renvoie que les extrémités, sans altitude, pour ces tronçons).
  hasStraight: boolean
}

// Échec imputé à un tronçon précis — c'est tout l'intérêt du découpage : la requête
// unique échouait globalement et sans indiquer où.
export class LegRoutingError extends Error {
  // Rang du tronçon fautif : il relie waypoint[legIndex] → waypoint[legIndex + 1].
  readonly legIndex: number

  constructor(legIndex: number, message: string) {
    super(message)
    this.name = 'LegRoutingError'
    this.legIndex = legIndex
  }
}

// Le serveur tourne avec BROUTER_THREADS=4 (deploy/brouter/Dockerfile) : au-delà les
// requêtes font la queue côté serveur, et plusieurs éditeurs simultanés le satureraient.
const MAX_CONCURRENCY = 4

// Cache des tronçons, partagé entre recalculs — c'est lui qui rend l'édition
// incrémentale : après un drag, seuls les tronçons touchés sont redemandés.
const MAX_CACHED_LEGS = 1000

interface Leg {
  coords: number[][]
  lengthM: number
  hints: VoiceHint[]
}

const legCache = new Map<string, Leg>()

// 6 décimales ≈ 0,1 m : assez fin pour ne jamais confondre deux waypoints distincts,
// assez grossier pour que le même point redonne la même clé d'un recalcul à l'autre.
function coordKey(w: LegWaypoint): string {
  return `${w.lng.toFixed(6)},${w.lat.toFixed(6)}`
}

function legKey(from: LegWaypoint, to: LegWaypoint, profile: string, straight: boolean): string {
  return `${coordKey(from)}|${coordKey(to)}|${profile}|${straight ? 's' : 'r'}`
}

function remember(key: string, leg: Leg): void {
  // Map conserve l'ordre d'insertion : la première clé est la plus anciennement écrite.
  if (legCache.size >= MAX_CACHED_LEGS) {
    const oldest = legCache.keys().next().value
    if (oldest !== undefined) legCache.delete(oldest)
  }
  legCache.set(key, leg)
}

// Vide le cache — à appeler quand les tronçons mémorisés ne valent plus, typiquement
// après un changement de données de routage. Le profil fait partie de la clé, un
// changement de profil n'a donc rien à invalider.
export function clearLegCache(): void {
  legCache.clear()
}

async function fetchLeg(
  from: LegWaypoint,
  to: LegWaypoint,
  profile: string,
  straight: boolean,
  legIndex: number,
  signal: AbortSignal,
): Promise<Leg> {
  const key = legKey(from, to, profile, straight)
  const cached = legCache.get(key)
  if (cached) return cached

  const lonlats = `${coordKey(from)}|${coordKey(to)}`
  // `straight` indexe les tronçons de LA requête : sur une requête à 2 points, le seul
  // tronçon possible est le 0.
  const straightParam = straight ? '&straight=0' : ''
  // timode=2 fait émettre à BRouter ses voicehints dans les propriétés du GeoJSON.
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timode=2${straightParam}`

  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (e: any) {
    // L'annulation d'un recalcul supplanté doit remonter telle quelle : l'appelant la
    // reconnaît à son nom et l'ignore, là où une LegRoutingError afficherait une erreur.
    if (e?.name === 'AbortError') throw e
    throw new LegRoutingError(legIndex, e?.message || 'network error')
  }
  if (!res.ok) throw new LegRoutingError(legIndex, `BRouter HTTP ${res.status}`)
  const data = await res.json()
  const feature = data?.features?.[0]
  const coords = feature?.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new LegRoutingError(legIndex, 'no route')
  }

  const parsed = parseFloat(feature.properties?.['track-length'] || '0')
  const lengthM = Number.isFinite(parsed) && parsed > 0 ? parsed : 0

  // Voicehints BRouter : [indexInTrack, commande, sortie, distanceToNext, angle].
  // On les ancre tout de suite sur la coordonnée (et non sur l'index), ce qui les rend
  // insensibles à la concaténation des tronçons comme à la densification ultérieure.
  const raw = Array.isArray(feature.properties?.voicehints) ? feature.properties.voicehints : []
  const hints = raw
    .map((h: number[]) => {
      const c = coords[h[0]]
      return c ? { lng: c[0], lat: c[1], cmd: h[1], angle: h[4] ?? 0, exit_number: h[2] ?? 0 } : null
    })
    .filter(Boolean) as VoiceHint[]

  const leg: Leg = { coords, lengthM, hints }
  remember(key, leg)
  return leg
}

// Inversion de cap (deg) à partir de laquelle une jonction entre deux tronçons est tenue
// pour un demi-tour. Un vrai demi-tour mesure 180° (constaté à la virgule près sur les
// impasses) ; la marge absorbe les tracés qui repartent par un embranchement voisin.
const UTURN_MIN_DEG = 150

// Commande BRouter « demi-tour, côté donné par l'angle » (cf. maneuverFromCmd dans
// routeHelpers) : c'est la forme sous laquelle le reste du code sait lire un demi-tour.
const CMD_UTURN = 15

// Cap de `p` vers `q`, en degrés. L'échelle exacte importe peu — seul l'écart entre deux
// caps est exploité — d'où la simple correction en cosinus de latitude.
function bearing(p: number[], q: number[]): number {
  const y = q[1] - p[1]
  const x = (q[0] - p[0]) * Math.cos((p[1] * Math.PI) / 180)
  return (Math.atan2(x, y) * 180) / Math.PI
}

// Écart signé entre deux caps, ramené dans ]-180, 180]. Positif = vers la droite, ce que
// maneuverFromCmd attend pour trancher le côté d'un demi-tour.
function turnAngle(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

// Le voicehint que BRouter n'émet pas : la manœuvre à la jonction de deux tronçons, quand
// elle est assez marquée pour être un demi-tour. Ancré sur la coordonnée de la jonction —
// c'est-à-dire sur le waypoint lui-même, ce qui permet à detectUturnAnomalies de
// l'imputer au bon point d'étape.
function junctionUturn(prev: Leg, next: Leg): VoiceHint | null {
  const beforeJunction = prev.coords[prev.coords.length - 2]
  const junction = prev.coords[prev.coords.length - 1]
  const afterJunction = next.coords[1]
  if (!beforeJunction || !junction || !next.coords[0] || !afterJunction) return null
  const angle = turnAngle(bearing(beforeJunction, junction), bearing(next.coords[0], afterJunction))
  if (Math.abs(angle) < UTURN_MIN_DEG) return null
  return { lng: junction[0], lat: junction[1], cmd: CMD_UTURN, angle, exit_number: 0 }
}

// Exécute `task` sur chaque index de 0..n-1, `limit` en vol à la fois, en conservant
// l'ordre des résultats.
async function mapWithConcurrency<T>(
  n: number,
  limit: number,
  task: (i: number) => Promise<T>,
): Promise<T[]> {
  const out = new Array<T>(n)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= n) return
      out[i] = await task(i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker))
  return out
}

/**
 * Route la suite de waypoints tronçon par tronçon et recolle le résultat.
 *
 * Un waypoint « libre » n'affecte que son tronçon entrant : celui-ci est tracé en ligne
 * droite depuis le point précédent. Le tronçon sortant reste routé, sauf si le point
 * suivant est libre à son tour. Le tronçon i relie waypoint[i] → waypoint[i+1], il est
 * donc droit ssi waypoint[i+1] est libre.
 *
 * Lève une LegRoutingError portant le rang du tronçon fautif si l'un d'eux n'est pas
 * routable.
 */
export async function routeLegs(
  waypoints: LegWaypoint[],
  profile: string,
  signal: AbortSignal,
): Promise<RoutedLegs> {
  const legCount = waypoints.length - 1
  if (legCount < 1) return { geometry: [], distanceM: 0, voiceHints: [], hasStraight: false }

  const isStraight = (i: number): boolean => waypoints[i + 1].free === true

  const legs = await mapWithConcurrency(legCount, MAX_CONCURRENCY, (i) =>
    fetchLeg(waypoints[i], waypoints[i + 1], profile, isStraight(i), i, signal),
  )

  const geometry: Coord[] = []
  const voiceHints: VoiceHint[] = []
  let distanceM = 0
  let hasStraight = false

  legs.forEach((leg, i) => {
    distanceM += leg.lengthM
    if (isStraight(i)) hasStraight = true
    // Le hint de jonction vient AVANT ceux du tronçon suivant : turnsFromVoiceHints
    // apparie les hints au tracé avec un curseur monotone, l'ordre de parcours fait foi.
    if (i > 0) {
      const uturn = junctionUturn(legs[i - 1], leg)
      if (uturn) voiceHints.push(uturn)
    }
    voiceHints.push(...leg.hints)
    for (let j = 0; j < leg.coords.length; j++) {
      const c = leg.coords[j]
      // Jonction entre deux tronçons : le dernier point du précédent et le premier du
      // suivant sont le même lieu, mais BRouter leur donne parfois une altitude
      // différente (il repart de la tuile du tronçon). On compare donc lng/lat seuls,
      // et on garde la première occurrence.
      if (j === 0 && i > 0) {
        const prev = geometry[geometry.length - 1]
        if (prev && prev[0] === c[0] && prev[1] === c[1]) continue
      }
      geometry.push([c[0], c[1], c.length > 2 ? c[2] : null])
    }
  })

  return { geometry, distanceM, voiceHints, hasStraight }
}
