<script setup lang="ts">
// Comparaison de deux sorties qui suivent le même chemin. Le serveur
// (`ActivityComparison`) aligne les tracés sur leur portion commune et renvoie les séries
// déjà rééchantillonnées sur la distance de A : ce composant ne fait que les dessiner.
//
// A est la référence. L'écart de temps vaut « temps de B − temps de A » au même point du
// chemin : au-dessus de zéro, B est en retard.
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { t } from '../i18n'
import { formatChrono, formatPace, paceMinPerKm, isRun, formatKm, formatHMS, chartDefs } from '../activityHelpers'
import { mapStyleFor } from '../mapStyles'
import { ActivityMapState } from '../pageState'
import { weatherLabel, windCardinal, type Weather } from '../weatherHelpers'
import MapStyleDropdown from './MapStyleDropdown.vue'

interface Side {
  source: string; id: string; name: string; type: string | null; started_at: string | null
  distance_m: number | null; moving_time_s: number | null; elapsed_time_s: number | null
  elevation_gain_m: number | null; average_speed: number | null; average_heartrate: number | null
  average_watts: number | null; average_cadence: number | null; normalized_power: number | null; ftp: number | null; weight_kg: number | null
  device: string | null; gear: string | null; start_latlng: [number, number] | null
  max_heartrate: number | null; max_watts: number | null; max_cadence: number | null
}
interface Stats {
  duration_s: number; average_speed: number | null; elevation_gain_m: number | null
  average_heartrate: number | null; average_watts: number | null; average_cadence: number | null
  max_heartrate: number | null; max_watts: number | null; max_cadence: number | null
}
interface CommonSide {
  time_s: number[]
  altitude: (number | null)[] | null; speed: (number | null)[] | null
  heartrate: (number | null)[] | null; power: (number | null)[] | null
  cadence: (number | null)[] | null; stats: Stats
}
interface Stretch { index: number; distance_m: number; a_from_m: number; b_from_m: number }
interface Comparison {
  stretches: Stretch[]; stretch: number
  a: Side; b: Side; a_full_track: [number, number][]; b_full_track: [number, number][]
  common: null | {
    distance_m: number; distance_b_m: number; x: number[]; delta_s: (number | null)[]
    a: CommonSide; b: CommonSide; a_track: [number, number][]; b_track: [number, number][]
  }
}

const props = defineProps({
  a: { type: String, required: true }, // "strava:123" | "imported:45"
  b: { type: String, required: true },
})

// A et B gardent deux teintes fixes ; chaque courbe reprend en plus la couleur de son canal
// (celle de l'analyse de base) sur ses graduations, pour qu'on lise les deux pages pareil.
const COLOR_A = '#0d6efd'
const COLOR_B = '#fc4c02'
const CHANNEL_DEF: Record<string, (typeof chartDefs)[number] | undefined> = {
  altitude: chartDefs.find((d) => d.key === 'altitude'),
  speed: chartDefs.find((d) => d.key === 'velocity_smooth'),
  heartrate: chartDefs.find((d) => d.key === 'heartrate'),
  power: chartDefs.find((d) => d.key === 'watts'),
  power_wkg: chartDefs.find((d) => d.key === 'watts'),
  cadence: chartDefs.find((d) => d.key === 'cadence'),
}
const CHANNEL_ICON: Record<string, string> = {
  altitude: 'fa-mountain', speed: 'fa-gauge-high', heartrate: 'fa-heart-pulse', power: 'fa-bolt', power_wkg: 'fa-weight-scale', cadence: 'fa-rotate',
}

// Fond de carte : même réglage mémorisé que la carte d'une activité.
const mapState = reactive(new ActivityMapState())
mapState.load()
function setMapStyle(id: string) {
  if (id === mapState.mapStyleId) return
  mapState.mapStyleId = id
  mapState.save()
  if (!mapInstance) return
  // `diff: false` : repart d'un style vierge, les couches sont reposées ensuite.
  mapInstance.setStyle(mapStyleFor(id), { diff: false })
  if (data.value) mapInstance.once('style.load', () => { addTrackLayers(data.value!); applyMapScope(false) })
}

// Axe X des graphiques : distance du tronçon commun, ou temps écoulé depuis son début.
// En mode temps, chaque sortie suit SON propre chrono — c'est ce qui montre qui est où à
// la minute N (les deux courbes se décalent là où l'une est plus lente).
type XAxis = 'distance' | 'time'
const XAXIS_KEY = 'sportsScope.compareXAxis'
function loadXAxis(): XAxis {
  try { return localStorage.getItem(XAXIS_KEY) === 'time' ? 'time' : 'distance' } catch { return 'distance' }
}
const xAxis = ref<XAxis>(loadXAxis())
function setXAxis(v: XAxis) {
  if (xAxis.value === v) return
  xAxis.value = v
  try { localStorage.setItem(XAXIS_KEY, v) } catch { /* stockage indisponible : sans conséquence */ }
  destroyCharts()
  renderCharts()
}

// Étendue de la carte : le tronçon commun (aligné avec les graphiques) ou les deux sorties
// en entier. Sans tronçon commun, il n'y a que les sorties entières à montrer.
type MapScope = 'common' | 'full'
const mapScope = ref<MapScope>('common')
function setMapScope(v: MapScope) {
  if (mapScope.value === v) return
  mapScope.value = v
  applyMapScope(true)
}

// Tronçon commun comparé : 0 = le plus long. Quand les deux sorties partagent plusieurs
// chemins (pas au même moment de la sortie), on choisit lequel regarder.
const stretch = ref(0)
function pickStretch(i: number) {
  if (i === stretch.value) return
  stretch.value = i
  load(true)
}
function kmText(m: number): string { return `${(m / 1000).toFixed(1)} km` }

const refA = ref(props.a)
const refB = ref(props.b)
const loading = ref(true)
const error = ref(false)
const data = ref<Comparison | null>(null)

const run = computed(() => !!data.value && isRun({ type: data.value.a.type, sport_type: data.value.a.type }))
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || undefined

function dateOf(s: Side): string {
  return s.started_at ? new Date(s.started_at).toLocaleDateString(lang, { day: '2-digit', month: 'short', year: 'numeric' }) : ''
}
// Infobulle d'un repère A / B : nom de la sortie et date.
function sideTitle(s: Side | undefined): string {
  return s ? [s.name, dateOf(s)].filter(Boolean).join(' — ') : ''
}
// Libellé court d'une sortie dans les phrases (« A », « B ») — le nom complet est dans l'en-tête.
const labelA = 'A'
const labelB = 'B'

