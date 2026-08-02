// Lecture d'un fichier `.fit` — reconnaissance, aiguillage, et conversion vers les
// deux formes que le site sait déjà consommer.
//
// Mutualisé entre :
//  - ImportFitActivity.vue  (dépôt d'un .fit sur le tableau de bord)
//  - ImportFitLanding.vue   (.fit partagé à l'app, ou ouvert avec elle)
//
// Un `.fit` peut être deux choses très différentes, et c'est le fichier lui-même qui
// le dit (message `file_id`) :
//
//   • `activity` — une sortie enregistrée. Elle part vers /api/imported_activities,
//     à la forme « flux parallèles » de Strava que tout le reste du site attend
//     (ActivityDetail, courbes de puissance, charge d'entraînement…).
//   • `course`   — un parcours planifié (Garmin Connect, Komoot). Il n'a rien à faire
//     dans le journal des sorties : c'est une trace, donc un itinéraire, échantillonné
//     comme un GPX étranger et confié au créateur.
//
// Un fichier peut légitimement servir aux deux (on refait un parcours qu'on a roulé),
// d'où l'aiguillage proposé et non imposé : `fitFileKind` ne fait que désigner le
// choix par défaut.

import { computeElevGain } from './activityHelpers'
import { fillHoles } from './fitStreams'
import { isValidLngLat, sampleTrackWaypoints } from './trackSampling'
import type { ImportWaypoint } from './trackSampling'

// Erreur d'import typée : `code` permet aux appelants de choisir le message i18n.
export class FitImportError extends Error {
  code: 'invalid' | 'no_points'
  constructor(code: 'invalid' | 'no_points') {
    super(code)
    this.code = code
    this.name = 'FitImportError'
  }
}

// Le `.FIT` du bloc d'en-tête (octets 8 à 11), seul marqueur fiable du format.
//
// C'est lui qui tranche, jamais l'extension ni le type MIME : Android partage très
// souvent un `.fit` en `application/octet-stream` — type que la cible de partage GPX
// accepte déjà — et le fichier atterrirait dans le créateur d'itinéraire comme un XML
// illisible. On renifle donc les octets à l'arrivée, quel que soit le champ du
// formulaire par lequel le fichier est entré.
export function isFitFile(buf: ArrayBuffer | Uint8Array): boolean {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.length < 12) return false
  // 0x2E 0x46 0x49 0x54 = « .FIT »
  return bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54
}

export type FitFileKind = 'activity' | 'course' | 'other'

// Ce que le fichier dit être. `file_ids` est le premier message d'un `.fit` valide ;
// son absence (fichier tronqué, encodeur exotique) ne doit pas faire échouer l'import,
// d'où le repli sur la présence de `sessions` — ce qu'un enregistrement a et pas un
// parcours.
export function fitFileKind(data: any): FitFileKind {
  const raw = Array.isArray(data?.file_ids) && data.file_ids[0] ? data.file_ids[0].type : null
  const type = raw == null ? '' : String(raw).toLowerCase()
  if (type === 'activity' || type === 'course') return type
  if (Array.isArray(data?.sessions) && data.sessions.length) return 'activity'
  if (Array.isArray(data?.courses) && data.courses.length) return 'course'
  return 'other'
}

// Décode le binaire. Options alignées sur celles de l'importateur historique — les
// changer changerait les unités de tous les flux déjà en base.
export async function parseFitFile(buf: ArrayBuffer): Promise<any> {
  const FitParser = (await import('fit-file-parser')).default
  const parser = new FitParser({
    force: true,
    mode: 'list',
    speedUnit: 'm/s',
    lengthUnit: 'm',
    temperatureUnit: 'celsius',
    elapsedRecordField: true,
  })
  return new Promise((resolve, reject) => {
    parser.parse(buf, (err: unknown, parsed: any) => (err ? reject(new FitImportError('invalid')) : resolve(parsed)))
  })
}

// [[lng, lat], ...] — les `records` d'abord (un parcours Garmin en porte, tout comme
// une sortie), les `course_points` en dernier recours : ceux-ci ne sont que les
// consignes de navigation (« tourner à droite »), donc une trace bien plus grossière.
export function fitTrackPoints(data: any): [number, number][] {
  const collect = (rows: any[]): [number, number][] => {
    const out: [number, number][] = []
    for (const r of rows) {
      const lat = Number(r?.position_lat)
      const lng = Number(r?.position_long)
      if (isValidLngLat(lng, lat)) out.push([lng, lat])
    }
    return out
  }
  const records = collect(Array.isArray(data?.records) ? data.records : [])
  if (records.length) return records
  return collect(Array.isArray(data?.course_points) ? data.course_points : [])
}

// Trace `.fit` → waypoints du créateur d'itinéraire, par le même échantillonneur que
// le GPX (cf. `trackSampling.ts`).
export function fitWaypoints(data: any): ImportWaypoint[] {
  const points = fitTrackPoints(data)
  if (!points.length) throw new FitImportError('no_points')
  return sampleTrackWaypoints(points)
}

