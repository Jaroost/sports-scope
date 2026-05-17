<script setup>
import { ref, onMounted, onBeforeUnmount, computed, nextTick, useTemplateRef, watch } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  activityId: { type: [String, Number], required: true },
  source: { type: String, default: 'strava' }, // 'strava' or 'imported'
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''
// Hand-off cap to the route builder: same as the GPX import path. The routes
// controller enforces MAX_WAYPOINTS=50; 25 leaves the user headroom to insert
// more once the route is loaded.
const ROUTE_FROM_ACTIVITY_MAX_WAYPOINTS = 25

// Build endpoint URLs from the source — Strava activities go to /strava/...,
// FIT-imported activities to /api/imported_activities/...
const activityUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}`
  : `/strava/activities/${props.activityId}`)
const streamsUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}/streams`
  : `/strava/activities/${props.activityId}/streams`)
const photosUrl = computed(() => props.source === 'imported'
  ? null // imported (FIT) has no photos
  : `/strava/activities/${props.activityId}/photos`)

const loading = ref(true)
const error = ref(null)
const activity = ref(null)
const streams = ref(null)
const streamsLoading = ref(false)
const streamsError = ref(null)
const xAxis = ref('distance')
// X axis time scale: always minutes. Ticks are rendered as hh:mm:ss by a
// callback on the chart's x scale, so the internal unit only drives zoom
// granularity — no need to expose it as a user choice.
const selection = ref(null) // { startIdx, endIdx } | null — immediate (drives map markers + chart band)
const selectionDisplay = ref(null) // debounced copy used for stats display
const mapEl = useTemplateRef('mapEl')

let mapInstance = null
let markerA = null
let markerB = null
let hoverMarker = null
let isDragging = false
let dragRafPending = false
const climbMarkers = []
let _maplibregl = null // cached after first import so toggles can re-install markers
const mapStyleId = ref('cyclosm')
const showClimbs = ref(true)
const mapExpanded = ref(false)
const photos = ref([])
const showPhotos = ref(true)
const photoMarkers = []
const lightboxIndex = ref(null)
const galleryCollapsed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.galleryCollapsed') === '1',
)
const statsCollapsed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.statsCollapsed') === '1',
)
const chartsCollapsed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.chartsCollapsed') === '1',
)
const chartInstances = new Map()
const wheelHandlers = new Map()
const zoomRange = ref(null) // { xMin, xMax } | null — shared zoom across all charts
let xMinAll = 0
let xMaxAll = 0

function activityIcon(type) {
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

const chartIcons = {
  altitude: 'fa-mountain',
  heartrate: 'fa-heart-pulse',
  velocity_smooth: 'fa-gauge-high',
  cadence: 'fa-rotate',
  watts: 'fa-bolt',
  temp: 'fa-temperature-half',
  grade_smooth: 'fa-slash',
}

const startEndDisplay = computed(() => {
  const a = activity.value
  if (!a?.start_date_local) return null
  // Strava ships start_date_local as a wall-clock local time but with a "Z"
  // suffix — strip it so JS doesn't shift it by the browser's UTC offset.
  const startMs = new Date(a.start_date_local.replace(/Z$/, '')).getTime()
  if (Number.isNaN(startMs)) return null
  const elapsed = a.elapsed_time
  const endMs = elapsed ? startMs + elapsed * 1000 : null
  const fmtFull = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  const fmtHM = { hour: '2-digit', minute: '2-digit' }
  const start = new Date(startMs)
  const end = endMs != null ? new Date(endMs) : null
  if (!end) return { start: start.toLocaleString(undefined, fmtFull), end: null, duration: null }
  const sameDay = start.toDateString() === end.toDateString()
  return {
    start: start.toLocaleString(undefined, fmtFull),
    end: sameDay ? end.toLocaleTimeString(undefined, fmtHM) : end.toLocaleString(undefined, fmtFull),
    duration: formatDuration(elapsed),
  }
})

const polyline = computed(() => activity.value?.map?.summary_polyline || activity.value?.map?.polyline || '')

// Prefer the high-resolution latlng stream when available (Strava stores it as [lat, lng] pairs).
const routeCoords = computed(() => {
  const latlng = streams.value?.latlng?.data
  if (Array.isArray(latlng) && latlng.length > 0) {
    return latlng.map(([lat, lng]) => [lng, lat])
  }
  if (polyline.value) return decodePolyline(polyline.value)
  return []
})

const hasRoute = computed(() => routeCoords.value.length > 0)
const hasLatLngStream = computed(() => Array.isArray(streams.value?.latlng?.data) && streams.value.latlng.data.length > 0)

// chartDefs order drives the default chart layout (top → bottom).
const chartDefs = [
  { key: 'altitude',        color: '#198754', unit: 'm',    transform: (v) => v,       digits: 0 },
  { key: 'watts',           color: '#fd7e14', unit: 'W',    transform: (v) => v,       digits: 0 },
  { key: 'velocity_smooth', color: '#0d6efd', unit: 'km/h', transform: (v) => v * 3.6, digits: 1 },
  { key: 'heartrate',       color: '#dc3545', unit: 'bpm',  transform: (v) => v,       digits: 0 },
  { key: 'cadence',         color: '#6f42c1', unit: 'rpm',  transform: (v) => v,       digits: 0 },
  { key: 'temp',            color: '#20c997', unit: '°C',   transform: (v) => v,       digits: 1 },
  { key: 'grade_smooth',    color: '#6c757d', unit: '%',    transform: (v) => v,       digits: 1 },
]

// Independent order for the stream-mean chips in the sticky header — kept
// stable regardless of how charts are ordered/merged.
const STREAM_CHIP_ORDER = ['grade_smooth', 'watts', 'velocity_smooth', 'heartrate', 'cadence', 'temp']

const availableCharts = computed(() => {
  if (!streams.value) return []
  return chartDefs.filter((def) => Array.isArray(streams.value[def.key]?.data) && streams.value[def.key].data.length > 0)
})

function defaultLayout() {
  return chartDefs.map((def) => ({ id: def.key, streams: [def.key], collapsed: false }))
}

function defByKey(key) {
  return chartDefs.find((d) => d.key === key)
}

// Aligns chartLayout with the streams actually present on this activity:
// - drops streams that aren't available
// - drops empty groups
// - appends any present stream that wasn't referenced by the saved layout
// Always returns a fresh array if anything changed (so the watcher fires once).
function syncLayoutWithStreams() {
  if (!streams.value) return
  const present = new Set(
    chartDefs
      .filter((d) => Array.isArray(streams.value[d.key]?.data) && streams.value[d.key].data.length > 0)
      .map((d) => d.key),
  )
  const cleaned = chartLayout.value
    .map((g) => ({ id: g.id, streams: g.streams.filter((k) => present.has(k)), collapsed: !!g.collapsed }))
    .filter((g) => g.streams.length > 0)
  const referenced = new Set(cleaned.flatMap((g) => g.streams))
  const missing = [...present].filter((k) => !referenced.has(k))
  const final = [...cleaned, ...missing.map((k) => ({ id: k, streams: [k], collapsed: false }))]
  if (JSON.stringify(final) === JSON.stringify(chartLayout.value)) return
  chartLayout.value = final
}

const chartLayout = ref(defaultLayout())
const layoutSaving = ref(false)
const layoutDirty = ref(false)
const savedLayouts = ref([]) // [{ id, name, layout }]
const selectedLayoutId = ref(null)
const lastUsedId = ref(null) // persisted on the server
const dragSourceId = ref(null)
const dragOverGroupId = ref(null)
const dragOverSlotIndex = ref(null)
const isCopyMode = ref(false) // true while Ctrl/Cmd is held during a drag
// groupId -> Set<datasetIndex> — which curves are currently hidden via the
// custom legend pills (Chart.js's built-in legend click was unreliable in
// our multi-axis setup).
const hiddenDatasets = ref(new Map())
const is3D = ref(false)
const showGrade = ref(true) // false → main route renders flat orange

// All visible groups are kept in chartLayout (kept in sync via syncLayoutWithStreams),
// so the displayed layout is just chartLayout itself — no virtual groups.
const availableLayout = computed(() => (streams.value ? chartLayout.value : []))

// Deduplicated list of streams currently displayed somewhere — used to
// render mean chips in the sticky header.
const visibleStreams = computed(() => {
  const seen = new Set()
  const result = []
  for (const group of availableLayout.value) {
    for (const s of group.streams) {
      if (!seen.has(s)) {
        seen.add(s)
        result.push(s)
      }
    }
  }
  return result
})

// Stream chips shown in the sticky header — uses STREAM_CHIP_ORDER (independent
// of chartDefs order) and only includes streams actually present in some chart.
const chipStreams = computed(() => {
  const present = new Set(visibleStreams.value)
  return STREAM_CHIP_ORDER.filter((k) => present.has(k))
})

// Seconds per X-axis time unit. Kept as a function (not a const) so existing
// call sites keep working unchanged.
function timeFactor() {
  return 60
}

function formatDuration(seconds) {
  if (!seconds) return '–'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}min` : (m > 0 ? `${m}min ${s}s` : `${s}s`)
}

function decodePolyline(str) {
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

// Binary search the x stream (raw units: meters or seconds) for the closest index to `target`.
function xValueToIndex(target) {
  const stream = streams.value?.[xAxis.value]?.data
  if (!stream || stream.length === 0) return 0
  let lo = 0
  let hi = stream.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stream[mid] < target) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(stream[lo - 1] - target) < Math.abs(stream[lo] - target)) return lo - 1
  return lo
}

function latLngToIndex(lng, lat) {
  const arr = streams.value?.latlng?.data
  if (!arr || arr.length === 0) return 0
  let bestIdx = 0
  let bestD = Infinity
  for (let i = 0; i < arr.length; i++) {
    const dLat = arr[i][0] - lat
    const dLng = arr[i][1] - lng
    const d = dLat * dLat + dLng * dLng
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

function setSelection(startIdx, endIdx) {
  if (startIdx == null || endIdx == null) {
    selection.value = null
    return
  }
  let s = Math.max(0, Math.min(startIdx, endIdx))
  let e = Math.max(startIdx, endIdx)
  const maxIdx = (streams.value?.[xAxis.value]?.data?.length || streams.value?.time?.data?.length || 1) - 1
  e = Math.min(maxIdx, e)
  selection.value = { startIdx: s, endIdx: e }
}

function clearSelection() {
  selection.value = null
  if (markerA && markerB && hasLatLngStream.value) {
    const data = streams.value.latlng.data
    markerA.setLngLat([data[0][1], data[0][0]])
    markerB.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
    applyMarkerRoles()
  }
}

function chartStats(def) {
  const data = streams.value?.[def.key]?.data
  if (!data || data.length === 0) return null
  const s = selectionDisplay.value?.startIdx ?? 0
  const e = selectionDisplay.value?.endIdx ?? data.length - 1
  let count = 0
  let sum = 0
  let mn = Infinity
  let mx = -Infinity
  for (let i = s; i <= e && i < data.length; i++) {
    const v = def.transform(data[i])
    if (v == null || Number.isNaN(v)) continue
    count++
    sum += v
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  if (count === 0) return null
  let mean = sum / count
  // grade_smooth: the per-sample arithmetic mean weights each sample equally
  // regardless of distance, so it disagrees with the climb-marker grade for
  // the same segment. Override with rangeGrade()'s net-rise / horizontal-
  // distance reading. Min/max stay per-sample — those describe the steepest
  // local sections, which is what users expect from a min/max stat.
  if (def.key === 'grade_smooth') {
    const rg = rangeGrade()
    if (rg != null) mean = rg
  }
  return { count, mean, min: mn, max: mx }
}

function fmt(v, digits) {
  if (v == null || Number.isNaN(v)) return '–'
  return v.toFixed(digits)
}

function rangeBounds() {
  const refStream = streams.value?.distance?.data || streams.value?.time?.data || streams.value?.latlng?.data
  if (!refStream || refStream.length === 0) return null
  const maxIdx = refStream.length - 1
  const s = Math.max(0, Math.min(selectionDisplay.value?.startIdx ?? 0, maxIdx))
  const e = Math.max(s, Math.min(selectionDisplay.value?.endIdx ?? maxIdx, maxIdx))
  return { startIdx: s, endIdx: e }
}

function rangeDuration() {
  const b = rangeBounds()
  const time = streams.value?.time?.data
  if (!b || !time || time.length === 0) return null
  const t0 = time[Math.min(b.startIdx, time.length - 1)]
  const t1 = time[Math.min(b.endIdx, time.length - 1)]
  return Math.max(0, t1 - t0)
}

function rangeDistance() {
  const b = rangeBounds()
  const dist = streams.value?.distance?.data
  if (!b || !dist || dist.length === 0) return null
  const d0 = dist[Math.min(b.startIdx, dist.length - 1)]
  const d1 = dist[Math.min(b.endIdx, dist.length - 1)]
  return Math.max(0, d1 - d0)
}

function rangeElevation() {
  const b = rangeBounds()
  const alt = streams.value?.altitude?.data
  if (!b || !alt || alt.length < 2) return null
  const start = Math.max(b.startIdx, 0)
  const end = Math.min(b.endIdx, alt.length - 1)
  let up = 0
  let down = 0
  for (let i = start + 1; i <= end; i++) {
    const d = alt[i] - alt[i - 1]
    if (d > 0) up += d
    else down += d
  }
  return { up, down: Math.abs(down) }
}

function rangePointCount() {
  const b = rangeBounds()
  if (!b) return null
  return b.endIdx - b.startIdx + 1
}

function rangeGrade() {
  // Net rise / horizontal distance — matches the conventional climb grade
  // that the map's col markers display via detectClimbs (gain / lengthM).
  // The sample-mean of grade_smooth is intentionally NOT used here: it
  // over-weights short steep spikes and varies with sample density, so it
  // diverged from the col reading for the same segment.
  const b = rangeBounds()
  if (!b) return null
  const alt = streams.value?.altitude?.data
  const dist = streams.value?.distance?.data
  if (!alt || !dist || alt.length === 0 || dist.length === 0) return null
  const d0 = dist[Math.min(b.startIdx, dist.length - 1)]
  const d1 = dist[Math.min(b.endIdx, dist.length - 1)]
  if (d1 - d0 <= 0) return null
  const a0 = alt[Math.min(b.startIdx, alt.length - 1)]
  const a1 = alt[Math.min(b.endIdx, alt.length - 1)]
  return ((a1 - a0) / (d1 - d0)) * 100
}

function formatHMS(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '–'
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function formatKm(meters) {
  if (meters == null || Number.isNaN(meters)) return '–'
  return `${(meters / 1000).toFixed(2)} km`
}

// Pace m:ss/km used by the splits table when the activity is a run.
function formatPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '–'
  const total = Math.round(secPerKm)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}/km`
}