async function load(keepPage = false) {
  if (!keepPage) loading.value = true
  error.value = false
  destroyAll()
  selection.value = null
  try {
    const res = await fetch(`/api/activity_comparison?a=${encodeURIComponent(refA.value)}&b=${encodeURIComponent(refB.value)}&stretch=${stretch.value}`,
      { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(String(res.status))
    data.value = await res.json()
  } catch {
    error.value = true
    data.value = null
  } finally {
    loading.value = false
  }
  if (data.value) {
    mapScope.value = data.value.common ? 'common' : 'full'
    loadWeather()
    await nextTick()
    if (data.value.common) renderCharts()
    renderMap()
  }
}

function swap() {
  [refA.value, refB.value] = [refB.value, refA.value]
  stretch.value = 0
  const url = new URL(window.location.href)
  url.searchParams.set('a', refA.value)
  url.searchParams.set('b', refB.value)
  window.history.replaceState(null, '', url)
  // Recharge sans démonter la page (`keepPage`) : le spinner pleine page ferait tomber la
  // hauteur du document et renverrait en haut. On restitue aussi le défilement par sécurité,
  // la hauteur pouvant varier un instant (graphiques recréés).
  const y = window.scrollY
  load(true).then(() => nextTick(() => window.scrollTo({ top: y })))
}

// ── Écart final ────────────────────────────────────────────────────────────
const finalGap = computed(() => {
  const d = data.value?.common?.delta_s
  if (!d) return null
  const sel = selection.value
  if (sel) {
    // Sur une sélection : écart gagné ou perdu entre ses deux bornes.
    const lo = d[sel.from], hi = d[sel.to]
    return lo != null && hi != null ? hi - lo : null
  }
  for (let i = d.length - 1; i >= 0; i--) if (d[i] != null) return d[i] as number
  return null
})
const finalGapText = computed(() => {
  const g = finalGap.value
  if (g == null) return ''
  if (Math.abs(g) < 1) return t('compare.final_gap_equal')
  const key = g > 0 ? 'compare.final_gap_slower' : 'compare.final_gap_faster'
  return t(key, { a: labelA, b: labelB, time: formatChrono(Math.abs(g)) })
})

const finalGapStyle = computed(() => {
  const g = finalGap.value
  if (g == null || Math.abs(g) < 1) return undefined
  const c = g > 0 ? BAD : GOOD
  return { background: `${c}1f`, color: c }
})

// ── Tableau de chiffres ────────────────────────────────────────────────────
// `better` : sens dans lequel B fait mieux que A (null = écart neutre, ni bon ni mauvais :
// distance, dénivelé, puissance, cadence — plus n'est pas mieux).
interface Row { label: string; a: string; b: string; diff: string; better?: 'lower' | 'higher' | null; delta?: number | null }
const GOOD = '#198754'
const BAD = '#dc3545'
function diffColor(r: Row): string | undefined {
  if (!r.diff || !r.better || r.delta == null || r.delta === 0) return undefined
  return (r.better === 'lower') === (r.delta < 0) ? GOOD : BAD
}

function speedText(mps: number | null | undefined): string {
  if (!mps) return '–'
  return run.value ? `${formatPace(paceMinPerKm(mps))} /km` : `${(mps * 3.6).toFixed(1)} km/h`
}
function diffNum(a: number | null | undefined, b: number | null | undefined, digits = 0, unit = ''): string {
  if (a == null || b == null) return ''
  const d = b - a
  if (Math.abs(d) < 0.5 * 10 ** -digits) return ''
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}${unit}`
}
function diffTime(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return ''
  const d = b - a
  if (Math.abs(d) < 1) return ''
  return `${d > 0 ? '+' : '−'}${formatChrono(Math.abs(d))}`
}
function diffSpeed(a: number | null | undefined, b: number | null | undefined): string {
  if (!a || !b) return ''
  if (run.value) {
    const d = paceMinPerKm(b) - paceMinPerKm(a)
    return Math.abs(d) < 1 / 120 ? '' : `${d > 0 ? '+' : '−'}${formatPace(Math.abs(d))}`
  }
  return diffNum(a * 3.6, b * 3.6, 1)
}
function num(v: number | null | undefined, digits = 0, unit = ''): string {
  return v == null ? '–' : `${v.toFixed(digits)}${unit}`
}

// Watts par kilo, avec le poids connu à la date de chaque sortie (pesées des préférences athlète).
function wkg(watts: number | null | undefined, weight: number | null | undefined): number | null {
  return watts != null && weight && weight > 0 ? watts / weight : null
}
function wkgRow(label: string, wa: number | null | undefined, wb: number | null | undefined, weightA: number | null | undefined, weightB: number | null | undefined): Row {
  const x = wkg(wa, weightA), y = wkg(wb, weightB)
  return { label, a: num(x, 2, ' W/kg'), b: num(y, 2, ' W/kg'), diff: diffNum(x, y, 2, ' W/kg'), better: 'higher', delta: (y ?? 0) - (x ?? 0) }
}

// ── Météo au départ de chaque sortie (best-effort, même proxy que le détail d'activité).
const weatherA = ref<Weather | null>(null)
const weatherB = ref<Weather | null>(null)
async function fetchWeatherFor(side: Side): Promise<Weather | null> {
  const ll = side.start_latlng
  if (!Array.isArray(ll) || ll.length !== 2 || !side.started_at) return null
  const [lat, lng] = ll
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null
  try {
    const res = await fetch(`/api/weather?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&at=${encodeURIComponent(side.started_at)}`,
      { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (res.status === 204 || !res.ok) return null
    return (await res.json()).weather || null
  } catch {
    return null
  }
}
function loadWeather() {
  weatherA.value = weatherB.value = null
  const d = data.value
  if (!d) return
  fetchWeatherFor(d.a).then((w) => { if (data.value === d) weatherA.value = w })
  fetchWeatherFor(d.b).then((w) => { if (data.value === d) weatherB.value = w })
}
function windText(w: Weather | null): string {
  if (!w || w.wind_speed == null) return '–'
  const dir = windCardinal(w.wind_direction)
  return `${Math.round(w.wind_speed)} km/h${dir ? ` ${dir}` : ''}`
}
const weatherRows = computed(() => {
  const a = weatherA.value, b = weatherB.value
  if (!a && !b) return []
  const temp = (w: Weather | null) => (w?.temperature != null ? `${w.temperature.toFixed(1)} °C` : '–')
  return [
    { label: t('compare.weather'), a: a ? weatherLabel(a.weather_code) || '–' : '–', b: b ? weatherLabel(b.weather_code) || '–' : '–', diff: '' },
    { label: t('compare.temperature'), a: temp(a), b: temp(b), diff: diffNum(a?.temperature, b?.temperature, 1, ' °C') },
    { label: t('compare.wind'), a: windText(a), b: windText(b), diff: diffNum(a?.wind_speed, b?.wind_speed, 0, ' km/h') },
  ].filter((r) => r.a !== '–' || r.b !== '–')
})

// ── Dates : les deux sorties et l'écart entre elles, dit à la main (« 3 semaines plus tard »).
function fullDate(side: Side): string {
  return side.started_at
    ? new Date(side.started_at).toLocaleString(lang, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '–'
}
function humanSpan(days: number): string {
  const fmt = (n: number, unit: string) =>
    new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'long' }).format(n)
  if (days < 14) return fmt(Math.max(1, Math.round(days)), 'day')
  if (days < 60) return fmt(Math.round(days / 7), 'week')
  if (days < 730) return fmt(Math.round(days / 30.44), 'month')
  return fmt(Math.round(days / 365.25), 'year')
}
const dateRow = computed(() => {
  const d = data.value
  if (!d) return null
  const ta = d.a.started_at ? Date.parse(d.a.started_at) : NaN
  const tb = d.b.started_at ? Date.parse(d.b.started_at) : NaN
  let gap = ''
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    const days = Math.abs(tb - ta) / 86_400_000
    if (days < 1) gap = t('compare.date_same_day')
    else gap = t(tb > ta ? 'compare.date_later' : 'compare.date_earlier', { span: humanSpan(days) })
  }
  return { label: t('compare.date'), a: fullDate(d.a), b: fullDate(d.b), gap }
})

// Maxima (FC, puissance, cadence) : mêmes champs sur la portion commune et la sortie
// entière. Écart neutre — un pic plus haut n'est ni mieux ni moins bien.
function maxRows(a: { max_heartrate: number | null; max_watts: number | null; max_cadence: number | null },
                 b: { max_heartrate: number | null; max_watts: number | null; max_cadence: number | null }): Row[] {
  return [
    { label: t('compare.stat.max_power'), a: num(a.max_watts, 0, ' W'), b: num(b.max_watts, 0, ' W'), diff: diffNum(a.max_watts, b.max_watts, 0, ' W'), better: 'higher', delta: (b.max_watts ?? 0) - (a.max_watts ?? 0) },
    { label: t('compare.stat.max_heartrate'), a: num(a.max_heartrate, 0, ' bpm'), b: num(b.max_heartrate, 0, ' bpm'), diff: diffNum(a.max_heartrate, b.max_heartrate, 0), better: 'lower', delta: (b.max_heartrate ?? 0) - (a.max_heartrate ?? 0) },
    { label: t('compare.stat.max_cadence'), a: num(a.max_cadence, 0), b: num(b.max_cadence, 0), diff: diffNum(a.max_cadence, b.max_cadence, 0), better: 'higher', delta: (b.max_cadence ?? 0) - (a.max_cadence ?? 0) },
  ]
}

// ── Sélection d'une portion du tronçon (glisser sur un graphique) ──────────
// Bornes = indices dans les séries rééchantillonnées (`common.x`). Les chiffres de la
// portion sont recalculés ici à partir de ces mêmes séries.
const selection = ref<{ from: number; to: number } | null>(null)

function sliceStats(side: CommonSide, from: number, to: number, distance: number): Stats {
  const nums = (v: (number | null)[] | null) => (v ?? []).slice(from, to + 1).filter((x): x is number => typeof x === 'number')
  const mean = (v: number[]) => (v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null)
  const peak = (v: number[]) => (v.length ? Math.round(Math.max(...v)) : null)
  const duration = (side.time_s[to] ?? 0) - (side.time_s[from] ?? 0)
  let gain: number | null = null
  const alts = nums(side.altitude)
  if (alts.length) {
    gain = 0
    let ref: number | null = null
    for (const v of alts) {
      if (ref == null) { ref = v; continue }
      if (v - ref >= 1) { gain += v - ref; ref = v } else if (v - ref <= -1) ref = v
    }
    gain = Math.round(gain)
  }
  const hr = nums(side.heartrate), pw = nums(side.power), cd = nums(side.cadence)
  return {
    duration_s: Math.round(duration), average_speed: duration > 0 ? distance / duration : null, elevation_gain_m: gain,
    average_heartrate: mean(hr), average_watts: mean(pw), average_cadence: mean(cd),
    max_heartrate: peak(hr), max_watts: peak(pw), max_cadence: peak(cd),
  }
}

const commonView = computed(() => {
  const c = data.value!.common!
  const sel = selection.value
  if (!sel) return { a: c.a.stats, b: c.b.stats, distA: c.distance_m, distB: c.distance_b_m }
  const distA = c.x[sel.to] - c.x[sel.from]
  const distB = c.distance_m > 0 ? (distA / c.distance_m) * c.distance_b_m : 0
  return { a: sliceStats(c.a, sel.from, sel.to, distA), b: sliceStats(c.b, sel.from, sel.to, distB), distA, distB }
})
const commonTitle = computed(() => {
  const sel = selection.value
  return sel ? t('compare.stats_selection', { km: (commonView.value.distA / 1000).toFixed(2) }) : t('compare.stats_common')
})

const commonRows = computed<Row[]>(() => {
  const c = data.value?.common
  if (!c) return []
  const a = commonView.value.a, b = commonView.value.b
  const distA = commonView.value.distA, distB = commonView.value.distB
  const sa = data.value!.a, sb = data.value!.b
  return [
    { label: t('compare.stat.distance'), a: formatKm(distA), b: formatKm(distB), diff: diffNum(distA / 1000, distB / 1000, 2, ' km'), better: 'higher' as const, delta: (distB ?? 0) - (distA ?? 0) },
    { label: t('compare.stat.duration'), a: formatChrono(a.duration_s), b: formatChrono(b.duration_s), diff: diffTime(a.duration_s, b.duration_s), better: 'lower' as const, delta: b.duration_s - a.duration_s },
    { label: t(run.value ? 'compare.stat.pace' : 'compare.stat.speed'), a: speedText(a.average_speed), b: speedText(b.average_speed), diff: diffSpeed(a.average_speed, b.average_speed), better: 'higher' as const, delta: (b.average_speed ?? 0) - (a.average_speed ?? 0) },
    { label: t('compare.stat.elevation'), a: num(a.elevation_gain_m, 0, ' m'), b: num(b.elevation_gain_m, 0, ' m'), diff: diffNum(a.elevation_gain_m, b.elevation_gain_m, 0, ' m'), better: 'higher' as const, delta: (b.elevation_gain_m ?? 0) - (a.elevation_gain_m ?? 0) },
    { label: t('compare.stat.heartrate'), a: num(a.average_heartrate, 0, ' bpm'), b: num(b.average_heartrate, 0, ' bpm'), diff: diffNum(a.average_heartrate, b.average_heartrate, 0), better: 'lower' as const, delta: (b.average_heartrate ?? 0) - (a.average_heartrate ?? 0) },
    { label: t('compare.stat.power'), a: num(a.average_watts, 0, ' W'), b: num(b.average_watts, 0, ' W'), diff: diffNum(a.average_watts, b.average_watts, 0, ' W'), better: 'higher' as const, delta: (b.average_watts ?? 0) - (a.average_watts ?? 0) },
    wkgRow(t('compare.stat.power_wkg'), a.average_watts, b.average_watts, sa.weight_kg, sb.weight_kg),
    { label: t('compare.stat.ftp'), a: num(sa.ftp, 0, ' W'), b: num(sb.ftp, 0, ' W'), diff: diffNum(sa.ftp, sb.ftp, 0, ' W'), better: 'higher' as const, delta: (sb.ftp ?? 0) - (sa.ftp ?? 0) },
    wkgRow(t('compare.stat.ftp_wkg'), sa.ftp, sb.ftp, sa.weight_kg, sb.weight_kg),
    { label: t('compare.stat.cadence'), a: num(a.average_cadence, 0), b: num(b.average_cadence, 0), diff: diffNum(a.average_cadence, b.average_cadence, 0), better: 'higher' as const, delta: (b.average_cadence ?? 0) - (a.average_cadence ?? 0) },
    ...maxRows(a, b),
  ].filter((r) => r.a !== '–' || r.b !== '–')
})

const wholeRows = computed<Row[]>(() => {
  if (!data.value) return []
  const a = data.value.a, b = data.value.b
  return [
    { label: t('compare.stat.distance'), a: formatKm(a.distance_m), b: formatKm(b.distance_m), diff: diffNum((a.distance_m ?? 0) / 1000, (b.distance_m ?? 0) / 1000, 2, ' km'), better: 'higher' as const, delta: (b.distance_m ?? 0) - (a.distance_m ?? 0) },
    { label: t('compare.stat.moving_time'), a: formatChrono(a.moving_time_s), b: formatChrono(b.moving_time_s), diff: diffTime(a.moving_time_s, b.moving_time_s), better: 'lower' as const, delta: (b.moving_time_s ?? 0) - (a.moving_time_s ?? 0) },
    { label: t(run.value ? 'compare.stat.pace' : 'compare.stat.speed'), a: speedText(a.average_speed), b: speedText(b.average_speed), diff: diffSpeed(a.average_speed, b.average_speed), better: 'higher' as const, delta: (b.average_speed ?? 0) - (a.average_speed ?? 0) },
    { label: t('compare.stat.elevation'), a: num(a.elevation_gain_m, 0, ' m'), b: num(b.elevation_gain_m, 0, ' m'), diff: diffNum(a.elevation_gain_m, b.elevation_gain_m, 0, ' m'), better: 'higher' as const, delta: (b.elevation_gain_m ?? 0) - (a.elevation_gain_m ?? 0) },
    { label: t('compare.stat.heartrate'), a: num(a.average_heartrate, 0, ' bpm'), b: num(b.average_heartrate, 0, ' bpm'), diff: diffNum(a.average_heartrate, b.average_heartrate, 0), better: 'lower' as const, delta: (b.average_heartrate ?? 0) - (a.average_heartrate ?? 0) },
    { label: t('compare.stat.power'), a: num(a.average_watts, 0, ' W'), b: num(b.average_watts, 0, ' W'), diff: diffNum(a.average_watts, b.average_watts, 0, ' W'), better: 'higher' as const, delta: (b.average_watts ?? 0) - (a.average_watts ?? 0) },
    { label: t('compare.stat.normalized_power'), a: num(a.normalized_power, 0, ' W'), b: num(b.normalized_power, 0, ' W'), diff: diffNum(a.normalized_power, b.normalized_power, 0, ' W'), better: 'higher' as const, delta: (b.normalized_power ?? 0) - (a.normalized_power ?? 0) },
    { label: t('compare.stat.ftp'), a: num(a.ftp, 0, ' W'), b: num(b.ftp, 0, ' W'), diff: diffNum(a.ftp, b.ftp, 0, ' W'), better: 'higher' as const, delta: (b.ftp ?? 0) - (a.ftp ?? 0) },
    wkgRow(t('compare.stat.ftp_wkg'), a.ftp, b.ftp, a.weight_kg, b.weight_kg),
    wkgRow(t('compare.stat.power_wkg'), a.average_watts, b.average_watts, a.weight_kg, b.weight_kg),
    ...maxRows(a, b),
  ].filter((r) => r.a !== '–' || r.b !== '–')
})

// ── Graphiques ─────────────────────────────────────────────────────────────
type ChannelKey = 'altitude' | 'speed' | 'heartrate' | 'power' | 'power_wkg' | 'cadence'
const gapCanvas = ref<HTMLCanvasElement | null>(null)
const canvases: Record<string, HTMLCanvasElement | null> = {}
function setCanvas(key: string, el: unknown) { canvases[key] = el as HTMLCanvasElement | null }

const channels = computed(() => {
  const c = data.value?.common
  if (!c) return [] as { key: ChannelKey; label: string }[]
  const keys: ChannelKey[] = ['altitude', 'speed', 'heartrate', 'power', 'power_wkg', 'cadence']
  return keys
    .filter((k) => {
      const src = k === 'power_wkg' ? 'power' : k
      const wa = k !== 'power_wkg' || !!data.value?.a.weight_kg, wb = k !== 'power_wkg' || !!data.value?.b.weight_kg
      return (wa && c.a[src]?.some((v) => v != null)) || (wb && c.b[src]?.some((v) => v != null))
    })
    .map((key) => ({ key, label: t(`compare.channel.${key === 'speed' && run.value ? 'pace' : key}`) }))
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let charts: any[] = []
let mapInstance: any = null
let markerA: any = null
let markerB: any = null
const hoverIndex = ref<number | null>(null)

function destroyCharts() {
  charts.forEach((c) => c.destroy())
  charts = []
}

function destroyAll() {
  destroyCharts()
  markerA?.remove(); markerB?.remove()
  markerA = markerB = null
  mapInstance?.remove()
  mapInstance = null
}

function channelValues(side: CommonSide, key: ChannelKey, weight: number | null = null): (number | null)[] {
  if (key === 'power_wkg') {
    return weight && weight > 0 ? (side.power ?? []).map((v) => (v == null ? null : +(v / weight).toFixed(2))) : []
  }
  const raw = side[key] ?? []
  if (key === 'speed' && run.value) {
    return raw.map((v) => (v == null ? null : (() => { const p = paceMinPerKm(v); return Number.isFinite(p) ? p : null })()))
  }
  if (key === 'speed') return raw.map((v) => (v == null ? null : v * 3.6))
  return raw
}

// FTP estimée de chaque sortie, en pointillés sur les graphiques de puissance (W et W/kg).
function ftpLines(key: ChannelKey, xMax: number) {
  if (key !== 'power' && key !== 'power_wkg') return []
  const d = data.value
  if (!d) return []
  return ([['A', d.a, COLOR_A], ['B', d.b, COLOR_B]] as const).flatMap(([name, side, color]) => {
    const y = key === 'power' ? side.ftp : wkg(side.ftp, side.weight_kg)
    if (y == null) return []
    const v = key === 'power' ? y : +y.toFixed(2)
    return [{ label: `${name} · ${t('compare.stat.ftp')}`, data: [{ x: 0, y: v }, { x: xMax, y: v }], borderColor: color, borderWidth: 1, borderDash: [6, 4], pointRadius: 0 }]
  })
}

// Rectangle de la sélection, dessiné par-dessus chaque graphique.
const selectionPlugin = {
  id: 'compareSelection',
  afterDatasetsDraw(chart: any) {
    const sel = selection.value
    const pts = chart.data.datasets[0]?.data
    if (!sel || !pts?.[sel.from] || !pts?.[sel.to]) return
    const { ctx, chartArea, scales } = chart
    const x0 = scales.x.getPixelForValue(pts[sel.from].x)
    const x1 = scales.x.getPixelForValue(pts[sel.to].x)
    ctx.save()
    ctx.fillStyle = 'rgba(255,193,7,.22)'
    ctx.strokeStyle = 'rgba(255,193,7,.9)'
    ctx.lineWidth = 1
    ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top)
    ctx.strokeRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top)
    ctx.restore()
  },
}

// Glisser = sélectionner ; un clic sans mouvement efface. L'index sous le curseur vient
// du survol (`hoverIndex`), commun à tous les graphiques.
let dragStart: number | null = null
let dragMoved = false
const bound = new WeakSet<HTMLCanvasElement>()
function bindDrag(el: HTMLCanvasElement) {
  if (bound.has(el)) return
  bound.add(el)
  el.style.userSelect = 'none'
  // Tactile, comme les analyses d'activité : un doigt qui glisse à l'horizontale
  // sélectionne ; un geste vertical rend la main au défilement de la page ; un tap efface.
  const TAP_TOL = 8
  let touch: { id: number; x: number; y: number; start: number; mode: 'pending' | 'select' } | null = null
  const chartOf = () => charts.find((c) => c.canvas === el)
  const indexAt = (clientX: number): number | null => {
    const chart = chartOf()
    const pts = chart?.data.datasets[0]?.data
    if (!chart || !pts?.length) return null
    const area = chart.chartArea
    const px = Math.max(area.left, Math.min(area.right, clientX - el.getBoundingClientRect().left))
    const v = chart.scales.x.getValueForPixel(px)
    if (v == null) return null
    let lo = 0, hi = pts.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].x < v) lo = mid + 1; else hi = mid }
    if (lo > 0 && Math.abs(pts[lo - 1].x - v) <= Math.abs(pts[lo].x - v)) lo--
    return lo
  }
  // Souris : l'index vient de la position du curseur sur l'axe, pas des éléments « survolés »
  // par Chart.js (qui écartent les points sans valeur — une courbe sans FC ne donnait rien).
  el.addEventListener('mousemove', (e) => { hoverIndex.value = indexAt(e.clientX) })
  el.addEventListener('mouseleave', () => { if (dragStart == null) hoverIndex.value = null })
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    const i = indexAt(e.clientX)
    if (i == null) return
    hoverIndex.value = i
    dragStart = i
    dragMoved = false
  })
  const find = (list: TouchList) => (touch ? Array.from(list).find((t) => t.identifier === touch!.id) : undefined)
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { touch = null; return }
    const tt = e.touches[0]
    const start = indexAt(tt.clientX)
    touch = start == null ? null : { id: tt.identifier, x: tt.clientX, y: tt.clientY, start, mode: 'pending' }
  }, { passive: true })
  el.addEventListener('touchmove', (e) => {
    const tt = find(e.touches)
    if (!touch || !tt) return
    if (touch.mode === 'pending') {
      const dx = Math.abs(tt.clientX - touch.x), dy = Math.abs(tt.clientY - touch.y)
      if (dx <= TAP_TOL && dy <= TAP_TOL) return
      if (dx <= dy) { touch = null; return } // plutôt vertical : c'est le défilement
      touch.mode = 'select'
    }
    e.preventDefault()
    const i = indexAt(tt.clientX)
    if (i == null) return
    hoverIndex.value = i
    selection.value = i === touch.start ? selection.value : { from: Math.min(touch.start, i), to: Math.max(touch.start, i) }
  }, { passive: false })
  const finish = (e: TouchEvent) => {
    if (!touch || find(e.touches)) return
    const wasSelecting = touch.mode === 'select'
    touch = null
    hoverIndex.value = null
    if (!wasSelecting) {
      // Tap sans glisser : efface, et évite le clic souris émulé (infobulle collée).
      if (e.cancelable) e.preventDefault()
      selection.value = null
    } else if (selection.value && selection.value.to - selection.value.from < 2) selection.value = null
  }
  el.addEventListener('touchend', finish, { passive: false })
  el.addEventListener('touchcancel', () => { touch = null; hoverIndex.value = null }, { passive: true })
}
function endDrag() {
  if (dragStart == null) return
  if (!dragMoved || (selection.value && selection.value.to - selection.value.from < 2)) selection.value = null
  dragStart = null
}
function clearSelection() { selection.value = null }

async function renderCharts() {
  const c = data.value?.common
  if (!c) return
  if (gapCanvas.value) bindDrag(gapCanvas.value)
  Object.values(canvases).forEach((el) => el && bindDrag(el))
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)
  const timeMode = xAxis.value === 'time'
  const labels = c.x.map((x) => +(x / 1000).toFixed(2))
  // Abscisses de chaque série : km commun en mode distance, sinon son propre chrono (s).
  const xsA = timeMode ? c.a.time_s : labels
  const xsB = timeMode ? c.b.time_s : labels
  const xMax = Math.max(xsA[xsA.length - 1] ?? 0, xsB[xsB.length - 1] ?? 0)
  const xTicks = timeMode
    ? { maxTicksLimit: 8, callback: (v: number | string) => formatHMS(Number(v)) }
    : { maxTicksLimit: 8 }
  const css = getComputedStyle(document.documentElement)
  const grid = css.getPropertyValue('--bs-border-color') || 'rgba(128,128,128,.2)'

  const common = (extra: object = {}) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    spanGaps: false,
    interaction: { mode: 'index' as const, intersect: false },
    // Aucun événement natif : survol souris ET doigt passent par `hoverIndex`, qui pose
    // l'infobulle sur tous les graphiques d'un coup (sinon seul le survolé l'affichait).
    events: [] as string[],
    plugins: { legend: { display: false } },
    scales: {
      x: { type: 'linear' as const, min: 0, max: xMax, title: { display: false }, ticks: xTicks, grid: { color: grid } },
      y: { grid: { color: grid } },
    },
    ...extra,
  })

  const pts = (vals: (number | null)[], xs: number[] = labels) => vals.map((v, i) => ({ x: xs[i], y: v }))
  const line = (label: string, vals: (number | null)[], color: string, xs: number[], extra: object = {}) =>
    ({ label, data: pts(vals, xs), borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.2, ...extra })

  if (gapCanvas.value) {
    const gapData = pts(c.delta_s, xsA)
    charts.push(new Chart(gapCanvas.value, {
      type: 'line',
      plugins: [selectionPlugin],
      data: {
        datasets: [{
          label: t('compare.gap_title'), data: gapData, borderColor: GOOD, borderWidth: 1.5, pointRadius: 0,
          fill: { target: 'origin', above: 'rgba(220,53,69,.18)', below: 'rgba(25,135,84,.18)' },
          segment: { borderColor: (ctx: any) => ((ctx.p1.parsed.y ?? 0) > 0 ? BAD : GOOD) },
        }],
      },
      options: common({
        scales: {
          x: { type: 'linear', min: 0, max: xMax, title: { display: false }, ticks: xTicks, grid: { color: grid } },
          y: { title: { display: false }, ticks: { maxTicksLimit: 6, callback: (v: number | string) => `${Number(v) > 0 ? '+' : ''}${v} s` }, grid: { color: grid } },
        },
      }),
    }))
  }

  for (const { key, label } of channels.value) {
    const el = canvases[key]
    if (!el) continue
    const reverse = key === 'speed' && run.value
    charts.push(new Chart(el, {
      type: 'line',
      plugins: [selectionPlugin],
      data: {
        datasets: [
          line(`A · ${label}`, channelValues(c.a, key, data.value?.a.weight_kg ?? null), COLOR_A, xsA, key === 'altitude' ? { fill: 'origin', backgroundColor: 'rgba(13,110,253,.10)' } : {}),
          line(`B · ${label}`, channelValues(c.b, key, data.value?.b.weight_kg ?? null), COLOR_B, xsB),
          ...ftpLines(key, xMax),
        ],
      },
      options: common({
        scales: {
          x: { type: 'linear', min: 0, max: xMax, title: { display: false }, ticks: xTicks, grid: { color: grid } },
          y: { reverse, position: 'left', ticks: { maxTicksLimit: 6, color: CHANNEL_DEF[key]?.color, ...(reverse ? { callback: (v: number | string) => formatPace(Number(v)) } : {}) }, grid: { color: grid } },
        },
      }),
    }))
  }
}

watch(hoverIndex, (i) => {
  if (dragStart != null && i != null && i !== dragStart) {
    dragMoved = true
    selection.value = { from: Math.min(dragStart, i), to: Math.max(dragStart, i) }
  }
  // Les autres graphiques suivent le survol, et les repères se déplacent sur la carte.
  const c = data.value?.common
  if (c && mapInstance && markerA && markerB) {
    if (i == null) { markerA.getElement().style.display = 'none'; markerB.getElement().style.display = 'none' }
    else {
      const frac = c.x.length > 1 ? i / (c.x.length - 1) : 0
      placeMarker(markerA, c.a_track, frac)
      placeMarker(markerB, c.b_track, frac)
    }
  }
  // Les graphiques suivent le survol (hors courbes plus courtes, ex. les lignes de FTP).
  charts.forEach((chart) => {
    try {
      if (i == null) { chart.tooltip?.setActiveElements([], {}); chart.setActiveElements([]); chart.update('none'); return }
      const active = chart.data.datasets
        .map((ds: any, d: number) => ({ datasetIndex: d, index: i, n: ds.data.length }))
        .filter((e: any) => e.n > i && chart.data.datasets[e.datasetIndex].data[i]?.y != null)
        .map(({ datasetIndex, index }: any) => ({ datasetIndex, index }))
      chart.setActiveElements(active)
      chart.tooltip?.setActiveElements(active, { x: 0, y: 0 })
      chart.update('none')
    } catch { /* un graphique en cours de reconstruction : sans conséquence */ }
  })
})

// Sélection : les graphiques redessinent leur rectangle, la carte surligne le tracé.
function sliceTrack(track: [number, number][], from: number, to: number, n: number): [number, number][] {
  if (track.length < 2 || n < 2) return []
  const lo = Math.round((from / (n - 1)) * (track.length - 1))
  const hi = Math.round((to / (n - 1)) * (track.length - 1))
  return track.slice(lo, hi + 1)
}
function updateSelectionMap() {
  const c = data.value?.common
  if (!mapInstance) return
  const sel = selection.value
  const feat = (coords: [number, number][]) => ({
    type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coords.length > 1 ? coords : [] },
  })
  const n = c?.x.length ?? 0
  for (const [id, track] of [['cmp-sel-b', c?.b_track], ['cmp-sel-a', c?.a_track]] as const) {
    const src = mapInstance.getSource(id)
    if (src) src.setData(feat(sel && track ? sliceTrack(track, sel.from, sel.to, n).map((p) => [p[0], p[1]] as [number, number]) : []))
  }
}
watch(selection, () => {
  charts.forEach((chart) => chart.update('none'))
  updateSelectionMap()
})

function placeMarker(marker: any, track: [number, number][], frac: number) {
  if (!track.length) return
  const p = track[Math.min(track.length - 1, Math.round(frac * (track.length - 1)))]
  marker.setLngLat(p)
  marker.getElement().style.display = 'block'
}

// ── Carte ──────────────────────────────────────────────────────────────────
const mapEl = ref<HTMLElement | null>(null)

function dot(color: string, title = ''): HTMLElement {
  const el = document.createElement('div')
  el.title = title
  el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5);display:none`
  return el
}

async function renderMap() {
  const d = data.value
  if (!d || !mapEl.value) return
  const c = d.common
  const start = (c?.a_track[0] ?? d.a_full_track[0] ?? [0, 0]) as [number, number]
  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')
  if (!mapEl.value) return
  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(mapState.mapStyleId) as any,
    center: start,
    zoom: 11,
    attributionControl: false,
  })
  mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
  mapInstance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
  mapInstance.on('load', () => {
    addTrackLayers(d)
    if (c) {
      markerA = new maplibregl.Marker({ element: dot(COLOR_A, sideTitle(d.a)) }).setLngLat(c.a_track[0] ?? start).addTo(mapInstance)
      markerB = new maplibregl.Marker({ element: dot(COLOR_B, sideTitle(d.b)) }).setLngLat(c.b_track[0] ?? start).addTo(mapInstance)
    }
    applyMapScope(false)
  })
}

