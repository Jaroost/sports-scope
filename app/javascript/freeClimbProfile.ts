// Profil d'un col deviné en navigation libre (sans tracé). Helpers purs : aucune
// dépendance à l'état réactif, au GPS ni à BRouter — tout est passé en paramètre.
//
// Sur itinéraire, le profil d'un col vient du tracé entier. En navigation libre on ne
// connaît ni la route devant, ni le col autrement que par sa position : on l'assemble
// donc à partir de deux sources, recollées en une seule polyligne :
//   - l'HISTORIQUE GPS depuis le début de la montée (ce qu'on vient de grimper, altitude
//     bruitée) ;
//   - un ITINÉRAIRE BRouter de la position au sommet (le reste à grimper, altitude issue
//     du modèle de terrain).
// Les deux altitudes ne sont pas du même référentiel (écart de quelques mètres à
// quelques dizaines) : l'historique est recalé d'une constante pour se raccorder à
// l'itinéraire sans marche d'escalier à la jonction.
import {
  buildDistancesM, bearingBetween, bearingDelta, climbCategory, colorForGrade,
  computeGainLoss, gradeForIndex, haversine,
} from './routeHelpers'
import type { Climb, Coord } from './routeHelpers'
import { buildClimbProfile, profileYAt, textColorOn } from './navHelpers'
import type { ClimbInfo, ClimbProfile } from './navHelpers'

export interface TrailPoint { lng: number; lat: number; alt: number }

export interface FreeClimbProfile {
  /** Historique + itinéraire, altitudes recalées en [2]. */
  coords: Coord[]
  alts: (number | null)[]
  cumDistM: number[]
  /** Indice dans `coords` du premier point de l'itinéraire (= le nombre de points d'historique). */
  aheadIdx: number
  /** Le col « virtuel » : de l'entrée dans la montée au sommet. */
  climb: Climb
  profile: ClimbProfile
}

// Moyenne glissante centrée : l'altitude GPS saute de plusieurs mètres d'un fix à
// l'autre, et un profil gradué dessinerait ces sauts en pentes folles.
function smoothAlts(alts: number[], half = 2): number[] {
  return alts.map((_, i) => {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - half); j <= Math.min(alts.length - 1, i + half); j++) { sum += alts[j]; n++ }
    return sum / n
  })
}

/**
 * Assemble le profil. `null` si l'itinéraire n'a pas d'altitude exploitable (la moitié
 * des points au moins) ou s'il n'y a rien à profiler.
 */
export function buildFreeClimbProfile(
  trail: TrailPoint[],
  ahead: Coord[],
  name: string,
): FreeClimbProfile | null {
  if (ahead.length < 2) return null
  const known = ahead.filter((c) => c[2] != null).length
  if (known < ahead.length / 2) return null

  // Altitudes de l'itinéraire : un point sans altitude reprend celle du précédent.
  const firstKnown = ahead.find((c) => c[2] != null)![2] as number
  let prev = firstKnown
  const aheadAlts = ahead.map((c) => { prev = c[2] ?? prev; return prev })

  // Historique recalé : son dernier point doit retomber sur le premier de l'itinéraire.
  const trailSmooth = smoothAlts(trail.map((p) => p.alt))
  const offset = trail.length ? aheadAlts[0] - trailSmooth[trailSmooth.length - 1] : 0

  const coords: Coord[] = [
    ...trail.map((p, i) => [p.lng, p.lat, trailSmooth[i] + offset] as Coord),
    ...ahead.map((c, i) => [c[0], c[1], aheadAlts[i]] as Coord),
  ]
  const alts = coords.map((c) => c[2])
  const cumDistM = buildDistancesM(coords)
  const last = coords.length - 1

  const lengthM = cumDistM[last]
  const gain = Math.max(0, (alts[last] ?? 0) - (alts[0] ?? 0))
  if (lengthM <= 0) return null
  const avgGrade = (gain / lengthM) * 100

  const climb: Climb = {
    startIdx: 0,
    endIdx: last,
    gain,
    lengthM,
    avgGrade,
    category: climbCategory(lengthM / 1000, avgGrade),
    startKm: 0,
    endKm: lengthM / 1000,
    name,
  }
  return {
    coords,
    alts,
    cumDistM,
    aheadIdx: trail.length,
    climb,
    profile: buildClimbProfile(climb, alts, cumDistM),
  }
}

/** D+ à gravir sur l'itinéraire seul (hors historique) — sert à écarter un « col » déjà quasi plat. */
export function aheadGainM(ahead: Coord[]): number {
  return computeGainLoss(ahead).gain
}

/**
 * Écart (0–180°) entre le cap de l'utilisateur et la direction que prend l'itinéraire sur
 * ses premiers mètres. Grand = BRouter nous fait faire demi-tour (route voisine, sens
 * inverse) : le profil serait celui d'une route qu'on n'est pas en train de monter.
 * `null` si l'itinéraire est trop court pour juger.
 */
export function startHeadingGap(ahead: Coord[], bearing: number, lookM = 150): number | null {
  let acc = 0
  for (let i = 1; i < ahead.length; i++) {
    acc += haversine(ahead[i - 1], ahead[i])
    if (acc >= lookM) return Math.abs(bearingDelta(bearing, bearingBetween(ahead[0], ahead[i])))
  }
  return null
}

/**
 * La carte de col (ClimbInfo) à l'indice `idx` du profil, `doneM` mètres parcourus
 * depuis son début. Même contenu que sur itinéraire (updateTurns).
 */
export function freeClimbInfoAt(
  fp: FreeClimbProfile,
  idx: number,
  doneM: number,
  profileId: number,
): ClimbInfo {
  const total = fp.cumDistM[fp.cumDistM.length - 1] || 1
  const ratio = Math.max(0, Math.min(1, doneM / total))
  const posX = ratio * 100
  const grade = gradeForIndex(idx, fp.alts, fp.cumDistM)
  const gradeColor = colorForGrade(grade)
  return {
    climb: fp.climb,
    profileId,
    ratio,
    remainingGainM: computeGainLoss(fp.coords.slice(idx)).gain,
    segments: fp.profile.segments,
    areaD: fp.profile.areaD,
    posX,
    posY: profileYAt(fp.profile.pts, posX),
    topY: fp.profile.topY,
    grade,
    gradeColor,
    gradeText: textColorOn(gradeColor),
  }
}
