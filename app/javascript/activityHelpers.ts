// Pure helpers extracted from ActivityDetail.vue so each sub-component
// (ActivityStats, ActivityMapCard, ActivityCharts, ...) can use the same
// formatting + climb-detection + route-geometry logic without duplication.
// No Vue / no DOM / no module-level state — easy to test and tree-shake.

export interface ChartDef {
  key: string
  color: string
  unit: string
  transform: (v: number) => number
  digits: number
  // Allure (min/km) : la valeur transformée est un temps décimal en minutes, pas un
  // nombre à afficher tel quel. `format` la rend en « m:ss » ; `isPace` signale aux
  // consommateurs (stats, axe) le traitement propre à une grandeur inverse de la vitesse.
  format?: (v: number) => string
  isPace?: boolean
  // Suffixe de clé i18n `strava.stream.*` à préférer à `key` pour le libellé affiché
  // (ex. « Allure » plutôt que « Vitesse » sur une course).
  labelKey?: string
}

export interface GradeBucket {
  max: number
  color: string
}

export interface ClimbSegment {
  startIdx: number
  endIdx: number
  gain: number
  lengthM: number
  avgGrade: number
  category: string | null
}

export interface PauseSegment {
  startIdx: number // dernier échantillon avant le trou
  endIdx: number // premier échantillon après le trou
  startSec: number
  endSec: number
  durationSec: number
}

export interface GeoFeature {
  type: 'Feature'
  geometry: { type: 'LineString'; coordinates: number[][] }
  properties: { bucket: number }
}

export interface PhotoLike {
  urls?: Record<string, string>
  unique_id?: string
  id?: string | number
  caption?: string
  location?: number[]
}

// ─── Activity-type → Font Awesome icon ────────────────────────────────────
export function activityIcon(type: string | null | undefined): string {
  const t = (type || '').toLowerCase()
  if (t.includes('run')) return 'fa-person-running'
  if (t.includes('ride') || t.includes('cycl') || t.includes('bike') || t.includes('velo')) return 'fa-person-biking'
  if (t.includes('swim')) return 'fa-person-swimming'
  if (t.includes('walk') || t.includes('hike')) return 'fa-person-hiking'
  if (t.includes('ski')) return 'fa-person-skiing'
  if (t.includes('row')) return 'fa-water'
  if (t.includes('yoga') || t.includes('pilates')) return 'fa-spa'
  // Sports de raquette : à tester avant `workout`, car leur `type` Strava vaut « Workout »
  // — c'est `sport_type` qui porte « Squash », « Padel »… (cf. sportType()).
  if (t.includes('squash') || t.includes('tennis') || t.includes('padel') ||
      t.includes('racquet') || t.includes('badminton') || t.includes('pickleball')) {
    return 'fa-table-tennis-paddle-ball'
  }
  if (t.includes('workout') || t.includes('weight')) return 'fa-dumbbell'
  return 'fa-bolt'
}

// Stream key → Font Awesome icon. Used by the chart legend pills + range
// chips + chart-hover tooltip rows.
export const chartIcons: Record<string, string> = {
  altitude: 'fa-mountain',
  heartrate: 'fa-heart-pulse',
  velocity_smooth: 'fa-gauge-high',
  cadence: 'fa-rotate',
  watts: 'fa-bolt',
  temp: 'fa-temperature-half',
  grade_smooth: 'fa-slash',
}

// chartDefs order drives the default chart layout (top → bottom).
export const chartDefs: ChartDef[] = [
  { key: 'altitude',        color: '#198754', unit: 'm',    transform: (v) => v,       digits: 0 },
  { key: 'watts',           color: '#fd7e14', unit: 'W',    transform: (v) => v,       digits: 0 },
  { key: 'velocity_smooth', color: '#0d6efd', unit: 'km/h', transform: (v) => v * 3.6, digits: 1 },
  { key: 'heartrate',       color: '#dc3545', unit: 'bpm',  transform: (v) => v,       digits: 0 },
  { key: 'cadence',         color: '#6f42c1', unit: 'rpm',  transform: (v) => v,       digits: 0 },
  { key: 'temp',            color: '#20c997', unit: '°C',   transform: (v) => v,       digits: 1 },
  { key: 'grade_smooth',    color: '#6c757d', unit: '%',    transform: (v) => v,       digits: 1 },
]

// Sur une activité de course, la « vitesse » se lit en allure (min/km) plutôt qu'en km/h.
// Le flux Strava reste `velocity_smooth` (des m/s) — seul son rendu change : transform
// vers un temps par km, unité et formatage dédiés (cf. paceMinPerKm / formatPace).
const VELOCITY_PACE_DEF: ChartDef = {
  key: 'velocity_smooth',
  color: '#0d6efd',
  unit: 'min/km',
  transform: paceMinPerKm,
  digits: 2,
  format: formatPace,
  isPace: true,
  labelKey: 'pace',
}

// `activity` optionnel : sans lui, on garde les défauts (vélo → km/h). Fourni, il permet
// de basculer la vitesse en allure sur les courses. Les autres flux ne dépendent pas du sport.
export function defByKey(key: string, activity?: Record<string, unknown> | null): ChartDef | undefined {
  if (key === 'velocity_smooth' && isRun(activity)) return VELOCITY_PACE_DEF
  return chartDefs.find((d) => d.key === key)
}

