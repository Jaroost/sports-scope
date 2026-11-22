#!/usr/bin/env node
// Mesure, une fois pour toutes, où et jusqu'à quel zoom chaque fond régional distribue de
// vraies tuiles, et écrit le résultat dans app/javascript/styleCoverage.json.
// Au runtime, mapStyles.ts ne fait plus que consulter cette table (aucune requête).
//
//   node script/build-style-coverage.mjs                 # tous les fonds
//   node script/build-style-coverage.mjs swisstopo ignplan
//   CONCURRENCY=4 node script/...                        # politesse envers les serveurs
//
// Principe : une grille quadtree. On part de cellules z8 sur la bbox du groupe (élargie), on
// échantillonne chaque cellule sur 4×4 points (tuiles z13). Tout plein ou tout vide : feuille.
// Mixte : on subdivise, jusqu'à z13 (~3 km), puis vote à la majorité. Pour chaque feuille
// couverte on garde `maxZoom`, le plus haut zoom qui a du contenu (cherché par dichotomie).
//
// Les critères de « tuile vide » reprennent ceux qu'avait la sonde du navigateur : 404/400,
// ou réponse plus petite que `blankMaxBytes`, ou (plan IGN) aucune route en dehors de la France.
// Ici on a le temps : 3 essais, délais longs, et une tuile qu'on n'arrive pas à lire n'est
// JAMAIS écrite comme vide — le script s'arrête en erreur plutôt que de mentir.
import { inflateSync } from 'node:zlib'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'javascript', 'styleCoverage.json')
const CONCURRENCY = Number(process.env.CONCURRENCY || 6)
const START_Z = 8
const END_Z = 13
const SAMPLE_Z = 13
const LATTICE = 4

// ─── Fonds (à garder alignés avec mapStyles.ts : mêmes URL, mêmes maxzoom) ─────────────
const swiss = (layer, ext) => ({
  group: 'swiss', maxzoom: 19, blankMaxBytes: 700,
  url: `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${ext}`,
})
const ign = (layer, format, needsRoads = false) => ({
  group: 'france', maxzoom: 19, needsRoads,
  url: `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&FORMAT=${format}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
})
const at = (layer, ext, blankMaxBytes) => ({
  group: 'austria', maxzoom: 19, blankMaxBytes,
  url: `https://maps.wien.gv.at/basemap/${layer}/normal/google3857/{z}/{y}/{x}.${ext}`,
})
const de = (path) => ({
  group: 'germany', maxzoom: 18, blankMaxBytes: 1000,
  url: `https://sgx.geodatenzentrum.de/${path}/{z}/{y}/{x}.png`,
})
// Contour grossier de la Suisse (copie de SWISS_OUTLINE, mapStyles.ts), marge comprise. SWISSIMAGE
// sert en dehors du pays une mosaïque basse résolution (Lyon, Milan, Annecy servis jusqu'à z19, mais
// en gros pixels) : une vraie tuile, donc ni 404 ni tuile blanche, et pourtant illisible. On ne la
// compte pas comme couverture : hors de ce contour, l'échantillon est déclaré vide.
const SWISS_OUTLINE = [
  [5.95, 46.12], [6.10, 46.38], [6.30, 46.62], [6.45, 46.85], [6.75, 47.08],
  [6.95, 47.30], [7.05, 47.52], [7.60, 47.62], [8.40, 47.68], [8.65, 47.82],
  [9.20, 47.72], [9.55, 47.55], [9.60, 47.20], [9.65, 46.90], [10.10, 46.85],
  [10.55, 46.95], [10.55, 46.55], [10.20, 46.20], [9.40, 46.30], [9.20, 45.80],
  [8.70, 45.90], [8.40, 46.10], [7.70, 45.90], [7.10, 45.85], [6.88, 46.05],
  [6.80, 46.20], [6.82, 46.38], [6.50, 46.44], [6.25, 46.30],
  [6.28, 46.17], [6.15, 46.12], // canton de Genève : sans ces deux points l'arête coupait la ville
]
function inPolygon(lng, lat, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const STYLES = {
  swissgrau:  swiss('ch.swisstopo.pixelkarte-grau', 'jpeg'),
  swisstopo:  swiss('ch.swisstopo.pixelkarte-farbe', 'jpeg'),
  swissimage: { ...swiss('ch.swisstopo.swissimage', 'jpeg'), clip: SWISS_OUTLINE },
  ignplan:    ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png', true),
  ignortho:   ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
  atbasemap:  at('geolandbasemap', 'png', 300),
  atgrau:     at('bmapgrau', 'png', 300),
  atortho:    at('bmaporthofoto30cm', 'jpeg', 3000),
  debasemap:  de('wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR'),
  degrau:     de('wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_grau/default/GLOBAL_WEBMERCATOR'),
}

// Zone de recherche par groupe, [minLng, minLat, maxLng, maxLat], volontairement plus large
// que le pays : ce qui est hors de la table compte comme « pas couvert ».
const SEARCH_BBOX = {
  swiss:   [5.4, 45.4, 11.1, 48.3],
  france:  [-5.8, 40.9, 9.8, 51.6],
  austria: [8.9, 45.9, 17.7, 49.5],
  germany: [5.3, 46.8, 15.6, 55.4],
}

// ─── Maths de tuiles ───────────────────────────────────────────────────────────────────
const lngToX = (lng, z) => ((lng + 180) / 360) * 2 ** z
const latToY = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z
const xToLng = (x, z) => (x / 2 ** z) * 360 - 180
const yToLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI

// ─── PNG minimal (RVB / RVBA 8 bits, entrelacement absent) pour le test des routes IGN ──
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0, depth = 0, palette = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9] }
    else if (type === 'PLTE') palette = data
    else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (depth !== 8 || ![2, 3, 6].includes(colorType)) throw new Error(`PNG non géré (type ${colorType}, ${depth} bits)`)
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + i] : 0
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0
      let v = src[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + i] = v & 255
    }
  }
  return { width, height, bpp, colorType, px, palette }
}

