import type { Coord } from './routeHelpers'

// Correspondance entre les points d'ancrage (waypoints) et la géométrie routée, et rang
// d'insertion d'un nouveau point. Tout est pur : la géométrie écran arrive déjà projetée par
// l'appelant (seul détenteur de la carte MapLibre). Extrait de RouteBuilderMap.vue pour être
// testable — c'est cette correspondance qui décide dans quel tronçon tombe un point inséré,
// et elle se trompait sur les tracés qui repassent au même endroit.

/** Un point d'ancrage, réduit à ce dont l'insertion a besoin (cf. routeStore.waypoints). */
export interface InsertWaypoint {
  lng: number
  lat: number
  free?: boolean
}

/** Point en pixels écran (ce que rend map.project). */
export interface ScreenPoint {
  x: number
  y: number
}

/** Une passe candidate sous le clic : l'arête touchée, où sur cette arête, et le rang. */
export interface InsertionPass {
  /** Arête geom[edgeIdx] → geom[edgeIdx + 1]. */
  edgeIdx: number
  /** Position du point projeté le long de l'arête, ∈ [0, 1]. */
  t: number
  /** Rang d'insertion dans le tableau de waypoints. */
  insertAt: number
}

// Affecte à chaque waypoint le sommet de la géométrie routée qui lui correspond. La
// géométrie parcourt les waypoints DANS L'ORDRE : on veut donc des index strictement
// croissants k0 < k1 < … < k(n-1).
//
// Le glouton « le sommet le plus proche à partir du précédent » échoue sur une boucle :
// quand le retour repasse près du départ, un waypoint précoce trouve un sommet de FIN
// globalement plus proche, s'y accroche, et tous les suivants restent coincés à la fin — le
// premier tronçon couvre alors tout le tracé et l'insertion tombe toujours au point 2.
//
// On résout par programmation dynamique : minimiser la somme des distances² sous la
// contrainte d'ordre. Placer un waypoint trop loin force tous les suivants encore plus loin
// de leur vraie position, ce que le coût global rejette — la boucle est gérée nativement.
// O(n·m), négligeable ici. Les distances sont calculées en degrés (pas en mètres) : on ne
// compare que des candidats voisins, une métrique monotone suffit.
export function assignWaypointGeomIndices(waypoints: InsertWaypoint[], geometry: Coord[]): number[] {
  const n = waypoints.length
  const m = geometry.length
  if (!n || !m) return []

  const cost = (wi: number, j: number) => {
    const dx = geometry[j][0] - waypoints[wi].lng, dy = geometry[j][1] - waypoints[wi].lat
    return dx * dx + dy * dy
  }

  if (m < n) {
    // Pas assez de sommets pour un index distinct par waypoint (cas dégénéré) : on retombe
    // sur un glouton monotone simple plutôt que de risquer une DP infaisable.
    let from = 0
    return waypoints.map((_, wi) => {
      const start = Math.min(wi === 0 ? 0 : from + 1, m - 1)
      let best = start, bestDist = Infinity
      for (let i = start; i < m; i++) { const d = cost(wi, i); if (d < bestDist) { bestDist = d; best = i } }
      from = best
      return best
    })
  }

  // dp[j] = coût minimal pour placer le waypoint courant au sommet j (waypoints précédents
  // casés à des index < j). par[wi-1][j] = sommet retenu pour le waypoint wi-1 quand le
  // waypoint wi est en j (pour remonter la solution).
  let dp = new Float64Array(m)
  for (let j = 0; j < m; j++) dp[j] = cost(0, j)
  const par: Int32Array[] = []
  for (let wi = 1; wi < n; wi++) {
    const ndp = new Float64Array(m)
    const p = new Int32Array(m)
    // Préfixe-min de dp sur les index strictement inférieurs à j.
    let bestPrev = Infinity, bestPrevIdx = -1
    for (let j = 0; j < m; j++) {
      if (j > 0 && dp[j - 1] < bestPrev) { bestPrev = dp[j - 1]; bestPrevIdx = j - 1 }
      ndp[j] = bestPrevIdx < 0 ? Infinity : bestPrev + cost(wi, j)
      p[j] = bestPrevIdx
    }
    par.push(p)
    dp = ndp
  }
  let endIdx = n - 1, endCost = Infinity
  for (let j = 0; j < m; j++) if (dp[j] < endCost) { endCost = dp[j]; endIdx = j }
  const res = new Array<number>(n)
  res[n - 1] = endIdx
  for (let wi = n - 1; wi > 0; wi--) res[wi - 1] = par[wi - 1][res[wi]]
  return res
}

