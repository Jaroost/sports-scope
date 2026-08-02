import { BROUTER_URL } from './brouter'
import { computeGainLoss, haversine } from './routeHelpers'
import type { Coord, LngLat } from './routeHelpers'

// Une variante de tracé pour un tronçon : la géométrie routée par BRouter entre les
// deux extrémités de la sélection, avec ses statistiques. `idx` est l'alternativeidx
// BRouter d'origine (0 = tracé de référence, 1..3 = variantes), ou -1 pour une variante
// obtenue par blocage (cf. fetchBlockedAlternatives).
export interface RouteAlternative {
  idx: number
  coords: Coord[]
  distanceM: number
  gainM: number
  lossM: number
}

// BRouter accepte alternativeidx 0..3 : 0 est l'itinéraire « optimal » (sert de
// référence pour l'affichage des écarts), 1..3 sont des variantes empruntant
// d'autres routes/chemins.
const ALT_INDICES = [0, 1, 2, 3]

// ─── Variantes par blocage ────────────────────────────────────────────────────
// alternativeidx n'explore qu'une bande de coût étroite autour de l'optimum : sur un
// couloir à une seule route, il renvoie 4 fois la même géométrie. Pour aller chercher
// les vraies bifurcations, on interdit tour à tour un disque (`nogos`) posé sur le
// tronçon actuel et on relance le routage : BRouter doit alors contourner, ce qui fait
// ressortir des tracés à +50/+100 % de coût qu'il ne proposerait jamais seul.
//
// Le disque est préféré au passage forcé par une jonction : on n'a pas le graphe
// routier en local (donc pas la position des jonctions), et un via mal placé produit
// des allers-retours, là où un disque interdit rend toujours un P0→P1 propre.

// Rayon du disque de la passe automatique. Mesuré : 150 m est le meilleur compromis
// (les grands rayons donnent surtout des doublons et des détours absurdes).
export const BLOCK_RADIUS_M = 150
// « Chercher plus large » : +500 m de rayon par clic, 10 paliers. Les grands rayons
// forcent des contournements de plus en plus lointains — c'est ce qu'on veut quand on
// les demande explicitement. Combien de paliers sont réellement praticables dépend du
// tronçon : voir usableWidenLevels().
export const WIDEN_STEP_M = 500
export const WIDEN_LEVELS = 10

// Rayon du palier `step` (0 = premier clic).
export function widenRadiusForStep(step: number): number {
  return BLOCK_RADIUS_M + (step + 1) * WIDEN_STEP_M
}

// Positions des disques le long du tronçon. Les extrémités sont exclues : un disque qui
// avale P0 ou P1 rend le routage impossible (BRouter ne renvoie alors aucune route).
const BLOCK_FRACTIONS = [0.15, 0.3, 0.45, 0.6, 0.75]
const BLOCK_ENDPOINT_MARGIN_M = 50

// Deux variantes sont considérées identiques si leur longueur diffère de moins de
// ~1,5 % ET que quelques points échantillonnés coïncident (< 25 m). BRouter renvoie
// souvent le même tracé pour plusieurs idx quand il n'existe pas de vraie alternative.
const DEDUP_LENGTH_RATIO = 0.015
const DEDUP_POINT_TOL_M = 25
const DEDUP_SAMPLES = 6

function sampleAt(coords: Coord[], f: number): Coord {
  const i = Math.min(coords.length - 1, Math.max(0, Math.round(f * (coords.length - 1))))
  return coords[i]
}

// Deux géométries routées sont-elles équivalentes (même longueur à ~1,5 % près et
// points échantillonnés proches) ? Sert à dédoublonner les variantes entre elles et
// à écarter celles identiques au tronçon actuel.
export function equivalentGeometry(
  a: { coords: Coord[]; distanceM: number },
  b: { coords: Coord[]; distanceM: number },
): boolean {
  const denom = Math.max(a.distanceM, b.distanceM, 1)
  if (Math.abs(a.distanceM - b.distanceM) / denom > DEDUP_LENGTH_RATIO) return false
  for (let s = 1; s < DEDUP_SAMPLES; s++) {
    const f = s / DEDUP_SAMPLES
    if (haversine(sampleAt(a.coords, f), sampleAt(b.coords, f)) > DEDUP_POINT_TOL_M) return false
  }
  return true
}

