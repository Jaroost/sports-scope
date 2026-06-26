import { BROUTER_URL, brouterProfile } from './brouter'
import { densifyGeometry } from './routeHelpers'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'
import type { Sport } from './userPreferences'

// Un point d'ancrage d'itinéraire : position + drapeau « libre » (tronçon entrant
// tracé en ligne droite plutôt qu'accroché à la route). Aligné sur routeStore.
export interface Waypoint { lng: number; lat: number; free?: boolean }

// Calcule un itinéraire BRouter entre deux points et renvoie sa géométrie + les
// indications de virage (voicehints). Partagé par le reroutage en séance
// (RouteNavigation) et le lancement d'une navigation vers un lieu choisi sur la
// carte (navigation libre ou sur itinéraire).
export async function fetchRouteToPlace(
  from: LngLat,
  to: LngLat,
  sport: Sport,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  return fetchRouteVia([from, to], sport)
}

// Calcule un itinéraire BRouter passant par une suite de points (≥ 2). Sert à insérer
// un point intermédiaire en navigation : on route depuis un ancrage du tracé, à travers
// le nouveau point, jusqu'à un ancrage situé un peu plus loin. Même format de retour que
// fetchRouteToPlace (géométrie + voicehints).
export async function fetchRouteVia(
  points: LngLat[],
  sport: Sport,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  const lonlats = points.map((p) => `${p[0]},${p[1]}`).join('|')
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${brouterProfile(sport)}&alternativeidx=0&format=geojson&timode=2`
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
  sport: Sport,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  const lonlats = waypoints.map((w) => `${w.lng},${w.lat}`).join('|')
  // Un waypoint « libre » rend son tronçon ENTRANT droit : le tronçon i (waypoint[i] →
  // waypoint[i+1]) est droit ssi waypoint[i+1] est libre.
  const straight = new Set<number>()
  waypoints.forEach((w, i) => { if (i > 0 && w.free) straight.add(i - 1) })
  const straightParam = straight.size ? `&straight=${[...straight].sort((a, b) => a - b).join(',')}` : ''
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${brouterProfile(sport)}&alternativeidx=0&format=geojson&timode=2${straightParam}`
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
