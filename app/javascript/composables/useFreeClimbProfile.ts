import type { Ref } from 'vue'
import { buildDistancesM, haversine, nearestGeomIndex, projectOnRoute } from '../routeHelpers'
import type { Coord, LngLat } from '../routeHelpers'
import { buildCompanionClimbProfile } from '../navHelpers'
import type { ClimbInfo } from '../navHelpers'
import { fetchRouteToPlace } from '../navRoute'
import { companionClimbProfile } from '../companionBridge'
import {
  aheadGainM, buildFreeClimbProfile, freeClimbInfoAt, startHeadingGap,
} from '../freeClimbProfile'
import type { FreeClimbProfile, TrailPoint } from '../freeClimbProfile'

// Profil du col en cours en navigation libre. Prend le relais de updateFreeClimbGuess
// (qui devine QUEL col) pour répondre à « à quoi ressemble ce qu'il reste ? » : un
// itinéraire BRouter de la position au sommet deviné, recollé à l'historique GPS de la
// montée (cf. freeClimbProfile). Le résultat est écrit dans `climbInfo`, le même ref que
// la montée sur itinéraire : carte de col, rétrécissement de la carte et publication à
// l'appli fonctionnent sans rien savoir de la différence.
//
// C'est une HYPOTHÈSE qui se corrige au fil de l'eau :
//   - le col deviné change → nouvel itinéraire ;
//   - on s'écarte de la ligne prédite (autre route) → nouvel itinéraire depuis ici ;
//   - BRouter nous renverrait en arrière (route voisine, sens inverse) → rejeté ;
//   - la devinette disparaît plus de NO_GUESS_GRACE_MS → on efface ;
//   - sommet atteint → on efface, et on ne re-devine pas ce col pendant SUMMIT_COOLDOWN_MS.

/** Au-delà de cet écart à la ligne prédite, on considère avoir pris une autre route. */
const OFF_LINE_M = 60
/** Délai minimum entre deux calculs BRouter. */
const FETCH_THROTTLE_MS = 15_000
/** Délai supplémentaire après un itinéraire rejeté (mauvais sens, pas de dénivelé…). */
const REJECT_BACKOFF_MS = 30_000
/** Une devinette qui clignote (pente au ras du seuil, col hors du cône de ±45° près du
 *  sommet) ne doit pas faire clignoter le profil : on la tient aussi longtemps. */
const NO_GUESS_GRACE_MS = 20_000
/** Sans fix sur la ligne prédite depuis aussi longtemps, le profil n'est plus fiable. */
const LOST_MS = 30_000
/** Reste à parcourir en deçà duquel le sommet est considéré atteint. */
const SUMMIT_REACHED_M = 25
const SUMMIT_COOLDOWN_MS = 10 * 60_000
/** Un itinéraire qui n'a presque plus de dénivelé à offrir n'est pas un col à profiler. */
const MIN_AHEAD_GAIN_M = 8
/** Au-delà de cet écart de cap, l'itinéraire part à l'envers. */
const MAX_HEADING_GAP_DEG = 100
/** Pas minimum de l'historique, et plafond de points (≈ 10 km de montée à ce pas). */
const TRAIL_STEP_M = 15
const TRAIL_MAX = 700

// Identifiants de profil publiés à l'appli : très au-dessus de tout indice de tracé, pour
// ne jamais coïncider avec un `startIdx` de `route_climbs`.
const PROFILE_ID_BASE = 1_000_000

export interface FreeClimbGuessInput {
  name: string
  lat: number
  lng: number
}

export interface FreeClimbFix {
  here: LngLat
  /** Altitude GPS ; absente → le fix ne nourrit pas l'historique. */
  alt: number | null
  now: number
  /** La devinette du moment (null hors montée confirmée). */
  guess: FreeClimbGuessInput | null
  /** Échantillons récents du détecteur de pente, pour amorcer l'historique à l'entrée. */
  recent: TrailPoint[]
}

export interface UseFreeClimbProfileOptions {
  /** Le ref de la carte de col, partagé avec la montée sur itinéraire. */
  climbInfo: Ref<ClimbInfo | null>
  getRoutingProfile: () => string
  getBearing: () => number
  /** Un tracé est chargé : ce composable se tait (la montée sur itinéraire prime). */
  isRouteActive: () => boolean
  /** Une carte de col factice est épinglée (mode débug) : ne pas l'écraser. */
  isPinned: () => boolean
}

