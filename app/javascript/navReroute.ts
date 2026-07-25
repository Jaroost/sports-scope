import { haversine, bearingBetween, nearestGeomIndex } from './routeHelpers'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'

// Décisions géométriques du reroutage en séance : où raccorder le tracé, quelles étapes
// restent à faire, et comment épisser un détour dans le tracé existant. Tout est pur
// (aucun appel réseau, aucun état de composant) — l'orchestration BRouter reste dans
// RouteNavigation.vue. Extrait pour être testable : ces choix décident si le guidage
// repart vers l'avant ou fait faire demi-tour, et si une boucle se croit finie.

// Raccord visé un peu en avant du sommet retenu, pour ne pas viser un point qu'on
// s'apprête déjà à dépasser.
const REJOIN_LOOKAHEAD_M = 30
// Demi-angle (deg) autour du cap dans lequel un point du tracé est considéré « devant »
// le coureur. Au-delà, le rejoindre imposerait de faire demi-tour.
const REJOIN_FORWARD_ARC = 85
// Distance minimale (m) au point de raccord : on ne raccorde pas juste à côté de soi.
const REJOIN_MIN_AHEAD_M = 40
// Saut maximal (m) LE LONG du tracé pour un raccord. Au-delà, on ne « rejoint » plus le
// tracé : on en escamote une portion entière. Décisif sur une boucle, dont l'arrivée
// passe à quelques mètres du départ — sans ce plafond, un écart en début de parcours
// raccorde les derniers sommets (les plus proches à vol d'oiseau) et le trajet est
// aussitôt fini. Le plafond est large : un détour normal raccroche à quelques centaines
// de mètres au plus.
const REJOIN_MAX_SKIP_M = 2000

// Sommet du tracé restant où raccorder. On privilégie le sommet le plus proche situé
// DEVANT le coureur (dans l'arc autour de son cap) : continuer tout droit raccroche alors
// le tracé plus loin, au lieu de raccorder derrière soi (point le plus proche après un
// virage manqué) et de ressortir aussitôt. À défaut de point exploitable devant (cap peu
// fiable à l'arrêt, ou tracé entièrement derrière), on retombe sur le sommet le plus proche
// depuis la progression : BRouter, guidé par le cap, en tracera quand même un accès qui
// repart vers l'avant, sans demi-tour collé au départ.
//
// `fromIdx` est la progression connue (sommet courant) : on ne regarde jamais en arrière,
// et la fenêtre de raccord part de là.
export function rejoinIndexAhead(
  geometry: Coord[],
  cumDistM: number[],
  pos: LngLat,
  heading: number,
  fromIdx: number,
): number {
  // Fenêtre de raccord : les sommets à moins de REJOIN_MAX_SKIP_M devant la progression
  // (cumDistM est croissant, on peut donc s'arrêter net). Voir REJOIN_MAX_SKIP_M.
  const maxDist = (cumDistM[fromIdx] ?? 0) + REJOIN_MAX_SKIP_M
  let best = -1
  let bestD = Infinity
  for (let i = fromIdx; i < geometry.length; i++) {
    if (cumDistM[i] > maxDist) break
    const d = haversine(pos, [geometry[i][0], geometry[i][1]])
    if (d < REJOIN_MIN_AHEAD_M) continue
    let rel = bearingBetween(pos, [geometry[i][0], geometry[i][1]]) - heading
    while (rel > 180) rel -= 360
    while (rel < -180) rel += 360
    if (Math.abs(rel) > REJOIN_FORWARD_ARC) continue
    if (d < bestD) { bestD = d; best = i }
  }
  if (best < 0) {
    best = fromIdx
    bestD = Infinity
    for (let i = fromIdx; i < geometry.length; i++) {
      if (cumDistM[i] > maxDist) break
      const d = haversine(pos, [geometry[i][0], geometry[i][1]])
      if (d < bestD) { bestD = d; best = i }
    }
  }
  let j = best
  while (j < geometry.length - 1 && cumDistM[j] - cumDistM[best] < REJOIN_LOOKAHEAD_M) j++
  return j
}

// Étapes d'une destination ad hoc encore devant le coureur : on projette chacune sur le
// tracé et on garde celles situées au-delà de sa position. Repli sur la destination seule
// si le GPS les a toutes « dépassées » — il reste toujours quelque part où aller.
export function viasAhead(vias: LngLat[], geometry: Coord[], lastIdx: number): LngLat[] {
  if (vias.length === 0) return []
  const ahead = vias.filter((v) => nearestGeomIndex(v, geometry).idx > lastIdx)
  return ahead.length > 0 ? ahead : [vias[vias.length - 1]]
}

// Ancrages d'un détour à insérer autour du sommet `nearIdx` : on remonte et on descend le
// tracé jusqu'à s'en écarter de `gapM`, pour laisser BRouter raccorder proprement le
// passage par le nouveau point au lieu de repartir pile du sommet. Bornés aux extrémités
// du tracé. `a` et `b` sont des sommets du tracé (à router), la portion `a`…`b` étant
// celle que le détour remplace — cf. spliceDetour(…, a, b + 1).
export function detourAnchors(
  geometry: Coord[],
  cumDistM: number[],
  nearIdx: number,
  gapM: number,
): { a: number; b: number } {
  let a = nearIdx
  while (a > 0 && cumDistM[nearIdx] - cumDistM[a] < gapM) a--
  let b = nearIdx
  while (b < geometry.length - 1 && cumDistM[b] - cumDistM[nearIdx] < gapM) b++
  return { a, b }
}

// Épisse un détour dans le tracé : tête inchangée (sommets < fromIdx) + détour + queue
// inchangée (sommets ≥ toIdx). Sert au reroutage hors-trace (fromIdx = 0 : le détour part
// de la position du coureur et remplace tout jusqu'au raccord) comme à l'insertion d'un
// point intermédiaire (le détour remplace une petite portion au milieu).
//
// Les voicehints des portions CONSERVÉES sont réutilisés : leurs coordonnées sont ancrées
// à l'identique sur les sommets gardés, on les retrouve donc par leur clé lng,lat. Ceux de
// la portion remplacée disparaissent avec elle. L'ordre tête → détour → queue est celui du
// tracé, comme l'attend turnsFromVoiceHints (appariement monotone le long du tracé).
export function spliceDetour(
  geometry: Coord[],
  hints: VoiceHint[],
  detour: Coord[],
  detourHints: VoiceHint[],
  fromIdx: number,
  toIdx: number,
): { geometry: Coord[]; hints: VoiceHint[] } {
  const head = geometry.slice(0, fromIdx)
  const tail = geometry.slice(toIdx)
  const key = (lng: number, lat: number) => `${lng},${lat}`
  const headKeys = new Set(head.map((c) => key(c[0], c[1])))
  const tailKeys = new Set(tail.map((c) => key(c[0], c[1])))
  const headHints = head.length ? hints.filter((h) => headKeys.has(key(h.lng, h.lat))) : []
  const tailHints = tail.length ? hints.filter((h) => tailKeys.has(key(h.lng, h.lat))) : []
  return {
    geometry: head.concat(detour).concat(tail),
    hints: headHints.concat(detourHints).concat(tailHints),
  }
}
