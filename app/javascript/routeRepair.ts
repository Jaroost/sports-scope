// Réparation d'un itinéraire re-routé, arbitrée par la trace d'origine.
//
// Contexte : « créer un itinéraire depuis une activité » simplifie la trace en waypoints
// (simplifyIndices + nudgeIndicesOffTurns) puis laisse BRouter la redessiner. Le résultat
// est fidèle à ~2 m en médiane, mais deux défauts subsistent, de natures opposées :
//
//  • Les CROCHETS — un waypoint mal accroché (carrefour, erreur GPS) force le moteur à un
//    aller-retour parasite. Correctif : SUPPRIMER le waypoint fautif.
//    Le diagnostic est délégué aux MÊMES détecteurs que le créateur d'itinéraire
//    (detectTurnAnomalies + detectUturnAnomalies) : on répare exactement ce dont
//    l'interface se plaindra, ni plus ni moins. Les prendre pour juge est essentiel —
//    se fier aux seuls demi-tours des voicehints laissait passer l'écrasante majorité des
//    cas (mesuré : 5 alertes sur 6 sont des AMAS de virages serrés, qui ne produisent
//    aucune commande de demi-tour). Ces détecteurs désignent en prime le waypoint à
//    corriger dans `waypointIdx` : aucune heuristique de rayon n'est nécessaire.
//  • Les DÉTOURS — entre deux waypoints corrects, le moteur préfère une voie parallèle à
//    celle réellement empruntée. Correctif : AJOUTER un waypoint pris sur la trace, au
//    cœur de la zone qui diverge.
//
// Les deux gestes sont opposés : appliquer le mauvais aggrave la situation (mesuré —
// purger la zone d'un détour l'allonge). D'où le diagnostic avant le geste, et le
// garde-fou ci-dessous.
//
// Garde-fou : on ne conserve une passe que si AUCUNE des deux mesures ne se dégrade.
// Mesurer seulement l'écart du tracé vers la trace ne suffit pas — c'est aveugle à un
// morceau SUPPRIMÉ (une purge qui couperait un aller-retour délibéré obtiendrait un score
// parfait). On mesure donc dans les deux sens : `detourM` (le tracé s'éloigne) et
// `missedM` (la trace n'est plus couverte).
//
// Tout ce module raisonne en INDICES dans la trace source, jamais en coordonnées : l'ordre
// des waypoints est alors garanti par construction, sans avoir à deviner où insérer un
// point ajouté.

import { BROUTER_URL } from './brouter'
import {
  haversine, simplifyTrack, buildDistancesM,
  turnsFromVoiceHints, detectTurnAnomalies, detectUturnAnomalies,
} from './routeHelpers'
import type { Coord, LngLat, VoiceHint } from './routeHelpers'

// Au-delà de ce seuil, le tracé est considéré comme divergent de la trace. En deçà, on est
// dans le bruit du GPS et de la géométrie OSM (le 95e percentile mesuré vaut ~10 m).
const DIVERGENCE_M = 25
// Budget d'essais de purge. Les waypoints accusés sont retirés UN PAR UN, pas en bloc :
// mesuré sur une sortie de 58 km, la purge groupée des 5 coupables était rejetée en entier
// à cause d'un seul d'entre eux, alors que 4 sur 5 étaient des gains francs pris
// séparément. Chaque essai coûte un appel BRouter — l'échéance globale reste le vrai
// garde-fou sur le temps.
const MAX_PURGE_ATTEMPTS = 12
// Distance minimale entre un waypoint ajouté et un waypoint existant : en deçà, le nouveau
// point ne contraindrait rien que l'ancien ne contraigne déjà.
const MIN_ANCHOR_SPACING_M = 40
// Nombre de passes d'ancrage. Chaque passe ré-ancre TOUTES les zones divergentes d'un coup
// (dans la limite du budget de waypoints) : sur une sortie où le moteur s'égare partout,
// en corriger trois ne déplacerait rien. Les passes suivantes rattrapent les zones nées de
// la correction précédente.
const ANCHOR_PASSES = 3
// Tolérance (m) de simplification des polylignes AVANT indexation. Elle ne s'applique qu'à
// la polyligne de RÉFÉRENCE (celle dont on mesure la distance), jamais aux points
// interrogés : simplifier ceux-ci rendait le garde-fou monotone sur une approximation
// seulement, et de vraies régressions de quelques dizaines de mètres passaient au travers.
const INDEX_SIMPLIFY_M = 4
// Échéance globale de la réparation. Le coût dominant n'est pas le calcul local (mesuré à
// ~0 s, même sur 137 km) mais BRouter lui-même : sur un tracé qu'il peine à router, un
// seul appel peut prendre plusieurs secondes (mesuré : 41 s cumulées sur une sortie à pied
// en zone piétonne). Passé ce délai on s'arrête net et on rend le meilleur état atteint —
// une création d'itinéraire ne doit jamais faire attendre plus que ça.
const DEADLINE_MS = 8_000