async function fetchOne(
  p0: LngLat,
  p1: LngLat,
  profile: string,
  idx: number,
  nogo?: { at: LngLat; radiusM: number },
): Promise<RouteAlternative | null> {
  const lonlats = `${p0[0]},${p0[1]}|${p1[0]},${p1[1]}`
  const nogos = nogo ? `&nogos=${nogo.at[0]},${nogo.at[1]},${Math.round(nogo.radiusM)}` : ''
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=${idx}&format=geojson&timode=2${nogos}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  const feature = data?.features?.[0]
  const raw = feature?.geometry?.coordinates
  if (!Array.isArray(raw) || raw.length < 2) return null
  const coords = raw.map((c: number[]) => [c[0], c[1], c.length > 2 ? c[2] : null]) as Coord[]
  const trackLen = parseFloat(feature.properties?.['track-length'] || '0')
  const { gain, loss } = computeGainLoss(coords)
  return {
    idx,
    coords,
    distanceM: Number.isFinite(trackLen) && trackLen > 0 ? trackLen : 0,
    gainM: gain,
    lossM: loss,
  }
}

// Rejoue le routage entre P0 et P1 avec chaque alternativeidx BRouter et renvoie les
// variantes distinctes. La première (idx 0) est conservée comme référence en tête ;
// les appelants la traitent comme le tronçon « actuel » pour comparer les écarts.
export async function fetchSegmentAlternatives(
  p0: LngLat,
  p1: LngLat,
  profile: string,
): Promise<RouteAlternative[]> {
  const settled = await Promise.allSettled(ALT_INDICES.map((idx) => fetchOne(p0, p1, profile, idx)))
  const raw = settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((a): a is RouteAlternative => a != null)

  const distinct: RouteAlternative[] = []
  for (const alt of raw) {
    if (distinct.some((d) => equivalentGeometry(d, alt))) continue
    distinct.push(alt)
  }
  return distinct
}

// Points du tronçon sur lesquels poser un disque interdit : répartis le long du tracé,
// en écartant ceux trop proches d'une extrémité (le disque l'engloberait).
export function blockPointsAlong(coords: Coord[], radiusM: number): LngLat[] {
  if (coords.length < 2) return []
  const cum: number[] = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]))
  const total = cum[cum.length - 1]
  if (total <= 0) return []

  const p0 = coords[0]
  const p1 = coords[coords.length - 1]
  const minGap = radiusM + BLOCK_ENDPOINT_MARGIN_M
  const points: LngLat[] = []
  for (const f of BLOCK_FRACTIONS) {
    const target = total * f
    let i = cum.findIndex((d) => d >= target)
    if (i < 0) i = coords.length - 1
    const c = coords[i]
    // Distance réelle aux extrémités, pas la distance le long du tracé : un tronçon qui
    // revient sur lui-même peut frôler son départ en son milieu.
    if (haversine(c, p0) < minGap || haversine(c, p1) < minGap) continue
    points.push([c[0], c[1]])
  }
  return points
}

// Nombre de paliers d'élargissement réellement praticables sur ce tronçon. Passé une
// certaine taille, le disque engloberait une extrémité où qu'on le pose : le routage
// devient impossible et la passe ne peut plus rien rapporter. Proposer ces paliers-là
// donnerait un bouton qui ne fait rien.
export function usableWidenLevels(segmentCoords: Coord[]): number {
  for (let step = 0; step < WIDEN_LEVELS; step++) {
    if (!blockPointsAlong(segmentCoords, widenRadiusForStep(step)).length) return step
  }
  return WIDEN_LEVELS
}

// Variantes obtenues en interdisant tour à tour un morceau du tronçon. Le résultat est
// dédoublonné entre variantes ; l'appelant reste chargé d'écarter celles équivalentes au
// tronçon actuel et de classer l'ensemble.
export async function fetchBlockedAlternatives(
  p0: LngLat,
  p1: LngLat,
  profile: string,
  segmentCoords: Coord[],
  radiusM: number,
): Promise<RouteAlternative[]> {
  const blocks = blockPointsAlong(segmentCoords, radiusM)
  if (!blocks.length) return []

  const settled = await Promise.allSettled(
    blocks.map((at) => fetchOne(p0, p1, profile, 0, { at, radiusM })),
  )
  const raw = settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((a): a is RouteAlternative => a != null)
    // `idx` n'a pas de sens ici : ces variantes ne viennent pas d'un alternativeidx.
    .map((a) => ({ ...a, idx: -1 }))

  const distinct: RouteAlternative[] = []
  for (const alt of raw) {
    if (distinct.some((d) => equivalentGeometry(d, alt))) continue
    distinct.push(alt)
  }
  return distinct
}