// Ce qu'on montre au cycliste avant qu'il choisisse quoi faire du fichier. Volontairement
// tolérant : un parcours n'a ni session ni cardio, et doit quand même s'afficher.
export function fitSummary(data: any, filename?: string | null) {
  const session = Array.isArray(data?.sessions) && data.sessions[0] ? data.sessions[0] : {}
  const records = Array.isArray(data?.records) ? data.records : []
  const course = Array.isArray(data?.courses) && data.courses[0] ? data.courses[0] : {}
  const points = fitTrackPoints(data)

  const startedAt = session.start_time
    ? new Date(session.start_time).toISOString()
    : (records[0]?.timestamp ? new Date(records[0].timestamp).toISOString() : null)

  // Distance : le total de la session s'il existe, sinon le compteur du dernier point —
  // un parcours planifié n'a que le second.
  let distanceM = numericOrNull(session.total_distance)
  if (distanceM == null) {
    for (let i = records.length - 1; i >= 0 && distanceM == null; i--) {
      distanceM = numericOrNull(records[i]?.distance)
    }
  }

  const altitudes = records
    .map((r: any) => numericOrNull(r?.altitude ?? r?.enhanced_altitude))
    .filter((v: number | null) => v != null)

  return {
    kind: fitFileKind(data),
    name: (course.name || session.sport || data?.activity?.sport || '').toString() || null,
    filename: filename ?? null,
    startedAt,
    distanceM,
    elapsedS: integerOrNull(session.total_elapsed_time ?? session.total_timer_time),
    elevationGainM: altitudes.length
      ? Math.round(computeElevGain(altitudes).gain)
      : (numericOrNull(session.total_ascent) ?? (numericOrNull(course.total_ascent))),
    pointCount: points.length,
    hasHeartrate: records.some((r: any) => r?.heart_rate != null),
    hasPower: records.some((r: any) => r?.power != null),
  }
}

// Transform fit-file-parser output into the Strava-shaped streams + summary
// our backend (and ActivityDetail.vue) already understand.
export function buildImportedActivityPayload(data: any, filename?: string | null) {
  const records = Array.isArray(data.records) ? data.records : []
  const session = Array.isArray(data.sessions) && data.sessions[0] ? data.sessions[0] : {}
  const activity = data.activity || {}

  // Build parallel arrays. Records without GPS still contribute to other
  // streams (HR/power/etc.), but a missing time field is dropped.
  const startTs = session.start_time
    ? new Date(session.start_time).getTime()
    : (records[0]?.timestamp ? new Date(records[0].timestamp).getTime() : null)

  const time: number[] = []
  const distance: number[] = []
  const latlng: ([number, number] | null)[] = []
  const altitude: (number | null)[] = []
  const velocity: (number | null)[] = []
  const heartrate: (number | null)[] = []
  const cadence: (number | null)[] = []
  const watts: (number | null)[] = []
  const temp: (number | null)[] = []

  for (const r of records) {
    let secs: number | null = null
    if (r.elapsed_time != null) secs = Math.round(Number(r.elapsed_time))
    else if (r.timestamp && startTs != null) secs = Math.round((new Date(r.timestamp).getTime() - startTs) / 1000)
    if (secs == null || !Number.isFinite(secs) || secs < 0) continue
    time.push(secs)
    distance.push(numericOrZero(r.distance))
    latlng.push((r.position_lat != null && r.position_long != null) ? [Number(r.position_lat), Number(r.position_long)] : null)
    altitude.push(numericOrNull(r.altitude ?? r.enhanced_altitude))
    velocity.push(numericOrNull(r.speed ?? r.enhanced_speed))
    heartrate.push(numericOrNull(r.heart_rate))
    cadence.push(numericOrNull(r.cadence))
    watts.push(numericOrNull(r.power))
    temp.push(numericOrNull(r.temperature))
  }

  // Drop streams that are entirely null (so the chart doesn't render them).
  const streams: Record<string, { data: any[] }> = {}
  streams.time = { data: time }
  if (distance.some((v) => v > 0)) streams.distance = { data: distance }
  // Position et altitude se comblent par la valeur connue la plus proche, jamais
  // par un zéro : voir `fitStreams.ts`. Le seuil de moitié reste — une trace dont
  // le GPS a manqué la majorité des points ne vaut pas d'être dessinée.
  const llValid = latlng.filter((p) => p != null)
  if (llValid.length >= 2 && llValid.length >= latlng.length * 0.5) {
    streams.latlng = { data: fillHoles(latlng) }
  }
  if (altitude.some((v) => v != null)) streams.altitude = { data: fillHoles(altitude) }
  if (velocity.some((v) => v != null)) streams.velocity_smooth = { data: velocity.map((v) => v ?? 0) }
  if (heartrate.some((v) => v != null)) streams.heartrate = { data: heartrate.map((v) => v ?? 0) }
  if (cadence.some((v) => v != null)) streams.cadence = { data: cadence.map((v) => v ?? 0) }
  if (watts.some((v) => v != null)) streams.watts = { data: watts.map((v) => v ?? 0) }
  if (temp.some((v) => v != null)) streams.temp = { data: temp.map((v) => v ?? 0) }

  // Derive grade_smooth from altitude/distance if both present.
  if (streams.altitude && streams.distance) {
    const alt = streams.altitude.data
    const dist = streams.distance.data
    const grade = new Array(alt.length).fill(0)
    for (let i = 1; i < alt.length; i++) {
      const dd = dist[i] - dist[i - 1]
      const da = alt[i] - alt[i - 1]
      grade[i] = dd > 0 ? (da / dd) * 100 : grade[i - 1]
    }
    streams.grade_smooth = { data: grade }
  }

  // Tours enregistrés par l'appareil. Le .fit les date (start_time + durée) au lieu
  // de les indexer : on convertit en indices de flux (forme Strava `start_index` /
  // `end_index`) pour que ActivityDetail traite les deux origines pareil. `time`
  // contient la seconde écoulée de chaque échantillon retenu, dans l'ordre.
  const laps = buildLaps(data.laps, time, startTs)

  const startLatLng = llValid.length ? llValid[0] : null
  const endLatLng = llValid.length ? llValid[llValid.length - 1] : null

  const name = (session.sport || activity.sport || 'Activité').toString()
  const nameClean = name.charAt(0).toUpperCase() + name.slice(1)
  const niceName = filename
    ? `${nameClean} · ${filename.replace(/\.fit$/i, '')}`
    : nameClean

  const startedAt = session.start_time
    ? new Date(session.start_time).toISOString()
    : (records[0]?.timestamp ? new Date(records[0].timestamp).toISOString() : null)

  return {
    source: 'fit',
    filename: filename || null,
    name: niceName.slice(0, 120),
    activity_type: session.sport || activity.sport || null,
    started_at: startedAt,
    distance_m: numericOrNull(session.total_distance) ?? (distance.length ? distance[distance.length - 1] : null),
    moving_time_s: integerOrNull(session.total_moving_time ?? session.total_timer_time),
    elapsed_time_s: integerOrNull(session.total_elapsed_time ?? session.total_timer_time),
    total_elevation_gain: altitude.some((v) => v != null)
      ? computeElevGain(altitude).gain
      : numericOrNull(session.total_ascent),
    average_speed: numericOrNull(session.avg_speed ?? session.enhanced_avg_speed),
    max_speed: numericOrNull(session.max_speed ?? session.enhanced_max_speed),
    average_heartrate: numericOrNull(session.avg_heart_rate),
    max_heartrate: numericOrNull(session.max_heart_rate),
    average_watts: numericOrNull(session.avg_power),
    max_watts: numericOrNull(session.max_power),
    average_cadence: numericOrNull(session.avg_cadence),
    max_cadence: numericOrNull(session.max_cadence),
    average_temp: numericOrNull(session.avg_temperature),
    start_latlng: startLatLng,
    end_latlng: endLatLng,
    streams,
    laps,
  }
}