// Sans GPS, Strava renvoie quand même `velocity_smooth` / `grade_smooth`, mais
// remplis de zéros de bout en bout : un flux entièrement nul (ou vide) ne porte
// aucune information et ne mérite pas de graphique.
export function streamHasData(stream: { data?: unknown } | null | undefined): boolean {
  const data = stream?.data
  if (!Array.isArray(data) || data.length === 0) return false
  return data.some((v) => typeof v === 'number' && Number.isFinite(v) && v !== 0)
}

// Le sport réel de l'activité. Sur une séance de squash, le `type` Strava vaut
// « Workout » — seul `sport_type` porte « Squash ».
export function sportType(activity: Record<string, unknown> | null | undefined): string {
  return String(activity?.sport_type || activity?.type || '')
}

// Course à pied (Run, TrailRun, VirtualRun) — tous portent « run » dans leur sport_type.
// C'est ce test qui fait basculer la vitesse en allure (min/km) partout où elle s'affiche.
export function isRun(activity: Record<string, unknown> | null | undefined): boolean {
  return sportType(activity).toLowerCase().includes('run')
}

// Catégorie d'itinéraire (Route#activity) correspondant à une activité Strava — sert à
// créer un itinéraire depuis une sortie avec le bon profil de routage dès le départ,
// plutôt que de retomber sur le dernier sport utilisé. Le VTT et le gravel partagent la
// catégorie `mtb` : ce sont les deux qui empruntent des chemins non revêtus.
export function routeSportFor(activity: Record<string, unknown> | null | undefined): 'cycling' | 'mtb' | 'hiking' {
  const t = sportType(activity).toLowerCase()
  if (t.includes('mountainbike') || t.includes('gravel') || t.includes('emountainbike')) return 'mtb'
  if (t.includes('hike') || t.includes('walk') || t.includes('run')) return 'hiking'
  return 'cycling'
}

// Sports de raquette : la cadence remontée par une montre au poignet n'y mesure rien de
// physiologique. Le jeu est fait de pas chassés, de fentes et d'arrêts, pas d'une foulée
// régulière — la montre ne détecte un rythme que par intermittence et remplit le reste
// de zéros. Le flux existe (donc `streamHasData` le laisse passer) mais n'est que du bruit.
const RACKET_SPORTS = new Set([
  'Squash',
  'Racquetball',
  'Tennis',
  'TableTennis',
  'Badminton',
  'Pickleball',
  'Padel',
])

// Un flux mérite-t-il un graphique sur CETTE activité ? Combine « contient des données »
// et les exclusions propres au sport.
export function streamIsMeaningful(
  key: string,
  stream: { data?: unknown } | null | undefined,
  activity: Record<string, unknown> | null | undefined,
): boolean {
  if (!streamHasData(stream)) return false
  if (key === 'cadence' && RACKET_SPORTS.has(sportType(activity))) return false
  return true
}

// Independent order for the stream-mean chips in the sticky header — kept
// stable regardless of how charts are ordered/merged.
export const STREAM_CHIP_ORDER: string[] = ['grade_smooth', 'watts', 'velocity_smooth', 'heartrate', 'cadence', 'temp']

// Standard cycling peak-power durations (mirrors PeakPowerCurve::DURATIONS
// on the Ruby side so server-stored values align with on-screen rows).
export const PEAK_POWER_DURATIONS: number[] = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400]

// ─── Puissance normalisée (NP) sur une tranche ───────────────────────────────
// Même formule que le serveur (TrainingLoad.normalized_power) : moyenne mobile
// 30 échantillons de la puissance, élevée à la 4, moyennée, puis racine 4e.
// Suppose un échantillonnage ~1 Hz (Strava/FIT). Sert à noter un segment
// sélectionné côté client ; la NP de l'activité entière vient du serveur.
// Renvoie null si la tranche fait moins de 30 points.
export function normalizedPower(
  watts: (number | null)[] | null | undefined,
  startIdx = 0,
  endIdx?: number,
): number | null {
  if (!Array.isArray(watts) || watts.length === 0) return null
  const end = Math.min(endIdx ?? watts.length - 1, watts.length - 1)
  const start = Math.max(0, startIdx)
  const n = end - start + 1
  if (n < 30) return null
  const window = 30
  const rolling: number[] = []
  let sum = 0
  const at = (i: number) => {
    const w = watts[i]
    return typeof w === 'number' && Number.isFinite(w) ? w : 0
  }
  for (let k = 0; k < n; k++) {
    sum += at(start + k)
    if (k >= window) sum -= at(start + k - window)
    if (k >= window - 1) rolling.push(sum / window)
  }
  if (rolling.length === 0) return null
  const mean4 = rolling.reduce((acc, r) => acc + r ** 4, 0) / rolling.length
  const np = mean4 ** 0.25
  return Number.isFinite(np) && np > 0 ? np : null
}

export interface Decoupling {
  pct: number
  basis: 'power' | 'pace'
}

