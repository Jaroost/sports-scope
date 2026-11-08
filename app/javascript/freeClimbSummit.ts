// Repli de la détection de col en navigation libre : quand la montée est confirmée mais
// qu'aucun col OSM n'est dans l'axe (sommet non tagué `mountain_pass`), on cherche le
// sommet DEVANT nous dans un modèle de terrain (tuiles terrarium, les mêmes que la 3D des
// cartes). Hypothèse encore plus faible qu'un col OSM : c'est le premier replat/crête du
// relief dans le cône de progression, pas un lieu nommé.
import { bearingBetween, bearingDelta, haversine } from './routeHelpers'
import type { LngLat } from './routeHelpers'

const TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const Z = 12
const M_PER_DEG = 111_320

/** Cône de recherche autour du cap, pas angulaire et pas de sondage le long de chaque rayon. */
const CONE_DEG = 40
const RAY_STEP_DEG = 10
const SAMPLE_STEP_M = 100
const MAX_RANGE_M = 6_000
/** Dénivelé minimal restant à gagner pour parler de sommet (sinon c'est un faux plat). */
const MIN_GAIN_M = 40
/** Une crête est confirmée quand le terrain redescend d'au moins ça, ou que le rayon s'arrête. */
const DROP_M = 12

type Tile = { data: Uint8ClampedArray; size: number }
const tiles = new Map<string, Promise<Tile | null>>()

function tileXY(lng: number, lat: number) {
  const n = 2 ** Z
  const x = ((lng + 180) / 360) * n
  const latR = (lat * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n
  return { x, y }
}

function loadTile(x: number, y: number): Promise<Tile | null> {
  const key = `${x}/${y}`
  let p = tiles.get(key)
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(TILES.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)))
        if (!res.ok) return null
        const bmp = await createImageBitmap(await res.blob())
        const canvas = document.createElement('canvas')
        canvas.width = bmp.width
        canvas.height = bmp.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        ctx.drawImage(bmp, 0, 0)
        return { data: ctx.getImageData(0, 0, bmp.width, bmp.height).data, size: bmp.width }
      } catch { return null }
    })()
    // Un échec ne doit pas rester en cache : on retentera au prochain appel.
    p.then((v) => { if (!v) tiles.delete(key) })
    tiles.set(key, p)
  }
  return p
}

/** Altitude (m) en un point, depuis les tuiles déjà chargées par `ensureTiles`. */
function elevationFrom(loaded: Map<string, Tile>, lng: number, lat: number): number | null {
  const { x, y } = tileXY(lng, lat)
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  const tile = loaded.get(`${tx}/${ty}`)
  if (!tile) return null
  const px = Math.min(tile.size - 1, Math.floor((x - tx) * tile.size))
  const py = Math.min(tile.size - 1, Math.floor((y - ty) * tile.size))
  const i = (py * tile.size + px) * 4
  return tile.data[i] * 256 + tile.data[i + 1] + tile.data[i + 2] / 256 - 32768
}

function destination(from: LngLat, bearingDeg: number, distM: number): LngLat {
  const r = (bearingDeg * Math.PI) / 180
  const lat = from[1] + (Math.cos(r) * distM) / M_PER_DEG
  const lng = from[0] + (Math.sin(r) * distM) / (M_PER_DEG * Math.cos((from[1] * Math.PI) / 180))
  return [lng, lat]
}

export interface SummitGuess { lng: number; lat: number; distanceM: number; gainM: number }

/**
 * Le sommet le plus proche dans le cône de progression, ou null (pas de terrain, pas de
 * crête assez haute dans la portée, hors ligne). `alt` est l'altitude GPS actuelle, mais
 * l'écart se mesure en terrain-contre-terrain pour ne pas mélanger deux référentiels.
 */
export async function findSummitAhead(here: LngLat, bearing: number): Promise<SummitGuess | null> {
  // Points de sondage, calculés d'abord pour savoir quelles tuiles charger.
  const rays: { angle: number; pts: LngLat[] }[] = []
  for (let a = -CONE_DEG; a <= CONE_DEG; a += RAY_STEP_DEG) {
    const pts: LngLat[] = []
    for (let d = SAMPLE_STEP_M; d <= MAX_RANGE_M; d += SAMPLE_STEP_M) pts.push(destination(here, bearing + a, d))
    rays.push({ angle: a, pts })
  }

  const needed = new Set<string>()
  for (const p of [here, ...rays.flatMap((r) => r.pts)]) {
    const { x, y } = tileXY(p[0], p[1])
    needed.add(`${Math.floor(x)}/${Math.floor(y)}`)
  }
  const loaded = new Map<string, Tile>()
  await Promise.all([...needed].map(async (k) => {
    const [x, y] = k.split('/').map(Number)
    const tile = await loadTile(x, y)
    if (tile) loaded.set(k, tile)
  }))

  const base = elevationFrom(loaded, here[0], here[1])
  if (base == null) return null

  let best: (SummitGuess & { score: number }) | null = null
  for (const ray of rays) {
    let peakI = -1
    let peakEle = base
    for (let i = 0; i < ray.pts.length; i++) {
      const ele = elevationFrom(loaded, ray.pts[i][0], ray.pts[i][1])
      if (ele == null) break
      if (ele > peakEle) { peakEle = ele; peakI = i }
      // Crête passée : le terrain est retombé nettement sous le point haut.
      else if (peakI >= 0 && peakEle - ele >= DROP_M) break
    }
    if (peakI < 0 || peakEle - base < MIN_GAIN_M) continue
    const [lng, lat] = ray.pts[peakI]
    const distanceM = haversine(here, [lng, lat])
    // Le plus proche l'emporte, l'axe du cap départage (un sommet pile devant vaut mieux
    // qu'un sommet de côté à même distance).
    const score = distanceM + Math.abs(ray.angle) * 10
    if (!best || score < best.score) best = { lng, lat, distanceM, gainM: peakEle - base, score }
  }
  return best ? { lng: best.lng, lat: best.lat, distanceM: best.distanceM, gainM: best.gainM } : null
}

/** Une devinette de sommet reste valable tant qu'elle est devant et pas atteinte. */
export function summitStillAhead(here: LngLat, bearing: number, s: { lng: number; lat: number }): boolean {
  const d = haversine(here, [s.lng, s.lat])
  return d > 40 && Math.abs(bearingDelta(bearing, bearingBetween(here, [s.lng, s.lat]))) <= 60
}