// Pace vs speed in the splits table. Runs (and hikes/walks) read more
// naturally as min/km; everything else (mostly rides) as km/h.
const isPaceActivity = computed(() => {
  const ty = (activity.value?.type || '').toLowerCase()
  return ty.includes('run') || ty.includes('walk') || ty.includes('hike')
})

// elapsed - moving = time stopped (red lights, refueling, etc.). Both fields
// are seconds on Strava and on the FIT-imported serializer.
const movingStats = computed(() => {
  const elapsed = activity.value?.elapsed_time
  const moving = activity.value?.moving_time
  if (!Number.isFinite(elapsed) || !Number.isFinite(moving)) return null
  const stopped = Math.max(0, elapsed - moving)
  const stopPct = elapsed > 0 ? (stopped / elapsed) * 100 : 0
  return { elapsed, moving, stopped, stopPct }
})

// Global VAM (m/h) over the whole activity. Falls back to elapsed time when
// moving_time is missing — the resulting number is then slightly pessimistic
// but still useful as a coarse climbing rate.
const globalVam = computed(() => {
  const gain = activity.value?.total_elevation_gain
  const denomS = movingStats.value?.moving ?? activity.value?.elapsed_time
  if (!Number.isFinite(gain) || gain <= 0 || !Number.isFinite(denomS) || denomS <= 0) return null
  return (gain / denomS) * 3600
})

// Per-km splits from the distance + time streams. The trailing split may be
// shorter than 1 km — we keep it with its true length so the table shows the
// real activity end, not a rounded distance.
const splits = computed(() => {
  const dist = streams.value?.distance?.data
  const time = streams.value?.time?.data
  if (!Array.isArray(dist) || !Array.isArray(time) || dist.length < 2) return []
  const alt = streams.value?.altitude?.data || []
  const hr = streams.value?.heartrate?.data || []
  const watts = streams.value?.watts?.data || []
  const len = Math.min(dist.length, time.length)
  const out = []
  let segStart = 0
  let nextKm = 1000
  for (let i = 1; i < len; i++) {
    const isLast = i === len - 1
    if (dist[i] >= nextKm || isLast) {
      const startD = dist[segStart]
      const endD = dist[i]
      const sliceLen = endD - startD
      if (sliceLen <= 0) { segStart = i; nextKm = Math.ceil(dist[i] / 1000) * 1000 + 1000; continue }
      const durationSec = Math.max(0, time[i] - time[segStart])
      let gain = 0
      let loss = 0
      for (let j = segStart + 1; j <= i; j++) {
        const a = alt[j - 1]
        const b = alt[j]
        if (typeof a === 'number' && typeof b === 'number') {
          const d = b - a
          if (d > 0) gain += d
          else loss -= d
        }
      }
      let hrSum = 0
      let hrCount = 0
      let powSum = 0
      let powCount = 0
      for (let j = segStart; j <= i; j++) {
        const v = hr[j]
        if (typeof v === 'number' && Number.isFinite(v)) { hrSum += v; hrCount++ }
        const w = watts[j]
        if (typeof w === 'number' && Number.isFinite(w)) { powSum += w; powCount++ }
      }
      out.push({
        kmIndex: out.length + 1,
        distance: sliceLen,
        durationSec,
        paceSecPerKm: sliceLen > 0 ? (durationSec / (sliceLen / 1000)) : null,
        speedKmh: durationSec > 0 ? (sliceLen / durationSec) * 3.6 : null,
        gain,
        loss,
        avgHr: hrCount ? hrSum / hrCount : null,
        avgPower: powCount ? powSum / powCount : null,
      })
      segStart = i
      nextKm += 1000
    }
  }
  return out
})

const splitsHavePower = computed(() => splits.value.some((s) => s.avgPower != null))

// Best average power sustained over standard durations (peak power curve).
// Uses a cumulative energy integral so it handles non-uniform sampling and
// stoppages correctly: avg = (E[j] - E[i]) / (time[j] - time[i]).
const PEAK_POWER_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400]
const peakPowers = computed(() => {
  const times = streams.value?.time?.data
  const watts = streams.value?.watts?.data
  if (!Array.isArray(times) || !Array.isArray(watts) || times.length < 2) return []
  const n = Math.min(times.length, watts.length)
  if (n < 2) return []
  // Cumulative energy (J): E[i] = Σ watts[k] * (time[k+1] - time[k])
  const E = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1]
    const w = watts[i - 1]
    const wv = (typeof w === 'number' && Number.isFinite(w)) ? w : 0
    E[i] = E[i - 1] + wv * Math.max(0, dt)
  }
  const totalSpan = times[n - 1] - times[0]
  const out = []
  for (const D of PEAK_POWER_DURATIONS) {
    if (D > totalSpan) break
    let best = null
    let j = 0
    for (let i = 0; i < n; i++) {
      while (j < n && times[j] - times[i] < D) j++
      if (j >= n) break
      const dt = times[j] - times[i]
      if (dt <= 0) continue
      const avg = (E[j] - E[i]) / dt
      if (best == null || avg > best) best = avg
    }
    if (best != null && Number.isFinite(best) && best > 0) {
      out.push({ duration: D, avgPower: best })
    }
  }
  return out
})

function formatPowerDuration(sec) {
  if (sec < 60) return `${sec} s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m === 0 ? `${h} h` : `${h} h ${m}`
}

// Per-climb stats enriched with duration + VAM. `detectClimbs` already gives
// us gain / lengthM / avgGrade / category; we add the actual time spent on
// each climb by looking at the time stream at start/end indices.
const climbsWithVam = computed(() => {
  if (!streams.value) return []
  const alt = streams.value.altitude?.data
  const dist = streams.value.distance?.data
  const time = streams.value.time?.data
  const grades = streams.value.grade_smooth?.data
  if (!Array.isArray(alt) || !Array.isArray(dist) || alt.length === 0) return []
  const climbs = detectClimbs(grades, alt, dist)
  return climbs.map((c) => {
    const t0 = Array.isArray(time) ? time[c.startIdx] : null
    const t1 = Array.isArray(time) ? time[c.endIdx] : null
    const duration = (t0 != null && t1 != null) ? Math.max(0, t1 - t0) : null
    const vam = (duration && c.gain > 0) ? (c.gain / duration) * 3600 : null
    return { ...c, duration, vam }
  })
})

async function fetchActivity() {
  try {
    const res = await fetch(activityUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (res.status === 404) {
      error.value = t('strava.activity_not_found')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    activity.value = payload.activity
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function fetchStreams() {
  streamsLoading.value = true
  streamsError.value = null
  try {
    const res = await fetch(streamsUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    streams.value = payload.streams || {}
  } catch (e) {
    streamsError.value = e.message
  } finally {
    streamsLoading.value = false
  }
}

async function fetchPhotos() {
  if (!photosUrl.value) { photos.value = []; return }
  try {
    const res = await fetch(photosUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    photos.value = Array.isArray(payload.photos) ? payload.photos : []
  } catch {
    photos.value = []
  }
}

const HANDLE_TOL = 8 // pixels around a flag pole that count as a "grab"

function drawChartFlag(ctx, area, x, kind) {
  const fw = 12
  const fh = 9
  const headTop = Math.max(0, area.top - fh)
  ctx.save()
  // pole
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x, area.top)
  ctx.lineTo(x, area.bottom)
  ctx.stroke()
  // flag head
  if (kind === 'start') {
    ctx.fillStyle = '#22c55e'
    ctx.fillRect(x, headTop, fw, fh)
    ctx.strokeStyle = '#15803d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  } else {
    const cell = 3
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ef4444' : '#ffffff'
        ctx.fillRect(x + c * cell, headTop + r * cell, cell, cell)
      }
    }
    ctx.strokeStyle = '#7f1d1d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  }
  // anchor dot at pole top
  ctx.fillStyle = '#1f2937'
  ctx.beginPath()
  ctx.arc(x, area.top, 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function detectChartHandle(chart, px) {
  const sel = chart.$selectionRange
  if (!sel || sel.start == null || sel.end == null) return null
  const area = chart.chartArea
  const px1 = Math.max(area.left, Math.min(area.right, chart.scales.x.getPixelForValue(sel.start)))
  const px2 = Math.max(area.left, Math.min(area.right, chart.scales.x.getPixelForValue(sel.end)))
  const startVal = sel.start
  const endVal = sel.end
  const dStart = Math.abs(px - px1)
  const dEnd = Math.abs(px - px2)
  if (dStart <= HANDLE_TOL && dStart <= dEnd) return { fixedValue: endVal }
  if (dEnd <= HANDLE_TOL) return { fixedValue: startVal }
  return null
}

// Chart.js plugin: drag-to-select on the canvas, draggable flag handles, and selection highlight.
const dragSelectPlugin = {
  id: 'dragSelect',
  beforeEvent(chart, args) {
    const e = args.event
    const native = e.native
    if (!native) return
    const st = chart.$drag || (chart.$drag = { mode: null, x0: null, x1: null, fixedValue: null })

    const isStart = (native.type === 'mousedown' && native.button === 0) || native.type === 'touchstart'
    const isMove = native.type === 'mousemove' || native.type === 'touchmove'
    const isEnd = native.type === 'mouseup' || native.type === 'mouseout' || native.type === 'touchend' || native.type === 'touchcancel'

    if (isStart) {
      const area = chart.chartArea
      // Bail out for clicks outside the plotting area (legend at the top, axis
      // labels at the bottom/sides) — otherwise we'd start a drag-select and
      // swallow the legend's own click handler.
      if (e.x < area.left - HANDLE_TOL || e.x > area.right + HANDLE_TOL) return
      if (e.y < area.top || e.y > area.bottom) return
      const handle = detectChartHandle(chart, e.x)
      if (handle) {
        st.mode = 'handle'
        st.fixedValue = handle.fixedValue
        chart.canvas.style.cursor = 'ew-resize'
      } else {
        st.mode = 'select'
        st.x0 = e.x
        st.x1 = e.x
        chart.canvas.style.cursor = 'crosshair'
      }
      if (native.type === 'touchstart' && native.cancelable) native.preventDefault()
      chart.draw()
    } else if (isMove && st.mode === 'handle') {
      const v = chart.scales.x.getValueForPixel(e.x)
      if (v != null && !Number.isNaN(v)) {
        chart.$onSelect?.(st.fixedValue, v)
      }
      if (native.type === 'touchmove' && native.cancelable) native.preventDefault()
    } else if (isMove && st.mode === 'select') {
      st.x1 = e.x
      if (native.type === 'touchmove' && native.cancelable) native.preventDefault()
      chart.draw()
    } else if (isMove && !st.mode) {
      const handle = detectChartHandle(chart, e.x)
      chart.canvas.style.cursor = handle ? 'ew-resize' : 'crosshair'
    } else if (isEnd && st.mode) {
      if (st.mode === 'select') {
        const area = chart.chartArea
        const x0 = Math.max(area.left, Math.min(area.right, st.x0))
        const x1 = Math.max(area.left, Math.min(area.right, st.x1))
        if (Math.abs(x1 - x0) >= 4) {
          const v0 = chart.scales.x.getValueForPixel(x0)
          const v1 = chart.scales.x.getValueForPixel(x1)
          chart.$onSelect?.(v0, v1)
        }
      }
      st.mode = null
      st.x0 = null
      st.x1 = null
      st.fixedValue = null
      chart.canvas.style.cursor = 'crosshair'
      chart.draw()
    }
  },
  afterDraw(chart) {
    const { ctx, chartArea } = chart
    const st = chart.$drag
    const sel = chart.$selectionRange
    if (sel && sel.start != null && sel.end != null) {
      const px1 = chart.scales.x.getPixelForValue(sel.start)
      const px2 = chart.scales.x.getPixelForValue(sel.end)
      const lo = Math.min(px1, px2)
      const hi = Math.max(px1, px2)
      if (!chart.$noSelection) {
        const clipLo = Math.max(chartArea.left, lo)
        const clipHi = Math.min(chartArea.right, hi)
        if (clipHi > clipLo) {
          ctx.save()
          ctx.fillStyle = 'rgba(13, 110, 253, 0.15)'
          ctx.fillRect(clipLo, chartArea.top, clipHi - clipLo, chartArea.bottom - chartArea.top)
          ctx.restore()
        }
      }
      const drawLo = Math.max(chartArea.left, Math.min(chartArea.right, lo))
      const drawHi = Math.max(chartArea.left, Math.min(chartArea.right, hi))
      drawChartFlag(ctx, chartArea, drawLo, 'start')
      drawChartFlag(ctx, chartArea, drawHi, 'end')
    }
    if (st && st.mode === 'select' && st.x0 != null && st.x1 != null) {
      ctx.save()
      ctx.fillStyle = 'rgba(13, 110, 253, 0.25)'
      ctx.fillRect(Math.min(st.x0, st.x1), chartArea.top, Math.abs(st.x1 - st.x0), chartArea.bottom - chartArea.top)
      ctx.restore()
    }
  },
}

async function renderMap() {
  if (!hasRoute.value || !mapEl.value) return

  const maplibregl = (await import('maplibre-gl')).default
  _maplibregl = maplibregl
  await import('maplibre-gl/dist/maplibre-gl.css')

  const coords = routeCoords.value
  const bounds = coords.reduce(
    (b, c) => [
      [Math.min(b[0][0], c[0]), Math.min(b[0][1], c[1])],
      [Math.max(b[1][0], c[0]), Math.max(b[1][1], c[1])],
    ],
    [[coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]],
  )

  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(mapStyleId.value),
    bounds,
    fitBoundsOptions: { padding: 40 },
    maxPitch: 75,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')

  mapInstance.on('load', () => {
    installRouteLayers(coords)
    if (hasLatLngStream.value) installMapHandles(maplibregl)
    installClimbMarkers(maplibregl)
    installPhotoMarkers(maplibregl)
    installMapHoverTooltip()
  })
}

// Adds the route geometry / arrows / selection overlay to the current style.
// Safe to call after a setStyle() swap because all of these layers/sources
// belong to the style and are wiped when the style changes.
function installRouteLayers(coords) {
  if (!mapInstance) return
  const altitudes = streams.value?.altitude?.data
  const distances = streams.value?.distance?.data
  const grades = streams.value?.grade_smooth?.data
  const segments = buildGradedSegments(coords, grades, altitudes, distances)
  const hasGrades = segments.length > 0 && (grades?.length || (altitudes && distances))

  // Single LineString kept around so the direction-arrow symbol layer has a
  // continuous geometry to follow even when the visible route is split into
  // many graded segments.
  mapInstance.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
  })

  if (hasGrades) {
    mapInstance.addSource('route-graded', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: segments },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route-graded',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': gradePaintExpression(),
        'line-width': 5,
      },
    })
  } else {
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fc4c02', 'line-width': 4 },
    })
  }

  mapInstance.addImage('route-arrow', buildArrowIcon())
  mapInstance.addLayer({
    id: 'route-direction',
    type: 'symbol',
    source: 'route',
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 90,
      'icon-image': 'route-arrow',
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-rotation-alignment': 'map',
    },
  })

  mapInstance.addSource('selected-route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })
  mapInstance.addLayer({
    id: 'selected-route-line',
    type: 'line',
    source: 'selected-route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#0d6efd', 'line-width': 6 },
  })

  // Re-apply the 3D terrain if it was on before the style switch.
  if (is3D.value) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
  }

  refreshSelectedRoute()
}

const THUNDERFOREST_KEY = (
  document.querySelector('meta[name="thunderforest-api-key"]')?.getAttribute('content') || ''
).trim()

function mapStyleFor(id) {
  if (id === 'liberty') return 'https://tiles.openfreemap.org/styles/liberty'
  if (id === 'topo') return openTopoMapStyle()
  if (id === 'cycle' && THUNDERFOREST_KEY) return openCycleMapStyle(THUNDERFOREST_KEY)
  return cyclOsmStyle()
}

function openTopoMapStyle() {
  return {
    version: 8,
    sources: {
      'topo-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 17,
        attribution:
          'Map: © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>) · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM',
      },
    },
    layers: [
      { id: 'topo-base', type: 'raster', source: 'topo-raster' },
    ],
  }
}

function openCycleMapStyle(apiKey) {
  return {
    version: 8,
    sources: {
      'thunderforest-cycle': {
        type: 'raster',
        tiles: [
          `https://a.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
          `https://b.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
          `https://c.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${apiKey}`,
        ],
        tileSize: 256,
        maxzoom: 22,
        attribution:
          'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'cycle-base', type: 'raster', source: 'thunderforest-cycle' },
    ],
  }
}

