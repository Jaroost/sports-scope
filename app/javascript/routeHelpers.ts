// Utility functions shared between RouteBuilder sub-components.
// No Vue imports — pure TypeScript.

import { userPreferences } from './userPreferences'
import type { Sport } from './userPreferences'

export type Coord = [number, number, number | null]
export type LngLat = [number, number]

// URL du créateur d'itinéraire pré-renseignée avec le nom et le type choisis dans
// la modale de création. Respecte le préfixe de langue éventuel (/en, /fr).
export function buildNewRouteUrl({ name, sport }: { name: string; sport: Sport }): string {
  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
  const localePrefix = lang ? `/${lang}` : ''
  const url = new URL(`${localePrefix}/routes/new`, window.location.origin)
  if (name) url.searchParams.set('name', name)
  url.searchParams.set('activity', sport)
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

export function gradeForIndex(i: number, altitudes: (number | null)[], distances: number[]): number {
  if (!altitudes || !distances || i + 1 >= altitudes.length || i + 1 >= distances.length) return 0
  const da = (altitudes[i + 1] ?? 0) - (altitudes[i] ?? 0)
  const dd = distances[i + 1] - distances[i]
  return dd > 0 ? (da / dd) * 100 : 0
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
}

// Seuils par défaut issus des préférences du profil (cf. userPreferences). Tombe
// sur les valeurs par défaut sûres hors page connectée (navigation partagée…).
function defaultClimbOptions(): ClimbDetectionOptions {
  const c = userPreferences().climb_detection
  return { minGrade: c.min_grade, minGainM: c.min_gain_m, minLengthM: c.min_length_m }
}

export function detectClimbs(
  altitudes: (number | null)[],
  distances: number[],
  options?: Partial<ClimbDetectionOptions>,
): Climb[] {
  if (!altitudes?.length || !distances?.length) return []
  const { minGrade: MIN_GRADE, minGainM: MIN_GAIN_M, minLengthM: MIN_LENGTH_M } = {
    ...defaultClimbOptions(),
    ...options,
  }
  const MERGE_GAP_M = 250
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
}

// Classify a BRouter voice-hint command (and its angle as a tie-breaker) into a
// maneuver family + side. Command ids:
// 2 TL  3 TSLL  4 TSHL  5 TR  6 TSLR  7 TSHR  8 KL  9 KR
// 10 TLU  11 TU  12 TRU  14 RNDB(right)  15 RNLB(left)
function maneuverFromCmd(cmd: number, angle: number): { kind: Maneuver; direction: 'left' | 'right' } {
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
    case 12: return { kind: 'uturn', direction: 'right' }
    case 11: return { kind: 'uturn', direction: angle >= 0 ? 'right' : 'left' }
    case 14: return { kind: 'roundabout', direction: 'right' }
    case 15: return { kind: 'roundabout', direction: 'left' }
    default: return { kind: 'turn', direction: angle >= 0 ? 'right' : 'left' }
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
}

// BRouter command ids that carry no actionable turn for our cues:
// 1 = continue straight, 13 = off-route marker, 16 = beeline segment.
const VOICE_HINT_SKIP = new Set([1, 13, 16])

// Map stored BRouter voice hints onto the current geometry, producing the same
// TurnPoint shape that the navigation cue logic consumes. Each hint is matched to
// its nearest geometry vertex so the cumulative distance stays correct.
export function turnsFromVoiceHints(
  hints: VoiceHint[],
  geometry: Coord[],
  cumDistM: number[],
): TurnPoint[] {
  const out: TurnPoint[] = []
  for (const h of hints) {
    if (VOICE_HINT_SKIP.has(h.cmd)) continue
    const { idx } = nearestGeomIndex([h.lng, h.lat], geometry)
    const { kind, direction } = maneuverFromCmd(h.cmd, h.angle)
    out.push({ idx, distM: cumDistM[idx] || 0, angle: h.angle, direction, kind })
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