// Affiche l'étendue choisie : le tronçon commun en trait plein, ou les sorties entières
// (le tronçon commun reste visible dessus, plus épais, pour situer la portion comparée).
function applyMapScope(animate: boolean) {
  const d = data.value
  if (!mapInstance || !d) return
  const full = mapScope.value === 'full' || !d.common
  for (const id of ['cmp-full-a', 'cmp-full-b']) {
    if (mapInstance.getLayer(id)) mapInstance.setLayoutProperty(id, 'visibility', full ? 'visible' : 'none')
  }
  const pts = full ? [...d.a_full_track, ...d.b_full_track] : [...(d.common?.a_track ?? []), ...(d.common?.b_track ?? [])]
  if (!pts.length) return
  import('maplibre-gl').then(({ default: maplibregl }) => {
    if (!mapInstance) return
    const b = new maplibregl.LngLatBounds(pts[0], pts[0])
    pts.forEach((p) => b.extend(p))
    mapInstance.fitBounds(b, { padding: 30, animate })
  })
}

function addTrackLayers(d: Comparison) {
  const feature = (coords: [number, number][]) => ({
    type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coords },
  })
  const addLine = (id: string, coords: [number, number][], color: string, width: number, opacity: number) => {
    mapInstance.addSource(id, { type: 'geojson', data: feature(coords) })
    mapInstance.addLayer({
      id, type: 'line', source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity },
    })
  }
  // Sorties entières dessous, fines et atténuées ; B sous A. Puis le tronçon commun par-dessus.
  addLine('cmp-full-b', d.b_full_track, COLOR_B, 3, 0.55)
  addLine('cmp-full-a', d.a_full_track, COLOR_A, 3, 0.55)
  if (d.common) {
    // B dessous, plus large : là où les deux tracés se superposent, les deux restent lisibles.
    addLine('cmp-b', d.common.b_track, COLOR_B, 6, 0.85)
    addLine('cmp-a', d.common.a_track, COLOR_A, 3, 0.95)
    // Portion sélectionnée sur les graphiques : trait plus épais, avec un halo jaune.
    addLine('cmp-sel-b', [], '#ffc107', 10, 0.9)
    addLine('cmp-sel-a', [], '#ffc107', 10, 0.9)
    mapInstance.moveLayer('cmp-b'); mapInstance.moveLayer('cmp-a')
    updateSelectionMap()
  }
}