export interface RepairReport {
  /** La réparation a-t-elle pu tourner (BRouter joignable, tracé exploitable) ? */
  ok: boolean
  removed: number
  added: number
  /** Virages signalés par les détecteurs du créateur, avant / après. */
  anomaliesBefore: number
  anomaliesAfter: number
  /** Longueur (m) du tracé s'écartant de la trace, avant / après. */
  detourBefore: number
  detourAfter: number
}

interface Routed {
  geom: Coord[]
  hints: VoiceHint[]
}

interface Score {
  detourM: number
  missedM: number
  /** Waypoints mis en cause par les détecteurs de virages douteux. */
  blamed: number[]
  anomalies: number
}

// Les mesures de ce module ne lisent que lng/lat : la géométrie BRouter porte en plus
// l'altitude (Coord), la trace source non (LngLat). On accepte donc les deux formes.
type Pt = Coord | LngLat

// ─── Index spatial ────────────────────────────────────────────────────────────
// Mesurer un écart, c'est chercher pour chaque point sa distance à une polyligne. En
// naïf c'est un produit (points × segments) : tenable sur 15 km, plus du tout sur 100 km
// avec plusieurs passes. On range donc les segments dans une grille métrique et on
// n'interroge que les cellules utiles.
class SegmentIndex {
  private cells = new Map<string, number[]>()
  private cell: number
  private kx: number
  private poly: Pt[]

  constructor(rawPoly: Pt[], cellM = 80) {
    const poly = simplifyTrack(rawPoly, INDEX_SIMPLIFY_M)
    this.poly = poly
    this.cell = cellM
    this.kx = Math.cos(((poly[0]?.[1] ?? 0) * Math.PI) / 180)
    for (let i = 1; i < poly.length; i++) {
      const [ax, ay] = this.toM(poly[i - 1])
      const [bx, by] = this.toM(poly[i])
      const x0 = Math.floor(Math.min(ax, bx) / cellM), x1 = Math.floor(Math.max(ax, bx) / cellM)
      const y0 = Math.floor(Math.min(ay, by) / cellM), y1 = Math.floor(Math.max(ay, by) / cellM)
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = `${x}:${y}`
          const list = this.cells.get(k)
          if (list) list.push(i)
          else this.cells.set(k, [i])
        }
      }
    }
  }

  private toM(p: Pt): [number, number] {
    return [p[0] * 111320 * this.kx, p[1] * 111320]
  }

  // Distance (m) du point à la polyligne. Plafonnée : au-delà de `cap`, la valeur exacte
  // n'intéresse personne — seul compte le fait d'être « loin ».
  distanceTo(p: Pt, cap = 400): number {
    const [px, py] = this.toM(p)
    let best = cap
    for (let ring = 0; ring * this.cell <= best; ring++) {
      const cx = Math.floor(px / this.cell), cy = Math.floor(py / this.cell)
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          // Anneau seulement : les cellules intérieures ont déjà été vues.
          if (ring > 0 && Math.abs(x - cx) !== ring && Math.abs(y - cy) !== ring) continue
          for (const i of this.cells.get(`${x}:${y}`) ?? []) {
            const d = this.segDist(px, py, this.poly[i - 1], this.poly[i])
            if (d < best) best = d
          }
        }
      }
    }
    return best
  }

  private segDist(px: number, py: number, a: Pt, b: Pt): number {
    const [ax, ay] = this.toM(a)
    const [bx, by] = this.toM(b)
    const dx = bx - ax, dy = by - ay
    const l2 = dx * dx + dy * dy
    if (l2 === 0) return Math.hypot(px - ax, py - ay)
    let t = ((px - ax) * dx + (py - ay) * dy) / l2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }
}

// Longueur cumulée (m) des tronçons de `pts` dont au moins une extrémité s'écarte de plus
// de `thr` de la polyligne indexée par `ref`.
function lengthBeyond(pts: Pt[], ref: SegmentIndex, thr = DIVERGENCE_M): number {
  let total = 0
  let prevFar = ref.distanceTo(pts[0]) > thr
  for (let i = 1; i < pts.length; i++) {
    const far = ref.distanceTo(pts[i]) > thr
    if (far || prevFar) total += haversine(pts[i - 1], pts[i])
    prevFar = far
  }
  return total
}