// `data.laps` (fit-file-parser) → tours à la forme Strava. Un tour est daté par
// `start_time` et dure `total_elapsed_time` : on borne donc l'intervalle en secondes
// écoulées, puis on cherche les indices correspondants dans `time` (trié croissant).
// Un lap dont l'intervalle ne couvre aucun échantillon (compteur en pause, tour
// enregistré après l'arrêt) est écarté.
function buildLaps(rawLaps: any, time: number[], startTs: number | null) {
  if (!Array.isArray(rawLaps) || rawLaps.length === 0 || time.length < 2 || startTs == null) return []

  // Premier indice dont la seconde écoulée est >= `sec`.
  const indexAt = (sec: number) => {
    let lo = 0
    let hi = time.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (time[mid] < sec) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const laps: any[] = []
  for (const lap of rawLaps) {
    if (!lap || !lap.start_time) continue
    const from = Math.round((new Date(lap.start_time).getTime() - startTs) / 1000)
    const dur = numericOrNull(lap.total_elapsed_time ?? lap.total_timer_time)
    if (!Number.isFinite(from) || dur == null || dur <= 0) continue
    const startIndex = indexAt(from)
    const endIndex = indexAt(from + dur)
    if (endIndex <= startIndex) continue
    laps.push({
      lap_index: laps.length + 1,
      start_index: startIndex,
      end_index: Math.min(endIndex, time.length - 1),
      // `lap_trigger` distingue le bouton pressé à la main (« manual ») de l'auto-lap.
      lap_trigger: lap.lap_trigger ? String(lap.lap_trigger) : null,
      elapsed_time: integerOrNull(lap.total_elapsed_time),
      moving_time: integerOrNull(lap.total_timer_time),
      distance: numericOrNull(lap.total_distance),
    })
  }
  return laps
}

export function numericOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function numericOrZero(v: unknown): number {
  const n = numericOrNull(v)
  return n == null ? 0 : n
}

export function integerOrNull(v: unknown): number | null {
  const n = numericOrNull(v)
  return n == null ? null : Math.round(n)
}
