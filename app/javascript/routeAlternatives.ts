import { BROUTER_URL } from './brouter'
import { computeGainLoss, haversine } from './routeHelpers'
import type { Coord, LngLat } from './routeHelpers'

// Une variante de tracé pour un tronçon : la géométrie routée par BRouter entre les
// deux extrémités de la sélection, avec ses statistiques. `idx` est l'alternativeidx
// BRouter d'origine (0 = tracé de référence, 1..3 = variantes).
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

async function fetchOne(p0: LngLat, p1: LngLat, profile: string, idx: number): Promise<RouteAlternative | null> {
  const lonlats = `${p0[0]},${p0[1]}|${p1[0]},${p1[1]}`
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=${idx}&format=geojson&timode=2`
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
