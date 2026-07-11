// Utility functions shared between RouteBuilder sub-components.
// No Vue imports — pure TypeScript.

import { sportPreferences } from './userPreferences'
import type { Sport } from './userPreferences'

export type Coord = [number, number, number | null]
export type LngLat = [number, number]

// URL du créateur d'itinéraire pré-renseignée avec le nom et le type choisis dans
// la modale de création. Respecte le préfixe de langue éventuel (/en, /fr).
export function buildNewRouteUrl({ name, sport, profile }: { name: string; sport: Sport; profile?: string }): string {
  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
  const localePrefix = lang ? `/${lang}` : ''
  const url = new URL(`${localePrefix}/routes/new`, window.location.origin)
  if (name) url.searchParams.set('name', name)
  url.searchParams.set('activity', sport)
  if (profile) url.searchParams.set('profile', profile)
  return url.toString()
}

export function haversine(a: Coord | LngLat, b: Coord | LngLat): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

export function buildDistancesM(geom: Array<Coord | LngLat>): number[] {
  const d = [0]
  for (let i = 1; i < geom.length; i++) d.push(d[i - 1] + haversine(geom[i - 1], geom[i]))
  return d
}

export function formatKm(m: number): string {
  if (!m) return '0 km'
  return `${(m / 1000).toFixed(2)} km`
}

export function formatDistanceShort(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${Math.round(m / 1000)} km`
}

// Comme formatDistanceShort mais avec 2 décimales en km (m < 1 km reste en mètres).
export function formatDistancePrecise(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`
}

export function formatDuration(totalSec: number): string {
  if (!totalSec || totalSec < 0) return '–'
  const h = Math.floor(totalSec / 3600)
  const m = Math.round((totalSec - h * 3600) / 60)
  if (h === 0) return `${m} min`
  return `${h} h ${String(m).padStart(2, '0')}`
}

// Densifie les longs tronçons (typiquement les lignes droites « straight » de BRouter
// entre points libres, qui ne contiennent que leurs deux extrémités) en insérant des
// points interpolés linéairement avec une altitude nulle, à combler ensuite par open-meteo.
// Les tronçons routés sont déjà denses : seuls les écarts > spacingM gagnent des points.
// Les points d'origine sont tous conservés, l'indexage des waypoints reste donc valide.
export function densifyGeometry(coords: Coord[], spacingM = 100): Coord[] {
  if (coords.length < 2) return coords.slice()
  const out: Coord[] = [coords[0]]
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]
    const b = coords[i]
    const d = haversine(a, b)
    if (d > spacingM * 1.5) {
      const n = Math.floor(d / spacingM)
      for (let k = 1; k < n; k++) {
        const f = k / n
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, null])
      }
    }
    out.push(b)
  }
  return out
}

export function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr.slice()
  const step = arr.length / maxPoints
  const out: T[] = []
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)])
  return out
}

// Sous-échantillonne une trace en répartissant les points uniformément par DISTANCE
// parcourue (et non par index, comme downsample). Indispensable pour les traces GPS
// enregistrées à intervalle de temps fixe : avec un échantillonnage par index, les
// sections rapides (descentes, souvent les plus sinueuses) reçoivent trop peu de points,
// ce qui maximise la dérive après re-routage. Conserve toujours le premier et le dernier
// point, et garantit des index strictement croissants (pas de waypoint dupliqué).
export function downsampleByDistance<T extends Coord | LngLat>(coords: T[], maxPoints: number): T[] {
  if (coords.length <= maxPoints || maxPoints < 2) return coords.slice()
  const dists = buildDistancesM(coords)
  const total = dists[dists.length - 1]
  if (total <= 0) return downsample(coords, maxPoints)
  const out: T[] = [coords[0]]
  let lastIdx = 0
  let j = 1
  for (let i = 1; i < maxPoints - 1; i++) {
    const target = (total * i) / (maxPoints - 1)
    while (j < coords.length - 1 && dists[j] < target) j++
    if (j > lastIdx) { out.push(coords[j]); lastIdx = j }
  }
  out.push(coords[coords.length - 1])
  return out
}

