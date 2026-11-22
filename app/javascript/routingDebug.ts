import { BROUTER_URL } from './brouter'
import { brouterProfileQuery, buildSpec, paramDef, paramKeysFor, parseSpec, effectiveValue } from './routingProfile'
import type { ParamValue } from './routingProfile'
import { t } from './i18n'
import type { Coord, LngLat } from './routeHelpers'
import type { LegWaypoint } from './brouterLegs'

// Débogage d'un profil de routage : pourquoi BRouter passe ici et pas là ?
//
// BRouter ne renvoie pas ses raisons, mais il renvoie de quoi les reconstituer. Avec
// `format=geojson`, chaque tronçon porte un tableau `messages` dont chaque ligne décrit un
// nœud du tracé : le coût au km de la voie qui y mène (`CostPerKm`, 1000 = coût neutre),
// ses tags OSM tels que le profil les a vus (`WayTags`), et les surcoûts de dénivelé / de
// virage / de nœud. Trois lectures en découlent, toutes ici :
//
//   1. colorer le tracé par coût au km (`fetchCostProfile`) ;
//   2. forcer le passage par un point et comparer au tracé retenu (`probePoint`) ;
//   3. relâcher les réglages un par un et voir lesquels font passer le tracé par ce point
//      (`tryRelaxations`) — c'est la seule façon fiable d'attribuer le refus à une variable,
//      le coût d'une voie étant le produit de plusieurs règles du .brf.
//
// Aucune de ces requêtes n'est mise en cache ni partagée avec brouterLegs : ce sont des
// requêtes de diagnostic, à la demande, avec leurs messages (que le cache de tronçons ne
// garde pas).

// Coût neutre d'une voie, en `CostPerKm` (facteur 1 = 1000 par km).
const NEUTRAL_COST_PER_KM = 1000

// Au-delà de cette distance au tracé, un point n'est pas « sur » le tracé.
export const ON_ROUTE_M = 15
// Un tracé qui passe à moins de cela du point visé « passe par là » (variantes).
const PASSES_THROUGH_M = 20

const MAX_CONCURRENCY = 4

export interface WayRun {
  // Tags OSM de la voie, tels que BRouter les expose (`highway=track surface=gravel`).
  tags: Record<string, string>
  tagsText: string
  coords: LngLat[]
  distanceM: number
  // Coût moyen au km sur la section, pondéré par la distance.
  costPerKm: number
  // costPerKm rapporté au coût neutre : 1 = voie idéale, 3 = trois fois plus chère…
  factor: number
  elevCost: number
  turnCost: number
}

export interface DebugLeg {
  coords: Coord[]
  lengthM: number
  // Coût total BRouter du tronçon (propriété `cost`), tous surcoûts compris.
  cost: number
  runs: WayRun[]
}

export type DebugOutcome = { ok: true; leg: DebugLeg } | { ok: false; error: string }

function parseTags(text: string): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const part of text.split(' ')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq < 0) tags[part] = ''
    else tags[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return tags
}

const micro = (deg: number): number => Math.round(deg * 1e6)

// Regroupe les lignes de `messages` en sections de même voie. Une ligne décrit le lien qui
// ARRIVE sur son nœud ; les coordonnées du tracé comprennent en plus des points de forme
// entre deux nœuds, d'où l'appariement par (lon, lat) en micro-degrés, avec un curseur qui
// ne recule jamais (un tracé peut repasser deux fois au même endroit).
export function parseRuns(coords: Coord[], messages: unknown): WayRun[] {
  if (!Array.isArray(messages) || messages.length < 2) return []
  const header = messages[0] as string[]
  const col = (name: string): number => header.indexOf(name)
  const iLon = col('Longitude'), iLat = col('Latitude'), iDist = col('Distance')
  const iCost = col('CostPerKm'), iElev = col('ElevCost'), iTurn = col('TurnCost'), iTags = col('WayTags')
  if ([iLon, iLat, iDist, iCost, iTags].some((i) => i < 0)) return []

  const keys = coords.map((c) => `${micro(c[0])},${micro(c[1])}`)
  const runs: WayRun[] = []
  let cursor = 0
  let prevEnd = 0
  for (let r = 1; r < messages.length; r++) {
    const row = messages[r] as string[]
    const end = keys.indexOf(`${row[iLon]},${row[iLat]}`, cursor)
    if (end < 0 || end < prevEnd) continue
    cursor = end
    const dist = Number(row[iDist]) || 0
    const cost = Number(row[iCost]) || 0
    const tagsText = row[iTags] ?? ''
    const stretch: LngLat[] = coords.slice(prevEnd, end + 1).map((c) => [c[0], c[1]])
    prevEnd = end
    if (stretch.length < 2) continue

    const last = runs[runs.length - 1]
    if (last && last.tagsText === tagsText) {
      // Même voie : on prolonge. Le coût moyen est repondéré par la distance.
      const total = last.distanceM + dist
      last.costPerKm = total > 0 ? (last.costPerKm * last.distanceM + cost * dist) / total : last.costPerKm
      last.factor = last.costPerKm / NEUTRAL_COST_PER_KM
      last.distanceM = total
      last.elevCost += Number(row[iElev]) || 0
      last.turnCost += Number(row[iTurn]) || 0
      last.coords.push(...stretch.slice(1))
    } else {
      runs.push({
        tags: parseTags(tagsText),
        tagsText,
        coords: stretch,
        distanceM: dist,
        costPerKm: cost,
        factor: cost / NEUTRAL_COST_PER_KM,
        elevCost: Number(row[iElev]) || 0,
        turnCost: Number(row[iTurn]) || 0,
      })
    }
  }
  return runs
}

