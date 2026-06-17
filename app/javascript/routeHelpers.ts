// Utility functions shared between RouteBuilder sub-components.
// No Vue imports — pure TypeScript.

export type Coord = [number, number, number | null]
export type LngLat = [number, number]

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

export function detectClimbs(altitudes: (number | null)[], distances: number[]): Climb[] {
  if (!altitudes?.length || !distances?.length) return []
  const MIN_GRADE = 2
  const MIN_GAIN_M = 60
  const MIN_LENGTH_M = 500
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

// Index of the geometry vertex closest to `pos`, plus the lateral distance (m).
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
  return { idx: bestIdx, distM: bestDist }
}

// Remaining distance / elevation / progress ratio from a projected index.
export function progressFor(
  idx: number,
  geometry: Coord[],
  cumDistM: number[],
): { remainingM: number; doneRatio: number; remainingGainM: number } {
  const total = cumDistM[cumDistM.length - 1] || 0
  const done = cumDistM[idx] || 0
  const remainingM = Math.max(0, total - done)
  const doneRatio = total > 0 ? Math.min(1, done / total) : 0
  const { gain } = computeGainLoss(geometry.slice(idx))
  return { remainingM, doneRatio, remainingGainM: gain }
}

// The climb currently being ridden (idx within [startIdx, endIdx]) and how far
// through it we are (0..1), or null when not on a climb.
export function activeClimb(idx: number, climbs: Climb[]): { climb: Climb; ratio: number } | null {
  for (const climb of climbs) {
    if (idx >= climb.startIdx && idx <= climb.endIdx) {
      const span = climb.endIdx - climb.startIdx
      const ratio = span > 0 ? (idx - climb.startIdx) / span : 0
      return { climb, ratio }
    }
  }
  return null
}