function setMapStyle(id) {
  if (!mapInstance || id === mapStyleId.value) return
  mapStyleId.value = id
  // `diff: false` forces a full wipe of the previous style (including any
  // images/sources/layers we added on top). Without it, maplibre tries to
  // preserve custom items across the swap and our subsequent addImage()
  // call throws "An image named route-arrow already exists".
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  // HTML markers (climbs, drag flags) and NavigationControl survive — they
  // live in the map's container, not in the style.
  mapInstance.once('style.load', () => {
    installRouteLayers(routeCoords.value)
  })
}

function cyclOsmStyle() {
  return {
    version: 8,
    sources: {
      'cyclosm-raster': {
        type: 'raster',
        tiles: [
          'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
          'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 20,
        attribution:
          '© <a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
    },
    layers: [
      {
        id: 'cyclosm-base',
        type: 'raster',
        source: 'cyclosm-raster',
        // Pulled back so the gradient-colored route stays the visual focal
        // point. Doesn't affect any layer drawn on top.
        paint: {
          'raster-saturation': -0.55,
          'raster-contrast': -0.1,
          'raster-opacity': 0.85,
        },
      },
    ],
  }
}

function installClimbMarkers(maplibregl) {
  // Always start clean: re-rendering the map shouldn't pile markers up.
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  if (!showClimbs.value) return
  const latlng = streams.value?.latlng?.data
  const altitudes = streams.value?.altitude?.data
  const distances = streams.value?.distance?.data
  const grades = streams.value?.grade_smooth?.data
  if (!latlng || !altitudes || !distances) return
  const climbs = detectClimbs(grades, altitudes, distances)
  climbs.forEach((climb) => {
    const pt = latlng[climb.startIdx]
    if (!pt) return
    const el = buildClimbMarkerEl(climb)
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' })
      .setLngLat([pt[1], pt[0]])
      .addTo(mapInstance)
    climbMarkers.push(marker)
  })
}

function toggleClimbs() {
  showClimbs.value = !showClimbs.value
  if (!showClimbs.value) {
    climbMarkers.forEach((m) => m.remove())
    climbMarkers.length = 0
  } else if (_maplibregl) {
    installClimbMarkers(_maplibregl)
  }
}

async function toggleMapSize() {
  mapExpanded.value = !mapExpanded.value
  // .map-wrap toggles to/from position:fixed full-screen — the layout change
  // is instant, so a single resize() after the DOM tick is enough for
  // maplibre to re-measure and re-project all markers (climbs, drag flags).
  await nextTick()
  if (mapInstance) mapInstance.resize()
}

function buildClimbMarkerEl(climb) {
  const el = document.createElement('div')
  const catClass = climb.category ? `climb-cat-${climb.category}` : 'climb-cat-uncat'
  el.className = `climb-marker ${catClass}`
  const lengthStr = climb.lengthM >= 1000
    ? `${(climb.lengthM / 1000).toFixed(1)} km`
    : `${Math.round(climb.lengthM)} m`
  el.innerHTML = `
    <i class="fa-solid fa-mountain" aria-hidden="true"></i>
    <span class="climb-marker-stats">+${Math.round(climb.gain)}m&nbsp;·&nbsp;${climb.avgGrade.toFixed(1)}%</span>
    ${climb.category ? `<span class="climb-marker-cat">${climb.category}</span>` : ''}
  `
  el.title = `${t('strava.click_to_select_climb')}\n${climb.category ? 'Cat ' + climb.category + ' · ' : ''}${lengthStr} · +${Math.round(climb.gain)} m · ${climb.avgGrade.toFixed(1)} %`
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    setSelection(climb.startIdx, climb.endIdx)
  })
  // Make sure mousedown doesn't initiate a map pan when the user clicks the badge.
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return el
}

// ─── Photos ───────────────────────────────────────────────────────────────

function pickPhotoUrl(photo, preferred = 256) {
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

function installPhotoMarkers(maplibregl) {
  photoMarkers.forEach((m) => m.remove())
  photoMarkers.length = 0
  if (!showPhotos.value || !mapInstance) return
  photos.value.forEach((photo, idx) => {
    const loc = photo.location
    if (!Array.isArray(loc) || loc.length < 2) return
    const el = buildPhotoMarkerEl(photo, idx)
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([loc[1], loc[0]])
      .addTo(mapInstance)
    photoMarkers.push(marker)
  })
}

function buildPhotoMarkerEl(photo, idx) {
  const el = document.createElement('div')
  el.className = 'photo-marker'
  const thumb = pickPhotoUrl(photo, 256)
  el.innerHTML = thumb
    ? `<img src="${thumb}" alt="">`
    : `<i class="fa-solid fa-camera"></i>`
  el.title = photo.caption || t('strava.photo_marker_title')
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    lightboxIndex.value = idx
  })
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  return el
}

function togglePhotos() {
  showPhotos.value = !showPhotos.value
  if (!showPhotos.value) {
    photoMarkers.forEach((m) => m.remove())
    photoMarkers.length = 0
  } else if (_maplibregl) {
    installPhotoMarkers(_maplibregl)
  }
}

function toggleStatsCollapsed() {
  statsCollapsed.value = !statsCollapsed.value
  try {
    localStorage.setItem('sportsScope.statsCollapsed', statsCollapsed.value ? '1' : '0')
  } catch { /* private mode, etc. */ }
}

function toggleChartsCollapsed() {
  chartsCollapsed.value = !chartsCollapsed.value
  try {
    localStorage.setItem('sportsScope.chartsCollapsed', chartsCollapsed.value ? '1' : '0')
  } catch { /* private mode, etc. */ }
}

function toggleGalleryCollapsed() {
  galleryCollapsed.value = !galleryCollapsed.value
  try {
    localStorage.setItem('sportsScope.galleryCollapsed', galleryCollapsed.value ? '1' : '0')
  } catch {
    // localStorage may be unavailable (private mode, etc.) — silently ignore.
  }
}

function buildArrowIcon() {
  const size = 18
  const cnv = document.createElement('canvas')
  cnv.width = size
  cnv.height = size
  const ctx = cnv.getContext('2d')
  ctx.translate(size / 2, size / 2)
  ctx.beginPath()
  ctx.moveTo(6, 0)
  ctx.lineTo(-5, -5)
  ctx.lineTo(-5, 5)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#7a2400'
  ctx.lineWidth = 1.5
  ctx.fill()
  ctx.stroke()
  const imgData = ctx.getImageData(0, 0, size, size)
  return { width: size, height: size, data: new Uint8Array(imgData.data.buffer) }
}

function createFlagElement(kind) {
  const el = document.createElement('div')
  el.dataset.kind = kind
  el.style.cursor = 'grab'
  el.style.width = '28px'
  el.style.height = '36px'
  el.innerHTML = flagSvg(kind)
  return el
}

function flagSvg(kind) {
  if (kind === 'start') {
    return `
      <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
        <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
        <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
        <path d="M4 4 L24 4 L24 18 L4 18 Z" fill="#22c55e" stroke="#15803d" stroke-width="1"/>
      </svg>`
  }
  // checkered flag
  const cells = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const x = 4 + col * 5
      const y = 4 + row * 5
      const dark = (row + col) % 2 === 0
      cells.push(`<rect x="${x}" y="${y}" width="5" height="5" fill="${dark ? '#ef4444' : '#ffffff'}"/>`)
    }
  }
  return `
    <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <line x1="4" y1="2" x2="4" y2="34" stroke="#1f2937" stroke-width="2" stroke-linecap="round"/>
      <circle cx="4" cy="34" r="2.5" fill="#1f2937"/>
      <rect x="4" y="4" width="20" height="15" fill="none" stroke="#7f1d1d" stroke-width="1"/>
      ${cells.join('')}
    </svg>`
}

function setFlagKind(el, kind) {
  if (el.dataset.kind === kind) return
  el.dataset.kind = kind
  el.innerHTML = flagSvg(kind)
}

function applyMarkerRoles() {
  if (!markerA || !markerB || !hasLatLngStream.value) return
  const a = markerA.getLngLat()
  const b = markerB.getLngLat()
  const aIdx = latLngToIndex(a.lng, a.lat)
  const bIdx = latLngToIndex(b.lng, b.lat)
  const aIsStart = aIdx <= bIdx
  setFlagKind(markerA.getElement(), aIsStart ? 'start' : 'end')
  setFlagKind(markerB.getElement(), aIsStart ? 'end' : 'start')
}

function installMapHandles(maplibregl) {
  const data = streams.value.latlng.data
  if (data.length < 2) return
  const start = data[0]
  const end = data[data.length - 1]

  const elA = createFlagElement('start')
  const elB = createFlagElement('end')
  markerA = new maplibregl.Marker({ element: elA, draggable: true, anchor: 'bottom-left' })
    .setLngLat([start[1], start[0]])
    .addTo(mapInstance)
  markerB = new maplibregl.Marker({ element: elB, draggable: true, anchor: 'bottom-left' })
    .setLngLat([end[1], end[0]])
    .addTo(mapInstance)

  markerA.on('dragstart', () => { isDragging = true })
  markerB.on('dragstart', () => { isDragging = true })
  markerA.on('drag', () => scheduleMarkerSync())
  markerB.on('drag', () => scheduleMarkerSync())
  markerA.on('dragend', () => { isDragging = false; syncFromMarkers() })
  markerB.on('dragend', () => { isDragging = false; syncFromMarkers() })

  applyMarkerRoles()
}

function scheduleMarkerSync() {
  if (dragRafPending) return
  dragRafPending = true
  requestAnimationFrame(() => {
    dragRafPending = false
    syncFromMarkers()
  })
}

function syncFromMarkers() {
  if (!markerA || !markerB) return
  const a = markerA.getLngLat()
  const b = markerB.getLngLat()
  const aIdx = latLngToIndex(a.lng, a.lat)
  const bIdx = latLngToIndex(b.lng, b.lat)
  const maxIdx = streams.value.latlng.data.length - 1
  const lo = Math.min(aIdx, bIdx)
  const hi = Math.max(aIdx, bIdx)
  const isFullRange = lo === 0 && hi === maxIdx
  if (isFullRange) {
    selection.value = null
  } else {
    setSelection(lo, hi)
  }
  applyMarkerRoles()
}

function refreshSelectedRoute() {
  if (!mapInstance || !mapInstance.getSource('selected-route')) return
  if (!hasLatLngStream.value || !selection.value) {
    mapInstance.getSource('selected-route').setData({ type: 'FeatureCollection', features: [] })
    return
  }
  const data = streams.value.latlng.data
  const { startIdx, endIdx } = selection.value
  const coords = data.slice(startIdx, endIdx + 1).map(([lat, lng]) => [lng, lat])
  mapInstance.getSource('selected-route').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
  })
}

// ─── Cycling helpers: grade-colored route + climb detection ──────────────────

const GRADE_BUCKETS = [
  { max: -8,       color: '#1e3a8a' }, // very steep descent
  { max: -3,       color: '#3b82f6' }, // descent
  { max:  3,       color: '#22c55e' }, // flat / rolling
  { max:  6,       color: '#eab308' }, // easy climb
  { max: 10,       color: '#f97316' }, // medium climb
  { max: 15,       color: '#dc2626' }, // hard climb
  { max: Infinity, color: '#7f1d1d' }, // very hard climb
]

function bucketGrade(g) {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return i
  }
  return GRADE_BUCKETS.length - 1
}

function gradeForIndex(i, grades, altitudes, distances) {
  if (grades && grades[i] != null && !Number.isNaN(grades[i])) return grades[i]
  if (!altitudes || !distances || i + 1 >= altitudes.length || i + 1 >= distances.length) return 0
  const da = altitudes[i + 1] - altitudes[i]
  const dd = distances[i + 1] - distances[i]
  return dd > 0 ? (da / dd) * 100 : 0
}

