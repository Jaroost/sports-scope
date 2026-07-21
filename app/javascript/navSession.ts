// Session de navigation en cours, persistée dans le localStorage.
//
// Le rechargement d'une page de navigation (bouton recharger, retour depuis une autre
// app, crash du navigateur sur mobile) faisait perdre ce qu'on suivait : itinéraire
// chargé depuis la liste ou destination ad hoc (« naviguer ici »). On mémorise donc le
// tracé complet — géométrie, voicehints, points d'ancrage, étapes, POI, repères — et non
// une simple référence : c'est la seule forme qui se restaure aussi hors ligne (une
// destination ad hoc n'existe nulle part côté serveur) et sans appel réseau au montage.
//
// Complémentaire de `sportsScope.navProgress.*` (RouteNavigation), qui mémorise OÙ on en
// est le long du tracé ; ici on mémorise QUEL tracé.

import type { Coord, LngLat, VoiceHint } from './routeHelpers'
import type { Waypoint } from './navRoute'
import type { RouteMarker } from './routeMarkers'
import type { Sport } from './userPreferences'

const KEY = 'sportsScope.navSession'
// Au-delà, on considère que la séance est finie : on ne veut pas recharger d'office
// l'itinéraire d'hier parce que la page a été rouverte. Large assez pour couvrir une
// longue sortie interrompue (pause déjeuner, batterie, tunnel).
const MAX_AGE_MS = 12 * 60 * 60 * 1000

export interface NavSessionPoi { name: string; type: string; lat: number; lng: number }

export interface NavSession {
  v: 1
  /** Horodatage de la dernière écriture (péremption). */
  t: number
  name: string
  /** Token de partage du tracé sauvegardé (clé de reprise + carte hors-ligne). */
  token: string | null
  /** Id de l'itinéraire possédé (édition enregistrable), sinon null. */
  routeId: number | null
  sport: Sport
  profile: string
  geometry: Coord[]
  hints: VoiceHint[]
  waypoints: Waypoint[]
  vias: LngLat[]
  pois: NavSessionPoi[]
  markers: RouteMarker[]
}

/** Enregistre la session courante. Best-effort : quota / mode privé ne doit rien casser. */
export function saveNavSession(s: Omit<NavSession, 'v' | 't'>): void {
  if (s.geometry.length < 2) { clearNavSession(); return }
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, v: 1, t: Date.now() } satisfies NavSession))
  } catch {
    // Quota dépassé (tracé très long) : plutôt que de laisser une entrée tronquée ou
    // périmée, on efface — on repartira en navigation libre au prochain chargement.
    clearNavSession()
  }
}

/** Session mémorisée encore valide, sinon null (l'entrée périmée est effacée). */
export function loadNavSession(): NavSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as NavSession
    if (!s || s.v !== 1 || typeof s.t !== 'number' || !Array.isArray(s.geometry) || s.geometry.length < 2) {
      clearNavSession()
      return null
    }
    if (Date.now() - s.t > MAX_AGE_MS) { clearNavSession(); return null }
    return s
  } catch {
    clearNavSession()
    return null
  }
}

export function clearNavSession(): void {
  try { localStorage.removeItem(KEY) } catch { /* stockage indisponible */ }
}
