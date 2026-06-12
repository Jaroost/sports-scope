// Pure helpers extracted from ActivityDetail.vue so each sub-component
// (ActivityStats, ActivityMapCard, ActivityCharts, ...) can use the same
// formatting + climb-detection + route-geometry logic without duplication.
// No Vue / no DOM / no module-level state — easy to test and tree-shake.

// ─── Activity-type → Font Awesome icon ────────────────────────────────────
export function activityIcon(type) {
  const t = (type || '').toLowerCase()
  if (t.includes('run')) return 'fa-person-running'
  if (t.includes('ride') || t.includes('cycl') || t.includes('bike') || t.includes('velo')) return 'fa-person-biking'
  if (t.includes('swim')) return 'fa-person-swimming'
  if (t.includes('walk') || t.includes('hike')) return 'fa-person-hiking'
  if (t.includes('ski')) return 'fa-person-skiing'
  if (t.includes('row')) return 'fa-water'
  if (t.includes('yoga')) return 'fa-spa'
  if (t.includes('workout') || t.includes('weight')) return 'fa-dumbbell'
  return 'fa-bolt'
}

// Stream key → Font Awesome icon. Used by the chart legend pills + range
// chips + chart-hover tooltip rows.
export const chartIcons = {
  altitude: 'fa-mountain',
  heartrate: 'fa-heart-pulse',
  velocity_smooth: 'fa-gauge-high',
  cadence: 'fa-rotate',
  watts: 'fa-bolt',
  temp: 'fa-temperature-half',
  grade_smooth: 'fa-slash',
}

// chartDefs order drives the default chart layout (top → bottom).
export const chartDefs = [
  { key: 'altitude',        color: '#198754', unit: 'm',    transform: (v) => v,       digits: 0 },
  { key: 'watts',           color: '#fd7e14', unit: 'W',    transform: (v) => v,       digits: 0 },
  { key: 'velocity_smooth', color: '#0d6efd', unit: 'km/h', transform: (v) => v * 3.6, digits: 1 },
  { key: 'heartrate',       color: '#dc3545', unit: 'bpm',  transform: (v) => v,       digits: 0 },
  { key: 'cadence',         color: '#6f42c1', unit: 'rpm',  transform: (v) => v,       digits: 0 },
  { key: 'temp',            color: '#20c997', unit: '°C',   transform: (v) => v,       digits: 1 },
  { key: 'grade_smooth',    color: '#6c757d', unit: '%',    transform: (v) => v,       digits: 1 },
]

export function defByKey(key) {
  return chartDefs.find((d) => d.key === key)
}

// Independent order for the stream-mean chips in the sticky header — kept
// stable regardless of how charts are ordered/merged.
export const STREAM_CHIP_ORDER = ['grade_smooth', 'watts', 'velocity_smooth', 'heartrate', 'cadence', 'temp']

// Standard cycling peak-power durations (mirrors PeakPowerCurve::DURATIONS
// on the Ruby side so server-stored values align with on-screen rows).
export const PEAK_POWER_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400]

// ─── Elevation gain/loss ──────────────────────────────────────────────────
// Compute D+/D- from a flat altitude array using a (2*halfWin+1)-point moving
// average to suppress sensor/quantisation noise before accumulating. Works for
// both FIT barometric data (floating point, baro/GPS noise) and BRouter SRTM
// integer data. Returns { gain, loss } in metres.
export function computeElevGain(alts, halfWin = 2) {
  const n = alts.length
  if (n < 2) return { gain: 0, loss: 0 }
  let up = 0, down = 0, prev = null
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    for (let j = Math.max(0, i - halfWin); j <= Math.min(n - 1, i + halfWin); j++) {
      if (alts[j] != null) { sum += alts[j]; cnt++ }
    }
    const smooth = cnt > 0 ? sum / cnt : null
    if (smooth == null) continue
    if (prev != null) {
      const d = smooth - prev
      if (d > 0) up += d
      else down -= d
    }
    prev = smooth
  }
  return { gain: up, loss: down }
}

// ─── Formatting ───────────────────────────────────────────────────────────
export function fmt(v, digits) {
  if (v == null || Number.isNaN(v)) return '–'
  return v.toFixed(digits)
}