// ─── Découplage aérobie (Pw:Hr / dérive cardiaque) ───────────────────────────
// Compare l'efficience (sortie / FC) de la 1re moitié vs la 2e moitié de la sortie.
// Sortie = NP quand la puissance est présente, sinon vitesse moyenne (m/s).
// pct > 0 : la FC a dérivé vers le haut relativement à la sortie (fatigue) ;
// < 5 % ≈ bonne base aérobie. On ne le calcule que pour des efforts assez longs
// (≥ minMovingSeconds) et on ignore les échantillons en pause. Renvoie null sinon.
export function aerobicDecoupling(
  streams: Record<string, { data?: unknown } | undefined> | null | undefined,
  minSeconds = 1200,
): Decoupling | null {
  const time = streams?.time?.data as number[] | undefined
  const hr = streams?.heartrate?.data as number[] | undefined
  if (!Array.isArray(time) || !Array.isArray(hr) || time.length < 4) return null

  const watts = streams?.watts?.data as (number | null)[] | undefined
  const vel = streams?.velocity_smooth?.data as (number | null)[] | undefined
  const moving = streams?.moving?.data as (boolean | null)[] | undefined
  const hasPower = Array.isArray(watts) && watts.some((w) => typeof w === 'number' && w > 0)
  const output = (hasPower ? watts : vel) as (number | null)[] | undefined
  if (!Array.isArray(output)) return null

  const n = Math.min(time.length, hr.length, output.length)
  if (n < 4) return null
  const total = time[n - 1] - time[0]
  if (!Number.isFinite(total) || total < minSeconds) return null

  // Coupe à la moitié du temps écoulé (et non de l'index) pour deux moitiés de
  // durée égale même quand l'échantillonnage n'est pas régulier.
  const mid = time[0] + total / 2
  let splitIdx = n - 1
  for (let i = 0; i < n; i++) {
    if (time[i] >= mid) { splitIdx = i; break }
  }
  if (splitIdx <= 1 || splitIdx >= n - 1) return null

  const moved = (i: number) => !(moving && moving[i] === false)

  // Efficience d'une moitié [a, b) : NP (ou vitesse moyenne) / FC moyenne, sur les
  // seuls échantillons en mouvement.
  const efHalf = (a: number, b: number): number | null => {
    let hrSum = 0
    let hrCnt = 0
    for (let i = a; i < b; i++) {
      if (!moved(i)) continue
      const h = hr[i]
      if (typeof h === 'number' && Number.isFinite(h) && h > 0) { hrSum += h; hrCnt++ }
    }
    if (hrCnt === 0) return null
    const meanHr = hrSum / hrCnt
    let out: number | null
    if (hasPower) {
      out = normalizedPower(output, a, b - 1)
    } else {
      let sSum = 0
      let sCnt = 0
      for (let i = a; i < b; i++) {
        if (!moved(i)) continue
        const s = output[i]
        if (typeof s === 'number' && Number.isFinite(s) && s >= 0.5) { sSum += s; sCnt++ }
      }
      out = sCnt > 0 ? sSum / sCnt : null
    }
    if (out == null || meanHr <= 0) return null
    return out / meanHr
  }

  const ef1 = efHalf(0, splitIdx)
  const ef2 = efHalf(splitIdx, n)
  if (ef1 == null || ef2 == null || ef1 <= 0) return null
  const pct = ((ef1 - ef2) / ef1) * 100
  if (!Number.isFinite(pct)) return null
  return { pct: Math.round(pct * 10) / 10, basis: hasPower ? 'power' : 'pace' }
}