function buildGradedSegments(coords, grades, altitudes, distances) {
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

function climbCategory(lengthKm, avgGrade) {
  const score = lengthKm * Math.pow(Math.max(0, avgGrade), 2)
  if (score >= 400) return 'HC'
  if (score >= 200) return '1'
  if (score >= 100) return '2'
  if (score >= 60) return '3'
  if (score >= 25) return '4'
  return null
}

function detectClimbs(grades, altitudes, distances) {
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

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr
  const step = arr.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.floor(i * step)])
  }
  return out
}

// "Create route from this activity" — same handoff as the GPX import in
// RoutesList.vue. Sample the activity's coords down to a manageable set of
// waypoints (BRouter will road-snap + add elevation on the builder side),
// stash them under the shared sessionStorage key, then redirect.
function createRouteFromActivity() {
  const coords = routeCoords.value
  if (!coords.length) return
  // Prompt for a name (pre-filled with the activity's name). User can edit
  // before committing. Cancel or empty → abort, no redirect.
  const defaultName = (activity.value?.name || '').trim().slice(0, 80)
  const raw = window.prompt(t('routes.name_prompt'), defaultName)
  if (raw == null) return
  const name = raw.trim().slice(0, 80)
  if (!name) return
  const sampled = downsample(coords.slice(), ROUTE_FROM_ACTIVITY_MAX_WAYPOINTS)
  // Pin original start/end so they survive downsampling.
  if (sampled.length >= 2) {
    sampled[0] = coords[0]
    sampled[sampled.length - 1] = coords[coords.length - 1]
  }
  sessionStorage.setItem('sportsScope.gpxImport', JSON.stringify({
    name,
    waypoints: sampled.map((p) => ({ lng: p[0], lat: p[1] })),
  }))
  window.location.href = `${localePrefix}/routes/new?fromGpx=1`
}

function chartXFromRaw(rawX) {
  if (xAxis.value === 'distance') return rawX / 1000
  return rawX / timeFactor()
}

function chartXToRaw(x) {
  if (xAxis.value === 'distance') return x * 1000
  return x * timeFactor()
}

function xAxisLabel() {
  if (xAxis.value === 'distance') return t('strava.distance_km')
  return t('strava.time_label_min')
}

async function renderCharts() {
  const groups = availableLayout.value
  if (groups.length === 0) return

  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables, dragSelectPlugin)

  destroyCharts()

  const xStream = streams.value[xAxis.value]?.data || streams.value.time?.data || []
  const maxPoints = 600
  const xRaw = xStream
  xMinAll = xRaw.length > 0 ? chartXFromRaw(xRaw[0]) : 0
  xMaxAll = xRaw.length > 0 ? chartXFromRaw(xRaw[xRaw.length - 1]) : 0

  groups.forEach((group) => {
    if (group.collapsed) return
    const canvas = document.getElementById(`chart-${group.id}`)
    if (!canvas) return

    // Count occurrences so we can label duplicates (Altitude #2, etc.).
    const occurrences = new Map()
    const datasets = group.streams.map((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return null
      const count = (occurrences.get(streamKey) || 0) + 1
      occurrences.set(streamKey, count)
      const totalForKey = group.streams.filter((s) => s === streamKey).length
      const label = totalForKey > 1
        ? `${t('strava.stream.' + def.key)} #${count} (${def.unit})`
        : `${t('strava.stream.' + def.key)} (${def.unit})`
      const yRaw = streams.value[streamKey].data
      const len = Math.min(xRaw.length, yRaw.length)
      const pairs = []
      for (let i = 0; i < len; i++) {
        pairs.push({ x: chartXFromRaw(xRaw[i]), y: def.transform(yRaw[i]) })
      }
      const data = downsample(pairs, maxPoints)
      return {
        label,
        data,
        borderColor: def.color,
        backgroundColor: def.color + '33',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: true,
        yAxisID: `y-${idx}`,
        $streamKey: streamKey,
      }
    }).filter(Boolean)

    const yScales = {}
    group.streams.forEach((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return
      yScales[`y-${idx}`] = {
        type: 'linear',
        position: idx % 2 === 0 ? 'left' : 'right',
        title: { display: true, text: def.unit, color: def.color },
        ticks: { maxTicksLimit: 6, color: def.color },
        grid: { drawOnChartArea: idx === 0 },
      }
    })

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { intersect: false, mode: 'index', axis: 'x' },
        events: ['mousedown', 'mousemove', 'mouseup', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'],
        plugins: {
          // Built-in legend disabled in favor of the custom Vue legend pills
          // above each chart — gives reliable click-to-toggle behavior.
          legend: { display: false },
          tooltip: {
            // Custom HTML tooltip aggregating the hovered chart + all the
            // other charts' values at the same x — see externalTooltipHandler.
            enabled: false,
            mode: 'index',
            intersect: false,
            external: externalTooltipHandler,
          },
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: xAxisLabel() },
            ticks: xAxis.value === 'time'
              // Time axis: 10-minute step, hh:mm:ss labels. maxTicksLimit
              // bumped so a long ride still gets ticks every 10 minutes
              // rather than being thinned to ~20 min.
              ? {
                  stepSize: 10,
                  maxTicksLimit: 30,
                  callback: ((tf) => (val) => formatHMS(val * tf))(timeFactor()),
                }
              : { maxTicksLimit: 8 },
            min: zoomRange.value?.xMin,
            max: zoomRange.value?.xMax,
          },
          ...yScales,
        },
      },
    })

    chart.$onSelect = (v0, v1) => {
      const r0 = chartXToRaw(Math.min(v0, v1))
      const r1 = chartXToRaw(Math.max(v0, v1))
      const sIdx = xValueToIndex(r0)
      const eIdx = xValueToIndex(r1)
      const xs = streams.value?.[xAxis.value]?.data || streams.value?.time?.data
      const maxIdx = (xs?.length || 1) - 1
      if (sIdx <= 0 && eIdx >= maxIdx) {
        selection.value = null
      } else {
        setSelection(sIdx, eIdx)
      }
    }

    const wheelHandler = (e) => handleZoomWheel(chart, e)
    canvas.addEventListener('wheel', wheelHandler, { passive: false })
    wheelHandlers.set(group.id, { canvas, handler: wheelHandler })

    chartInstances.set(group.id, chart)
  })

  applySelectionToCharts()
}

function applySelectionToCharts() {
  const xs = streams.value?.[xAxis.value]?.data
  if (!xs || xs.length === 0) return
  const fullStart = chartXFromRaw(xs[0])
  const fullEnd = chartXFromRaw(xs[xs.length - 1])
  chartInstances.forEach((chart) => {
    if (!selection.value) {
      chart.$selectionRange = { start: fullStart, end: fullEnd }
      chart.$noSelection = true
    } else {
      const x0 = chartXFromRaw(xs[selection.value.startIdx])
      const x1 = chartXFromRaw(xs[selection.value.endIdx])
      chart.$selectionRange = { start: x0, end: x1 }
      chart.$noSelection = false
    }
    chart.draw()
  })
}

function syncMarkersFromSelection() {
  if (isDragging) return
  if (!markerA || !markerB || !hasLatLngStream.value) return
  const data = streams.value.latlng.data
  if (!selection.value) {
    markerA.setLngLat([data[0][1], data[0][0]])
    markerB.setLngLat([data[data.length - 1][1], data[data.length - 1][0]])
  } else {
    const { startIdx, endIdx } = selection.value
    markerA.setLngLat([data[startIdx][1], data[startIdx][0]])
    markerB.setLngLat([data[endIdx][1], data[endIdx][0]])
  }
  applyMarkerRoles()
}

function destroyCharts() {
  wheelHandlers.forEach(({ canvas, handler }) => canvas.removeEventListener('wheel', handler))
  wheelHandlers.clear()
  // Remove any external tooltip DOM nodes before destroying their charts.
  chartInstances.forEach((c) => {
    c.canvas.parentNode?.querySelector('.chart-tooltip')?.remove()
  })
  chartInstances.forEach((c) => c.destroy())
  chartInstances.clear()
  hiddenDatasets.value = new Map()
}

// Shared tooltip builder — used by both Chart.js (`externalTooltipHandler`)
// and the map mousemove handler so both surfaces show identical content.
// `priorityStreams`: stream keys (in display order) that should appear *first*
// in the tooltip. When the user hovers a specific chart, its own datasets go
// at the top (and in the order they're laid out on that chart); the rest of
// the visible streams follow under a separator.
function buildTooltipHtmlForIndex(idx, priorityStreams = []) {
  if (idx == null) return ''
  const titleLines = buildTooltipTitleLines(idx)
  let html = '<div class="chart-tooltip-title">'
  for (const line of titleLines) {
    const cls = line.main ? 'chart-tooltip-title-main' : 'chart-tooltip-title-sub'
    html += `<div class="${cls}">${escapeHtml(line.text)}</div>`
  }
  html += '</div>'

  const rendered = new Set()
  const renderRow = (streamKey) => {
    if (rendered.has(streamKey)) return ''
    const def = defByKey(streamKey)
    if (!def) return ''
    const raw = streams.value?.[streamKey]?.data?.[idx]
    if (raw == null) return ''
    const y = def.transform(raw)
    const digits = def.digits ?? 1
    const value = Number.isNaN(y) ? '–' : y.toFixed(digits)
    rendered.add(streamKey)
    return `<div class="chart-tooltip-row">
      <span class="chart-tooltip-swatch" style="background:${def.color}"></span>
      <span class="chart-tooltip-name">${escapeHtml(t('strava.stream.' + streamKey))}</span>
      <span class="chart-tooltip-value">${escapeHtml(value)} ${escapeHtml(def.unit || '')}</span>
    </div>`
  }

  let primary = ''
  for (const k of priorityStreams) primary += renderRow(k)
  let secondary = ''
  for (const k of visibleStreams.value) secondary += renderRow(k)

  if (primary) html += `<div class="chart-tooltip-section">${primary}</div>`
  if (primary && secondary) html += '<div class="chart-tooltip-divider"></div>'
  if (secondary) html += `<div class="chart-tooltip-section chart-tooltip-section-secondary">${secondary}</div>`
  return html
}

function buildTooltipTitleLines(idx) {
  const lines = []
  const distStream = streams.value?.distance?.data
  const timeStream = streams.value?.time?.data
  const dm = distStream?.[idx]
  const tSec = timeStream?.[idx]
  // Primary line: the unit of the currently selected X axis. Secondary: the other.
  if (xAxis.value === 'distance') {
    if (dm != null) lines.push({ main: true, text: `${(dm / 1000).toFixed(2)} km` })
    if (tSec != null) lines.push({ main: false, text: formatHMS(tSec) })
  } else {
    if (tSec != null) lines.push({ main: true, text: formatHMS(tSec) })
    if (dm != null) lines.push({ main: false, text: `${(dm / 1000).toFixed(2)} km` })
  }
  // Absolute datetime = activity start (wall clock, Z stripped) + elapsed seconds.
  const startIso = activity.value?.start_date_local
  if (startIso && tSec != null) {
    const localBase = new Date(startIso.replace(/Z$/, '')).getTime()
    const dt = new Date(localBase + tSec * 1000)
    lines.push({
      main: false,
      text: dt.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    })
  }
  return lines
}

function positionTooltipBeside(el, anchorX, anchorY, containerWidth, containerHeight) {
  const tipRect = el.getBoundingClientRect()
  const OFFSET = 16
  const placeOnRight = anchorX + OFFSET + tipRect.width < containerWidth - 4
  if (placeOnRight) {
    el.style.left = `${anchorX + OFFSET}px`
    el.style.transform = 'translate(0, -50%)'
  } else {
    el.style.left = `${anchorX - OFFSET}px`
    el.style.transform = 'translate(-100%, -50%)'
  }
  let topPos = anchorY
  const halfH = tipRect.height / 2
  if (topPos - halfH < 4) topPos = halfH + 4
  if (topPos + halfH > containerHeight - 4) topPos = containerHeight - halfH - 4
  el.style.top = `${topPos}px`
}