// Distance perpendiculaire (en mètres) du point p au segment [a, b]. Les coordonnées
// lng/lat sont projetées sur un plan local (équirectangulaire centré sur le segment) :
// l'approximation est largement suffisante aux échelles d'un itinéraire pour comparer
// une distance à une tolérance en mètres.
function perpDistanceM(p: Coord | LngLat, a: Coord | LngLat, b: Coord | LngLat): number {
  const latRef = (((a[1] + b[1]) / 2) * Math.PI) / 180
  const mLat = 111320
  const mLng = 111320 * Math.cos(latRef)
  const ax = a[0] * mLng, ay = a[1] * mLat
  const bx = b[0] * mLng, by = b[1] * mLat
  const px = p[0] * mLng, py = p[1] * mLat
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// Simplifie une trace par l'algorithme de Ramer-Douglas-Peucker : ne conserve que les
// points qui s'écartent de plus de `toleranceM` de la corde — autrement dit, les points
// où la trace change réellement de direction. Les longues lignes droites s'effondrent à
// deux points, les virages gardent le détail nécessaire. Bien plus malin qu'un
// sous-échantillonnage uniforme : moins de waypoints inutiles pour une fidélité égale.
// Implémentation itérative (pile explicite) pour encaisser les traces de milliers de points.
// `maxPoints` (optionnel) : si la simplification dépasse ce plafond, la tolérance est
// augmentée progressivement jusqu'à passer dessous (utile pour rester sous la limite BRouter).
export function simplifyTrack<T extends Coord | LngLat>(coords: T[], toleranceM = 8, maxPoints?: number): T[] {
  const rdp = (tol: number): T[] => {
    const n = coords.length
    if (n <= 2) return coords.slice()
    const keep = new Uint8Array(n)
    keep[0] = 1; keep[n - 1] = 1
    const stack: Array<[number, number]> = [[0, n - 1]]
    while (stack.length) {
      const [first, last] = stack.pop()!
      let maxDist = -1, idx = -1
      for (let i = first + 1; i < last; i++) {
        const d = perpDistanceM(coords[i], coords[first], coords[last])
        if (d > maxDist) { maxDist = d; idx = i }
      }
      if (idx !== -1 && maxDist > tol) {
        keep[idx] = 1
        stack.push([first, idx], [idx, last])
      }
    }
    const out: T[] = []
    for (let i = 0; i < n; i++) if (keep[i]) out.push(coords[i])
    return out
  }

  let tol = toleranceM
  let out = rdp(tol)
  if (maxPoints && maxPoints >= 2) {
    let guard = 0
    while (out.length > maxPoints && guard++ < 24) { tol *= 1.6; out = rdp(tol) }
    // Garde-fou ultime sur trace pathologique : coupe net par distance.
    if (out.length > maxPoints) out = downsampleByDistance(out, maxPoints)
  }
  return out
}

// Variante de simplifyTrack qui renvoie les INDICES conservés (triés croissant) plutôt que
// les points eux-mêmes. Utile pour sous-échantillonner en parallèle plusieurs tableaux
// alignés par index (coords + altitude + distance) sans casser leur correspondance — ce
// qu'exige buildGradedSegments. Même algorithme Ramer-Douglas-Peucker que simplifyTrack.
export function simplifyIndices(coords: (Coord | LngLat)[], toleranceM = 8): number[] {
  const n = coords.length
  if (n <= 2) return coords.map((_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1; keep[n - 1] = 1
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    let maxDist = -1, idx = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpDistanceM(coords[i], coords[first], coords[last])
      if (d > maxDist) { maxDist = d; idx = i }
    }
    if (idx !== -1 && maxDist > toleranceM) {
      keep[idx] = 1
      stack.push([first, idx], [idx, last])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

// ─── Grade / climb helpers ────────────────────────────────────────────────────

export const GRADE_BUCKETS = [
  { max: -8,       color: '#1e3a8a' },
  { max: -3,       color: '#3b82f6' },
  { max:  3,       color: '#22c55e' },
  { max:  6,       color: '#eab308' },
  { max: 10,       color: '#f97316' },
  { max: 15,       color: '#dc2626' },
  { max: Infinity, color: '#7f1d1d' },
]

// Fenêtre de lissage de la pente (m), réglable dans le profil utilisateur pour le sport
// courant. Repli sur 40 m hors page connectée. Source unique pour gradeForIndex /
// computeSegmentGrades.
export function gradeSmoothingM(): number {
  const v = sportPreferences().climb_detection.grade_smoothing_m
  return Number.isFinite(v) && v > 0 ? v : 40
}

// Pente au sommet i, lissée sur une fenêtre horizontale d'au moins windowM mètres.
// Sans lissage, l'altitude quantifiée au mètre produit des pentes aberrantes entre
// sommets voisins (cf. computeSegmentGrades). Sert à la fois à la coloration de la
// carte et à la détection de cols, pour rester cohérent avec le profil d'altitude.
export function gradeForIndex(
  i: number,
  altitudes: (number | null)[],
  distances: number[],
  windowM = gradeSmoothingM(),
): number {
  if (!altitudes || !distances) return 0
  const n = Math.min(altitudes.length, distances.length)
  if (i + 1 >= n) return 0
  const half = windowM / 2
  const mid = (distances[i] + distances[i + 1]) / 2
  let lo = i
  while (lo > 0 && (mid - distances[lo] < half || altitudes[lo] == null)) lo--
  let hi = i + 1
  while (hi < n - 1 && (distances[hi] - mid < half || altitudes[hi] == null)) hi++
  const elo = altitudes[lo]
  const ehi = altitudes[hi]
  const dd = distances[hi] - distances[lo]
  return elo != null && ehi != null && dd > 0 ? ((ehi - elo) / dd) * 100 : 0
}

export function bucketGrade(g: number): number {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return i
  }
  return GRADE_BUCKETS.length - 1
}

export function colorForGrade(g: number): string {
  for (const b of GRADE_BUCKETS) {
    if (g < b.max) return b.color
  }
  return GRADE_BUCKETS[GRADE_BUCKETS.length - 1].color
}

export interface Climb {
  startIdx: number
  endIdx: number
  gain: number
  lengthM: number
  avgGrade: number
  category: string | null
  startKm: number
  endKm: number
}

function climbCategory(lengthKm: number, avgGrade: number): string | null {
  const score = lengthKm * Math.pow(Math.max(0, avgGrade), 2)
  if (score >= 400) return 'HC'
  if (score >= 200) return '1'
  if (score >= 100) return '2'
  if (score >= 60) return '3'
  if (score >= 25) return '4'
  return null
}

export interface ClimbDetectionOptions {
  minGrade: number
  minGainM: number
  minLengthM: number
  mergeGapM: number
}

// Seuils par défaut issus des préférences du profil pour le sport courant (cf.
// sportPreferences) : un raidillon de sentier n'est pas un col de vélo. Tombe sur les
// valeurs par défaut sûres hors page connectée (navigation partagée…).
function defaultClimbOptions(): ClimbDetectionOptions {
  const c = sportPreferences().climb_detection
  return { minGrade: c.min_grade, minGainM: c.min_gain_m, minLengthM: c.min_length_m, mergeGapM: c.merge_gap_m }
}

export function detectClimbs(
  altitudes: (number | null)[],
  distances: number[],
  options?: Partial<ClimbDetectionOptions>,
): Climb[] {
  if (!altitudes?.length || !distances?.length) return []
  const { minGrade: MIN_GRADE, minGainM: MIN_GAIN_M, minLengthM: MIN_LENGTH_M, mergeGapM: MERGE_GAP_M } = {
    ...defaultClimbOptions(),
    ...options,
  }
  const len = Math.min(altitudes.length, distances.length)
  const raw: { startIdx: number; endIdx: number }[] = []
  let startIdx = -1
  for (let i = 0; i < len; i++) {
    const g = gradeForIndex(i, altitudes, distances)
    if (g >= MIN_GRADE) {
      if (startIdx < 0) startIdx = i
    } else if (startIdx >= 0) {
      raw.push({ startIdx, endIdx: i })
      startIdx = -1
    }
  }
  if (startIdx >= 0) raw.push({ startIdx, endIdx: len - 1 })
  const merged: { startIdx: number; endIdx: number }[] = []
  for (const r of raw) {
    if (!merged.length) { merged.push(r); continue }
    const prev = merged[merged.length - 1]
    const gap = distances[r.startIdx] - distances[prev.endIdx]
    if (gap <= MERGE_GAP_M) prev.endIdx = r.endIdx
    else merged.push(r)
  }
  return merged
    .map((r) => {
      const gain = (altitudes[r.endIdx] ?? 0) - (altitudes[r.startIdx] ?? 0)
      const lengthM = distances[r.endIdx] - distances[r.startIdx]
      const avgGrade = lengthM > 0 ? (gain / lengthM) * 100 : 0
      return {
        ...r,
        gain,
        lengthM,
        avgGrade,
        category: climbCategory(lengthM / 1000, avgGrade),
        startKm: distances[r.startIdx] / 1000,
        endKm: distances[r.endIdx] / 1000,
      }
    })
    .filter((c) => c.gain >= MIN_GAIN_M && c.lengthM >= MIN_LENGTH_M && c.avgGrade >= MIN_GRADE)
}

export function buildGradedSegments(
  coords: LngLat[],
  altitudes: (number | null)[],
  distances: number[],
): any[] {
  if (!coords || coords.length < 2) return []
  const features: any[] = []
  let current = [coords[0]]
  let curBucket = bucketGrade(gradeForIndex(0, altitudes, distances))
  for (let i = 1; i < coords.length; i++) {
    const g = gradeForIndex(Math.min(i, coords.length - 2), altitudes, distances)
    const b = bucketGrade(g)
    current.push(coords[i])
    if (b !== curBucket && current.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: current.slice() },
        properties: { bucket: curBucket },
      })
      current = [coords[i]]
      curBucket = b
    }
  }
  if (current.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: current },
      properties: { bucket: curBucket },
    })
  }
  return features
}

