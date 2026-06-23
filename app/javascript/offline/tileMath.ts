// Calcul de l'ensemble des tuiles (z/x/y, schéma slippy Web Mercator) couvrant un
// corridor autour d'un tracé, pour le pré-téléchargement hors-ligne.

export interface Tile { z: number; x: number; y: number }
export interface CorridorOpts { minZoom: number; maxZoom: number; bufferM: number }

const EARTH_CIRC_M = 40075016.686

export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, v))
  return { x: clamp(x), y: clamp(y) }
}

// Côté au sol (m) d'une tuile à un zoom et une latitude donnés.
function tileGroundSizeM(z: number, lat: number): number {
  return (EARTH_CIRC_M * Math.cos((lat * Math.PI) / 180)) / 2 ** z
}

// Boîte englobante [minLon, minLat, maxLon, maxLat] du tracé.
export function boundsOf(coords: [number, number][]): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lng, lat] of coords) {
    if (lng < minLon) minLon = lng
    if (lng > maxLon) maxLon = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return [minLon, minLat, maxLon, maxLat]
}

// Ajoute à `set` toutes les tuiles d'un zoom couvrant le carré de demi-côté `bufferM`
// centré sur (lng, lat).
function addBufferBox(set: Set<string>, lng: number, lat: number, z: number, bufferM: number): void {
  const dLat = bufferM / 111320
  const dLng = bufferM / (111320 * Math.cos((lat * Math.PI) / 180))
  const tl = lngLatToTile(lng - dLng, lat + dLat, z) // coin haut-gauche (y croît vers le sud)
  const br = lngLatToTile(lng + dLng, lat - dLat, z)
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) set.add(`${z}/${x}/${y}`)
  }
}

// Ensemble des tuiles du corridor. Le tracé est densifié pour qu'aucune tuile ne soit
// manquée entre deux sommets éloignés, puis chaque échantillon contribue sa boîte tampon
// à chaque zoom demandé.
export function corridorTiles(coords: [number, number][], opts: CorridorOpts): Tile[] {
  const { minZoom, maxZoom, bufferM } = opts
  const set = new Set<string>()
  if (coords.length === 0) return []
  const midLat = (boundsOf(coords)[1] + boundsOf(coords)[3]) / 2

  for (let z = minZoom; z <= maxZoom; z++) {
    // Pas d'échantillonnage : assez fin pour que les boîtes tampons se recouvrent le
    // long du tracé, même au zoom le plus fin (petites tuiles).
    const stepM = Math.max(30, Math.min(bufferM, tileGroundSizeM(z, midLat) / 2))
    let prev = coords[0]
    addBufferBox(set, prev[0], prev[1], z, bufferM)
    for (let i = 1; i < coords.length; i++) {
      const cur = coords[i]
      const segM = haversineM(prev, cur)
      const steps = Math.max(1, Math.ceil(segM / stepM))
      for (let s = 1; s <= steps; s++) {
        const f = s / steps
        addBufferBox(set, prev[0] + (cur[0] - prev[0]) * f, prev[1] + (cur[1] - prev[1]) * f, z, bufferM)
      }
      prev = cur
    }
  }

  return [...set].map((k) => {
    const [z, x, y] = k.split('/').map(Number)
    return { z, x, y }
  })
}

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const la1 = (a[1] * Math.PI) / 180
  const la2 = (b[1] * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