// Rang d'insertion pour une ARÊTE de la géométrie : le tronçon entre waypoint i et i+1
// couvre les arêtes [wgi[i], wgi[i+1][, donc une arête de ce tronçon s'insère en i+1.
// Renvoie la fin du tableau quand les index sont indisponibles ou l'arête hors tronçons.
export function waypointPosForEdge(edgeIdx: number, wgi: number[], waypointCount: number): number {
  if (wgi.length !== waypointCount) return waypointCount
  for (let i = 0; i < wgi.length - 1; i++) {
    if (edgeIdx >= wgi[i] && edgeIdx < wgi[i + 1]) return i + 1
  }
  return waypointCount
}

// Rang d'insertion pour un SOMMET de la géométrie. Contrairement à une arête, un sommet peut
// être la borne commune à deux tronçons (c'est le sommet d'un waypoint) : la borne haute est
// donc inclusive, et le premier tronçon l'emporte.
export function waypointPosForVertex(vertexIdx: number, wgi: number[], waypointCount: number): number {
  if (wgi.length !== waypointCount) return waypointCount
  for (let i = 0; i < wgi.length - 1; i++) {
    if (vertexIdx >= wgi[i] && vertexIdx <= wgi[i + 1]) return i + 1
  }
  return waypointCount
}

// Un point inséré hérite du caractère « libre » (tronçon en ligne droite) de ses voisins :
// si l'un des deux points encadrants est libre, le nouveau l'est aussi — on prolonge la
// nature du tronçon plutôt que d'y forcer un bout routé.
export function inheritsFree(waypoints: InsertWaypoint[], insertAt: number): boolean {
  return waypoints[insertAt - 1]?.free === true || waypoints[insertAt]?.free === true
}

// Passes candidates sous un point cliqué (tout en pixels écran). Un tracé qui repasse au
// même endroit superpose plusieurs arêtes (souvent des sommets identiques, même voie OSM
// routée deux fois) au pixel près : chacune appartient à un tronçon de waypoints DIFFÉRENT,
// donc à un rang d'insertion différent. On regroupe les arêtes candidates (à `tolPx` près de
// la plus proche) par rang — une passe couvre plusieurs arêtes — en gardant l'arête la plus
// proche du clic, et on renvoie une entrée par passe, triée par rang. Plusieurs entrées =
// ambiguïté à trancher par l'utilisateur.
export function insertionPasses(
  px: ScreenPoint[],
  point: ScreenPoint,
  wgi: number[],
  waypointCount: number,
  tolPx = 8,
): InsertionPass[] {
  if (px.length < 2 || wgi.length !== waypointCount) return []

  const distSq = new Array<number>(px.length - 1)
  const ts = new Array<number>(px.length - 1)
  let bestDist = Infinity
  for (let j = 0; j < px.length - 1; j++) {
    const a = px[j], b = px[j + 1]
    const vx = b.x - a.x, vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    let tt = len2 > 0 ? ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2 : 0
    if (tt < 0) tt = 0; else if (tt > 1) tt = 1
    const cx = a.x + tt * vx, cy = a.y + tt * vy
    const dx = cx - point.x, dy = cy - point.y
    distSq[j] = dx * dx + dy * dy
    ts[j] = tt
    if (distSq[j] < bestDist) bestDist = distSq[j]
  }
  if (bestDist === Infinity) return []

  const limitSq = (Math.sqrt(bestDist) + tolPx) ** 2
  const byPos = new Map<number, InsertionPass & { dist: number }>()
  for (let j = 0; j < distSq.length; j++) {
    if (distSq[j] > limitSq) continue
    const insertAt = waypointPosForEdge(j, wgi, waypointCount)
    const prev = byPos.get(insertAt)
    if (!prev || distSq[j] < prev.dist) byPos.set(insertAt, { edgeIdx: j, t: ts[j], insertAt, dist: distSq[j] })
  }
  return [...byPos.values()]
    .sort((a, b) => a.insertAt - b.insertAt)
    .map(({ edgeIdx, t, insertAt }) => ({ edgeIdx, t, insertAt }))
}