function externalTooltipHandler(context) {
  const { chart, tooltip } = context
  // Find the slot reserved in the side panel of this chart group.
  const canvasId = chart.canvas.id || ''
  const groupId = canvasId.startsWith('chart-') ? canvasId.slice(6) : null
  if (!groupId) return
  const slot = document.querySelector(`.chart-tooltip-slot[data-group-id="${CSS.escape(groupId)}"]`)
  if (!slot) return
  let el = slot.querySelector('.chart-tooltip')
  if (!el) {
    el = document.createElement('div')
    el.className = 'chart-tooltip chart-tooltip-inline'
    slot.appendChild(el)
  }
  if (tooltip.opacity === 0 || chart.$drag?.mode) {
    el.classList.add('chart-tooltip-hidden')
    return
  }
  const xv = tooltip.dataPoints?.[0]?.parsed?.x
  if (xv == null || Number.isNaN(xv)) {
    el.classList.add('chart-tooltip-hidden')
    return
  }
  const idx = xValueToIndex(chartXToRaw(xv))
  // The hovered chart's own streams come first in the tooltip, in the order
  // they're declared on the group (which is the order Chart.js stacks them).
  const hoveredGroup = chartLayout.value.find((g) => g.id === groupId)
  const priority = hoveredGroup?.streams || []
  el.innerHTML = buildTooltipHtmlForIndex(idx, priority)
  el.classList.remove('chart-tooltip-hidden')
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Map hover tooltip — reuses the same `.chart-tooltip` DOM/CSS but lives in
// .map-wrap. Pinned to the top-right of the map (below the NavigationControl)
// so it doesn't move with the cursor or obscure the route.
function showMapTooltip(idx) {
  const wrap = mapEl.value?.parentNode
  if (!wrap || idx == null) return
  let el = wrap.querySelector('.chart-tooltip')
  if (!el) {
    el = document.createElement('div')
    el.className = 'chart-tooltip chart-tooltip-pinned'
    wrap.appendChild(el)
  }
  el.innerHTML = buildTooltipHtmlForIndex(idx)
  el.style.opacity = '1'
  el.style.top = '110px'
  el.style.right = '12px'
  el.style.left = 'auto'
  el.style.transform = 'none'
}

function hideMapTooltip() {
  const wrap = mapEl.value?.parentNode
  const el = wrap?.querySelector('.chart-tooltip')
  if (el) el.style.opacity = '0'
}

function showRouteCursor(lngLat) {
  if (!mapInstance) return
  if (!hoverMarker && _maplibregl) {
    const el = document.createElement('div')
    el.className = 'route-cursor'
    hoverMarker = new _maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(mapInstance)
  } else if (hoverMarker) {
    hoverMarker.setLngLat(lngLat)
    hoverMarker.getElement().style.display = ''
  }
}

function hideRouteCursor() {
  if (hoverMarker) hoverMarker.getElement().style.display = 'none'
}

// Returns the route index nearest to a map mousemove/click event if the
// cursor is within `tolPx` screen pixels of the actual route, otherwise null.
function nearestRouteIndexFromEvent(e, tolPx) {
  const data = streams.value?.latlng?.data
  if (!data || data.length === 0) return null
  const idx = latLngToIndex(e.lngLat.lng, e.lngLat.lat)
  const pt = data[idx]
  if (!pt) return null
  const routePx = mapInstance.project([pt[1], pt[0]])
  const dx = e.point.x - routePx.x
  const dy = e.point.y - routePx.y
  if (Math.hypot(dx, dy) > tolPx) return null
  return { idx, pt }
}

function installMapHoverTooltip() {
  if (!mapInstance) return
  mapInstance.on('mousemove', (e) => {
    if (isDragging) { hideMapTooltip(); hideRouteCursor(); return }
    const hit = nearestRouteIndexFromEvent(e, 40)
    if (!hit) { hideMapTooltip(); hideRouteCursor(); return }
    showMapTooltip(hit.idx)
    showRouteCursor([hit.pt[1], hit.pt[0]])
  })
  mapInstance.on('mouseout', () => { hideMapTooltip(); hideRouteCursor() })
  mapInstance.on('click', (e) => {
    if (isDragging) return
    const hit = nearestRouteIndexFromEvent(e, 25)
    if (!hit) return
    setSelection(hit.idx, hit.idx)
  })
}

function isDatasetHidden(groupId, idx) {
  return hiddenDatasets.value.get(groupId)?.has(idx) || false
}

function toggleDataset(groupId, idx) {
  const chart = chartInstances.get(groupId)
  if (!chart) return
  const prev = hiddenDatasets.value.get(groupId) || new Set()
  const next = new Set(prev)
  if (next.has(idx)) {
    next.delete(idx)
    chart.show(idx)
  } else {
    next.add(idx)
    chart.hide(idx)
  }
  const newMap = new Map(hiddenDatasets.value)
  newMap.set(groupId, next)
  hiddenDatasets.value = newMap
}

const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

function gradePaintExpression() {
  if (!showGrade.value) return '#fc4c02'
  return [
    'match', ['get', 'bucket'],
    0, GRADE_BUCKETS[0].color,
    1, GRADE_BUCKETS[1].color,
    2, GRADE_BUCKETS[2].color,
    3, GRADE_BUCKETS[3].color,
    4, GRADE_BUCKETS[4].color,
    5, GRADE_BUCKETS[5].color,
    6, GRADE_BUCKETS[6].color,
    '#fc4c02',
  ]
}

function toggleGrade() {
  showGrade.value = !showGrade.value
  if (mapInstance && mapInstance.getLayer('route-line')) {
    mapInstance.setPaintProperty('route-line', 'line-color', gradePaintExpression())
  }
}

function toggleMap3D() {
  if (!mapInstance) return
  is3D.value = !is3D.value
  if (is3D.value) {
    if (!mapInstance.getSource('terrain-dem')) {
      mapInstance.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      })
    }
    mapInstance.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    mapInstance.easeTo({ pitch: 60, bearing: -20, duration: 700 })
  } else {
    mapInstance.setTerrain(null)
    mapInstance.easeTo({ pitch: 0, bearing: 0, duration: 700 })
  }
}

function mergeGroups(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const merged = {
    id: target.id,
    streams: [...target.streams, ...source.streams.filter((s) => !target.streams.includes(s))],
    collapsed: !!target.collapsed,
  }
  chartLayout.value = chartLayout.value
    .filter((g) => g.id !== sourceId)
    .map((g) => (g.id === targetId ? merged : g))
  layoutDirty.value = true
}

// Copy: add source's streams to target without removing source and without dedup.
// Lets users overlay the same curve multiple times.
function copyToGroup(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const updated = {
    id: target.id,
    streams: [...target.streams, ...source.streams],
    collapsed: !!target.collapsed,
  }
  chartLayout.value = chartLayout.value.map((g) => (g.id === targetId ? updated : g))
  layoutDirty.value = true
}

function toggleCollapsed(group) {
  const next = chartLayout.value.map((g) =>
    g.id === group.id ? { ...g, collapsed: !g.collapsed } : g,
  )
  chartLayout.value = next
  layoutDirty.value = true
}

function splitGroup(group) {
  if (!group || group.streams.length <= 1) return
  const idx = chartLayout.value.findIndex((g) => g.id === group.id)
  if (idx < 0) return
  const otherGroups = chartLayout.value.filter((g) => g.id !== group.id)
  const used = new Set(otherGroups.map((g) => g.id))
  const replacements = []
  for (const s of group.streams) {
    // Skip if a solo group with this exact stream already exists somewhere.
    if (otherGroups.some((g) => g.streams.length === 1 && g.streams[0] === s)) continue
    // Skip if we already added a solo group for this stream during this split
    // (group may contain duplicates from prior copy operations).
    if (replacements.some((r) => r.streams[0] === s)) continue
    let candidate = s
    let suffix = 1
    while (used.has(candidate)) {
      suffix++
      candidate = `${s}-${suffix}`
    }
    used.add(candidate)
    replacements.push({ id: candidate, streams: [s], collapsed: false })
  }
  const newLayout = [...chartLayout.value]
  newLayout.splice(idx, 1, ...replacements)
  chartLayout.value = newLayout
  layoutDirty.value = true
}

function moveGroupToIndex(groupId, targetIndex) {
  const idx = chartLayout.value.findIndex((g) => g.id === groupId)
  if (idx < 0) return
  const arr = [...chartLayout.value]
  const [moved] = arr.splice(idx, 1)
  const clamped = Math.max(0, Math.min(targetIndex > idx ? targetIndex - 1 : targetIndex, arr.length))
  arr.splice(clamped, 0, moved)
  if (arr.every((g, i) => g.id === chartLayout.value[i]?.id)) return
  chartLayout.value = arr
  layoutDirty.value = true
}

function resetLayout() {
  chartLayout.value = defaultLayout()
  selectedLayoutId.value = null
  layoutDirty.value = true
  syncLayoutWithStreams()
  setLastUsed(null)
}