const lonlat = (p: LngLat): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`

// Un tronçon à 2 points, avec ses messages. Les erreurs BRouter sont du texte brut
// (`datafile E0_N0.rd5 not found`, `no track found`…) : on les rend telles quelles, c'est
// précisément ce qu'on veut lire.
export async function fetchDebugLeg(from: LngLat, to: LngLat, spec: string, signal?: AbortSignal): Promise<DebugOutcome> {
  const url = `${BROUTER_URL}?lonlats=${lonlat(from)}|${lonlat(to)}&${brouterProfileQuery(spec)}&alternativeidx=0&format=geojson`
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e
    return { ok: false, error: e?.message || 'network error' }
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim()
    return { ok: false, error: text || `BRouter HTTP ${res.status}` }
  }
  const data = await res.json().catch(() => null)
  const feature = data?.features?.[0]
  const raw = feature?.geometry?.coordinates
  if (!Array.isArray(raw) || raw.length < 2) return { ok: false, error: 'no route' }
  const coords = raw.map((c: number[]) => [c[0], c[1], c.length > 2 ? c[2] : null]) as Coord[]
  const length = parseFloat(feature.properties?.['track-length'] || '0')
  const cost = parseFloat(feature.properties?.cost || '0')
  return {
    ok: true,
    leg: {
      coords,
      lengthM: Number.isFinite(length) ? length : 0,
      cost: Number.isFinite(cost) ? cost : 0,
      runs: parseRuns(coords, feature.properties?.messages),
    },
  }
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await task(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ─── 1. Le tracé, tronçon par tronçon, avec ses coûts ────────────────────────

export interface CostLeg {
  // Tronçon en ligne droite (point « libre ») : pas de voie, donc pas de coût.
  straight: boolean
  outcome: DebugOutcome | null
}

export async function fetchCostProfile(waypoints: LegWaypoint[], spec: string, signal: AbortSignal): Promise<CostLeg[]> {
  const idx = Array.from({ length: Math.max(0, waypoints.length - 1) }, (_, i) => i)
  return mapLimit(idx, MAX_CONCURRENCY, async (i): Promise<CostLeg> => {
    if (waypoints[i + 1].free) return { straight: true, outcome: null }
    const outcome = await fetchDebugLeg(
      [waypoints[i].lng, waypoints[i].lat],
      [waypoints[i + 1].lng, waypoints[i + 1].lat],
      spec,
      signal,
    )
    return { straight: false, outcome }
  })
}

// ─── Géométrie ───────────────────────────────────────────────────────────────

// Distance d'un point à une polyligne, en mètres (projection locale équirectangulaire :
// l'erreur est négligeable aux échelles d'un tronçon).
export function distanceToPolyline(p: LngLat, line: Array<Coord | LngLat>): number {
  if (!line.length) return Infinity
  const k = Math.cos((p[1] * Math.PI) / 180)
  const M = 111320
  let best = Infinity
  for (let i = 0; i < line.length; i++) {
    const ax = (line[i][0] - p[0]) * k * M, ay = (line[i][1] - p[1]) * M
    if (i === 0 && line.length === 1) return Math.hypot(ax, ay)
    if (i === line.length - 1) break
    const bx = (line[i + 1][0] - p[0]) * k * M, by = (line[i + 1][1] - p[1]) * M
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    const d = Math.hypot(ax + f * dx, ay + f * dy)
    if (d < best) best = d
  }
  return best
}

// ─── 2. Forcer le passage par un point ───────────────────────────────────────

export interface ProbeResult {
  legIndex: number
  point: LngLat
  // Le tracé actuel passe déjà par là : on inspecte, on ne force rien.
  onRoute: boolean
  // Distance du point cliqué à la voie routable la plus proche (BRouter y « accroche » le
  // point). Grande = la voie visée n'est pas dans le graphe de routage de ce profil.
  snapM: number | null
  currentCost: number
  currentLengthM: number
  // Tracé forcé par le point (absent si on est sur le tracé, ou si le routage a échoué).
  forcedCoords: Coord[] | null
  forcedCost: number
  forcedLengthM: number
  error: string | null
  // Voies proches du point, dans l'ordre du parcours.
  nearby: WayRun[]
}

// Tronçon (hors lignes droites) le plus proche d'un point.
export function nearestLeg(p: LngLat, legs: CostLeg[]): { index: number; distM: number } | null {
  let best: { index: number; distM: number } | null = null
  legs.forEach((l, i) => {
    if (l.straight || !l.outcome?.ok) return
    const d = distanceToPolyline(p, l.outcome.leg.coords)
    if (!best || d < best.distM) best = { index: i, distM: d }
  })
  return best
}

// Voies d'un tracé dans le voisinage du point : la plus proche et celles qui la touchent
// dans la fenêtre de recherche — de quoi lire « ce qu'il y a là » sans noyer le tableau.
function runsNear(runs: WayRun[], p: LngLat, radiusM: number): WayRun[] {
  return runs.filter((r) => distanceToPolyline(p, r.coords) <= radiusM)
}

export async function probePoint(
  point: LngLat,
  legIndex: number,
  waypoints: LegWaypoint[],
  current: DebugLeg,
  spec: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const base = {
    legIndex,
    point,
    currentCost: current.cost,
    currentLengthM: current.lengthM,
  }
  const onTrack = distanceToPolyline(point, current.coords)
  if (onTrack <= ON_ROUTE_M) {
    return {
      ...base,
      onRoute: true,
      snapM: onTrack,
      forcedCoords: null,
      forcedCost: current.cost,
      forcedLengthM: current.lengthM,
      error: null,
      nearby: runsNear(current.runs, point, ON_ROUTE_M + 25),
    }
  }

  const from: LngLat = [waypoints[legIndex].lng, waypoints[legIndex].lat]
  const to: LngLat = [waypoints[legIndex + 1].lng, waypoints[legIndex + 1].lat]
  // Deux requêtes à 2 points plutôt qu'une à 3 : BRouter supprime les demi-tours aux points
  // de passage d'une requête multiple, et un point sur une impasse disparaîtrait du tracé
  // (cf. brouterLegs) — or c'est exactement le coût de l'aller-retour qu'on veut voir.
  const [a, b] = await Promise.all([fetchDebugLeg(from, point, spec, signal), fetchDebugLeg(point, to, spec, signal)])
  if (a.ok === false || b.ok === false) {
    const failed = a.ok === false ? a : (b as { ok: false; error: string })
    return {
      ...base,
      onRoute: false,
      snapM: null,
      forcedCoords: null,
      forcedCost: 0,
      forcedLengthM: 0,
      error: failed.error,
      nearby: [],
    }
  }
  const coords = [...a.leg.coords, ...b.leg.coords.slice(1)]
  const snapM = distanceToPolyline(point, coords)
  return {
    ...base,
    onRoute: false,
    snapM,
    forcedCoords: coords,
    forcedCost: a.leg.cost + b.leg.cost,
    forcedLengthM: a.leg.lengthM + b.leg.lengthM,
    error: null,
    nearby: runsNear([...a.leg.runs, ...b.leg.runs], point, Math.max(40, snapM + 30)),
  }
}

// ─── 3. Quel réglage ? ───────────────────────────────────────────────────────

export interface Relaxation {
  key: string
  value: ParamValue
  from: ParamValue
}

// Réglages à essayer pour rendre un passage plus attractif : une valeur « relâchée » par
// variable, jamais plusieurs à la fois. Les extrêmes suffisent : abaisser un coût ne peut
// que rendre une voie plus attirante, et si le plus bas ne suffit pas, un intermédiaire non
// plus (à la nuance près que les autres voies suivent aussi — d'où le relevé du tracé
// obtenu, que l'utilisateur voit avant d'appliquer).
export function relaxationCandidates(spec: string): Relaxation[] {
  const { base } = parseSpec(spec)
  const out: Relaxation[] = []
  for (const key of paramKeysFor(base)) {
    const def = paramDef(key)
    if (!def) continue
    const cur = effectiveValue(spec, key)
    const add = (value: ParamValue) => {
      if (value !== cur) out.push({ key, value, from: cur })
    }
    if (def.type === 'bool') {
      // Un `allow_*` déjà vrai ne se relâche pas davantage.
      if (key.startsWith('allow_') && cur === true) continue
      add(!cur)
    } else if (def.type === 'choice') {
      const values = def.values!
      if (def.labels === 'sac' || def.labels === 'mtb') add(Math.max(...values))
      else add(Math.min(...values))
    } else {
      // Nombre : le sens de « relâcher » dépend de la variable (poids d'un trottoir,
      // surcoût de pente…), on essaie donc les deux bornes.
      add(def.min!)
      add(def.max!)
    }
  }
  return out
}

export interface RelaxationResult extends Relaxation {
  spec: string
  // Le tracé obtenu passe par le point visé.
  passes: boolean
  coords: Coord[]
  lengthM: number
}

// `through` : le tronçon from → to doit se mettre à passer par `point`. `reach` : `point` est
// injoignable avec le réglage actuel, et on cherche ce qui le rend joignable depuis `from`.
export async function tryRelaxations(
  mode: 'through' | 'reach',
  from: LngLat,
  to: LngLat,
  point: LngLat,
  spec: string,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<RelaxationResult[]> {
  const { base, params } = parseSpec(spec)
  const candidates = relaxationCandidates(spec)
  let done = 0
  const results = await mapLimit(candidates, MAX_CONCURRENCY, async (c): Promise<RelaxationResult | null> => {
    const variant = buildSpec(base, { ...params, [c.key]: c.value })
    const out = await fetchDebugLeg(from, mode === 'reach' ? point : to, variant, signal)
    onProgress?.(++done, candidates.length)
    if (!out.ok) return null
    return {
      ...c,
      spec: variant,
      passes: mode === 'reach' || distanceToPolyline(point, out.leg.coords) <= PASSES_THROUGH_M,
      coords: out.leg.coords,
      lengthM: out.leg.lengthM,
    }
  })
  return results.filter((r): r is RelaxationResult => r != null && r.passes)
}

// ─── Présentation ────────────────────────────────────────────────────────────

// Stops de la rampe de couleur du coût au km (facteur → couleur) : vert = voie idéale,
// rouge = très évitée, violet = quasi interdite. Partagée par le calque et la légende.
export const COST_COLOR_STOPS: Array<[number, string]> = [
  [1, '#16a34a'],
  [1.25, '#84cc16'],
  [1.6, '#eab308'],
  [2.2, '#f97316'],
  [3.5, '#dc2626'],
  [10, '#7e22ce'],
]

export function costColor(factor: number): string {
  if (factor <= COST_COLOR_STOPS[0][0]) return COST_COLOR_STOPS[0][1]
  for (let i = 1; i < COST_COLOR_STOPS.length; i++) {
    if (factor <= COST_COLOR_STOPS[i][0]) return COST_COLOR_STOPS[i][1]
  }
  return COST_COLOR_STOPS[COST_COLOR_STOPS.length - 1][1]
}

// Tags à montrer en premier : ce sont ceux sur lesquels les .brf décident.
const TAG_PRIORITY = [
  'highway', 'surface', 'tracktype', 'smoothness', 'sac_scale', 'mtb:scale', 'bicycle', 'foot', 'access',
  'oneway', 'cycleway', 'sidewalk', 'route', 'incline', 'maxspeed',
]

export function sortedTags(tags: Record<string, string>): Array<[string, string]> {
  const rank = (k: string): number => {
    const i = TAG_PRIORITY.indexOf(k)
    return i < 0 ? TAG_PRIORITY.length : i
  }
  return Object.entries(tags).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
}

const COST_LABEL: Record<number, string> = { 1: 'allowed', 2: 'avoided', 10000: 'forbidden' }
const LEVEL_LABEL: Record<number, string> = { 1: 'ideal', 1.5: 'slight', 3: 'avoided', 10: 'strong', 10000: 'forbidden' }

// Valeur d'un réglage, comme l'éditeur de profil l'écrit (RoutingProfileEditor.choiceLabel).
export function paramValueLabel(key: string, v: ParamValue): string {
  const def = paramDef(key)
  if (typeof v === 'boolean') return t(v ? 'routes.routing_debug.on' : 'routes.routing_debug.off')
  if (def?.type === 'choice') {
    switch (def.labels) {
      case 'sac': return `T${v}`
      case 'mtb': return `S${v}`
      case 'level': return t(`routes.routing_profile.level.${LEVEL_LABEL[v]}`)
      default: return t(`routes.routing_profile.cost.${COST_LABEL[v]}`)
    }
  }
  return String(v)
}

// Message BRouter → clé de traduction qui l'explique, ou null (le texte brut est alors
// affiché tel quel). Les formulations sont celles du moteur (RoutingEngine / BRouterWorker).
export function explainErrorKey(error: string): string | null {
  if (/datafile .* not found/i.test(error)) return 'routes.routing_debug.err_datafile'
  if (/island/i.test(error)) return 'routes.routing_debug.err_island'
  if (/timeout|killed/i.test(error)) return 'routes.routing_debug.err_timeout'
  if (/no track found|no route|not mapped/i.test(error)) return 'routes.routing_debug.err_no_track'
  return null
}