export function formatDuration(seconds) {
  if (!seconds) return '–'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}min` : (m > 0 ? `${m}min ${s}s` : `${s}s`)
}

export function formatHMS(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '–'
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export function formatKm(meters) {
  if (meters == null || Number.isNaN(meters)) return '–'
  return `${(meters / 1000).toFixed(2)} km`
}

export function formatPowerDuration(sec) {
  if (sec < 60) return `${sec} s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m === 0 ? `${h} h` : `${h} h ${m}`
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Strava photos come with multiple sized URLs keyed by their max edge length
// (e.g. `{ "100": "...", "256": "...", "2048": "..." }`). Pick the entry that
// matches `preferred`, else the smallest one bigger, else the biggest.
export function pickPhotoUrl(photo, preferred = 256) {
  if (!photo?.urls) return null
  const entries = Object.entries(photo.urls)
    .map(([k, v]) => [Number(k), v])
    .filter(([k]) => !Number.isNaN(k))
    .sort((a, b) => a[0] - b[0])
  if (entries.length === 0) return null
  const exact = entries.find(([k]) => k === preferred)
  if (exact) return exact[1]
  const larger = entries.find(([k]) => k >= preferred)
  return (larger || entries[entries.length - 1])[1]
}

// ─── Polyline + downsample ────────────────────────────────────────────────
export function decodePolyline(str) {
  let index = 0
  let lat = 0
  let lng = 0
  const coords = []
  while (index < str.length) {
    let b
    let shift = 0
    let result = 0
    do {
      b = str.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1)
    lat += dlat

    shift = 0
    result = 0
    do {
      b = str.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1)
    lng += dlng

    coords.push([lng / 1e5, lat / 1e5])
  }
  return coords
}

export function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr
  const step = arr.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.floor(i * step)])
  }
  return out
}

// ─── Grade buckets (route colouring) + climb detection ────────────────────
export const GRADE_BUCKETS = [
  { max: -8,       color: '#1e3a8a' }, // very steep descent
  { max: -3,       color: '#3b82f6' }, // descent
  { max:  3,       color: '#22c55e' }, // flat / rolling
  { max:  6,       color: '#eab308' }, // easy climb
  { max: 10,       color: '#f97316' }, // medium climb
  { max: 15,       color: '#dc2626' }, // hard climb
  { max: Infinity, color: '#7f1d1d' }, // very hard climb
]

export function bucketGrade(g) {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return i
  }
  return GRADE_BUCKETS.length - 1
}

export function gradeForIndex(i, grades, altitudes, distances) {
  if (grades && grades[i] != null && !Number.isNaN(grades[i])) return grades[i]
  if (!altitudes || !distances || i + 1 >= altitudes.length || i + 1 >= distances.length) return 0
  const da = altitudes[i + 1] - altitudes[i]
  const dd = distances[i + 1] - distances[i]
  return dd > 0 ? (da / dd) * 100 : 0
}

export function buildGradedSegments(coords, grades, altitudes, distances) {
  if (!coords || coords.length < 2) return []
  const features = []
  let current = [coords[0]]
  let curBucket = bucketGrade(gradeForIndex(0, grades, altitudes, distances))
  for (let i = 1; i < coords.length; i++) {
    const g = gradeForIndex(Math.min(i, coords.length - 2), grades, altitudes, distances)
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

export function climbCategory(lengthKm, avgGrade) {
  const score = lengthKm * Math.pow(Math.max(0, avgGrade), 2)
  if (score >= 400) return 'HC'
  if (score >= 200) return '1'
  if (score >= 100) return '2'
  if (score >= 60) return '3'
  if (score >= 25) return '4'
  return null
}

export function detectClimbs(grades, altitudes, distances) {
  if (!altitudes || !distances || altitudes.length === 0 || distances.length === 0) return []
  const MIN_GRADE = 2
  const MIN_GAIN_M = 60
  const MIN_LENGTH_M = 500
  const MERGE_GAP_M = 250
  const len = Math.min(altitudes.length, distances.length, grades?.length ?? altitudes.length)
  const raw = []
  let startIdx = -1
  for (let i = 0; i < len; i++) {
    const g = gradeForIndex(i, grades, altitudes, distances)
    if (g >= MIN_GRADE) {
      if (startIdx < 0) startIdx = i
    } else if (startIdx >= 0) {
      raw.push({ startIdx, endIdx: i })
      startIdx = -1
    }
  }
  if (startIdx >= 0) raw.push({ startIdx, endIdx: len - 1 })
  const merged = []
  for (const r of raw) {
    if (!merged.length) { merged.push(r); continue }
    const prev = merged[merged.length - 1]
    const gap = distances[r.startIdx] - distances[prev.endIdx]
    if (gap <= MERGE_GAP_M) prev.endIdx = r.endIdx
    else merged.push(r)
  }
  return merged
    .map((r) => {
      const gain = altitudes[r.endIdx] - altitudes[r.startIdx]
      const lengthM = distances[r.endIdx] - distances[r.startIdx]
      const avgGrade = lengthM > 0 ? (gain / lengthM) * 100 : 0
      return { ...r, gain, lengthM, avgGrade, category: climbCategory(lengthM / 1000, avgGrade) }
    })
    .filter((c) => c.gain >= MIN_GAIN_M && c.lengthM >= MIN_LENGTH_M && c.avgGrade >= MIN_GRADE)
}