export function computeGainLoss(coords: Coord[]): { gain: number; loss: number } {
  let gain = 0
  let loss = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1][2]
    const b = coords[i][2]
    if (a == null || b == null) continue
    const d = b - a
    if (d > 0) gain += d
    else loss += -d
  }
  return { gain, loss }
}

// Pente lissée, un élément par tronçon (longueur coords.length - 1).
// L'altitude (BRouter/SRTM, open-meteo) est quantifiée au mètre : calculer la pente
// entre deux sommets voisins distants de ~1–2 m fait apparaître des valeurs absurdes
// (un saut d'1 m sur 1,5 m horizontal = ~67 %). On calcule donc la pente sur une
// fenêtre horizontale d'au moins windowM mètres centrée sur le tronçon, en n'utilisant
// que des sommets cotés (altitude non nulle).
export function computeSegmentGrades(coords: Coord[], windowM = gradeSmoothingM()): (number | null)[] {
  const n = coords.length
  const grades: (number | null)[] = []
  if (n < 2) return grades
  const altitudes = coords.map((c) => c[2])
  const distances = buildDistancesM(coords)
  for (let i = 1; i < n; i++) {
    if (altitudes[i - 1] == null || altitudes[i] == null) { grades.push(null); continue }
    grades.push(gradeForIndex(i - 1, altitudes, distances, windowM))
  }
  return grades
}

export function geomIdxForKm(km: number, cumDistKm: number[]): number {
  if (!cumDistKm.length) return 0
  let lo = 0
  let hi = cumDistKm.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cumDistKm[mid] < km) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ─── Navigation helpers ────────────────────────────────────────────────────────

// GPS accuracy circle as a ring of [lng, lat] points (used as a GeoJSON polygon).
export function generateCircle(center: LngLat, radiusM: number, steps = 64): LngLat[] {
  const [lng, lat] = center
  const latR = (lat * Math.PI) / 180
  const pts: LngLat[] = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    pts.push([
      lng + (radiusM / (111320 * Math.cos(latR))) * Math.cos(a),
      lat + (radiusM / 110540) * Math.sin(a),
    ])
  }
  return pts
}