export function useFreeClimbProfile(opts: UseFreeClimbProfileOptions) {
  const { climbInfo, getRoutingProfile, getBearing, isRouteActive, isPinned } = opts

  let trail: TrailPoint[] = []
  // L'itinéraire prédit et le profil construit dessus. `offsetM` : distance, dans le
  // profil combiné, de son premier point (= longueur de l'historique au moment du calcul).
  let ahead: {
    geom: Coord[]
    cum: number[]
    fp: FreeClimbProfile
    forName: string
    id: number
    offsetM: number
  } | null = null

  let inflight = false
  let fetchSeq = 0
  let lastFetchAt = 0
  let lastFixAt = 0
  let lastOnLineAt = 0
  let noGuessSince = 0
  let nextId = PROFILE_ID_BASE
  let cooldown: { name: string; until: number } | null = null
  // Vrai tant que `climbInfo` contient NOTRE carte : on ne l'efface pas si elle n'est pas à nous.
  let owns = false

  function clearInfo() {
    if (owns) climbInfo.value = null
    owns = false
  }

  /** Repart de zéro (tracé chargé, retour en navigation libre, fin de montée). */
  function reset() {
    fetchSeq++               // une réponse BRouter encore en vol sera ignorée
    inflight = false
    trail = []
    ahead = null
    noGuessSince = 0
    lastFixAt = 0
    clearInfo()
  }

  function pushTrail(here: LngLat, alt: number) {
    const last = trail[trail.length - 1]
    if (last && haversine([last.lng, last.lat], here) < TRAIL_STEP_M) return
    trail.push({ lng: here[0], lat: here[1], alt })
    if (trail.length > TRAIL_MAX) trail.shift()
  }

  function seedTrail(recent: TrailPoint[]) {
    trail = []
    for (const s of recent) pushTrail([s.lng, s.lat], s.alt)
  }

  async function fetchAhead(here: LngLat, guess: FreeClimbGuessInput, now: number) {
    const seq = ++fetchSeq
    inflight = true
    lastFetchAt = now
    try {
      const { geometry } = await fetchRouteToPlace(
        here, [guess.lng, guess.lat], getRoutingProfile(), getBearing(),
      )
      // Obsolète : reset() entre-temps, un tracé a été chargé, ou un calcul plus récent.
      if (seq !== fetchSeq || isRouteActive()) return

      const gap = startHeadingGap(geometry, getBearing())
      if (gap != null && gap > MAX_HEADING_GAP_DEG) { lastFetchAt = now + REJECT_BACKOFF_MS; return }
      if (aheadGainM(geometry) < MIN_AHEAD_GAIN_M) { lastFetchAt = now + REJECT_BACKOFF_MS; return }

      const fp = buildFreeClimbProfile(trail.slice(), geometry, guess.name)
      if (!fp) { lastFetchAt = now + REJECT_BACKOFF_MS; return }

      const id = nextId++
      ahead = {
        geom: geometry,
        cum: buildDistancesM(geometry),
        fp,
        forName: guess.name,
        id,
        offsetM: fp.cumDistM[fp.aheadIdx] ?? 0,
      }
      lastOnLineAt = Date.now()
      // Le profil part vers l'appli AVANT la trame `nav` qui y renvoie par `id` (voir
      // ClimbProfileNotifier côté appli : un message à la fois, le dernier gagne).
      companionClimbProfile({ ...buildCompanionClimbProfile(fp.climb, fp.alts, fp.cumDistM), id })
      // La carte de col apparaît tout de suite, sans attendre le prochain fix.
      climbInfo.value = freeClimbInfoAt(fp, fp.aheadIdx, ahead.offsetM, id)
      owns = true
    } catch {
      // Réseau, BRouter, hors couverture : on garde le profil précédent s'il y en a un,
      // et le prochain fix retentera après le délai.
    } finally {
      if (seq === fetchSeq) inflight = false
    }
  }

  /** À appeler à chaque fix de la navigation libre. */
  function onFix({ here, alt, now, guess, recent }: FreeClimbFix) {
    if (isRouteActive() || isPinned()) return
    // Plus de fix depuis longtemps (mode itinéraire entre-temps, application en veille) :
    // l'historique ne se raccorde plus à la position.
    if (lastFixAt && now - lastFixAt > 60_000) reset()
    lastFixAt = now

    // Col déjà grimpé : on ne le re-devine pas en redescendant l'autre versant.
    if (cooldown && now >= cooldown.until) cooldown = null
    if (guess && cooldown?.name === guess.name) guess = null

    if (guess) noGuessSince = 0
    else if (!noGuessSince) noGuessSince = now
    if (!guess && noGuessSince && now - noGuessSince > NO_GUESS_GRACE_MS) { reset(); return }
    if (!guess && !ahead) { trail = []; return }

    // Historique : amorcé à l'entrée dans la montée avec la fenêtre du détecteur.
    if (alt != null) {
      if (!trail.length) seedTrail(recent)
      pushTrail(here, alt)
    }

    let needFetch = false
    if (ahead) {
      const near = nearestGeomIndex(here, ahead.geom)
      const proj = projectOnRoute(here, ahead.geom, ahead.cum, near.idx)
      const offM = haversine(here, proj.point)
      const remainingM = ahead.cum[ahead.cum.length - 1] - proj.distAlongM

      if (remainingM < SUMMIT_REACHED_M && offM <= OFF_LINE_M) {
        cooldown = { name: ahead.forName, until: now + SUMMIT_COOLDOWN_MS }
        reset()
        return
      }
      if (offM <= OFF_LINE_M) {
        lastOnLineAt = now
        climbInfo.value = freeClimbInfoAt(
          ahead.fp, ahead.fp.aheadIdx + near.idx, ahead.offsetM + proj.distAlongM, ahead.id,
        )
        owns = true
      } else {
        needFetch = true
        if (now - lastOnLineAt > LOST_MS) { ahead = null; clearInfo() }
      }
      if (guess && ahead?.forName !== guess.name) needFetch = true
    } else {
      needFetch = true
    }

    if (needFetch && guess && !inflight && now - lastFetchAt >= FETCH_THROTTLE_MS) {
      void fetchAhead(here, guess, now)
    }
  }

  return { onFix, reset }
}