// Même critère que l'ancien hasRoadPixels du navigateur : pixels « de route » orange/jaune.
const ROAD_PIXEL_MIN_SHARE = 0.0005
function hasRoadPixels(buf) {
  const { width, height, bpp, colorType, px, palette } = decodePng(buf)
  let roads = 0
  for (let i = 0; i < width * height; i++) {
    let r, b
    if (colorType === 3) { r = palette[px[i] * 3]; b = palette[px[i] * 3 + 2] }
    else { r = px[i * bpp]; b = px[i * bpp + 2] }
    if (r > 180 && r - b > 45) roads++
  }
  return roads / (width * height) >= ROAD_PIXEL_MIN_SHARE
}

// ─── Réseau : file à concurrence bornée, 3 essais, jamais de « vide » par défaut ───────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let inFlight = 0
const waiting = []
async function slot() {
  if (inFlight >= CONCURRENCY) await new Promise((r) => waiting.push(r))
  inFlight++
}
function release() { inFlight--; waiting.shift()?.() }

const tileCache = new Map()
// true = vraie tuile, false = vide/absente. Lève si le serveur reste illisible.
async function tileHasContent(name, z, x, y, outsideFrance) {
  const key = `${name}|${z}|${x}|${y}`
  if (tileCache.has(key)) return tileCache.get(key)
  const def = STYLES[name]
  const url = def.url.replace('{z}', z).replace('{x}', x).replace('{y}', y)
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    await slot()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      let verdict
      if (res.status === 404 || res.status === 400) verdict = false
      else if (!res.ok) throw new Error(`HTTP ${res.status}`)
      else {
        const buf = Buffer.from(await res.arrayBuffer())
        if (def.blankMaxBytes && buf.length <= def.blankMaxBytes) verdict = false
        else if (def.needsRoads && outsideFrance) verdict = hasRoadPixels(buf)
        else verdict = true
      }
      tileCache.set(key, verdict)
      return verdict
    } catch (e) {
      lastErr = e
      await sleep(1500 * (attempt + 1))
    } finally {
      release()
    }
  }
  throw new Error(`tuile illisible ${url} : ${lastErr?.message}`)
}

// « hors de France » pour le test des routes : approximé par le rectangle principal du pays,
// comme l'ancien code — sans polygone, on reste du côté strict (demande des routes) hors bbox.
const FRANCE_CORE = [-5.2, 41.2, 7.1, 51.2]
const inFranceCore = (lng, lat) => lng >= FRANCE_CORE[0] && lng <= FRANCE_CORE[2] && lat >= FRANCE_CORE[1] && lat <= FRANCE_CORE[3]

// ─── Quadtree ──────────────────────────────────────────────────────────────────────────
// Points d'échantillonnage (tuiles z13) d'une cellule (z, x, y).
function lattice(z, x, y) {
  const span = 2 ** (SAMPLE_Z - z)
  const pts = []
  for (let i = 0; i < LATTICE; i++) {
    for (let j = 0; j < LATTICE; j++) {
      pts.push([Math.floor(x * span + ((i + 0.5) / LATTICE) * span), Math.floor(y * span + ((j + 0.5) / LATTICE) * span)])
    }
  }
  return pts
}