// Construit l'URL Google Maps Street View d'un point. Quand `heading` est fourni (cap en
// degrés, 0 = nord), le panorama est orienté dans cette direction — typiquement le cap
// depuis le tracé vers un POI, pour regarder le POI plutôt que la route. Utilise l'API
// Google Maps URLs (action `pano`), qui « snappe » au panorama le plus proche du `viewpoint`
// et, contrairement au format `cbll`, honore l'orientation de la caméra.
export function streetViewUrl(lat: number, lng: number, heading?: number): string {
  const base = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`
  if (heading == null || Number.isNaN(heading)) return base
  const h = ((Math.round(heading) % 360) + 360) % 360
  return `${base}&heading=${h}`
}

// Cap (degrés, 0 = nord) depuis le point du tracé le plus proche de `[lng, lat]` vers ce
// point : la direction dans laquelle regarder pour voir le POI depuis la route. Renvoie
// undefined si la géométrie est vide (aucune référence) — l'appelant ouvre alors Street
// View sans orientation imposée.
export function bearingFromRoute(geometry: Coord[], lng: number, lat: number): number | undefined {
  if (!geometry.length) return undefined
  const { idx } = nearestGeomIndex([lng, lat], geometry)
  return bearingBetween(geometry[idx], [lng, lat])
}

// Cap (degrés, 0 = nord) du tracé À l'endroit le plus proche de `[lng, lat]` : la
// direction de parcours (sens aller). Pour un point situé SUR le tracé (waypoint, point
// cliqué du tracé), oriente une vue Street View dans le sens de la route plutôt que vers
// un POI. Renvoie undefined si la géométrie compte moins de 2 points.
export function bearingAlongRoute(geometry: Coord[], lng: number, lat: number): number | undefined {
  if (geometry.length < 2) return undefined
  const { idx } = nearestGeomIndex([lng, lat], geometry)
  // Cap du segment courant : du point vers le suivant, sauf au tout dernier point.
  const a = idx < geometry.length - 1 ? idx : idx - 1
  return bearingBetween(geometry[a], geometry[a + 1])
}

// Initial bearing (degrees, 0 = north) from point a to point b.
export function bearingBetween(a: Coord | LngLat, b: Coord | LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const dLng = toRad(b[0] - a[0])
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (Math.atan2(y, x) * 180) / Math.PI
}

// Construit une polyligne d'AFFICHAGE alignée index-pour-index sur `geom` : identique au
// tracé réel, SAUF là où l'itinéraire se superpose à lui-même (portion empruntée ≥ 2 fois),
// où les sommets sont décalés perpendiculairement à droite du sens de parcours. Comme aller
// et retour vont en sens opposés, ils se séparent en deux « voies ». Le décalage est lissé
// (fenêtre glissante) pour éviter un saut à l'entrée/sortie des zones de recouvrement.
//
// `geom` reste la vérité géométrique (snapping, distances…) ; seul l'affichage est décalé.
// Renvoie, alignés index-pour-index sur `geom` :
//  - `line`   : la polyligne d'affichage (décalée sur les recouvrements) ;
//  - `wscale` : un facteur de largeur ∈ [1−narrowFrac, 1], abaissé sur les recouvrements
//               pour amincir le tracé là où il se dédouble (deux voies serrées plus lisibles).
export function buildOffsetDisplayLine(
  geom: Array<Coord | LngLat>,
  cumDistM: number[],
  opts: { offsetM?: number; proximityM?: number; minSeparationM?: number; rampM?: number; narrowFrac?: number } = {},
): { line: LngLat[]; wscale: number[] } {
  const offsetM = opts.offsetM ?? 3          // décalage latéral appliqué aux portions superposées (aller et retour s'écartent du double : ~6 m)
  const proximityM = opts.proximityM ?? 12   // en deçà, deux points sont « au même endroit »
  const minSeparationM = opts.minSeparationM ?? 50  // écart le long du parcours au-delà duquel un rapprochement est un vrai recouvrement (et non de simples voisins)
  const rampM = opts.rampM ?? 18             // longueur de transition pour lisser le décalage
  const narrowFrac = opts.narrowFrac ?? 0.3  // amincissement max du tracé sur les recouvrements (30 %)
  const n = geom.length
  const pts: LngLat[] = geom.map((c) => [c[0], c[1]])
  if (n < 3) return { line: pts, wscale: new Array(n).fill(1) }

  // 1) Détection du recouvrement via grille de hachage spatiale (≈ O(n)). On indexe chaque
  // sommet dans une cellule de ~proximityM, puis on ne compare qu'aux 8 cellules voisines.
  const latRef = geom[0][1]
  const mPerDegLat = 111320
  const mPerDegLng = 111320 * Math.cos((latRef * Math.PI) / 180) || 1
  const cellLat = proximityM / mPerDegLat
  const cellLng = proximityM / mPerDegLng
  const grid = new Map<string, number[]>()
  const cellKey = (gx: number, gy: number) => `${gx},${gy}`
  const cellOf = (i: number): [number, number] => [Math.floor(geom[i][0] / cellLng), Math.floor(geom[i][1] / cellLat)]
  for (let i = 0; i < n; i++) {
    const [gx, gy] = cellOf(i)
    const k = cellKey(gx, gy)
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  }
  const overlapping = new Array<boolean>(n).fill(false)
  for (let i = 0; i < n; i++) {
    const [gx, gy] = cellOf(i)
    for (let dx = -1; dx <= 1 && !overlapping[i]; dx++) {
      for (let dy = -1; dy <= 1 && !overlapping[i]; dy++) {
        const bucket = grid.get(cellKey(gx + dx, gy + dy))
        if (!bucket) continue
        for (const j of bucket) {
          if (j === i) continue
          if (Math.abs(cumDistM[i] - cumDistM[j]) < minSeparationM) continue  // simples voisins le long du tracé
          if (haversine(geom[i], geom[j]) <= proximityM) { overlapping[i] = true; break }
        }
      }
    }
  }

  // 2) Lissage : moyenne glissante (en distance) de la cible binaire 0/offsetM → rampes douces
  // à l'entrée/sortie au lieu de marches d'escalier. Deux pointeurs monotones → O(n).
  const target = overlapping.map((o) => (o ? offsetM : 0))
  const off = new Array<number>(n)
  let lo = 0, hi = 0, sum = 0
  for (let i = 0; i < n; i++) {
    while (hi < n && cumDistM[hi] - cumDistM[i] <= rampM) { sum += target[hi]; hi++ }
    while (lo < hi && cumDistM[i] - cumDistM[lo] > rampM) { sum -= target[lo]; lo++ }
    off[i] = sum / Math.max(1, hi - lo)
  }

  // 3) Application : on pousse chaque sommet de off[i] mètres à droite de la tangente locale
  // (tangente = cap du sommet précédent au suivant ; bord = cap du segment adjacent).
  const out: LngLat[] = new Array(n)
  for (let i = 0; i < n; i++) {
    if (off[i] < 1e-3) { out[i] = pts[i]; continue }
    const a = geom[Math.max(0, i - 1)]
    const b = geom[Math.min(n - 1, i + 1)]
    const tangent = bearingBetween(a, b)              // degrés, 0 = nord
    const right = ((tangent + 90) * Math.PI) / 180    // perpendiculaire droite, en radians
    const dLat = (off[i] * Math.cos(right)) / mPerDegLat
    const lngScale = Math.cos((geom[i][1] * Math.PI) / 180) || 1
    const dLng = (off[i] * Math.sin(right)) / (111320 * lngScale)
    out[i] = [pts[i][0] + dLng, pts[i][1] + dLat]
  }

  // Largeur : on amincit proportionnellement au décalage déjà lissé (off/offsetM ∈ [0,1]),
  // donc le tracé maigrit exactement là où il se dédouble, avec les mêmes rampes douces.
  const wscale = off.map((o) => 1 - narrowFrac * (o / offsetM))
  return { line: out, wscale }
}

// Closest point on the segment [a, b] to `p`, using an equirectangular
// projection centred on `p` (accurate over the short spans between adjacent
// route vertices). `p` is the origin (0,0) in that projection, so we clamp its
// projection parameter `s` onto the segment to [0,1]; because the projection is
// affine, that same `s` lerps back to lng/lat for the snapped point.
function closestOnSegment(p: LngLat, a: Coord | LngLat, b: Coord | LngLat): { point: LngLat; distM: number; s: number } {
  const R = 6371000
  const cosLat = Math.cos((p[1] * Math.PI) / 180)
  const toXY = (c: Coord | LngLat): [number, number] => [
    (((c[0] - p[0]) * Math.PI) / 180) * cosLat * R,
    (((c[1] - p[1]) * Math.PI) / 180) * R,
  ]
  const [ax, ay] = toXY(a)
  const [bx, by] = toXY(b)
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const s = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
  const point: LngLat = [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])]
  return { point, distM: Math.hypot(ax + s * dx, ay + s * dy), s }
}

// Perpendicular distance in metres from point `p` to the segment [a, b].
export function pointToSegmentM(p: LngLat, a: Coord | LngLat, b: Coord | LngLat): number {
  return closestOnSegment(p, a, b).distM
}

// Snap `pos` onto the polyline, given the already-known nearest vertex `idx`.
// Returns the snapped lng/lat, `nextIdx` (the first original vertex ahead of the
// snap point, so callers can build the geometry from the rider forward as
// [point, ...geometry.slice(nextIdx)]), and `distAlongM` — the distance covered
// along the route at the snap point, interpolated within the segment so progress
// advances continuously rather than vertex by vertex.
export function projectOnRoute(
  pos: LngLat,
  geometry: Coord[],
  cumDistM: number[],
  idx: number,
): { point: LngLat; nextIdx: number; distAlongM: number } {
  let best: { point: LngLat; nextIdx: number; distAlongM: number; distM: number } = {
    point: [geometry[idx][0], geometry[idx][1]],
    nextIdx: idx,
    distAlongM: cumDistM[idx] || 0,
    distM: Infinity,
  }
  // Segment ending at the vertex → keep the vertex (and everything after) ahead.
  if (idx > 0) {
    const { point, distM, s } = closestOnSegment(pos, geometry[idx - 1], geometry[idx])
    if (distM < best.distM) {
      const distAlongM = cumDistM[idx - 1] + s * (cumDistM[idx] - cumDistM[idx - 1])
      best = { point, nextIdx: idx, distAlongM, distM }
    }
  }
  // Segment leaving the vertex → the vertex is behind us, keep from idx+1 on.
  if (idx < geometry.length - 1) {
    const { point, distM, s } = closestOnSegment(pos, geometry[idx], geometry[idx + 1])
    if (distM < best.distM) {
      const distAlongM = cumDistM[idx] + s * (cumDistM[idx + 1] - cumDistM[idx])
      best = { point, nextIdx: idx + 1, distAlongM, distM }
    }
  }
  return { point: best.point, nextIdx: best.nextIdx, distAlongM: best.distAlongM }
}

// Lng/lat à `distM` le long de la polyligne (recherche binaire sur cumDistM puis
// interpolation linéaire dans le tronçon). Réciproque de projectOnRoute.distAlongM :
// sert à faire avancer la flèche LE LONG du tracé entre deux fixes GPS.
export function lngLatAtDistanceM(geometry: Array<Coord | LngLat>, cumDistM: number[], distM: number): LngLat {
  const n = cumDistM.length
  if (n === 0) return [0, 0]
  const total = cumDistM[n - 1]
  const d = Math.max(0, Math.min(total, distM))
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cumDistM[mid] < d) lo = mid + 1
    else hi = mid
  }
  // `lo` est le premier sommet dont la distance cumulée >= d : le tronçon est [lo-1, lo].
  if (lo === 0) return [geometry[0][0], geometry[0][1]]
  const a = geometry[lo - 1]
  const b = geometry[lo]
  const segLen = cumDistM[lo] - cumDistM[lo - 1]
  const s = segLen > 0 ? (d - cumDistM[lo - 1]) / segLen : 0
  return [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])]
}

// Index of the geometry vertex closest to `pos`, plus the lateral distance (m).
// The distance is measured to the nearest point on the polyline (the two segments
// adjacent to the nearest vertex), not to the vertex itself — so a position
// squarely on a long straight segment isn't mis-flagged as off-route just because
// the nearest vertex happens to be far along that segment.
// `hintIdx` restricts the search to a window around the last known index for perf;
// pass -1 (default) to scan the whole geometry.
export function nearestGeomIndex(
  pos: LngLat,
  geometry: Coord[],
  hintIdx = -1,
  window = 60,
): { idx: number; distM: number } {
  let bestIdx = 0
  let bestDist = Infinity
  let lo = 0
  let hi = geometry.length
  if (hintIdx >= 0) {
    lo = Math.max(0, hintIdx - window)
    hi = Math.min(geometry.length, hintIdx + window)
  }
  for (let i = lo; i < hi; i++) {
    const d = haversine(pos, geometry[i])
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  let distM = bestDist
  if (bestIdx > 0) distM = Math.min(distM, pointToSegmentM(pos, geometry[bestIdx - 1], geometry[bestIdx]))
  if (bestIdx < geometry.length - 1) distM = Math.min(distM, pointToSegmentM(pos, geometry[bestIdx], geometry[bestIdx + 1]))
  return { idx: bestIdx, distM }
}

// Remaining distance / elevation / progress ratio from a projected index.
// Pass `doneM` (the distance covered along the route, e.g. from projectOnRoute)
// to advance distance and ratio continuously within a segment; it defaults to
// the distance at the vertex `idx`. Elevation gain stays vertex-granular.
export function progressFor(
  idx: number,
  geometry: Coord[],
  cumDistM: number[],
  doneM?: number,
): { remainingM: number; doneRatio: number; remainingGainM: number } {
  const total = cumDistM[cumDistM.length - 1] || 0
  const done = doneM ?? cumDistM[idx] ?? 0
  const remainingM = Math.max(0, total - done)
  const doneRatio = total > 0 ? Math.min(1, done / total) : 0
  const { gain } = computeGainLoss(geometry.slice(idx))
  return { remainingM, doneRatio, remainingGainM: gain }
}

// ─── Turn detection ─────────────────────────────────────────────────────────

// Maneuver families, each mapped to a distinct audio cue.
export type Maneuver = 'turn' | 'slight' | 'sharp' | 'keep' | 'uturn' | 'roundabout'

export interface TurnPoint {
  idx: number              // geometry vertex of the turn
  distM: number            // cumulative distance to the turn from the start
  angle: number            // signed turn angle (deg): + = right, − = left
  direction: 'left' | 'right'
  kind: Maneuver
  exitNumber?: number      // roundabout exit number (undefined for non-roundabouts)
}

// Classify a BRouter voice-hint command (and its angle as a tie-breaker) into a
// maneuver family + side. Command ids, d'après btools/router/VoiceHint.java :
// 1 C  2 TL  3 TSLL  4 TSHL  5 TR  6 TSLR  7 TSHR  8 KL  9 KR
// 10 TLU  11 TRU  12 OFFR  13 RNDB  14 RNLB  15 TU  16 BL  17 EL  18 ER
//
// ATTENTION : la table s'écarte de l'intuition à partir de 10. En particulier 13 est le
// rond-point (et non un marqueur hors-tracé) et 15 est le demi-tour à 180° (et non un
// rond-point). Confirmé sur les données : les 67 hints `cmd=13` de la base portent un
// numéro de sortie, et les 9 hints `cmd=15` ont tous un angle de 180° pile.
function maneuverFromCmd(cmd: number, angle: number): { kind: Maneuver; direction: 'left' | 'right' } {
  const side = angle >= 0 ? 'right' : 'left'
  switch (cmd) {
    case 2: return { kind: 'turn', direction: 'left' }
    case 5: return { kind: 'turn', direction: 'right' }
    case 3: return { kind: 'slight', direction: 'left' }
    case 6: return { kind: 'slight', direction: 'right' }
    case 4: return { kind: 'sharp', direction: 'left' }
    case 7: return { kind: 'sharp', direction: 'right' }
    case 8: return { kind: 'keep', direction: 'left' }
    case 9: return { kind: 'keep', direction: 'right' }
    case 10: return { kind: 'uturn', direction: 'left' }
    case 11: return { kind: 'uturn', direction: 'right' }
    case 15: return { kind: 'uturn', direction: side }
    // L'angle d'un rond-point est l'angle total parcouru sur l'anneau (jusqu'à ±450°) ;
    // son signe indique le sens de rotation, pas un côté à annoncer.
    case 13: return { kind: 'roundabout', direction: side }
    case 14: return { kind: 'roundabout', direction: 'left' }
    case 17: return { kind: 'keep', direction: 'left' }
    case 18: return { kind: 'keep', direction: 'right' }
    default: return { kind: 'turn', direction: side }
  }
}

// Maneuver family for a purely geometric turn, derived from the turn sharpness.
function kindFromAngle(absAngle: number): Maneuver {
  if (absAngle >= 95) return 'sharp'
  if (absAngle < 45) return 'slight'
  return 'turn'
}

// A BRouter turn instruction, anchored to a coordinate (robust to later geometry
// changes such as densification) rather than to a raw track index.
export interface VoiceHint {
  lng: number
  lat: number
  cmd: number              // BRouter command id (2=TL, 3=TSLL, 5=TR, 6=TSLR, 14=roundabout…)
  angle: number            // signed turn angle (deg): + = right, − = left
  exit_number?: number     // roundabout exit number (BRouter h[2])
}

// BRouter command ids that carry no actionable turn for our cues:
// 1 = continue straight, 12 = off-route marker, 16 = beeline segment.
const VOICE_HINT_SKIP = new Set([1, 12, 16])

// Commandes de rond-point (RNDB / RNLB). Le numéro de sortie ne peut pas servir de test :
// BRouter l'omet parfois (exit_number = 0) sur un rond-point bien réel.
const ROUNDABOUT_CMDS = new Set([13, 14])

// Premier passage du tracé sur la coordonnée `pos`, en repartant de `fromIdx` :
// on avance jusqu'au premier groupe de sommets passant à moins de `proximityM`,
// et on en retient le sommet le plus proche (le minimum local de ce groupe). On
// s'arrête dès qu'on ressort de la proximité, pour NE PAS sauter à un passage
// ultérieur (une route qui se recoupe repasse à la même coordonnée plus loin, à
// ~0 m elle aussi : prendre le minimum global choisirait un passage au hasard).
// Repli : si aucun sommet n'est assez proche (densification, hint légèrement hors
// tracé), on prend le plus proche au-delà de `fromIdx`.
function firstPassFrom(pos: LngLat, geometry: Coord[], fromIdx: number, proximityM = 20): number {
  let clusterIdx = -1
  let clusterDist = Infinity
  for (let i = fromIdx; i < geometry.length; i++) {
    const d = haversine(pos, geometry[i])
    if (d <= proximityM) {
      if (d < clusterDist) { clusterDist = d; clusterIdx = i }
    } else if (clusterIdx >= 0) {
      break  // on a quitté le premier groupe proche → c'est le bon passage
    }
  }
  if (clusterIdx >= 0) return clusterIdx
  // Repli BORNÉ : on cherche le sommet le plus proche dans une petite fenêtre en avant
  // du curseur, jamais sur tout le reste du tracé. Sur un tracé qui se recoupe (boucle,
  // aller-retour), un hint non apparié dans la proximité — amas de virages ayant dépassé
  // le curseur (rond-point, double virage), ou hint légèrement hors tracé — verrait
  // sinon son sommet GLOBALEMENT le plus proche tomber sur un passage très lointain de la
  // même route. Le curseur sauterait alors de plusieurs km, et tous les hints suivants,
  // appariés depuis ce curseur empoisonné, perdraient leurs virages : il en résulte un
  // énorme trou dans la chaîne de virages (« prochain virage » annoncé à 50 km). La
  // fenêtre couvre la jitter de densification et un léger décrochage sans jamais
  // atteindre un recoupement distant.
  const FALLBACK_AHEAD = 50
  const end = Math.min(geometry.length, fromIdx + FALLBACK_AHEAD)
  let bestIdx = fromIdx
  let bestDist = Infinity
  for (let i = fromIdx; i < end; i++) {
    const d = haversine(pos, geometry[i])
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  return bestIdx
}

// Map stored BRouter voice hints onto the current geometry, producing the same
// TurnPoint shape that the navigation cue logic consumes. Each hint is matched to
// its nearest geometry vertex so the cumulative distance stays correct.
//
// BRouter émet les hints DANS L'ORDRE DE PARCOURS. Sur un tracé qui se recoupe
// (aller-retour, plusieurs boucles), le seul lng/lat d'un hint est ambigu : la même
// jonction est visitée 2–3 fois et apparaît à ~0 m sur chaque passage. Une recherche
// du sommet GLOBALEMENT le plus proche écrase alors tous les passages sur celui qui
// se trouve le plus près, empilant des virages contradictoires au même endroit et
// perdant les virages des passages suivants. On apparie donc de façon MONOTONE : un
// curseur avance le long du tracé et chaque hint est ancré au premier passage situé
// au-delà du hint précédent (avec une petite tolérance arrière pour absorber la
// densification), si bien que des passages successifs tombent sur des positions
// successives. Les marqueurs ignorés (continuer / hors-tracé / beeline) font tout de
// même avancer le curseur, pour ne pas rompre la chaîne.
export function turnsFromVoiceHints(
  hints: VoiceHint[],
  geometry: Coord[],
  cumDistM: number[],
): TurnPoint[] {
  // Recul autorisé (en sommets) sous le curseur : assez pour absorber la jitter de
  // densification, mais bien inférieur à l'écart d'index entre deux passages d'une
  // même jonction, pour ne jamais re-cibler un passage déjà franchi.
  const BACK_TOL = 10
  const out: TurnPoint[] = []
  let cursor = 0
  for (const h of hints) {
    const idx = firstPassFrom([h.lng, h.lat], geometry, Math.max(0, cursor - BACK_TOL))
    cursor = idx
    if (VOICE_HINT_SKIP.has(h.cmd)) continue
    const { kind, direction } = maneuverFromCmd(h.cmd, h.angle)
    const exit = h.exit_number ?? 0
    const exitNumber = ROUNDABOUT_CMDS.has(h.cmd) && exit > 0 ? exit : undefined
    out.push({ idx, distM: cumDistM[idx] || 0, angle: h.angle, direction, kind, exitNumber })
  }
  return out.sort((a, b) => a.distM - b.distM)
}

// Detect significant turns ("intersections" the rider must take) along the
// route. For each vertex we compare the heading ~spanM before and after it,
// smoothing over noisy/dense geometry, and keep turns sharper than minAngleDeg.
// Nearby turns within a small cluster are collapsed to their sharpest vertex.
export function detectTurns(
  geometry: Coord[],
  cumDistM: number[],
  minAngleDeg = 35,
  spanM = 18,
): TurnPoint[] {
  const n = geometry.length
  if (n < 3) return []
  const raw: TurnPoint[] = []
  for (let i = 1; i < n - 1; i++) {
    let a = i
    while (a > 0 && cumDistM[i] - cumDistM[a] < spanM) a--
    let b = i
    while (b < n - 1 && cumDistM[b] - cumDistM[i] < spanM) b++
    if (a === i || b === i) continue
    const inB = bearingBetween(geometry[a], geometry[i])
    const outB = bearingBetween(geometry[i], geometry[b])
    let diff = outB - inB
    while (diff > 180) diff -= 360
    while (diff < -180) diff += 360
    if (Math.abs(diff) >= minAngleDeg) {
      raw.push({ idx: i, distM: cumDistM[i], angle: diff, direction: diff > 0 ? 'right' : 'left', kind: kindFromAngle(Math.abs(diff)) })
    }
  }
  // Collapse clusters: a single road turn spans several vertices, keep the sharpest.
  const out: TurnPoint[] = []
  for (const tp of raw) {
    const last = out[out.length - 1]
    if (last && tp.distM - last.distM < 25) {
      if (Math.abs(tp.angle) > Math.abs(last.angle)) out[out.length - 1] = tp
    } else {
      out.push(tp)
    }
  }
  return out
}

// ─── Turn anomaly detection ──────────────────────────────────────────────────

// Un « amas de virages » : plusieurs virages rapprochés sur un très court rayon.
// Symptôme typique d'un point d'étape mal posé (à côté de la route) : BRouter trace
// un crochet pour aller le chercher puis revenir, ce qui empile 2–3 virages au même
// endroit et fausse la navigation (instructions contradictoires en quelques mètres).
export interface TurnAnomaly {
  idx: number         // sommet géométrique du virage le plus marqué de l'amas
  lng: number
  lat: number
  distM: number       // distance cumulée jusqu'à l'amas
  count: number       // nombre de virages dans l'amas
  waypointIdx: number // point d'étape en cause (-1 si les waypoints n'ont pas été fournis)
}

// Emprise d'un rond-point : rayon autour du hint RNDB dans lequel les virages voisins
// sont considérés comme faisant partie de la même manœuvre. Couvre les grands giratoires
// (~50 m de rayon) sans atteindre le carrefour suivant.
const ROUNDABOUT_SPAN_M = 50

// Un rond-point vaut UNE manœuvre, pas trois. BRouter y émet le virage d'entrée, le hint
// RNDB porteur du numéro de sortie, puis le virage de sortie : trois virages à quelques
// dizaines de mètres, soit exactement la signature que detectTurnAnomalies cherche. On
// replie donc chaque rond-point sur son seul hint RNDB (kind === 'roundabout') avant de
// compter, en absorbant les virages voisins qui tiennent dans son emprise.
//
// Ne couvre que les ronds-points taggés `junction=roundabout` en OSM — ailleurs BRouter
// n'émet que des TL/TR indiscernables d'un crochet. Le filtre par point d'étape ci-dessous
// rattrape ces cas : un rond-point simplement traversé ne porte aucun waypoint.
function collapseRoundabouts(sorted: TurnPoint[], pos: (t: TurnPoint) => LngLat): TurnPoint[] {
  if (!sorted.some((t) => t.kind === 'roundabout')) return sorted
  const consumed = sorted.map(() => false)
  const keep = sorted.map(() => false)
  for (let r = 0; r < sorted.length; r++) {
    if (sorted[r].kind !== 'roundabout' || consumed[r]) continue
    keep[r] = true
    consumed[r] = true
    const p = pos(sorted[r])
    // On s'arrête au premier virage déjà consommé (rond-point précédent : on ne lui vole
    // pas son représentant) ou hors emprise.
    for (let j = r - 1; j >= 0; j--) {
      if (consumed[j] || haversine(pos(sorted[j]), p) > ROUNDABOUT_SPAN_M) break
      consumed[j] = true
    }
    // Vers l'avant, un autre rond-point garde son propre représentant.
    for (let j = r + 1; j < sorted.length; j++) {
      if (consumed[j] || sorted[j].kind === 'roundabout') break
      if (haversine(pos(sorted[j]), p) > ROUNDABOUT_SPAN_M) break
      consumed[j] = true
    }
  }
  return sorted.filter((_, i) => keep[i] || !consumed[i])
}

// Point d'étape le plus proche d'un amas de virages, dans un rayon de `radiusM` ; -1 si
// aucun n'est à portée. On minimise sur TOUS les couples (virage, waypoint) : le premier
// virage d'un crochet est souvent à quelques dizaines de mètres d'un waypoint parfaitement
// posé (le départ, l'étape précédente), alors que le point fautif, lui, colle au demi-tour.
// S'arrêter au premier virage ayant un waypoint à portée accuserait donc l'innocent.
function nearestWaypoint(positions: LngLat[], waypoints: LngLat[], radiusM: number): number {
  let best = -1
  let bestDist = radiusM
  for (const p of positions) {
    waypoints.forEach((w, i) => {
      const d = haversine(w, p)
      if (d <= bestDist) { bestDist = d; best = i }
    })
  }
  return best
}

// Repère les amas d'au moins `minTurns` virages tenant dans un cercle de `diameterM`
// de diamètre. `turns` provient des voicehints BRouter (turnsFromVoiceHints) ou de la
// détection géométrique (detectTurns) ; on lit la position de chaque virage dans
// `geometry` via son index. On parcourt les virages dans l'ordre de parcours et on
// agrège ceux qui restent regroupés : un virage rejoint l'amas tant que sa distance à
// TOUS les virages déjà retenus reste sous `diameterM` (l'amas tient donc bien dans un
// cercle de ce diamètre). Un amas assez fourni est signalé, ancré sur son virage le
// plus serré. `diameterM` vaut 100 m par défaut : un point posé à côté de la route fait
// crocheter BRouter (virage d'entrée → demi-tour → virage de sortie) dont l'entrée et
// la sortie peuvent s'écarter de plusieurs dizaines de mètres le long de la route ; un
// crochet diffus dépasse facilement 60 m d'emprise. Validé sur des cas réels : à 100 m
// on capture les crochets étalés sans faux positif (les virages naturels d'une route
// sinueuse ne se groupent pas à 3+ sous ce diamètre).
//
// Deux garde-fous contre les fausses alertes, les ronds-points en tête :
//  - les manœuvres d'un même rond-point sont repliées en une (cf. collapseRoundabouts) ;
//  - un amas n'est signalé que si un point d'étape se trouve à sa portée. Un crochet est
//    toujours causé par un waypoint mal posé ; un carrefour complexe simplement traversé,
//    lui, n'en porte aucun. Le waypoint retenu est celui à corriger : on le renvoie dans
//    `waypointIdx`. Omettre `waypoints` désactive ce filtre (waypointIdx = -1).
export function detectTurnAnomalies(
  turns: TurnPoint[],
  geometry: Coord[],
  opts: { diameterM?: number; minTurns?: number; waypoints?: LngLat[] } = {},
): TurnAnomaly[] {
  const diameterM = opts.diameterM ?? 100
  const minTurns = opts.minTurns ?? 3
  const waypoints = opts.waypoints
  const out: TurnAnomaly[] = []
  if (turns.length < minTurns || !geometry.length) return out
  const pos = (t: TurnPoint): LngLat => [geometry[t.idx][0], geometry[t.idx][1]]
  const sorted = collapseRoundabouts([...turns].sort((a, b) => a.distM - b.distM), pos)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length) {
      let fits = true
      for (let k = i; k <= j; k++) {
        if (haversine(pos(sorted[k]), pos(sorted[j + 1])) > diameterM) { fits = false; break }
      }
      if (!fits) break
      j++
    }
    const count = j - i + 1
    if (count >= minTurns) {
      let sharp = sorted[i]
      for (let k = i + 1; k <= j; k++) {
        if (Math.abs(sorted[k].angle) > Math.abs(sharp.angle)) sharp = sorted[k]
      }
      // Le waypoint fautif est cherché depuis TOUS les virages de l'amas, pas seulement
      // le plus serré : BRouter accroche le point d'étape sur la route la plus proche,
      // si bien que le crochet peut passer à plusieurs dizaines de mètres du clic brut.
      let waypointIdx = -1
      if (waypoints) {
        waypointIdx = nearestWaypoint(sorted.slice(i, j + 1).map(pos), waypoints, diameterM)
        if (waypointIdx < 0) { i = j + 1; continue }
      }
      const [lng, lat] = pos(sharp)
      out.push({ idx: sharp.idx, lng, lat, distM: sharp.distM, count, waypointIdx })
      i = j + 1
    } else {
      i++
    }
  }
  return out
}

// The climb currently being ridden (idx within [startIdx, endIdx]) and how far
// through it we are (0..1), or null when not on a climb. The ratio is measured by
// distance covered (via cumDistM, and `doneM` for sub-segment precision) rather
// than by vertex count, so the progress bar advances smoothly and proportionally
// to ground covered instead of jumping unevenly between vertices.
export function activeClimb(
  idx: number,
  climbs: Climb[],
  cumDistM: number[],
  doneM?: number,
): { climb: Climb; ratio: number } | null {
  const done = doneM ?? cumDistM[idx] ?? 0
  for (const climb of climbs) {
    if (idx >= climb.startIdx && idx <= climb.endIdx) {
      const startM = cumDistM[climb.startIdx] || 0
      const span = (cumDistM[climb.endIdx] || 0) - startM
      const ratio = span > 0 ? Math.max(0, Math.min(1, (done - startM) / span)) : 0
      return { climb, ratio }
    }
  }
  return null
}
