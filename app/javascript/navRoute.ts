import { BROUTER_URL } from './brouter'
import { densifyGeometry, nearestGeomIndex } from './routeHelpers'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'

// Un point d'ancrage d'itinéraire : position + drapeau « libre » (tronçon entrant
// tracé en ligne droite plutôt qu'accroché à la route). Aligné sur routeStore.
export interface Waypoint { lng: number; lat: number; free?: boolean }

// Rang d'insertion d'un nouveau point d'ancrage dans `waypoints` : on repère le tronçon
// d'ancrages (waypoint[i] → waypoint[i+1]) auquel appartient le sommet du tracé le plus
// proche du point, et on insère juste après waypoint[i]. À défaut — moins de deux
// ancrages, tracé absent, ou point au-delà du dernier ancrage — on ajoute en fin.
// `nearIdx` évite de recalculer le sommet le plus proche quand l'appelant l'a déjà.
export function waypointInsertIndex(
  geometry: Coord[],
  waypoints: Waypoint[],
  lng: number,
  lat: number,
  nearIdx?: number,
): number {
  if (waypoints.length < 2 || geometry.length < 2) return waypoints.length
  const near = nearIdx ?? nearestGeomIndex([lng, lat], geometry).idx
  const wpIdx = waypoints.map((w) => nearestGeomIndex([w.lng, w.lat], geometry).idx)
  for (let i = 0; i < wpIdx.length - 1; i++) {
    if (near >= wpIdx[i] && near <= wpIdx[i + 1]) return i + 1
  }
  return waypoints.length
}

// Rang d'insertion d'une étape tapée SUR le trajet d'aperçu d'une navigation vers un lieu
// (mode « cible »). Sans cela, un point tapé entre deux étapes existantes s'ajouterait en
// fin de séquence et le trajet ferait un aller-retour. On repère, sur la géométrie BRouter,
// le sommet le plus proche du tap, puis la première étape dont le sommet le dépasse : le
// point s'insère juste avant elle. `origin` est le point de départ du trajet (position GPS),
// qui n'est pas une étape — d'où le décalage de rang. À défaut (tap au-delà de la dernière
// étape, géométrie absente), on ajoute en fin.
export function stopInsertIndex(
  geometry: Coord[],
  origin: LngLat,
  stops: LngLat[],
  tap: LngLat,
): number {
  if (geometry.length < 2) return stops.length
  const tapIdx = nearestGeomIndex(tap, geometry).idx
  const points = [origin, ...stops]
  for (let k = 1; k < points.length; k++) {
    if (tapIdx <= nearestGeomIndex(points[k], geometry).idx) return k - 1
  }
  return stops.length
}

// Cap (angle boussole 0–360) injecté comme direction de départ BRouter. Le moteur place
// un faux point d'origine à 1 km en arrière dans ce cap, si bien que repartir en sens
// inverse au départ subit la pleine pénalité de virage (turncost) : le demi-tour initial
// devient très coûteux. Sert au reroutage pour repartir vers l'avant au lieu de faire
// demi-tour vers d'où l'on vient. Renvoie le fragment d'URL `&heading=…` (ou rien).
function headingParam(heading?: number): string {
  if (heading == null || !Number.isFinite(heading)) return ''
  const deg = Math.round(((heading % 360) + 360) % 360)
  return `&heading=${deg}`
}

// Calcule un itinéraire BRouter entre deux points et renvoie sa géométrie + les
// indications de virage (voicehints). Partagé par le reroutage en séance
// (RouteNavigation) et le lancement d'une navigation vers un lieu choisi sur la
// carte (navigation libre ou sur itinéraire). `heading` (optionnel) fixe le cap de
// départ pour décourager un demi-tour initial — voir headingParam.
export async function fetchRouteToPlace(
  from: LngLat,
  to: LngLat,
  profile: string,
  heading?: number,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  return fetchRouteVia([from, to], profile, heading)
}

// Calcule un itinéraire BRouter passant par une suite de points (≥ 2). Sert à insérer
// un point intermédiaire en navigation : on route depuis un ancrage du tracé, à travers
// le nouveau point, jusqu'à un ancrage situé un peu plus loin. Même format de retour que
// fetchRouteToPlace (géométrie + voicehints). `heading` (optionnel) fixe le cap de départ.
export async function fetchRouteVia(
  points: LngLat[],
  profile: string,
  heading?: number,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  const lonlats = points.map((p) => `${p[0]},${p[1]}`).join('|')
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timode=2${headingParam(heading)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`)
  const data = await res.json()
  const feature = data?.features?.[0]
  const coords = feature?.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('no route')
  const geometry = coords.map((c: number[]) => [c[0], c[1], c.length > 2 ? c[2] : null]) as Coord[]
  // Voicehints BRouter : [indexInTrack, command, exitNumber, distToNext, angle].
  const rawHints = Array.isArray(feature.properties?.voicehints) ? feature.properties.voicehints : []
  const hints = rawHints
    .map((h: number[]) => {
      const c = coords[h[0]]
      return c ? { lng: c[0], lat: c[1], cmd: h[1], angle: h[4] ?? 0, exit_number: h[2] ?? 0 } : null
    })
    .filter(Boolean) as VoiceHint[]
  return { geometry, hints }
}

// Recalcule un itinéraire BRouter à travers une suite de points d'ancrage, en
// respectant le drapeau « libre » de chacun (tronçon entrant tracé en ligne droite).
// Reproduit la logique du créateur (RouteBuilder.recomputeRoute) pour que l'édition
// d'un itinéraire EN navigation produise exactement le même tracé qu'à sa création.
// Sert à l'édition des points d'ancrage en séance (RouteNavigation, mode édition).
export async function fetchRouteFromWaypoints(
  waypoints: Waypoint[],
  profile: string,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  const lonlats = waypoints.map((w) => `${w.lng},${w.lat}`).join('|')
  // Un waypoint « libre » rend son tronçon ENTRANT droit : le tronçon i (waypoint[i] →
  // waypoint[i+1]) est droit ssi waypoint[i+1] est libre.
  const straight = new Set<number>()
  waypoints.forEach((w, i) => { if (i > 0 && w.free) straight.add(i - 1) })
  const straightParam = straight.size ? `&straight=${[...straight].sort((a, b) => a - b).join(',')}` : ''
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timode=2${straightParam}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`)
  const data = await res.json()
  const feature = data?.features?.[0]
  const coords = feature?.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('no route')
  let geometry = coords.map((c: number[]) => [c[0], c[1], c.length > 2 ? c[2] : null]) as Coord[]
  const rawHints = Array.isArray(feature.properties?.voicehints) ? feature.properties.voicehints : []
  const hints = rawHints
    .map((h: number[]) => {
      const c = coords[h[0]]
      return c ? { lng: c[0], lat: c[1], cmd: h[1], angle: h[4] ?? 0, exit_number: h[2] ?? 0 } : null
    })
    .filter(Boolean) as VoiceHint[]
  // Les tronçons droits (points libres) ne contiennent que leurs extrémités : on les
  // densifie pour un tracé et une progression lisses (comme le créateur).
  if (straight.size) geometry = densifyGeometry(geometry)
  return { geometry, hints }
}