// ─── Elevation gain/loss ──────────────────────────────────────────────────
// Compute D+/D- from a flat altitude array using a (2*halfWin+1)-point moving
// average to suppress sensor/quantisation noise before accumulating. Works for
// both FIT barometric data (floating point, baro/GPS noise) and BRouter SRTM
// integer data. Returns { gain, loss } in metres.
export function computeElevGain(alts: (number | null)[], halfWin = 2): { gain: number; loss: number } {
  const n = alts.length
  if (n < 2) return { gain: 0, loss: 0 }
  let up = 0, down = 0, prev: number | null = null
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    for (let j = Math.max(0, i - halfWin); j <= Math.min(n - 1, i + halfWin); j++) {
      if (alts[j] != null) { sum += alts[j] as number; cnt++ }
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

// ─── Pauses ───────────────────────────────────────────────────────────────
// Un arrêt se lit dans DEUX signaux, et aucun des deux ne suffit seul :
//
//   • Le capteur coupe l'enregistrement — le flux `time` devient creux et l'arrêt n'est
//     qu'un trou entre deux échantillons. Sur l'activité Strava 19313900233 (home-trainer),
//     `moving` est `true` de bout en bout et `moving_time == elapsed_time` : les trous sont
//     la seule trace des 47 min d'arrêt.
//   • Le capteur enregistre mais marque l'échantillon immobile (`moving: false`). Sur la
//     marche 18930174882, les trous ne pèsent que 28 min quand Strava en compte 108.
//
// D'où l'union : un intervalle est à l'arrêt si l'enregistrement a été coupé OU si le point
// est marqué immobile. Les intervalles consécutifs forment un seul run — ce qui fusionne au
// passage les pauses qui ne « reprennent » pas vraiment entre elles : sur 18930174882 la
// montre réenregistre parfois un unique point immobile entre deux trous, qu'on lisait à tort
// comme deux pauses distinctes.
//
// PAUSE_GAP_STEP_FACTOR rend le seuil de trou relatif à la cadence réelle (médiane) : un
// enregistrement à 5 s d'intervalle ne doit pas voir un trou à chaque point. PAUSE_GAP_MIN_S
// écarte l'inverse — sur du 1 Hz, quelques secondes manquantes relèvent du décrochage
// capteur. PAUSE_MIN_S écarte enfin les arrêts trop brefs pour valoir une bande à l'écran.
const PAUSE_GAP_MIN_S = 30
const PAUSE_GAP_STEP_FACTOR = 3
const PAUSE_MIN_S = 30

// Écart au-delà duquel deux échantillons consécutifs ne sont plus séparés par du jitter
// mais par une coupure d'enregistrement.
function samplingGapThreshold(time: (number | null)[]): number | null {
  const steps: number[] = []
  for (let i = 1; i < time.length; i++) {
    const dt = (time[i] as number) - (time[i - 1] as number)
    if (Number.isFinite(dt) && dt > 0) steps.push(dt)
  }
  if (steps.length === 0) return null
  const median = [...steps].sort((a, b) => a - b)[steps.length >> 1]
  return Math.max(PAUSE_GAP_MIN_S, median * PAUSE_GAP_STEP_FACTOR)
}

// Trous d'enregistrement : les intervalles où le capteur n'a rien écrit du tout. À ne pas
// confondre avec les pauses de `detectPauses`, qui les englobent : une pause fusionnée
// contient le plus souvent de vrais échantillons (immobiles, mais enregistrés). Seul un
// trou justifie de couper une courbe — la couper sur toute la pause creuserait un vide là
// où la donnée existe, et désordonnerait l'axe X.
export function detectRecordingGaps(time: (number | null)[] | null | undefined): PauseSegment[] {
  if (!Array.isArray(time) || time.length < 3) return []
  const threshold = samplingGapThreshold(time)
  if (threshold == null) return []
  const out: PauseSegment[] = []
  for (let i = 1; i < time.length; i++) {
    const startSec = time[i - 1] as number
    const endSec = time[i] as number
    const durationSec = endSec - startSec
    if (!Number.isFinite(durationSec) || durationSec < threshold) continue
    out.push({ startIdx: i - 1, endIdx: i, startSec, endSec, durationSec })
  }
  return out
}

export function detectPauses(
  time: (number | null)[] | null | undefined,
  moving?: (boolean | null)[] | null,
  minPauseS = PAUSE_MIN_S,
): PauseSegment[] {
  if (!Array.isArray(time) || time.length < 3) return []
  const gapThreshold = samplingGapThreshold(time)
  if (gapThreshold == null) return []
  const hasMoving = Array.isArray(moving) && moving.length >= time.length

  // L'intervalle `k` court de l'échantillon k-1 à k. Un run d'intervalles à l'arrêt
  // k = a..b couvre donc les échantillons a-1 à b.
  const out: PauseSegment[] = []
  let runStart = -1
  for (let k = 1; k <= time.length; k++) {
    const dt = k < time.length ? (time[k] as number) - (time[k - 1] as number) : NaN
    const isStopped = k < time.length
      && Number.isFinite(dt)
      && (dt >= gapThreshold || (hasMoving && moving![k] === false))
    if (isStopped) {
      if (runStart < 0) runStart = k
      continue
    }
    if (runStart < 0) continue
    const startIdx = runStart - 1
    const endIdx = k - 1
    const startSec = time[startIdx] as number
    const endSec = time[endIdx] as number
    const durationSec = endSec - startSec
    if (durationSec >= minPauseS) out.push({ startIdx, endIdx, startSec, endSec, durationSec })
    runStart = -1
  }
  return out
}

export function totalPausedSeconds(pauses: PauseSegment[]): number {
  return pauses.reduce((sum, p) => sum + p.durationSec, 0)
}

// ─── Formatting ───────────────────────────────────────────────────────────
export function fmt(v: number | null | undefined, digits: number): string {
  if (v == null || Number.isNaN(v)) return '–'
  return v.toFixed(digits)
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return '–'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h ${m}min` : (m > 0 ? `${m}min ${s}s` : `${s}s`)
}

export function formatHMS(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '–'
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export function formatKm(meters: number | null | undefined): string {
  if (meters == null || Number.isNaN(meters)) return '–'
  return `${(meters / 1000).toFixed(2)} km`
}

// Allure de course en minutes par km, à partir d'une vitesse en m/s. Sous ~0,5 m/s
// (1,8 km/h) l'échantillon est un arrêt : l'allure y diverge, on renvoie NaN pour l'exclure
// des courbes (coupure) et des stats plutôt que d'afficher une valeur aberrante.
export function paceMinPerKm(speedMps: number): number {
  if (!Number.isFinite(speedMps) || speedMps < 0.5) return NaN
  return 1000 / speedMps / 60
}

// Allure (min/km décimales) → « m:ss ». 5.5 → « 5:30 ».
export function formatPace(minPerKm: number | null | undefined): string {
  if (minPerKm == null || !Number.isFinite(minPerKm)) return '–'
  const totalSec = Math.round(minPerKm * 60)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatPowerDuration(sec: number): string {
  if (sec < 60) return `${sec} s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return m === 0 ? `${h} h` : `${h} h ${m}`
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
  ))
}