onMounted(() => { window.addEventListener('mouseup', endDrag); load() })
onBeforeUnmount(() => { window.removeEventListener('mouseup', endDrag); destroyAll() })

function activityUrl(s: Side): string {
  return s.source === 'imported' ? `/imported_activities/${s.id}` : `/activities/${s.id}`
}
</script>

<template>
  <div class="activity-compare">
    <h1 class="h4 mb-3">{{ t('compare.title') }}</h1>

    <div v-if="loading" class="text-body-secondary">
      <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ t('compare.loading') }}
    </div>
    <div v-else-if="error || !data" class="alert alert-danger">{{ t('compare.error') }}</div>

    <template v-else>
      <!-- En-tête : les deux sorties, A en référence. -->
      <div class="row g-2 mb-3 align-items-stretch">
        <div v-for="(side, i) in [data.a, data.b]" :key="i" class="col-12 col-md">
          <a :href="activityUrl(side)" class="card shadow-sm border-0 h-100 text-decoration-none text-reset">
            <div class="card-body py-2" :style="{ borderLeft: `6px solid ${i === 0 ? COLOR_A : COLOR_B}` }">
              <div class="small text-body-secondary">
                <span :title="sideTitle(side)">{{ i === 0 ? `A · ${t('compare.reference')}` : 'B' }}</span> · {{ dateOf(side) }}
              </div>
              <div class="fw-semibold text-truncate">{{ side.name }}</div>
              <div class="small text-body-secondary">{{ formatKm(side.distance_m) }}</div>
            </div>
          </a>
        </div>
        <div class="col-12 col-md-auto d-flex align-items-center">
          <button type="button" class="btn btn-outline-secondary w-100" @click="swap">
            <i class="fa-solid fa-right-left me-1" aria-hidden="true"></i>{{ t('compare.swap') }}
          </button>
        </div>
      </div>