async function fetchSavedLayouts() {
  try {
    const res = await fetch('/preferences/chart_layouts', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    if (Array.isArray(payload.chart_layouts)) {
      savedLayouts.value = payload.chart_layouts
    }
    lastUsedId.value = payload.last_used_id ?? null
  } catch {
    // ignore
  }
}

// Apply a preset locally without persisting it as the new "last used" — used
// on mount when we restore the previously selected preset from the server.
function applyPresetById(id) {
  if (id == null) return false
  const preset = savedLayouts.value.find((p) => p.id === id)
  if (!preset) return false
  selectedLayoutId.value = id
  chartLayout.value = (preset.layout || []).map((g) => ({
    id: String(g.id),
    streams: Array.isArray(g.streams) ? g.streams.map(String) : [],
    collapsed: !!g.collapsed,
  }))
  layoutDirty.value = false
  return true
}

function loadPreset(rawId) {
  const id = typeof rawId === 'number' ? rawId : parseInt(rawId, 10)
  if (Number.isNaN(id)) {
    selectedLayoutId.value = null
    setLastUsed(null)
    return
  }
  if (!applyPresetById(id)) return
  syncLayoutWithStreams()
  setLastUsed(id)
}

async function setLastUsed(id) {
  try {
    await fetch('/preferences/chart_layouts/last_used', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id == null ? null : id }),
    })
    lastUsedId.value = id
  } catch {
    // fire-and-forget
  }
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function savePresetAs() {
  const current = selectedLayoutId.value
    ? savedLayouts.value.find((p) => p.id === selectedLayoutId.value)
    : null
  const proposed = current?.name || ''
  const name = window.prompt(t('strava.layout.save_as_prompt'), proposed)
  if (name == null) return
  const trimmed = name.trim()
  if (!trimmed) return
  layoutSaving.value = true
  try {
    const res = await fetch('/preferences/chart_layouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name: trimmed, layout: chartLayout.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const saved = payload.chart_layout
    if (saved) {
      const existing = savedLayouts.value.findIndex((p) => p.id === saved.id)
      if (existing >= 0) savedLayouts.value.splice(existing, 1, saved)
      else savedLayouts.value.push(saved)
      savedLayouts.value = [...savedLayouts.value].sort((a, b) => a.name.localeCompare(b.name))
      selectedLayoutId.value = saved.id
      layoutDirty.value = false
      setLastUsed(saved.id)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    layoutSaving.value = false
  }
}

async function deletePreset() {
  const id = selectedLayoutId.value
  if (!id) return
  const preset = savedLayouts.value.find((p) => p.id === id)
  if (!preset) return
  const confirmed = window.confirm(`${t('strava.layout.delete_confirm')} « ${preset.name} » ?`)
  if (!confirmed) return
  try {
    const res = await fetch(`/preferences/chart_layouts/${id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    savedLayouts.value = savedLayouts.value.filter((p) => p.id !== id)
    // Snap back to the default layout (same as choosing "— Aucune —" or
    // clicking the dedicated reset button). resetLayout also clears the
    // server-side last_used pointer.
    resetLayout()
  } catch (e) {
    error.value = e.message
  }
}

function onPresetChange(ev) {
  const v = ev.target.value
  if (v === '') {
    // Picking "— Aucune —" should behave like the dedicated reset button:
    // restore the default layout, clear the last-used preset on the server,
    // and drop the local selection.
    resetLayout()
  } else {
    loadPreset(v)
  }
}

// Pointer-events based drag instead of HTML5 native drag — gives us full control
// and avoids browser quirks around draggable attributes, drop event registration,
// and document-level listener wiring.
const DRAG_THRESHOLD_PX = 6
let pdStartX = 0
let pdStartY = 0
let pdInitialized = false
let pdMoveListener = null
let pdUpListener = null

function onChartPointerDown(group, e) {
  if (e.button !== undefined && e.button !== 0) return // left mouse only
  // Don't initiate drag from controls inside the header (e.g., the Split button).
  if (e.target.closest && e.target.closest('button')) return
  pdStartX = e.clientX
  pdStartY = e.clientY
  pdInitialized = false
  dragSourceId.value = group.id
  pdMoveListener = (ev) => onPointerMove(ev)
  pdUpListener = (ev) => onPointerUp(ev)
  window.addEventListener('mousemove', pdMoveListener)
  window.addEventListener('mouseup', pdUpListener)
}

function onPointerMove(e) {
  if (!pdInitialized) {
    const dx = e.clientX - pdStartX
    const dy = e.clientY - pdStartY
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    pdInitialized = true
  }
  pointerHitTest(e.clientX, e.clientY)
  document.body.style.cursor = dragOverGroupId.value
    ? (isCopyMode.value ? 'copy' : 'alias')
    : 'grabbing'
}

function pointerHitTest(clientX, clientY) {
  const elem = document.elementFromPoint(clientX, clientY)
  if (!elem) {
    dragOverGroupId.value = null
    dragOverSlotIndex.value = null
    isCopyMode.value = false
    return
  }
  let node = elem
  while (node && node !== document.body) {
    if (node.classList?.contains('chart-drop-slot')) {
      const idx = parseInt(node.dataset?.slotIdx ?? '', 10)
      if (!Number.isNaN(idx)) {
        dragOverSlotIndex.value = idx
        dragOverGroupId.value = null
        isCopyMode.value = false
      }
      return
    }
    if (node.classList?.contains('chart-group')) {
      const id = node.dataset?.groupId
      if (id && id !== dragSourceId.value) {
        // Left half → merge ; right half → copy.
        const rect = node.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        isCopyMode.value = clientX > midX
        dragOverGroupId.value = id
        dragOverSlotIndex.value = null
      } else {
        dragOverGroupId.value = null
        dragOverSlotIndex.value = null
        isCopyMode.value = false
      }
      return
    }
    node = node.parentElement
  }
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
  isCopyMode.value = false
}

function onPointerUp() {
  if (pdMoveListener) {
    window.removeEventListener('mousemove', pdMoveListener)
    pdMoveListener = null
  }
  if (pdUpListener) {
    window.removeEventListener('mouseup', pdUpListener)
    pdUpListener = null
  }
  document.body.style.cursor = ''

  if (pdInitialized && dragSourceId.value) {
    if (dragOverGroupId.value && dragOverGroupId.value !== dragSourceId.value) {
      // isCopyMode was set by pointerHitTest based on cursor position over the target.
      if (isCopyMode.value) {
        copyToGroup(dragSourceId.value, dragOverGroupId.value)
      } else {
        mergeGroups(dragSourceId.value, dragOverGroupId.value)
      }
    } else if (dragOverSlotIndex.value != null) {
      moveGroupToIndex(dragSourceId.value, dragOverSlotIndex.value)
    }
  }

  dragSourceId.value = null
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
  isCopyMode.value = false
  pdInitialized = false
}

function setZoom(min, max) {
  const natural = xMaxAll - xMinAll
  if (natural <= 0) return
  const minSpan = natural * 0.005
  let lo = Math.max(min, xMinAll)
  let hi = Math.min(max, xMaxAll)
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2
    lo = Math.max(xMinAll, mid - minSpan / 2)
    hi = Math.min(xMaxAll, mid + minSpan / 2)
  }
  if (lo <= xMinAll && hi >= xMaxAll) {
    zoomRange.value = null
  } else {
    zoomRange.value = { xMin: lo, xMax: hi }
  }
}

function resetZoom() {
  zoomRange.value = null
}

function zoomToSelection() {
  if (!selection.value) return
  const xs = streams.value?.[xAxis.value]?.data || streams.value?.time?.data
  if (!xs || xs.length === 0) return
  const a = xs[selection.value.startIdx]
  const b = xs[selection.value.endIdx]
  if (a == null || b == null) return
  const x0 = chartXFromRaw(a)
  const x1 = chartXFromRaw(b)
  if (Number.isNaN(x0) || Number.isNaN(x1) || x0 === x1) return
  setZoom(Math.min(x0, x1), Math.max(x0, x1))
}

function applyZoomToCharts() {
  chartInstances.forEach((chart) => {
    chart.options.scales.x.min = zoomRange.value?.xMin
    chart.options.scales.x.max = zoomRange.value?.xMax
    chart.update('none')
  })
}

let wheelRafPending = false
let pendingWheel = null

function handleZoomWheel(chart, e) {
  e.preventDefault()
  const rect = chart.canvas.getBoundingClientRect()
  const px = e.clientX - rect.left
  // Latest event wins per frame — older pending events are dropped.
  pendingWheel = { chart, px, deltaY: e.deltaY }
  if (wheelRafPending) return
  wheelRafPending = true
  requestAnimationFrame(() => {
    wheelRafPending = false
    if (!pendingWheel) return
    const { chart: c, px: p, deltaY } = pendingWheel
    pendingWheel = null
    applyZoomStep(c, p, deltaY)
  })
}

function applyZoomStep(chart, px, deltaY) {
  const xScale = chart.scales.x
  const cursorVal = xScale.getValueForPixel(px)
  const currentMin = zoomRange.value?.xMin ?? xMinAll
  const currentMax = zoomRange.value?.xMax ?? xMaxAll
  const range = currentMax - currentMin
  if (range <= 0 || cursorVal == null || Number.isNaN(cursorVal)) return
  const factor = deltaY > 0 ? 1.25 : 0.8
  const naturalRange = xMaxAll - xMinAll
  const newRange = range * factor
  if (newRange >= naturalRange) {
    resetZoom()
    return
  }
  const leftFrac = (cursorVal - currentMin) / range
  let newMin = cursorVal - leftFrac * newRange
  let newMax = newMin + newRange
  if (newMin < xMinAll) {
    newMax += xMinAll - newMin
    newMin = xMinAll
  }
  if (newMax > xMaxAll) {
    newMin -= newMax - xMaxAll
    newMax = xMaxAll
  }
  setZoom(newMin, newMax)
}

watch(xAxis, () => {
  zoomRange.value = null
  if (streams.value) renderCharts()
})

watch(chartLayout, async () => {
  if (!streams.value) return
  await nextTick()
  renderCharts()
}, { deep: true })

// When the user re-shows the charts after collapsing, the canvases were torn
// down by v-if so the previously-built Chart.js instances no longer have DOM
// elements to draw into. Re-render once Vue has mounted the new canvases.
watch(chartsCollapsed, async (collapsed) => {
  if (collapsed) return
  if (!streams.value) return
  await nextTick()
  renderCharts()
})

watch(zoomRange, applyZoomToCharts)

watch(selection, () => {
  applySelectionToCharts()
  refreshSelectedRoute()
  syncMarkersFromSelection()
})

let displayDebounceTimer = null
const DISPLAY_DEBOUNCE_MS = 60
watch(selection, (val) => {
  if (displayDebounceTimer) clearTimeout(displayDebounceTimer)
  displayDebounceTimer = setTimeout(() => {
    displayDebounceTimer = null
    selectionDisplay.value = val ? { ...val } : null
  }, DISPLAY_DEBOUNCE_MS)
})

onMounted(async () => {
  const savedLayoutsPromise = fetchSavedLayouts()
  const photosPromise = fetchPhotos()
  await fetchActivity()
  if (!activity.value) return
  await fetchStreams()
  await savedLayoutsPromise
  // Auto-apply the user's last-used preset if any. applyPresetById is a no-op
  // if the id no longer exists (e.g., was deleted from another tab).
  if (lastUsedId.value != null) applyPresetById(lastUsedId.value)
  syncLayoutWithStreams()
  if (hasRoute.value) {
    await renderMap()
  }
  // Photos may finish loading after renderMap; install markers when ready.
  photosPromise.then(() => {
    if (mapInstance && _maplibregl) installPhotoMarkers(_maplibregl)
  })
  if (streams.value && availableLayout.value.length > 0) {
    await new Promise((r) => requestAnimationFrame(r))
    await renderCharts()
  }
  window.addEventListener('keydown', onLightboxKey)
})

onBeforeUnmount(() => {
  climbMarkers.forEach((m) => m.remove())
  climbMarkers.length = 0
  photoMarkers.forEach((m) => m.remove())
  photoMarkers.length = 0
  if (hoverMarker) { hoverMarker.remove(); hoverMarker = null }
  if (mapInstance) {
    mapInstance.remove()
    mapInstance = null
  }
  destroyCharts()
  window.removeEventListener('keydown', onLightboxKey)
})

function onLightboxKey(ev) {
  if (lightboxIndex.value === null) return
  if (ev.key === 'Escape') {
    lightboxIndex.value = null
  } else if (ev.key === 'ArrowLeft' && lightboxIndex.value > 0) {
    lightboxIndex.value--
  } else if (ev.key === 'ArrowRight' && lightboxIndex.value < photos.value.length - 1) {
    lightboxIndex.value++
  }
}
</script>

<template>
  <div>
    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>Loading…</span>
    </div>
    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>
    <div v-else-if="activity">
      <div class="card mb-3 shadow-sm border-0">
        <div class="card-header activity-card-header d-flex align-items-center gap-2">
          <span class="activity-type-badge">
            <i :class="`fa-solid ${activityIcon(activity.type)}`" aria-hidden="true"></i>
          </span>
          <div class="flex-grow-1 min-width-0">
            <h2 class="h5 mb-0 text-truncate">{{ activity.name }}</h2>
            <div v-if="startEndDisplay" class="activity-times d-flex flex-wrap align-items-center gap-2 mt-1">
              <span class="d-inline-flex align-items-center gap-1">
                <i class="fa-solid fa-flag text-success" aria-hidden="true"></i>
                <span>{{ startEndDisplay.start }}</span>
              </span>
              <i v-if="startEndDisplay.end" class="fa-solid fa-arrow-right text-muted" aria-hidden="true"></i>
              <span v-if="startEndDisplay.end" class="d-inline-flex align-items-center gap-1">
                <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>
                <span>{{ startEndDisplay.end }}</span>
              </span>
              <span
                v-if="startEndDisplay.duration"
                class="activity-duration-pill d-inline-flex align-items-center gap-1"
              >
                <i class="fa-solid fa-stopwatch" aria-hidden="true"></i>
                <span>{{ startEndDisplay.duration }}</span>
              </span>
              <span
                v-if="activity.calories"
                class="activity-cal-pill d-inline-flex align-items-center gap-1"
              >
                <i class="fa-solid fa-fire" aria-hidden="true"></i>
                <span>{{ Math.round(activity.calories) }} kcal</span>
              </span>
            </div>
          </div>
          <button
            v-if="hasRoute"
            type="button"
            class="btn btn-sm btn-outline-warning d-inline-flex align-items-center gap-1 ms-auto"
            :title="t('routes.create_from_activity_title')"
            @click="createRouteFromActivity"
          >
            <i class="fa-solid fa-route" aria-hidden="true"></i>
            <span class="d-none d-md-inline">{{ t('routes.create_from_activity') }}</span>
          </button>
        </div>
        <div class="card-body p-0">
          <div v-if="hasRoute" class="map-wrap" :class="{ expanded: mapExpanded }">
            <div ref="mapEl" class="activity-map"></div>
            <div class="map-controls">
              <!-- Groupe 1 : style de fond (radio) -->
              <div class="btn-group btn-group-sm shadow-sm" role="group" :aria-label="t('strava.map_style_label')">
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapStyleId === 'cyclosm' ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="setMapStyle('cyclosm')"
                  :title="t('strava.map_style_cyclo')"
                >
                  <i class="fa-solid fa-bicycle" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_cyclo') }}</span>
                </button>
                <button
                  v-if="THUNDERFOREST_KEY"
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapStyleId === 'cycle' ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="setMapStyle('cycle')"
                  :title="t('strava.map_style_opencycle')"
                >
                  <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_opencycle') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapStyleId === 'topo' ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="setMapStyle('topo')"
                  :title="t('strava.map_style_topo')"
                >
                  <i class="fa-solid fa-mountain-sun" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_topo') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapStyleId === 'liberty' ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="setMapStyle('liberty')"
                  :title="t('strava.map_style_standard')"
                >
                  <i class="fa-solid fa-map" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.map_style_standard') }}</span>
                </button>
              </div>

              <!-- Groupe 2 : overlays et vue (toggles indépendants) -->
              <div class="btn-group btn-group-sm shadow-sm" role="group">
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="showClimbs ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleClimbs"
                  :title="showClimbs ? t('strava.hide_climbs') : t('strava.show_climbs')"
                  :aria-pressed="showClimbs"
                >
                  <i class="fa-solid fa-mountain" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.climbs_label') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="showGrade ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleGrade"
                  :title="showGrade ? t('strava.hide_grade') : t('strava.show_grade')"
                  :aria-pressed="showGrade"
                >
                  <i class="fa-solid fa-palette" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.grade_label') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="showPhotos ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="togglePhotos"
                  :title="showPhotos ? t('strava.hide_photos') : t('strava.show_photos')"
                  :aria-pressed="showPhotos"
                  :disabled="photos.length === 0"
                >
                  <i class="fa-solid fa-camera" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ t('strava.photos_label') }}</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="is3D ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleMap3D"
                  :title="is3D ? t('strava.map_2d') : t('strava.map_3d')"
                  :aria-pressed="is3D"
                >
                  <i class="fa-solid fa-cube" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">3D</span>
                </button>
                <button
                  type="button"
                  class="btn map-ctrl-btn"
                  :class="mapExpanded ? 'btn-warning text-dark active' : 'btn-light'"
                  @click="toggleMapSize"
                  :title="mapExpanded ? t('strava.shrink_map') : t('strava.expand_map')"
                  :aria-pressed="mapExpanded"
                >
                  <i :class="mapExpanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" aria-hidden="true"></i>
                  <span class="d-none d-md-inline ms-1">{{ mapExpanded ? t('strava.shrink_map') : t('strava.expand_map') }}</span>
                </button>
              </div>
            </div>
          </div>
          <div v-else class="alert alert-info m-3 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-map-location-dot" aria-hidden="true"></i>
            <span>{{ t('strava.no_route_data') }}</span>
          </div>
        </div>
      </div>

      <!-- Galerie photos -->
      <div v-if="photos.length > 0" class="card mt-3 shadow-sm border-0">
        <div class="card-header activity-card-header d-flex align-items-center gap-2">
          <i class="fa-solid fa-images text-warning" aria-hidden="true"></i>
          <h3 class="h6 mb-0 flex-grow-1">{{ t('strava.photo_gallery') }} ({{ photos.length }})</h3>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            @click="toggleGalleryCollapsed"
            :title="galleryCollapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
            :aria-pressed="galleryCollapsed"
          >
            <i :class="galleryCollapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
          </button>
        </div>
        <div v-if="!galleryCollapsed" class="card-body">
          <div class="photo-gallery">
            <button
              v-for="(photo, idx) in photos"
              :key="photo.unique_id || photo.id || idx"
              type="button"
              class="photo-thumb"
              @click="lightboxIndex = idx"
              :title="photo.caption || ''"
            >
              <img :src="pickPhotoUrl(photo, 256)" :alt="photo.caption || ''" loading="lazy">
              <span v-if="photo.caption" class="photo-thumb-caption">{{ photo.caption }}</span>
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="movingStats || globalVam != null || splits.length > 0 || climbsWithVam.length > 0 || peakPowers.length > 0"
        class="card shadow-sm border-0 mt-3"
      >
        <div class="card-header activity-card-header d-flex align-items-center gap-2">
          <i class="fa-solid fa-chart-simple text-warning" aria-hidden="true"></i>
          <h3 class="h6 mb-0">{{ t('strava.stats.title') }}</h3>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary ms-auto"
            :title="statsCollapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
            :aria-pressed="statsCollapsed"
            @click="toggleStatsCollapsed"
          >
            <i :class="statsCollapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
          </button>
        </div>
        <div v-if="!statsCollapsed" class="card-body">
          <!-- Top-line stats: temps roulé / arrêts / VAM globale -->
          <div v-if="movingStats || globalVam != null" class="row g-3 mb-3 stats-pills-row">
            <div v-if="movingStats" class="col-6 col-md-3">
              <div class="stat-card">
                <span class="stat-icon"><i class="fa-solid fa-person-biking text-success" aria-hidden="true"></i></span>
                <div>
                  <div class="text-muted small">{{ t('strava.stats.moving') }}</div>
                  <strong>{{ formatHMS(movingStats.moving) }}</strong>
                </div>
              </div>
            </div>
            <div v-if="movingStats" class="col-6 col-md-3">
              <div class="stat-card">
                <span class="stat-icon"><i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i></span>
                <div>
                  <div class="text-muted small">{{ t('strava.stats.elapsed') }}</div>
                  <strong>{{ formatHMS(movingStats.elapsed) }}</strong>
                </div>
              </div>
            </div>
            <div v-if="movingStats" class="col-6 col-md-3">
              <div class="stat-card">
                <span class="stat-icon"><i class="fa-solid fa-pause text-secondary" aria-hidden="true"></i></span>
                <div>
                  <div class="text-muted small">
                    {{ t('strava.stats.stopped') }}
                    <span v-if="movingStats.elapsed > 0" class="text-muted">· {{ movingStats.stopPct.toFixed(0) }} %</span>
                  </div>
                  <strong>{{ formatHMS(movingStats.stopped) }}</strong>
                </div>
              </div>
            </div>
            <div v-if="globalVam != null" class="col-6 col-md-3">
              <div class="stat-card" :title="t('strava.stats.vam_hint')">
                <span class="stat-icon"><i class="fa-solid fa-mountain text-success" aria-hidden="true"></i></span>
                <div>
                  <div class="text-muted small">{{ t('strava.stats.vam_global') }}</div>
                  <strong>{{ Math.round(globalVam) }} m/h</strong>
                </div>
              </div>
            </div>
          </div>

          <!-- Climbs (per-climb VAM) -->
          <div v-if="climbsWithVam.length > 0" class="stats-section">
            <h4 class="h6 mb-2 d-flex align-items-center gap-2">
              <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
              <span>{{ t('strava.stats.climbs_title') }}</span>
            </h4>
            <div class="table-responsive stats-table-scroll">
              <table class="table table-sm stats-table align-middle mb-0">
                <thead>
                  <tr>
                    <th>#</th>
                    <th :title="t('strava.stats.col_length')">
                      <i class="fa-solid fa-route text-secondary" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_length') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_gain')">
                      <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_gain') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_grade')">
                      <i class="fa-solid fa-slash text-secondary" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_grade') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_time')">
                      <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_vam')">
                      <i class="fa-solid fa-mountain text-success" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_vam') }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(c, i) in climbsWithVam" :key="`climb-${i}`">
                    <td>
                      <span class="climb-cat-badge" :class="`climb-cat-${c.category || 'HC'}`">
                        <span>{{ c.category ? `Cat ${c.category}` : 'HC' }}</span>
                      </span>
                    </td>
                    <td>{{ formatKm(c.lengthM) }}</td>
                    <td>+{{ Math.round(c.gain) }} m</td>
                    <td>{{ c.avgGrade.toFixed(1) }} %</td>
                    <td>{{ c.duration != null ? formatHMS(c.duration) : '–' }}</td>
                    <td>{{ c.vam != null ? `${Math.round(c.vam)} m/h` : '–' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Splits per km -->
          <div v-if="splits.length > 0" class="stats-section mt-3">
            <h4 class="h6 mb-2 d-flex align-items-center gap-2">
              <i class="fa-solid fa-flag-checkered text-warning" aria-hidden="true"></i>
              <span>{{ t('strava.stats.splits_title') }}</span>
            </h4>
            <div class="table-responsive stats-table-scroll">
              <table class="table table-sm stats-table align-middle mb-0">
                <thead>
                  <tr>
                    <th>{{ t('strava.stats.col_km') }}</th>
                    <th :title="t('strava.stats.col_time')">
                      <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                    </th>
                    <th>
                      <template v-if="isPaceActivity">
                        {{t('strava.stats.col_pace')}}
                      </template>
                      <template v-else>
                        <i class="fa-solid fa-gauge-high text-primary" aria-hidden="true"></i>
                      </template>
                    </th>
                    <th :title="t('strava.stats.col_gain')">
                      <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_gain') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_loss')">
                      <i class="fa-solid fa-arrow-trend-down text-danger" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_loss') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_hr')">
                      <i class="fa-solid fa-heart-pulse text-danger" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_hr') }}</span>
                    </th>
                    <th v-if="splitsHavePower" :title="t('strava.stats.col_power')">
                      <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_power') }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="sp in splits" :key="`split-${sp.kmIndex}`">
                    <td>
                      <strong>{{ sp.kmIndex }}</strong>
                      <span v-if="sp.distance < 990" class="text-muted ms-1 small">({{ (sp.distance / 1000).toFixed(2) }} km)</span>
                    </td>
                    <td>{{ formatHMS(sp.durationSec) }}</td>
                    <td>{{ isPaceActivity ? formatPace(sp.paceSecPerKm) : (sp.speedKmh != null ? `${sp.speedKmh.toFixed(1)} km/h` : '–') }}</td>
                    <td>+{{ Math.round(sp.gain) }} m</td>
                    <td>−{{ Math.round(sp.loss) }} m</td>
                    <td>{{ sp.avgHr != null ? `${Math.round(sp.avgHr)} bpm` : '–' }}</td>
                    <td v-if="splitsHavePower">{{ sp.avgPower != null ? `${Math.round(sp.avgPower)} W` : '–' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Peak average power per duration (shortest → longest). -->
          <div v-if="peakPowers.length > 0" class="stats-section mt-3">
            <h4 class="h6 mb-2 d-flex align-items-center gap-2">
              <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
              <span>{{ t('strava.stats.peak_power_title') }}</span>
            </h4>
            <div class="table-responsive stats-table-scroll">
              <table class="table table-sm stats-table align-middle mb-0">
                <thead>
                  <tr>
                    <th :title="t('strava.stats.col_duration')">
                      <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_duration') }}</span>
                    </th>
                    <th :title="t('strava.stats.col_power')">
                      <i class="fa-solid fa-bolt text-success" aria-hidden="true"></i>
                      <span class="visually-hidden">{{ t('strava.stats.col_power') }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="pp in peakPowers" :key="`peak-${pp.duration}`">
                    <td>{{ formatPowerDuration(pp.duration) }}</td>
                    <td>{{ Math.round(pp.avgPower) }} W</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="card shadow-sm border-0 mt-3">
        <div class="card-header activity-card-header charts-sticky-header">
          <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-chart-line text-warning" aria-hidden="true"></i>
              <span>{{ t('strava.charts') }}</span>
            </h3>
            <div class="d-flex flex-wrap gap-3 align-items-center">
              <!-- Controls only render when the charts card is expanded. The
                   toggle button below stays visible in both states. -->
              <template v-if="!chartsCollapsed">
              <!-- GROUPE 1 : Actions ponctuelles (visibles si applicables) -->
              <!-- Placé en premier pour que l'apparition/disparition des
                   boutons ne décale pas les groupes Préférence + Axe X qui
                   sont ancrés à droite. -->
              <div class="control-group" v-if="selection || zoomRange">
                <button
                  v-if="selection"
                  type="button"
                  class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                  @click="zoomToSelection"
                  :title="t('strava.zoom_to_selection')"
                >
                  <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
                  <span>{{ t('strava.zoom_to_selection') }}</span>
                </button>
                <button
                  v-if="selection"
                  type="button"
                  class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                  @click="clearSelection"
                  :title="t('strava.clear_selection')"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                  <span>{{ t('strava.clear_selection') }}</span>
                </button>
                <button
                  v-if="zoomRange"
                  type="button"
                  class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                  @click="resetZoom"
                  :title="t('strava.reset_zoom')"
                >
                  <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
                  <span>{{ t('strava.reset_zoom') }}</span>
                </button>
              </div>

              <!-- GROUPE 2 : Préférence (preset nommé) -->
              <div class="control-group" :title="t('strava.layout.title')">
                <span class="control-group-label">{{ t('strava.layout.preset_label') }}</span>
                <select
                  class="form-select form-select-sm preset-select"
                  :value="selectedLayoutId ?? ''"
                  @change="onPresetChange"
                  :title="t('strava.layout.select_preset')"
                >
                  <option value="">— {{ t('strava.layout.no_preset') }} —</option>
                  <option v-for="p in savedLayouts" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
                <div class="btn-group btn-group-sm">
                  <button
                    type="button"
                    class="btn btn-outline-primary"
                    @click="savePresetAs"
                    :disabled="layoutSaving"
                    :title="t('strava.layout.save_as')"
                  >
                    <span v-if="layoutSaving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                    <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    class="btn btn-outline-danger"
                    @click="deletePreset"
                    :disabled="!selectedLayoutId || layoutSaving"
                    :title="t('strava.layout.delete')"
                  >
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  </button>
                  <button
                    type="button"
                    class="btn btn-outline-secondary"
                    @click="resetLayout"
                    :title="t('strava.layout.reset')"
                  >
                    <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
                  </button>
                </div>
              </div>

              <!-- GROUPE 3 : Axe X (toujours visible) -->
              <div class="control-group" v-if="availableLayout.length > 0">
                <span class="control-group-label">{{ t('strava.x_axis_label') }}</span>
                <div class="btn-group btn-group-sm" role="group">
                  <input type="radio" class="btn-check" name="xAxis" id="xAxis-distance" autocomplete="off" value="distance" v-model="xAxis" :disabled="!streams || !streams.distance" />
                  <label class="btn btn-outline-secondary" for="xAxis-distance">{{ t('strava.x_distance') }}</label>
                  <input type="radio" class="btn-check" name="xAxis" id="xAxis-time" autocomplete="off" value="time" v-model="xAxis" :disabled="!streams || !streams.time" />
                  <label class="btn btn-outline-secondary" for="xAxis-time">{{ t('strava.x_time') }}</label>
                </div>
              </div>
              </template>

              <button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                :title="chartsCollapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
                :aria-pressed="chartsCollapsed"
                @click="toggleChartsCollapsed"
              >
                <i :class="chartsCollapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div v-if="availableLayout.length > 0" class="range-chips d-flex flex-wrap gap-2 align-items-center mt-2">
            <span v-if="rangeDuration() != null" class="range-chip">
              <i class="fa-regular fa-clock" aria-hidden="true"></i>
              <strong>{{ formatHMS(rangeDuration()) }}</strong>
            </span>
            <span v-if="rangeDistance() != null" class="range-chip">
              <i class="fa-solid fa-route" aria-hidden="true"></i>
              <strong>{{ formatKm(rangeDistance()) }}</strong>
            </span>
            <span v-if="rangeElevation()" class="range-chip range-chip-success">
              <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
              <strong>{{ Math.round(rangeElevation().up) }} m</strong>
            </span>
            <span v-if="rangeElevation()" class="range-chip range-chip-danger">
              <i class="fa-solid fa-arrow-trend-down" aria-hidden="true"></i>
              <strong>{{ Math.round(rangeElevation().down) }} m</strong>
            </span>
            <span v-if="rangeGrade() != null && !visibleStreams.includes('grade_smooth')" class="range-chip">
              <i class="fa-solid fa-percent" aria-hidden="true"></i>
              <strong>{{ rangeGrade().toFixed(1) }} %</strong>
            </span>
            <span
              v-for="streamKey in chipStreams"
              :key="`mean-${streamKey}`"
              class="range-chip range-chip-stream"
              :style="{ background: defByKey(streamKey)?.color + '1f', color: defByKey(streamKey)?.color }"
            >
              <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
              <strong v-if="chartStats(defByKey(streamKey))">{{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</strong>
              <strong v-else>–</strong>
            </span>
          </div>
        </div>
        <div v-if="!chartsCollapsed" class="card-body">
          <div v-if="streamsLoading" class="text-muted d-flex align-items-center gap-2">
            <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
            <span>{{ t('strava.loading_streams') }}</span>
          </div>
          <div v-else-if="streamsError" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <span>{{ streamsError }}</span>
          </div>
          <div v-else-if="availableLayout.length === 0" class="text-muted d-flex align-items-center gap-2">
            <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
            <span>{{ t('strava.no_stream_data') }}</span>
          </div>
          <div v-else class="chart-layout">
            <template v-for="(group, gIdx) in availableLayout" :key="group.id">
              <div
                class="chart-drop-slot"
                :class="{ active: dragOverSlotIndex === gIdx, hinting: dragSourceId }"
                :data-slot-idx="gIdx"
              ></div>
              <div
                class="chart-group"
                :class="{
                  'merge-target': dragOverGroupId === group.id && dragSourceId !== group.id,
                  dragging: dragSourceId === group.id,
                }"
                :data-group-id="group.id"
              >
                <div
                  v-if="dragOverGroupId === group.id && dragSourceId !== group.id"
                  class="chart-group-zones"
                >
                  <div class="chart-zone chart-zone-merge" :class="{ active: !isCopyMode }">
                    <span>{{ t('strava.layout.merge_here') }}</span>
                  </div>
                  <div class="chart-zone chart-zone-copy" :class="{ active: isCopyMode }">
                    <span>{{ t('strava.layout.copy_here') }}</span>
                  </div>
                </div>
                <div
                  class="chart-group-header"
                  @mousedown="onChartPointerDown(group, $event)"
                  :title="t('strava.layout.drag_hint')"
                >
                  <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                    <div class="d-flex align-items-center gap-2 flex-wrap">
                      <span class="drag-handle">
                        <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                      </span>
                      <template v-if="!group.collapsed">
                        <button
                          v-for="(streamKey, sIdx) in group.streams"
                          :key="`legend-${group.id}-${sIdx}`"
                          type="button"
                          class="legend-pill"
                          :class="{ hidden: isDatasetHidden(group.id, sIdx) }"
                          @click="toggleDataset(group.id, sIdx)"
                          @mousedown.stop
                          :title="isDatasetHidden(group.id, sIdx) ? t('strava.layout.show_curve') : t('strava.layout.hide_curve')"
                        >
                          <i
                            :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'} legend-icon`"
                            :style="{ color: defByKey(streamKey)?.color }"
                            aria-hidden="true"
                          ></i>
                          <span>{{ t('strava.stream.' + streamKey) }}</span>
                        </button>
                      </template>
                      <template v-else>
                        <span
                          v-for="streamKey in group.streams"
                          :key="streamKey"
                          class="legend-pill legend-pill-static"
                        >
                          <i
                            :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'} legend-icon`"
                            :style="{ color: defByKey(streamKey)?.color }"
                            aria-hidden="true"
                          ></i>
                          <span>{{ t('strava.stream.' + streamKey) }}</span>
                        </span>
                      </template>
                    </div>
                    <div class="d-flex gap-1">
                      <button
                        v-if="group.streams.length > 1 && !group.collapsed"
                        type="button"
                        class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                        @click="splitGroup(group)"
                        @mousedown.stop
                        :title="t('strava.layout.split')"
                      >
                        <i class="fa-solid fa-object-ungroup" aria-hidden="true"></i>
                        <span>{{ t('strava.layout.split') }}</span>
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                        @click="toggleCollapsed(group)"
                        @mousedown.stop
                        :title="group.collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
                      >
                        <i :class="group.collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-if="!group.collapsed" class="row g-2 align-items-stretch">
                  <div class="col-lg-9">
                    <div class="chart-canvas-wrap">
                      <canvas :id="`chart-${group.id}`"></canvas>
                    </div>
                  </div>
                  <div class="col-lg-3 chart-side-panel">
                    <div
                      v-for="streamKey in group.streams"
                      :key="streamKey"
                      class="stream-stats-row"
                    >
                      <span
                        class="stream-stats-id"
                        :style="{ color: defByKey(streamKey)?.color }"
                        :title="t('strava.stream.' + streamKey)"
                      >
                        <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
                      </span>
                      <template v-if="chartStats(defByKey(streamKey))">
                        <span :title="t('strava.range_stats.min')">
                          <i class="fa-solid fa-arrow-down-short-wide" aria-hidden="true"></i>
                          {{ fmt(chartStats(defByKey(streamKey)).min, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}
                        </span>
                        <span :title="t('strava.range_stats.mean')">
                          <i class="fa-solid fa-equals" aria-hidden="true"></i>
                          {{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}
                        </span>
                        <span :title="t('strava.range_stats.max')">
                          <i class="fa-solid fa-arrow-up-wide-short" aria-hidden="true"></i>
                          {{ fmt(chartStats(defByKey(streamKey)).max, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}
                        </span>
                      </template>
                    </div>
                    <div class="chart-tooltip-slot" :data-group-id="group.id"></div>
                  </div>
                </div>
              </div>
            </template>
            <div
              class="chart-drop-slot"
              :class="{ active: dragOverSlotIndex === availableLayout.length, hinting: dragSourceId }"
              :data-slot-idx="availableLayout.length"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Lightbox modal pour les photos (Teleport au body pour échapper aux overflow/z-index) -->
    <Teleport to="body">
      <div
        v-if="lightboxIndex !== null && photos[lightboxIndex]"
        class="photo-lightbox"
        @click.self="lightboxIndex = null"
      >
        <button
          type="button"
          class="photo-lightbox-btn photo-lightbox-close"
          @click="lightboxIndex = null"
          :title="t('strava.close')"
          :aria-label="t('strava.close')"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <button
          v-if="lightboxIndex > 0"
          type="button"
          class="photo-lightbox-btn photo-lightbox-prev"
          @click="lightboxIndex--"
          :title="t('strava.previous')"
          :aria-label="t('strava.previous')"
        >
          <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
        </button>
        <button
          v-if="lightboxIndex < photos.length - 1"
          type="button"
          class="photo-lightbox-btn photo-lightbox-next"
          @click="lightboxIndex++"
          :title="t('strava.next')"
          :aria-label="t('strava.next')"
        >
          <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
        </button>
        <img
          :src="pickPhotoUrl(photos[lightboxIndex], 2048)"
          :alt="photos[lightboxIndex].caption || ''"
          class="photo-lightbox-img"
        />
        <div v-if="photos[lightboxIndex].caption" class="photo-lightbox-caption">
          {{ photos[lightboxIndex].caption }}
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
}
.map-wrap.expanded {
  position: fixed;
  /* Sits below the fixed-top navbar (z-index 1030 in Bootstrap) and above
     anything else. left=0/right=0 makes it span the full viewport width. */
  top: 4rem;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1020;
  background: #fff;
  box-shadow: 0 -2px 20px rgba(0, 0, 0, 0.2);
}
.min-width-0 {
  min-width: 0;
}
.activity-times {
  font-size: 0.82rem;
  color: #495057;
  font-variant-numeric: tabular-nums;
}
.activity-duration-pill {
  background: rgba(252, 76, 2, 0.12);
  color: #fc4c02;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
.activity-cal-pill {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  font-weight: 600;
}
.activity-map {
  height: 520px;
  width: 100%;
}
.map-wrap.expanded .activity-map {
  height: 100%;
  width: 100%;
}
.map-controls {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
  pointer-events: none; /* let the map handle drags outside the buttons */
}
.map-controls > * { pointer-events: auto; }
.map-ctrl-btn {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  font-weight: 500;
}
/* Active state — has to win over .map-ctrl-btn's white background. */
.map-ctrl-btn.active,
.map-ctrl-btn.active:hover,
.map-ctrl-btn.active:focus {
  background: #ffc107;
  color: #212529;
  border-color: rgba(252, 76, 2, 0.7);
}

.custom-legend {
  margin: 0.35rem 0 0.4rem;
  font-size: 0.72rem;
}
.legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: #495057;
  font-size: 0.72rem;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, color 0.12s;
  user-select: none;
  line-height: 1.5;
}
.legend-pill:hover {
  background: rgba(0, 0, 0, 0.07);
}
.legend-pill.hidden {
  opacity: 0.45;
  text-decoration: line-through;
}
.legend-icon {
  font-size: 0.85rem;
  line-height: 1;
  flex-shrink: 0;
}
.legend-pill.hidden .legend-icon {
  color: #adb5bd !important;
}
.legend-pill-static {
  cursor: default;
  background: rgba(0, 0, 0, 0.02);
  border-style: dashed;
}
.legend-pill-static:hover {
  background: rgba(0, 0, 0, 0.02);
}
.chart-canvas-wrap {
  position: relative;
  height: 240px;
  width: 100%;
}
.chart-canvas-wrap canvas {
  cursor: crosshair;
  touch-action: pan-y;
}

.stats-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  row-gap: 0.1rem;
}
.stats-grid dt {
  font-weight: 400;
}
.stats-grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.charts-sticky-header {
  position: sticky;
  top: 4rem;
  z-index: 5;
  background: #ffffff;
  backdrop-filter: saturate(140%);
  border-bottom: 1px solid rgba(252, 76, 2, 0.22);
  box-shadow: 0 6px 14px -10px rgba(0, 0, 0, 0.18);
}

.range-chips {
  font-size: 0.85rem;
}

.range-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: rgba(108, 117, 125, 0.1);
  color: #495057;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.range-chip strong {
  font-weight: 600;
  color: #212529;
}
.range-chip .range-chip-label {
  color: #6c757d;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.range-chip-accent {
  background: rgba(13, 110, 253, 0.12);
  color: #0a58ca;
}
.range-chip-muted {
  background: rgba(108, 117, 125, 0.12);
  color: #495057;
}
.range-chip-success {
  background: rgba(25, 135, 84, 0.12);
  color: #198754;
}
.range-chip-success strong { color: #146c43; }
.range-chip-danger {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
}
.range-chip-danger strong { color: #842029; }

.chart-layout {
  position: relative;
}
.chart-group {
  border-radius: 0.5rem;
  padding: 0.5rem;
  border: 1px solid transparent;
  position: relative;
  transition: outline 0.12s, background-color 0.12s, opacity 0.12s, box-shadow 0.12s;
}
.chart-group.dragging {
  opacity: 0.45;
}
.chart-group.merge-target {
  outline: 3px solid rgba(13, 110, 253, 0.45);
  outline-offset: -3px;
  box-shadow: 0 0 0 4px rgba(13, 110, 253, 0.08);
}
.chart-group-zones {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: none;
  z-index: 4;
  border-radius: 0.5rem;
  overflow: hidden;
}
.chart-zone {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: 0.02em;
  transition: background 0.12s, color 0.12s;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
}
.chart-zone-merge {
  background: linear-gradient(to right, rgba(13, 110, 253, 0.22), rgba(13, 110, 253, 0.06));
  color: #0a58ca;
  border-right: 2px dashed rgba(0, 0, 0, 0.15);
}
.chart-zone-copy {
  background: linear-gradient(to left, rgba(25, 135, 84, 0.22), rgba(25, 135, 84, 0.06));
  color: #146c43;
}
.chart-zone.active {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
.chart-zone-merge.active {
  background: linear-gradient(to right, rgba(13, 110, 253, 0.65), rgba(13, 110, 253, 0.35));
}
.chart-zone-copy.active {
  background: linear-gradient(to left, rgba(25, 135, 84, 0.65), rgba(25, 135, 84, 0.35));
}
.chart-zone span {
  background: rgba(255, 255, 255, 0.85);
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  box-shadow: 0 4px 12px -4px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
}
.chart-zone.active span {
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
}
.chart-group-header {
  cursor: grab;
  padding: 0.35rem 0.5rem;
  margin-bottom: 0.4rem;
  border-radius: 0.4rem;
  background: rgba(108, 117, 125, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.05);
  transition: background-color 0.12s, border-color 0.12s;
  user-select: none;
}
.chart-group-header:hover {
  background: rgba(252, 76, 2, 0.06);
  border-color: rgba(252, 76, 2, 0.25);
}
.chart-group.dragging .chart-group-header {
  cursor: grabbing;
}
.drag-handle {
  color: #adb5bd;
  font-size: 0.95rem;
  pointer-events: none;
}
.chart-group-header:hover .drag-handle {
  color: #fc4c02;
}
.chart-drop-slot {
  height: 6px;
  margin: 0;
  border-radius: 4px;
  background: transparent;
  transition: background-color 0.12s, height 0.12s, margin 0.12s, box-shadow 0.12s;
  position: relative;
}
.chart-drop-slot.hinting {
  height: 24px;
  margin: 6px 0;
  background: repeating-linear-gradient(
    45deg,
    rgba(108, 117, 125, 0.14),
    rgba(108, 117, 125, 0.14) 6px,
    rgba(108, 117, 125, 0.05) 6px,
    rgba(108, 117, 125, 0.05) 12px
  );
  border: 1px dashed rgba(108, 117, 125, 0.4);
}
.chart-drop-slot.hinting::before {
  content: "↕";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(108, 117, 125, 0.6);
  font-size: 0.95rem;
  pointer-events: none;
}
.chart-drop-slot.active {
  background: rgba(13, 110, 253, 0.35);
  border-color: #0d6efd;
  box-shadow: 0 0 0 2px rgba(13, 110, 253, 0.25);
  height: 28px;
  margin: 6px 0;
}
.chart-drop-slot.active::before {
  color: #0d6efd;
  font-weight: bold;
}
.stream-stats-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding: 0.2rem 0;
  color: #495057;
}
.stream-stats-row + .stream-stats-row {
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
}
.stream-stats-row > span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.stream-stats-row > span i {
  color: #adb5bd;
  font-size: 0.75rem;
}
.stream-stats-id i {
  color: inherit !important;
  font-size: 0.95rem !important;
}

.preset-select {
  width: auto;
  max-width: 220px;
  min-width: 140px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.55rem 0.25rem 0.6rem;
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 0.5rem;
  position: relative;
}
.control-group-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6c757d;
  user-select: none;
  padding-right: 0.15rem;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  margin-right: 0.25rem;
  line-height: 1.6;
}

.range-chip-stream {
  font-weight: 500;
}
.range-chip-stream strong {
  color: inherit;
}

.photo-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.5rem;
}
.photo-thumb {
  position: relative;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  border-radius: 0.4rem;
  overflow: hidden;
  aspect-ratio: 4 / 3;
  box-shadow: 0 2px 6px -2px rgba(0, 0, 0, 0.2);
  transition: box-shadow 0.15s ease;
}
.photo-thumb:hover { box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.35); }
.photo-thumb img {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
  transition: transform 0.15s ease;
}
.photo-thumb:hover img { transform: scale(1.04); }
.photo-thumb-caption {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 0.3rem 0.5rem;
  font-size: 0.72rem;
  color: #fff;
  background: linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.3) 70%, transparent 100%);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

<!-- Non-scoped: the tooltip DOM is created via document.createElement and
     therefore doesn't carry Vue's scoped data attribute, so its styles must
     be global. -->
<style>
.chart-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(33, 37, 41, 0.94);
  color: #fff;
  padding: 0.5rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  z-index: 30;
  white-space: nowrap;
  transition: opacity 0.1s ease;
  opacity: 0;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.45);
  max-width: 360px;
  left: 0;
  top: 0;
}
.chart-tooltip-title {
  margin-bottom: 0.35rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18);
}
.chart-tooltip-title-main {
  font-weight: 600;
  font-size: 0.85rem;
}
.chart-tooltip-title-sub {
  font-weight: 400;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 0.1rem;
}
.chart-tooltip-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  line-height: 1.65;
}
.chart-tooltip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
.chart-tooltip-name {
  color: rgba(255, 255, 255, 0.78);
  margin-right: 0.4rem;
}
.chart-tooltip-value {
  margin-left: auto;
  font-weight: 600;
  padding-left: 0.55rem;
}
.chart-tooltip-divider {
  margin: 0.35rem 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.22);
}
.chart-tooltip-section-secondary {
  opacity: 0.78;
  font-size: 0.95em;
}