// ─── BRouter ──────────────────────────────────────────────────────────────────
async function routeVia(wps: LngLat[], profile: string, signal: AbortSignal): Promise<Routed | null> {
  const lonlats = wps.map((w) => `${w[0].toFixed(6)},${w[1].toFixed(6)}`).join('|')
  // timode=2 : BRouter joint ses voicehints, d'où l'on tire les demi-tours à purger.
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timode=2`
  const res = await fetch(url, { signal })
  if (!res.ok) return null
  const json = await res.json()
  const feature = json?.features?.[0]
  const coords: number[][] = feature?.geometry?.coordinates ?? []
  const geom: Coord[] = coords.map((c) => [c[0], c[1], c.length > 2 ? c[2] : null] as Coord)
  if (geom.length < 2) return null
  // Même conversion que RouteBuilder.recomputeRoute : [index, commande, sortie, _, angle]
  // ancré sur la coordonnée brute. `exit_number` compte — c'est lui qui permet à
  // collapseRoundabouts de replier un rond-point en une manœuvre au lieu de le compter
  // comme un amas de virages.
  const raw: number[][] = Array.isArray(feature?.properties?.voicehints) ? feature.properties.voicehints : []
  const hints = raw
    .map((h) => {
      const c = coords[h[0]]
      return c ? { lng: c[0], lat: c[1], cmd: h[1], angle: h[4] ?? 0, exit_number: h[2] ?? 0 } : null
    })
    .filter(Boolean) as VoiceHint[]
  return { geom, hints }
}

// Waypoints mis en cause par les détecteurs de virages douteux du créateur — réplique de
// `computeTurnAnomalies` (RouteBuilder). Renvoie les rangs de waypoints fautifs, un amas
// et un demi-tour imputés au même point ne comptant qu'une fois.
function blamedWaypoints(r: Routed, wps: LngLat[], diameterM: number): { blamed: number[]; total: number } {
  const cum = buildDistancesM(r.geom)
  const turns = turnsFromVoiceHints(r.hints, r.geom, cum)
  const clusters = detectTurnAnomalies(turns, r.geom, { diameterM, waypoints: wps })
  const claimed = new Set(clusters.map((a) => a.waypointIdx).filter((i) => i >= 0))
  const uturns = detectUturnAnomalies(turns, r.geom, { waypoints: wps })
    .filter((a) => a.waypointIdx < 0 || !claimed.has(a.waypointIdx))
  // Les plus fournis d'abord : sous échéance, autant tenter les coupables les plus francs.
  const all = [...clusters, ...uturns].sort((a, b) => (b.count ?? 1) - (a.count ?? 1))
  return {
    blamed: [...new Set(all.map((a) => a.waypointIdx).filter((i) => i >= 0))],
    total: all.length,
  }
}

// ─── Réparation ───────────────────────────────────────────────────────────────

/**
 * Diagnostique puis corrige les waypoints d'un itinéraire construit depuis une trace.
 *
 * `indices` désigne les waypoints par leur rang dans `track` (ce que renvoient
 * simplifyIndices / nudgeIndicesOffTurns). La valeur de retour est de même nature.
 *
 * Ne jette jamais : en cas d'échec réseau ou de tracé inexploitable, renvoie les indices
 * d'entrée inchangés avec `ok: false`. Créer un itinéraire doit rester possible même sans
 * BRouter.
 */
export async function repairAgainstTrack(
  track: LngLat[],
  indices: number[],
  profile: string,
  opts: { maxPoints?: number; turnDiameterM?: number; signal?: AbortSignal } = {},
): Promise<{ indices: number[]; report: RepairReport }> {
  const maxPoints = opts.maxPoints ?? Infinity
  // Même diamètre d'amas que le créateur, sans quoi on répare autre chose que ce qui sera
  // signalé (réglable par sport dans le profil, cf. turnAnomalyDiameterForSport).
  const diameterM = opts.turnDiameterM ?? 100
  // Échéance interne, doublée du signal de l'appelant (démontage du composant).
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS)
  opts.signal?.addEventListener('abort', () => deadline.abort())
  const signal = deadline.signal
  const fail: RepairReport = {
    ok: false, removed: 0, added: 0, anomaliesBefore: 0, anomaliesAfter: 0, detourBefore: 0, detourAfter: 0,
  }
  if (indices.length < 3 || track.length < 3) {
    clearTimeout(timer)
    return { indices, report: fail }
  }

  const trackIndex = new SegmentIndex(track)
  const score = (r: Routed, idx: number[]): Score => {
    const { blamed, total } = blamedWaypoints(r, idx.map((i) => track[i]), diameterM)
    return {
      detourM: lengthBeyond(r.geom, trackIndex),
        missedM: lengthBeyond(track, new SegmentIndex(r.geom)),
      blamed,
      anomalies: total,
    }
  }

  let curIdx = indices
  let curRouted: Routed
  let curScore: Score
  try {
    const r = await routeVia(curIdx.map((i) => track[i]), profile, signal)
    if (!r) { clearTimeout(timer); return { indices, report: fail } }
    curRouted = r
    curScore = score(r, curIdx)
  } catch {
    clearTimeout(timer)
    return { indices, report: fail }
  }

  const first = curScore
  const anomaliesBefore = curScore.anomalies
  let removed = 0
  let added = 0

  // Une passe n'est retenue que si elle n'empire rien et améliore quelque chose.
  const better = (next: Score, prev: Score): boolean =>
    next.detourM <= prev.detourM && next.missedM <= prev.missedM && next.anomalies <= prev.anomalies &&
    (next.detourM < prev.detourM || next.missedM < prev.missedM || next.anomalies < prev.anomalies)

  const tryIndices = async (nextIdx: number[]): Promise<boolean> => {
    if (nextIdx.length < 2) return false
    const r = await routeVia(nextIdx.map((i) => track[i]), profile, signal)
    if (!r) return false
    const s = score(r, nextIdx)
    if (!better(s, curScore)) return false
    curIdx = nextIdx
    curRouted = r
    curScore = s
    return true
  }

  try {
    // ── Purge : retirer les waypoints accusés, un par un ─────────────────────
    // Les détecteurs nomment le coupable ; on le retire seul et on garde le retrait s'il
    // tient devant le garde-fou. Chaque retrait accepté rebat les rangs et le diagnostic,
    // d'où la boucle. Les extrémités sont intouchables : départ et arrivée sont voulus, et
    // un demi-tour qui leur est imputé est un artefact connu (cf. detectUturnAnomalies).
    let attempts = 0
    while (attempts < MAX_PURGE_ATTEMPTS) {
      const candidates = curScore.blamed.filter((k) => k > 0 && k < curIdx.length - 1)
      if (!candidates.length) break
      let accepted = false
      for (const k of candidates) {
        if (++attempts > MAX_PURGE_ATTEMPTS) break
        if (await tryIndices(curIdx.filter((_, j) => j !== k))) {
          removed++
          accepted = true
          break
        }
      }
      if (!accepted) break
    }

    // ── Passes 2+ : ré-ancrer les détours ────────────────────────────────────
    for (let pass = 0; pass < ANCHOR_PASSES; pass++) {
      if (curScore.detourM <= 0 || curIdx.length >= maxPoints) break
      const anchors = pickAnchors(curRouted.geom, trackIndex, track, curIdx)
      if (!anchors.length) break
      const nextIdx = [...curIdx]
      for (const a of anchors) {
        if (nextIdx.length >= maxPoints) break
        const at = nextIdx.findIndex((i) => i > a)
        if (at === -1) nextIdx.push(a)
        else nextIdx.splice(at, 0, a)
      }
      const gained = nextIdx.length - curIdx.length
      if (!gained || !(await tryIndices(nextIdx))) break
      added += gained
    }
  } catch {
    // Réseau coupé ou échéance atteinte : on garde la meilleure version obtenue.
  }
  clearTimeout(timer)

  return {
    indices: curIdx,
    report: {
      ok: true,
      removed,
      added,
      anomaliesBefore,
      anomaliesAfter: curScore.anomalies,
      detourBefore: Math.round(first.detourM),
      detourAfter: Math.round(curScore.detourM),
    },
  }
}

// Indices de la trace à insérer comme waypoints : un par zone où le tracé s'éloigne
// durablement, pris au cœur de la zone, du plus grave au moins grave. On écarte ceux qui
// tomberaient sur un waypoint déjà présent — ils ne contraindraient rien de neuf.
function pickAnchors(
  geom: Pt[],
  trackIndex: SegmentIndex,
  track: LngLat[],
  curIdx: number[],
): number[] {
  const devs = geom.map((p) => trackIndex.distanceTo(p))
  const clusters: Array<{ from: number; to: number; max: number }> = []
  for (let i = 0; i < geom.length; i++) {
    if (devs[i] <= DIVERGENCE_M) continue
    const last = clusters[clusters.length - 1]
    if (last && last.to === i - 1) {
      last.to = i
      last.max = Math.max(last.max, devs[i])
    } else {
      clusters.push({ from: i, to: i, max: devs[i] })
    }
  }

  clusters.sort((a, b) => b.max - a.max)
  const out: number[] = []
  for (const c of clusters) {
    const mid = geom[Math.round((c.from + c.to) / 2)]
    let bestI = -1
    let bestD = Infinity
    for (let i = 0; i < track.length; i++) {
      const d = haversine(track[i], mid)
      if (d < bestD) { bestD = d; bestI = i }
    }
    if (bestI < 0) continue
    if (curIdx.includes(bestI)) continue
    if (curIdx.some((i) => haversine(track[i], track[bestI]) < MIN_ANCHOR_SPACING_M)) continue
    out.push(bestI)
  }
  return out
}