<div v-if="data.stretches && data.stretches.length > 1" class="card shadow-sm border-0 mt-3">
        <div class="card-header activity-card-header">
          <h3 class="h6 mb-0 d-flex align-items-center gap-2">
            <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>
            <span>{{ t('compare.stretches_title') }}</span>
          </h3>
        </div>
        <div class="card-body">
          <p class="small text-body-secondary mb-2">{{ t('compare.stretches_hint') }}</p>
          <div class="d-flex flex-wrap gap-2">
            <button v-for="st in data.stretches" :key="st.index" type="button"
                    class="btn btn-sm text-start" :class="data.stretch === st.index ? 'btn-warning' : 'btn-outline-secondary'"
                    :aria-pressed="data.stretch === st.index" @click="pickStretch(st.index)">
              <strong>{{ kmText(st.distance_m) }}</strong>
              <span class="small ms-2">{{ t('compare.stretch_where', { a: kmText(st.a_from_m), b: kmText(st.b_from_m) }) }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="card shadow-sm border-0 mt-3">
          <div class="card-header activity-card-header d-flex align-items-center justify-content-between gap-2">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-map text-warning" aria-hidden="true"></i>
              <span>{{ t('compare.map_title') }}</span>
            </h3>
            <div class="d-flex align-items-center gap-2">
              <div v-if="data.common" class="btn-group btn-group-sm" role="group" :aria-label="t('compare.map_title')">
                <button type="button" class="btn" :class="mapScope === 'common' ? 'btn-warning' : 'btn-outline-secondary'" :aria-pressed="mapScope === 'common'" @click="setMapScope('common')">{{ t('compare.scope_common') }}</button>
                <button type="button" class="btn" :class="mapScope === 'full' ? 'btn-warning' : 'btn-outline-secondary'" :aria-pressed="mapScope === 'full'" @click="setMapScope('full')">{{ t('compare.scope_full') }}</button>
              </div>
              <MapStyleDropdown class="map-dropdown-btn" :model-value="mapState.mapStyleId" @update:model-value="setMapStyle" />
            </div>
          </div>
          <div ref="mapEl" class="compare-map"></div>
        </div>

            <div v-if="!data.common" class="alert alert-info">{{ t('compare.no_common') }}</div>

      <template v-else>

        <div class="card shadow-sm border-0 mt-3">
          <div class="card-header activity-card-header d-flex align-items-center justify-content-between gap-2">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-stopwatch text-warning" aria-hidden="true"></i>
              <span>{{ t('compare.gap_title') }}</span>
            </h3>
            <div class="btn-group btn-group-sm" role="group" :aria-label="t('compare.x_axis')">
              <button type="button" class="btn" :class="xAxis === 'distance' ? 'btn-warning' : 'btn-outline-secondary'" :aria-pressed="xAxis === 'distance'" @click="setXAxis('distance')">{{ t('compare.x_distance') }}</button>
              <button type="button" class="btn" :class="xAxis === 'time' ? 'btn-warning' : 'btn-outline-secondary'" :aria-pressed="xAxis === 'time'" @click="setXAxis('time')">{{ t('compare.x_time') }}</button>
            </div>
          </div>
          <div class="card-body">
            <div class="range-chips d-flex flex-wrap gap-2 align-items-center mb-2">
              <span v-if="finalGapText" class="range-chip" :style="finalGapStyle"><i class="fa-regular fa-clock" aria-hidden="true"></i><strong :style="{ color: 'inherit' }">{{ finalGapText }}</strong></span>
              <span class="range-chip"><i class="fa-solid fa-route" aria-hidden="true"></i><strong>{{ t('compare.common_length', { km: (data.common.distance_m / 1000).toFixed(1) }) }}</strong></span>
            </div>
            <p class="small text-body-secondary mb-2">{{ t('compare.delta_hint', { a: labelA, b: labelB }) }}</p>
            <p class="small text-body-secondary mb-2">{{ t('compare.select_hint') }}</p>
            <div class="compare-chart"><canvas ref="gapCanvas"></canvas></div>
          </div>
        </div>

        <div class="card shadow-sm border-0 mt-3">
          <div class="card-header activity-card-header d-flex align-items-center justify-content-between gap-2">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-chart-line text-warning" aria-hidden="true"></i>
              <span>{{ t('compare.charts_title') }}</span>
            </h3>
            <span class="d-flex gap-2 align-items-center">
              <span class="legend-pill" :title="sideTitle(data.a)"><span class="legend-dot" :style="{ background: COLOR_A }"></span>A</span>
              <span class="legend-pill" :title="sideTitle(data.b)"><span class="legend-dot" :style="{ background: COLOR_B }"></span>B</span>
              <div class="btn-group btn-group-sm" role="group" :aria-label="t('compare.x_axis')">
                <button type="button" class="btn" :class="xAxis === 'distance' ? 'btn-warning' : 'btn-outline-secondary'" :aria-pressed="xAxis === 'distance'" @click="setXAxis('distance')">{{ t('compare.x_distance') }}</button>
                <button type="button" class="btn" :class="xAxis === 'time' ? 'btn-warning' : 'btn-outline-secondary'" :aria-pressed="xAxis === 'time'" @click="setXAxis('time')">{{ t('compare.x_time') }}</button>
              </div>
            </span>
          </div>
          <div class="card-body">
            <div v-for="ch in channels" :key="ch.key" class="chart-group">
              <div class="chart-group-header">
                <span class="legend-pill legend-pill-static">
                  <i :class="`fa-solid ${CHANNEL_ICON[ch.key]} legend-icon`" :style="{ color: CHANNEL_DEF[ch.key]?.color }" aria-hidden="true"></i>{{ ch.label }}
                </span>
              </div>
              <div class="compare-chart compare-chart-sm"><canvas :ref="(el) => setCanvas(ch.key, el)"></canvas></div>
            </div>
          </div>
        </div>

        <div class="card shadow-sm border-0 mt-3">
          <div class="card-header activity-card-header d-flex align-items-center justify-content-between gap-2">
            <h3 class="h6 mb-0 d-flex align-items-center gap-2">
              <i class="fa-solid fa-table-list text-warning" aria-hidden="true"></i>
              <span>{{ t('compare.stats_title') }}</span>
            </h3>
          </div>
          <div class="table-responsive">
            <table class="table table-sm mb-0 align-middle w-auto compare-table">
              <thead>
                <tr>
                  <th>
                    <button type="button" class="btn btn-sm btn-outline-secondary py-0" :title="t('compare.swap')" :aria-label="t('compare.swap')" @click="swap">
                      <i class="fa-solid fa-right-left" aria-hidden="true"></i>
                    </button>
                  </th>
                  <th :style="{ color: COLOR_A }" :title="sideTitle(data.a)">A</th>
                  <th :style="{ color: COLOR_B }" :title="sideTitle(data.b)">B</th>
                  <th>{{ t('compare.diff') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{{ t('compare.name') }}</td>
                  <td class="compare-name" :title="data.a.name">{{ data.a.name }}</td>
                  <td class="compare-name" :title="data.b.name">{{ data.b.name }}</td>
                  <td></td>
                </tr>
                <tr v-if="data.a.gear || data.b.gear">
                  <td>{{ t('compare.gear') }}</td>
                  <td class="compare-name" :title="data.a.gear || ''">{{ data.a.gear || '–' }}</td>
                  <td class="compare-name" :title="data.b.gear || ''">{{ data.b.gear || '–' }}</td>
                  <td class="text-body-secondary">{{ data.a.gear && data.b.gear && data.a.gear !== data.b.gear ? t('compare.differs') : '' }}</td>
                </tr>
                <tr v-if="data.a.device || data.b.device">
                  <td>{{ t('compare.device') }}</td>
                  <td class="compare-name" :title="data.a.device || ''">{{ data.a.device || '–' }}</td>
                  <td class="compare-name" :title="data.b.device || ''">{{ data.b.device || '–' }}</td>
                  <td class="text-body-secondary">{{ data.a.device && data.b.device && data.a.device !== data.b.device ? t('compare.differs') : '' }}</td>
                </tr>
                <tr v-if="dateRow">
                  <td>{{ dateRow.label }}</td><td>{{ dateRow.a }}</td><td>{{ dateRow.b }}</td>
                  <td class="text-body-secondary">{{ dateRow.gap }}</td>
                </tr>
                <tr v-for="r in weatherRows" :key="`m-${r.label}`">
                  <td>{{ r.label }}</td><td>{{ r.a }}</td><td>{{ r.b }}</td><td class="text-body-secondary">{{ r.diff }}</td>
                </tr>
                <tr class="table-light"><th colspan="4" class="small text-uppercase">
                  {{ commonTitle }}
                  <button v-if="selection" type="button" class="btn btn-sm btn-outline-secondary py-0 ms-2 text-uppercase" @click="clearSelection">{{ t('compare.clear_selection') }}</button>
                </th></tr>
                <tr v-for="r in commonRows" :key="`c-${r.label}`">
                  <td>{{ r.label }}</td><td>{{ r.a }}</td><td>{{ r.b }}</td><td class="fw-semibold" :style="{ color: diffColor(r) }"><span v-if="!diffColor(r)" class="text-body-secondary">{{ r.diff }}</span><template v-else>{{ r.diff }}</template></td>
                </tr>
                <tr class="table-light"><th colspan="4" class="small text-uppercase">{{ t('compare.stats_whole') }}</th></tr>
                <tr v-for="r in wholeRows" :key="`w-${r.label}`">
                  <td>{{ r.label }}</td><td>{{ r.a }}</td><td>{{ r.b }}</td><td class="fw-semibold" :style="{ color: diffColor(r) }"><span v-if="!diffColor(r)" class="text-body-secondary">{{ r.diff }}</span><template v-else>{{ r.diff }}</template></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.compare-map { height: 340px; }
.compare-table { margin-left: 0.75rem; }
.compare-table td.compare-name { max-width: 11rem; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.compare-table th, .compare-table td { padding-left: 0.9rem; padding-right: 0.9rem; white-space: nowrap; }
.compare-chart { position: relative; height: 200px; }
.compare-chart canvas { touch-action: pan-y; }
.compare-chart-sm { height: 170px; }
@media (max-width: 575.98px) { .compare-chart { height: 170px; } }
.legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.range-chips { font-size: 0.85rem; }
.range-chip {
  display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.6rem;
  border-radius: 999px; background: rgba(108, 117, 125, 0.1); color: #495057;
  font-variant-numeric: tabular-nums;
}
.range-chip strong { font-weight: 600; color: #212529; }
.legend-pill {
  display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.05rem 0.45rem;
  border-radius: 999px; background: rgba(0, 0, 0, 0.03); border: 1px solid rgba(0, 0, 0, 0.08);
  color: #495057; font-size: 0.72rem; line-height: 1.5; user-select: none;
}
.legend-icon { font-size: 0.85rem; line-height: 1; flex-shrink: 0; }
.chart-group { border-radius: 0.5rem; padding: 0.5rem; position: relative; }
.chart-group-header {
  padding: 0.35rem 0.5rem; margin-bottom: 0.4rem; border-radius: 0.4rem;
  background: rgba(108, 117, 125, 0.04); border: 1px solid rgba(0, 0, 0, 0.05);
}
@media (min-width: 768px) {
  .card-header :deep(.map-dropdown-btn > button) { width: 12rem; justify-content: space-between; }
}
</style>