/* Inline variant: lives in the side panel slot, in flow, sized to its column. */
.chart-tooltip-inline {
  position: static;
  transform: none;
  width: 100%;
  max-width: 100%;
  margin-top: 0.6rem;
  opacity: 1;
  white-space: normal;
  font-size: 0.72rem;
}
.chart-tooltip-hidden {
  display: none;
}

.climb-marker {
  display: inline-flex;
  align-items: center;
  gap: 0.22rem;
  background: rgba(255, 255, 255, 0.96);
  padding: 0.1rem 0.35rem 0.1rem 0.32rem;
  border-radius: 12px;
  font-size: 0.66rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  border: 1.5px solid currentColor;
  box-shadow: 0 3px 8px -3px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transform: translateY(-4px);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
  user-select: none;
  line-height: 1.4;
}
.climb-marker:hover {
  transform: translateY(-6px) scale(1.06);
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.45);
}
.climb-marker i { font-size: 0.74rem; }
.climb-marker .climb-marker-stats { color: #212529; }
.climb-marker .climb-marker-cat {
  background: currentColor;
  color: #fff !important;
  padding: 0 0.3rem;
  border-radius: 999px;
  font-size: 0.6rem;
  letter-spacing: 0.02em;
  min-width: 0.85rem;
  text-align: center;
}
.climb-marker .climb-marker-cat::first-letter { text-transform: uppercase; }
/* Force the badge's inner text to be white via a child trick — the `currentColor`
   trick above colours background; the children inherit current text colour. */
.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }

/* Inline category badge used in the Stats card's climbs table. Reuses the
   .climb-cat-* color classes above (which set `color`); the badge's outer
   span paints its background from currentColor and the inner span forces
   the foreground white for legibility. */
.climb-cat-badge {
  display: inline-flex;
  align-items: center;
  background: currentColor;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.4;
}
.climb-cat-badge > span {
  color: #fff;
}

/* Stats card sections + tables. */
.stats-section + .stats-section { border-top: 1px dashed rgba(0, 0, 0, 0.08); padding-top: 0.75rem; }
.stats-table th {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6c757d;
  font-weight: 600;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.stats-table td {
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
}
.stats-table-scroll {
  max-height: 360px;
  overflow-y: auto;
}
.stats-table-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
}

/* Hover cursor that follows the route on the map */
.route-cursor {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  border: 3px solid #fc4c02;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.75), 0 2px 8px rgba(0, 0, 0, 0.4);
  pointer-events: none; /* clicks pass through to the map */
}

/* Photo markers on the map (HTML DOM, not in style) */
.photo-marker {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2.5px solid #fff;
  background: #1f2937;
  overflow: hidden;
  box-shadow: 0 3px 8px -2px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  transform: translateY(-4px);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}
.photo-marker:hover {
  transform: translateY(-6px) scale(1.1);
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.55);
  z-index: 10;
}
.photo-marker img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.photo-marker i {
  color: #fff;
  font-size: 0.95rem;
}

/* Lightbox: Teleport'd to body so styles must be global */
.photo-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1080;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
.photo-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.6);
}
.photo-lightbox-btn {
  position: absolute;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: 0;
  border-radius: 50%;
  width: 44px;
  height: 44px;
  font-size: 1.2rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease, transform 0.12s ease;
}
.photo-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.35);
  transform: scale(1.06);
}
.photo-lightbox-close { top: 1rem; right: 1rem; }
.photo-lightbox-prev  { left: 1rem;  top: 50%; transform: translateY(-50%); }
.photo-lightbox-next  { right: 1rem; top: 50%; transform: translateY(-50%); }
.photo-lightbox-prev:hover { transform: translateY(-50%) scale(1.06); }
.photo-lightbox-next:hover { transform: translateY(-50%) scale(1.06); }
.photo-lightbox-caption {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  max-width: 70vw;
  text-align: center;
  font-size: 0.9rem;
}
</style>
