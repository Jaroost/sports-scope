import { BROUTER_URL, brouterProfile } from './brouter'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'
import type { Sport } from './userPreferences'

// Clé sessionStorage où la navigation libre dépose l'itinéraire calculé vers un lieu
// avant de rediriger vers la page de guidage (RouteNavigation en mode session).
export const GUIDED_ROUTE_KEY = 'sportsScope.guidedRoute'

// Calcule un itinéraire BRouter entre deux points et renvoie sa géométrie + les
// indications de virage (voicehints). Partagé par le reroutage en séance
// (RouteNavigation) et le lancement d'une navigation vers un lieu choisi sur la
// carte (navigation libre ou sur itinéraire).
export async function fetchRouteToPlace(
  from: LngLat,
  to: LngLat,
  sport: Sport,
): Promise<{ geometry: Coord[]; hints: VoiceHint[] }> {
  const lonlats = `${from[0]},${from[1]}|${to[0]},${to[1]}`
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