async function samplePoint(name, sx, sy) {
  const lng = xToLng(sx + 0.5, SAMPLE_Z), lat = yToLat(sy + 0.5, SAMPLE_Z)
  if (STYLES[name].clip && !inPolygon(lng, lat, STYLES[name].clip)) return { sx, sy, lng, lat, ok: false }
  const ok = await tileHasContent(name, SAMPLE_Z, sx, sy, !inFranceCore(lng, lat))
  return { sx, sy, lng, lat, ok }
}

// Plus haut zoom (≤ maxzoom) où la tuile du point a du contenu. Couverture emboîtée, donc
// dichotomie. On sait déjà qu'elle en a à SAMPLE_Z.
async function maxZoomAt(name, sx, sy) {
  const def = STYLES[name]
  const at = (z) => {
    const f = 2 ** (z - SAMPLE_Z)
    const x = Math.floor((sx + 0.5) * f), y = Math.floor((sy + 0.5) * f)
    const lng = xToLng(x + 0.5, z), lat = yToLat(y + 0.5, z)
    return tileHasContent(name, z, x, y, !inFranceCore(lng, lat))
  }
  if (await at(def.maxzoom)) return def.maxzoom
  let lo = SAMPLE_Z, hi = def.maxzoom // lo a du contenu, hi non
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (await at(mid)) lo = mid; else hi = mid
  }
  return lo
}

async function classify(name, z, x, y, leaves) {
  const samples = await Promise.all(lattice(z, x, y).map(([sx, sy]) => samplePoint(name, sx, sy)))
  const full = samples.filter((s) => s.ok)
  if (full.length === 0) return
  if (full.length === samples.length || z >= END_Z) {
    if (full.length < samples.length && full.length * 2 < samples.length) return // majorité vide
    const zooms = await Promise.all(full.map((s) => maxZoomAt(name, s.sx, s.sy)))
    // Pas le minimum : une zone uniforme (lac, forêt, névé) donne à fort zoom une tuile plus petite
    // que `blankMaxBytes` sans que le serveur cesse de la servir — un seul échantillon de ce genre
    // plafonnerait toute la cellule (swissgrau à Boudry sortait à z13 au lieu de z19). Le 75e
    // centile : les rares échantillons « vides par nature » ne comptent plus.
    zooms.sort((a, b) => a - b)
    const at = (q) => zooms[Math.floor((zooms.length - 1) * q)]
    // Une cellule entièrement servie peut l'être à des zooms très différents : swisstopo sert
    // aussi les abords français, mais seulement jusqu'à z14-16, contre z19 en Suisse. Une seule
    // valeur par cellule fausserait un côté de la frontière (Biaufond sortait à z14 au lieu de z19
    // parce qu'une cellule z8 de 150 km était une feuille). Étendue entre 10e et 90e centile ≥ 2 (un quart de Suisse dans une cellule française ne se verrait pas à l'interquartile) : on affine.
    if (z < END_Z && at(0.9) - at(0.1) >= 2) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) await classify(name, z + 1, x * 2 + dx, y * 2 + dy, leaves)
      return
    }
    leaves.push([z, x, y, at(0.75)])
    return
  }
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) await classify(name, z + 1, x * 2 + dx, y * 2 + dy, leaves)
}

async function buildStyle(name) {
  const [w, s, e, n] = SEARCH_BBOX[STYLES[name].group]
  const x0 = Math.floor(lngToX(w, START_Z)), x1 = Math.floor(lngToX(e, START_Z))
  const y0 = Math.floor(latToY(n, START_Z)), y1 = Math.floor(latToY(s, START_Z))
  const jobs = []
  const leaves = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(classify(name, START_Z, x, y, leaves))
  await Promise.all(jobs)
  leaves.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  return leaves
}

// ─── Programme ─────────────────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(STYLES)
for (const n of names) if (!STYLES[n]) { console.error(`fond inconnu : ${n}`); process.exit(1) }

const table = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { styles: {} }
table.generatedAt = new Date().toISOString().slice(0, 10)
table.startZoom = START_Z
table.endZoom = END_Z
for (const name of names) {
  const t0 = Date.now()
  const leaves = await buildStyle(name)
  // Format plat [z, x, y, maxZoom, z, x, y, maxZoom, …] : le JSON reste petit une fois gzippé.
  table.styles[name] = leaves.flat()
  console.log(`${name}: ${leaves.length} cellules, ${tileCache.size} tuiles lues, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  writeFileSync(OUT, JSON.stringify(table))
}
console.log(`→ ${OUT}`)