// Strava photos come with multiple sized URLs keyed by their max edge length
// (e.g. `{ "100": "...", "256": "...", "2048": "..." }`). Pick the entry that
// matches `preferred`, else the smallest one bigger, else the biggest.
export function pickPhotoUrl(photo: PhotoLike | null | undefined, preferred = 256): string | null {
  if (!photo?.urls) return null
  const entries = Object.entries(photo.urls)
    .map(([k, v]) => [Number(k), v] as [number, string])
    .filter(([k]) => !Number.isNaN(k))
    .sort((a, b) => a[0] - b[0])
  if (entries.length === 0) return null
  const exact = entries.find(([k]) => k === preferred)
  if (exact) return exact[1]
  const larger = entries.find(([k]) => k >= preferred)
  return (larger || entries[entries.length - 1])[1]
}

// ─── Polyline + downsample ────────────────────────────────────────────────
export function decodePolyline(str: string): number[][] {
  let index = 0
  let lat = 0
  let lng = 0
  const coords: number[][] = []
  while (index < str.length) {
    let b: number
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

// Indices retenus par un sous-échantillonnage, en garantissant la présence de `keep`.
// Renvoyer les INDICES plutôt que les points permet à l'appelant de rester ancré sur le
// flux d'origine — indispensable pour placer une coupure de courbe, qui se repère par
// index et non par valeur d'axe : à l'arrêt, la distance ne bouge pas et une dizaine
// d'échantillons partagent le même x, si bien qu'un `x >= x1` tombe au début du plateau
// immobile au lieu du bord du trou.
//
// `keep` sert aux bords des trous d'enregistrement : `downsample` prend un point tous les
// n et peut jeter les deux, auquel cas la coupure s'élargit jusqu'aux points survivants —
// sur l'activité 18930174882, un trou réel de 0,1 m se voyait sur 38 m à l'écran.
export function downsampleIndices(count: number, maxPoints: number, keep: Iterable<number> = []): number[] {
  if (count <= 0) return []
  if (count <= maxPoints) return Array.from({ length: count }, (_, i) => i)
  const idx = new Set<number>()
  const step = count / maxPoints
  for (let i = 0; i < maxPoints; i++) idx.add(Math.floor(i * step))
  for (const k of keep) if (Number.isInteger(k) && k >= 0 && k < count) idx.add(k)
  return [...idx].sort((a, b) => a - b)
}

// ─── Grade buckets (route colouring) + climb detection ────────────────────
export const GRADE_BUCKETS: GradeBucket[] = [
  { max: -8,       color: '#1e3a8a' }, // very steep descent
  { max: -3,       color: '#3b82f6' }, // descent
  { max:  3,       color: '#22c55e' }, // flat / rolling
  { max:  6,       color: '#eab308' }, // easy climb
  { max: 10,       color: '#f97316' }, // medium climb
  { max: 15,       color: '#dc2626' }, // hard climb
  { max: Infinity, color: '#7f1d1d' }, // very hard climb
]

export function bucketGrade(g: number): number {
  for (let i = 0; i < GRADE_BUCKETS.length; i++) {
    if (g < GRADE_BUCKETS[i].max) return i
  }
  return GRADE_BUCKETS.length - 1
}

export function gradeForIndex(
  i: number,
  grades: number[] | null | undefined,
  altitudes: number[] | null | undefined,
  distances: number[] | null | undefined,
): number {
  if (grades && grades[i] != null && !Number.isNaN(grades[i])) return grades[i]
  if (!altitudes || !distances || i + 1 >= altitudes.length || i + 1 >= distances.length) return 0
  const da = altitudes[i + 1] - altitudes[i]
  const dd = distances[i + 1] - distances[i]
  return dd > 0 ? (da / dd) * 100 : 0
}

export function buildGradedSegments(
  coords: number[][],
  grades: number[] | null | undefined,
  altitudes: number[] | null | undefined,
  distances: number[] | null | undefined,
): GeoFeature[] {
  if (!coords || coords.length < 2) return []
  const features: GeoFeature[] = []
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

export function climbCategory(lengthKm: number, avgGrade: number): string | null {
  const score = lengthKm * Math.pow(Math.max(0, avgGrade), 2)
  if (score >= 400) return 'HC'
  if (score >= 200) return '1'
  if (score >= 100) return '2'
  if (score >= 60) return '3'
  if (score >= 25) return '4'
  return null
}

// ─── Moyenne d'un flux sur une tranche ───────────────────────────────────────
// Moyenne des échantillons `> gt` et finis sur [start, end]. `gt` filtre les
// arrêts : FC/cadence à 0 = capteur au repos (gt = 0), puissance à 0 = roue libre
// à conserver (gt = -Infinity). Renvoie null si aucun échantillon retenu.
function meanRange(
  data: (number | null)[] | null | undefined,
  start: number,
  end: number,
  gt = -Infinity,
): number | null {
  if (!Array.isArray(data)) return null
  const e = Math.min(end, data.length - 1)
  let sum = 0
  let cnt = 0
  for (let i = Math.max(0, start); i <= e; i++) {
    const v = data[i]
    if (typeof v === 'number' && Number.isFinite(v) && v > gt) { sum += v; cnt++ }
  }
  return cnt > 0 ? sum / cnt : null
}

// ─── Allure ajustée à la pente (Grade Adjusted Pace) ─────────────────────────
// Le coût métabolique de la course dépend de la pente : monter coûte plus cher, si
// bien qu'une allure « facile » en côte équivaut à une allure plus rapide sur le plat.
// On convertit chaque tronçon en distance « plat équivalente » via le coût
// énergétique de Minetti et al. (2002) — C(i) en J/(kg·m), i = pente en fraction
// (dénivelé/horizontale) — puis GAP = temps ÷ distance plat équivalente.
const RUN_FLAT_COST = 3.6 // C(0), coût sur le plat

// Facteur de coût relatif au plat pour une pente donnée (fraction). Borné à ±45 %
// (au-delà on marche, le modèle de course ne s'applique plus).
export function runCostFactor(gradeFraction: number): number {
  const i = Math.max(-0.45, Math.min(0.45, gradeFraction))
  const c = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6
  return c > 0 ? c / RUN_FLAT_COST : 0.1
}

// Allure ajustée à la pente (min/km décimales) sur [startIdx, endIdx], ou null si
// la géométrie manque. Ne dépend pas du sport — l'appelant réserve son usage à la course.
export function gradeAdjustedPace(
  streams: Record<string, { data?: unknown } | undefined> | null | undefined,
  startIdx = 0,
  endIdx?: number,
): number | null {
  const dist = streams?.distance?.data as number[] | undefined
  const alt = streams?.altitude?.data as number[] | undefined
  const time = streams?.time?.data as number[] | undefined
  if (!Array.isArray(dist) || !Array.isArray(alt) || !Array.isArray(time)) return null
  const s = Math.max(0, startIdx)
  const e = Math.min(endIdx ?? dist.length - 1, dist.length - 1, alt.length - 1, time.length - 1)
  if (e - s < 1) return null
  let flatEquiv = 0
  for (let i = s + 1; i <= e; i++) {
    const dd = dist[i] - dist[i - 1]
    if (!(dd > 0)) continue
    const da = (typeof alt[i] === 'number' && typeof alt[i - 1] === 'number') ? alt[i] - alt[i - 1] : 0
    flatEquiv += dd * runCostFactor(da / dd)
  }
  const duration = time[e] - time[s]
  if (!(flatEquiv > 0) || !(duration > 0)) return null
  const p = paceMinPerKm(flatEquiv / duration)
  return Number.isFinite(p) ? p : null
}

// ─── Facteur d'efficience (Efficiency Factor) ────────────────────────────────
// Rendement aérobie = production ÷ FC moyenne. Avec puissance : NP ÷ FC (vélo).
// Sinon, à partir de la vitesse : m/min ÷ FC (course/marche). Monte quand la forme
// s'améliore (plus de sortie pour la même FC). Complète le découplage (qui, lui,
// mesure la dérive intra-séance). Renvoie null sans FC exploitable.
export interface Efficiency { value: number; basis: 'power' | 'pace' }

export function efficiencyFactor(
  streams: Record<string, { data?: unknown } | undefined> | null | undefined,
  startIdx = 0,
  endIdx?: number,
): Efficiency | null {
  const hr = streams?.heartrate?.data as number[] | undefined
  if (!Array.isArray(hr)) return null
  const s = Math.max(0, startIdx)
  const e = Math.min(endIdx ?? hr.length - 1, hr.length - 1)
  const meanHr = meanRange(hr, s, e, 0)
  if (meanHr == null || meanHr <= 0) return null

  const watts = streams?.watts?.data as (number | null)[] | undefined
  const hasPower = Array.isArray(watts)
    && watts.slice(s, e + 1).some((w) => typeof w === 'number' && w > 0)
  if (hasPower) {
    const np = normalizedPower(watts, s, e)
    if (np == null) return null
    return { value: np / meanHr, basis: 'power' }
  }

  const dist = streams?.distance?.data as number[] | undefined
  const time = streams?.time?.data as number[] | undefined
  if (Array.isArray(dist) && Array.isArray(time)) {
    const dd = dist[Math.min(e, dist.length - 1)] - dist[s]
    const dt = time[Math.min(e, time.length - 1)] - time[s]
    if (dd > 0 && dt > 0) return { value: (dd / dt * 60) / meanHr, basis: 'pace' }
  }
  return null
}

// ─── Stats d'une tranche [startIdx, endIdx] ──────────────────────────────────
// Récapitulatif complet d'un segment : durée/distance, allure ou vitesse, FC,
// puissance (+ NP), cadence, D+/D-, VAM, pente nette, GAP et EF. Sert à l'analyseur
// de segment sélectionné ET à chaque ligne de la table des splits.
export interface SegmentStats {
  startIdx: number
  endIdx: number
  isRun: boolean
  duration: number | null   // s (temps écoulé de la tranche)
  distance: number | null   // m
  avgSpeed: number | null   // m/s
  pace: number | null       // min/km décimales (course)
  gap: number | null        // min/km ajustée pente (course)
  gain: number
  loss: number
  vam: number | null        // m/h
  avgGrade: number | null   // % (net)
  avgHr: number | null
  avgPower: number | null
  np: number | null
  avgCadence: number | null
  ef: number | null
  efBasis: 'power' | 'pace' | null
}

export function segmentStats(
  streams: Record<string, { data?: unknown } | undefined> | null | undefined,
  activity: Record<string, unknown> | null | undefined,
  startIdx: number,
  endIdx: number,
): SegmentStats {
  const time = streams?.time?.data as number[] | undefined
  const dist = streams?.distance?.data as number[] | undefined
  const alt = streams?.altitude?.data as (number | null)[] | undefined
  const refLen = time?.length || dist?.length || alt?.length || 0
  const s = Math.max(0, Math.min(startIdx, endIdx))
  const e = Math.min(Math.max(startIdx, endIdx), Math.max(0, refLen - 1))
  const run = isRun(activity)

  const duration = (Array.isArray(time) && Number.isFinite(time[e]) && Number.isFinite(time[s]))
    ? Math.max(0, time[e] - time[s]) : null
  const distance = (Array.isArray(dist) && Number.isFinite(dist[e]) && Number.isFinite(dist[s]))
    ? Math.max(0, dist[e] - dist[s]) : null
  const avgSpeed = (distance != null && duration != null && duration > 0) ? distance / duration : null
  const pace = (run && avgSpeed != null && avgSpeed >= 0.5) ? paceMinPerKm(avgSpeed) : null

  let gain = 0
  let loss = 0
  let avgGrade: number | null = null
  let vam: number | null = null
  if (Array.isArray(alt) && alt.length > e) {
    const g = computeElevGain(alt.slice(s, e + 1))
    gain = g.gain
    loss = g.loss
    const a0 = alt[s]
    const a1 = alt[e]
    if (distance != null && distance > 0 && typeof a0 === 'number' && typeof a1 === 'number') {
      avgGrade = ((a1 - a0) / distance) * 100
    }
    if (duration != null && duration > 0 && gain > 0) vam = (gain / duration) * 3600
  }

  const ef = efficiencyFactor(streams, s, e)
  return {
    startIdx: s,
    endIdx: e,
    isRun: run,
    duration,
    distance,
    avgSpeed,
    pace,
    gap: run ? gradeAdjustedPace(streams, s, e) : null,
    gain,
    loss,
    vam,
    avgGrade,
    avgHr: meanRange(streams?.heartrate?.data as (number | null)[], s, e, 0),
    avgPower: meanRange(streams?.watts?.data as (number | null)[], s, e),
    np: normalizedPower(streams?.watts?.data as (number | null)[], s, e),
    avgCadence: meanRange(streams?.cadence?.data as (number | null)[], s, e, 0),
    ef: ef?.value ?? null,
    efBasis: ef?.basis ?? null,
  }
}

// ─── Splits automatiques (par km, ou par mile via splitMeters) ───────────────
// Découpe l'activité en tranches de `splitMeters` sur le flux `distance` et
// calcule les stats de chacune. La dernière tranche (< splitMeters) est marquée
// `partial`. Universel : marche pour Strava comme pour les .fit importés — la
// seule dépendance est le flux `distance`, toujours présent sur une sortie GPS.
export interface SplitRow extends SegmentStats {
  index: number
  partial: boolean
}

export function computeSplits(
  streams: Record<string, { data?: unknown } | undefined> | null | undefined,
  activity: Record<string, unknown> | null | undefined,
  splitMeters = 1000,
): SplitRow[] {
  const dist = streams?.distance?.data as number[] | undefined
  if (!Array.isArray(dist) || dist.length < 2) return []
  const n = dist.length
  const total = dist[n - 1]
  if (!(total > splitMeters)) return [] // sortie plus courte qu'un split : rien à découper

  const ranges: { start: number; end: number; partial: boolean }[] = []
  let start = 0
  let threshold = splitMeters
  for (let i = 1; i < n; i++) {
    if (dist[i] >= threshold && i > start) {
      ranges.push({ start, end: i, partial: false })
      start = i
      threshold += splitMeters
    }
  }
  if (start < n - 1) ranges.push({ start, end: n - 1, partial: true })

  return ranges.map((r, i) => ({
    ...segmentStats(streams, activity, r.start, r.end),
    index: i + 1,
    partial: r.partial,
  }))
}

// ─── Tours (laps) enregistrés par l'appareil ─────────────────────────────────
// Contrairement aux splits (recalculés par nous tous les km), les tours viennent
// du fichier d'origine : bouton « lap » pressé par l'athlète ou auto-lap du
// compteur. Source unique côté front pour les deux origines :
//   • Strava — le détail `/activities/:id` porte `laps[]` avec `start_index` /
//     `end_index`, déjà exprimés en indices de flux : rien à convertir.
//   • .fit importés — `ImportFitActivity.vue` écrit la même forme au moment de
//     l'upload (indices calculés depuis les timestamps des `records`).
export interface LapRow extends SegmentStats {
  index: number
  name: string | null
  auto: boolean // déclenché par le compteur (distance/temps) plutôt qu'à la main
}

// Nom d'un tour, sauf quand c'est le libellé générique du fournisseur (« Lap 3 »,
// « Tour 3 ») : la colonne « Nom » ne redirait alors que le numéro déjà affiché.
function lapName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || /^(lap|tour)\s*\d+$/i.test(name)) return null
  return name
}

// Premier indice du flux `time` (secondes écoulées, croissant) atteignant `sec`.
function indexAtSecond(time: number[], sec: number): number {
  let lo = 0
  let hi = time.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (time[mid] < sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Bornes des tours en indices de flux. Deux sources, dans cet ordre :
//   1. les dates absolues (`start_date` du tour vs de l'activité), chaque tour
//      s'arrêtant là où commence le suivant ;
//   2. à défaut, les `start_index` / `end_index` fournis.
// L'ordre n'est pas un caprice : Strava livre régulièrement des index faux (un
// premier tour `0..0`, un second qui repart de `0` et chevauche le premier), alors
// que les dates, elles, sont cohérentes. Les .fit importés n'ont pas de dates ici
// (`ImportFitActivity.vue` a déjà converti en indices) et passent donc par (2).
function lapRanges(raw: unknown[], activity: Record<string, unknown> | null | undefined, time: number[] | undefined) {
  const n = time?.length ?? 0
  const actStart = Date.parse(String((activity as any)?.start_date ?? ''))
  if (time && n >= 2 && Number.isFinite(actStart)) {
    const starts = raw.map((l) => {
      const ms = Date.parse(String((l as any)?.start_date ?? ''))
      return Number.isFinite(ms) ? (ms - actStart) / 1000 : null
    })
    const usable = starts.every((s) => s != null)
      && starts.every((s, i) => i === 0 || (s as number) > (starts[i - 1] as number))
    if (usable) {
      return starts.map((s, i) => ({
        start: indexAtSecond(time, s as number),
        end: i === starts.length - 1 ? n - 1 : indexAtSecond(time, starts[i + 1] as number),
      }))
    }
  }
  return raw.map((l) => ({ start: Number((l as any)?.start_index), end: Number((l as any)?.end_index) }))
}

// Un tour est ignoré si ses bornes ne pointent nulle part dans les flux (activité
// dont les streams ont été tronqués, ou lap vide d'un compteur resté en pause).
export function computeLaps(
  streams: Record<string, { data?: unknown } | undefined> | null | undefined,
  activity: Record<string, unknown> | null | undefined,
  laps?: unknown,
): LapRow[] {
  const raw = Array.isArray(laps) ? laps : (activity as any)?.laps
  if (!Array.isArray(raw) || raw.length === 0) return []
  const time = streams?.time?.data as number[] | undefined
  const dist = streams?.distance?.data as number[] | undefined
  const n = time?.length || dist?.length || 0
  if (n < 2) return []

  const ranges = lapRanges(raw, activity, time)
  const rows: LapRow[] = []
  raw.forEach((l, i) => {
    if (!l || typeof l !== 'object') return
    const lap = l as Record<string, unknown>
    const { start: s, end: e } = ranges[i]
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || s >= n) return
    const trigger = String(lap.lap_trigger ?? '').toLowerCase()
    rows.push({
      ...segmentStats(streams, activity, s, Math.min(e, n - 1)),
      index: rows.length + 1,
      name: lapName(lap.name),
      auto: trigger !== '' && trigger !== 'manual',
    })
  })
  // Un seul tour = l'activité entière : la table n'apprendrait rien de plus que
  // le bandeau de stats global.
  return rows.length > 1 ? rows : []
}

export function detectClimbs(
  grades: number[] | null | undefined,
  altitudes: number[] | null | undefined,
  distances: number[] | null | undefined,
): ClimbSegment[] {
  if (!altitudes || !distances || altitudes.length === 0 || distances.length === 0) return []
  const MIN_GRADE = 2
  const MIN_GAIN_M = 60
  const MIN_LENGTH_M = 500
  const MERGE_GAP_M = 250
  const len = Math.min(altitudes.length, distances.length, grades?.length ?? altitudes.length)
  const raw: { startIdx: number; endIdx: number }[] = []
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
      const gain = altitudes![r.endIdx] - altitudes![r.startIdx]
      const lengthM = distances![r.endIdx] - distances![r.startIdx]
      const avgGrade = lengthM > 0 ? (gain / lengthM) * 100 : 0
      return { ...r, gain, lengthM, avgGrade, category: climbCategory(lengthM / 1000, avgGrade) }
    })
    .filter((c) => c.gain >= MIN_GAIN_M && c.lengthM >= MIN_LENGTH_M && c.avgGrade >= MIN_GRADE)
}
