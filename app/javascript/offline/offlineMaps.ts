// Cartes hors-ligne pour la navigation : pré-télécharge le corridor du trajet en fond
// swisstopo gris (WMTS, JPEG), empaquète en une archive PMTiles unique stockée dans l'OPFS,
// puis l'expose à MapLibre via le protocole `pmtiles://`.
//
// Pourquoi swisstopo gris : c'est le seul fond utilisé en navigation dont les CGU autorisent
// explicitement l'usage hors-ligne (géodonnées OGD, gratuites y compris commercialement,
// seule condition : mention « © swisstopo »). Les autres fonds (CyclOSM, OpenTopoMap)
// interdisent le pré-téléchargement. Voir la discussion CGU du projet.
//
// Hors de la couverture suisse (France, Italie…), le WMTS ne renvoie pas d'erreur : il
// répond 200 avec une tuile JPEG uniforme de 668 octets. Le zoom maximal réellement servi
// dépend donc du lieu (z17 sur le Plateau, z15 vers Aoste, z14 vers Annecy). On descend la
// pyramide zoom par zoom : dès qu'une tuile est « vide », ses descendants le sont aussi et
// ne sont pas demandés ; les niveaux manquants sont ensuite comblés en agrandissant le
// quadrant correspondant du plus profond ancêtre réel. La carte reste ainsi lisible (mais
// floue) au-delà de la frontière, au lieu de virer au blanc quand on zoome.
import { PMTiles, FileSource, Protocol } from 'pmtiles'
import { buildPmtilesArchive, type RawTile } from './pmtilesWriter'
import { corridorTiles, corridorTilesByZoom, boundsOf, type CorridorOpts, type Tile } from './tileMath'

const GRAU_TILE = (z: number, x: number, y: number) =>
  `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/${z}/${x}/${y}.jpeg`

const OPFS_DIR = 'offline-maps'
const ATTRIBUTION = '© swisstopo'
// Poids moyen observé d'une tuile JPEG grau, pour l'estimation affichée avant téléchargement.
const AVG_TILE_BYTES = 18 * 1024
// Nombre de requêtes WMTS simultanées : un petit burst ponctuel par trajet reste compatible
// avec le fair use swisstopo (la limite ~20 req/min vise la moyenne 24/7, pas un import unique).
const CONCURRENCY = 6
// Côté d'une tuile WMTS, en pixels.
const TILE_PX = 256
// La tuile « hors couverture » de swisstopo pèse 668 o (JPEG uniforme, toujours identique).
// Toute tuile aussi légère est traitée comme vide : une tuile réelle mais unie (grand lac)
// serait de toute façon reconstruite à l'identique depuis son parent.
const BLANK_MAX_BYTES = 1024
// Qualité de ré-encodage des tuiles agrandies. L'image est déjà floue : inutile de monter.
const UPSCALE_QUALITY = 0.8

export const OFFLINE_DEFAULTS: CorridorOpts = { minZoom: 10, maxZoom: 17, bufferM: 400 }

export interface DownloadProgress { done: number; total: number; failed: number }

// L'OPFS et l'écriture par flux ne sont pas disponibles partout (Safari ancien, contextes
// non sécurisés) : on dégrade en masquant la fonctionnalité plutôt qu'en plantant.
export function offlineSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage?.getDirectory &&
    typeof CompressionStream !== 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  )
}

// Nom de fichier OPFS = clé du protocole PMTiles. Le `pmtiles://<clé>/{z}/{x}/{y}` du style
// DOIT correspondre à `FileSource.getKey()`, qui renvoie `file.name`.
function archiveName(token: string): string {
  return `route-${token.replace(/[^a-zA-Z0-9_-]/g, '')}.pmtiles`
}

export function offlineTileUrl(token: string): string {
  return `pmtiles://${archiveName(token)}/{z}/{x}/{y}`
}

async function opfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_DIR, { create: true })
}

export async function hasOfflineArchive(token: string): Promise<boolean> {
  try {
    const dir = await opfsDir()
    await dir.getFileHandle(archiveName(token))
    return true
  } catch {
    return false
  }
}

export async function deleteOfflineArchive(token: string): Promise<void> {
  try {
    const dir = await opfsDir()
    await dir.removeEntry(archiveName(token))
  } catch {
    /* déjà absent */
  }
}

async function readArchiveFile(token: string): Promise<File> {
  const dir = await opfsDir()
  const handle = await dir.getFileHandle(archiveName(token))
  return handle.getFile()
}

async function writeArchiveFile(token: string, bytes: Uint8Array): Promise<void> {
  const dir = await opfsDir()
  const handle = await dir.getFileHandle(archiveName(token), { create: true })
  const writable = await handle.createWritable()
  await writable.write(bytes as unknown as BufferSource)
  await writable.close()
}

/** Estimation (nombre de tuiles + Mo) affichée avant le téléchargement. */
export function estimateOffline(coords: [number, number][], opts: CorridorOpts = OFFLINE_DEFAULTS): { tiles: number; mb: number } {
  const tiles = corridorTiles(coords, opts).length
  return { tiles, mb: (tiles * AVG_TILE_BYTES) / (1024 * 1024) }
}

const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`

/**
 * Agrandit le quadrant (`z`,`x`,`y`) de l'image d'un ancêtre situé `d` niveaux au-dessus,
 * pour produire une tuile 256×256 plausible là où swisstopo ne sert plus de données.
 * Renvoie `null` si le navigateur n'expose pas `OffscreenCanvas` : on stocke alors
 * simplement moins de niveaux, sans faire échouer le téléchargement.
 */
async function upscaleQuadrant(bitmap: ImageBitmap, d: number, x: number, y: number): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === 'undefined') return null
  const side = TILE_PX / 2 ** d // côté du quadrant dans l'image de l'ancêtre
  const canvas = new OffscreenCanvas(TILE_PX, TILE_PX)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, (x & ((1 << d) - 1)) * side, (y & ((1 << d) - 1)) * side, side, side, 0, 0, TILE_PX, TILE_PX)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: UPSCALE_QUALITY })
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Comble les tuiles absentes de `real` en les dérivant du plus profond ancêtre réel.
 * Les tuiles à combler sont regroupées par ancêtre pour ne décoder chaque JPEG qu'une fois.
 */
async function fillMissingTiles(
  real: Map<string, Uint8Array>,
  byZoom: Map<number, Tile[]>,
  minZoom: number,
  collected: RawTile[],
): Promise<void> {
  const groups = new Map<string, { tile: Tile; d: number }[]>()
  for (const [z, tiles] of byZoom) {
    for (const t of tiles) {
      if (real.has(tileKey(z, t.x, t.y))) continue
      for (let d = 1; z - d >= minZoom; d++) {
        const ancestor = tileKey(z - d, t.x >> d, t.y >> d)
        if (!real.has(ancestor)) continue
        const group = groups.get(ancestor)
        if (group) group.push({ tile: t, d })
        else groups.set(ancestor, [{ tile: t, d }])
        break
      }
    }
  }

  for (const [ancestor, items] of groups) {
    const src = real.get(ancestor)
    if (!src) continue
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(new Blob([src as BlobPart], { type: 'image/jpeg' }))
    } catch {
      continue // JPEG illisible : on laisse ces tuiles absentes de l'archive
    }
    try {
      for (const { tile, d } of items) {
        const data = await upscaleQuadrant(bitmap, d, tile.x, tile.y)
        if (data) collected.push({ z: tile.z, x: tile.x, y: tile.y, data })
      }
    } finally {
      bitmap.close()
    }
  }
}

/**
 * Télécharge le corridor, construit l'archive PMTiles et la stocke dans l'OPFS.
 * Renvoie le nombre de tuiles effectivement stockées et la taille de l'archive.
 */
export async function downloadOfflineArchive(
  token: string,
  coords: [number, number][],
  opts: CorridorOpts = OFFLINE_DEFAULTS,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ tiles: number; bytes: number }> {
  const byZoom = corridorTilesByZoom(coords, opts)
  const total = [...byZoom.values()].reduce((n, list) => n + list.length, 0)
  const real = new Map<string, Uint8Array>() // tuiles réellement servies par swisstopo
  const blank = new Set<string>()            // tuiles hors couverture, elles ou un ancêtre
  let done = 0
  let failed = 0

  const fetchTiles = async (tiles: Tile[]): Promise<void> => {
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < tiles.length) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const t = tiles[next++]
        try {
          const res = await fetch(GRAU_TILE(t.z, t.x, t.y), { signal })
          if (res.ok) {
            const data = new Uint8Array(await res.arrayBuffer())
            if (data.length > BLANK_MAX_BYTES) real.set(tileKey(t.z, t.x, t.y), data)
            else blank.add(tileKey(t.z, t.x, t.y))
          } else {
            failed++
          }
        } catch (e) {
          if (signal?.aborted) throw e
          failed++ // erreur réseau ponctuelle : on continue, la tuile sera comblée
        }
        done++
        onProgress?.({ done, total, failed })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker))
  }

  // Descente de la pyramide : un zoom n'est demandé que là où le niveau au-dessus a
  // renvoyé des données. Un parent en échec réseau n'élague pas ses enfants — seule
  // l'absence avérée de couverture (tuile vide) le fait.
  for (let z = opts.minZoom; z <= opts.maxZoom; z++) {
    const tiles = byZoom.get(z) ?? []
    const toFetch: Tile[] = []
    for (const t of tiles) {
      if (z > opts.minZoom && blank.has(tileKey(z - 1, t.x >> 1, t.y >> 1))) {
        blank.add(tileKey(z, t.x, t.y))
        done++
      } else {
        toFetch.push(t)
      }
    }
    onProgress?.({ done, total, failed })
    await fetchTiles(toFetch)
  }

  if (real.size === 0) throw new Error('offline_no_tiles')

  const collected: RawTile[] = [...real].map(([key, data]) => {
    const [z, x, y] = key.split('/').map(Number)
    return { z, x, y, data }
  })
  await fillMissingTiles(real, byZoom, opts.minZoom, collected)

  const archive = await buildPmtilesArchive(collected, {
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    bounds: boundsOf(coords),
    attribution: ATTRIBUTION,
  })
  await writeArchiveFile(token, archive)
  return { tiles: collected.length, bytes: archive.length }
}

// ─── POI hors-ligne (localStorage) ───────────────────────────────────────────
// Sauvegarde les POI du tracé dans le localStorage au moment du téléchargement de
// l'archive hors-ligne. Clé dérivée du token (identique à l'archive PMTiles).

function poisKey(token: string): string {
  return `offline-pois-${token.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

export interface OfflinePoi { name: string; type: string; lat: number; lng: number }

export function saveOfflinePois(token: string, pois: OfflinePoi[]): void {
  try { localStorage.setItem(poisKey(token), JSON.stringify(pois)) } catch { /* quota */ }
}

export function loadOfflinePois(token: string): OfflinePoi[] {
  try {
    const raw = localStorage.getItem(poisKey(token))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function deleteOfflinePois(token: string): void {
  try { localStorage.removeItem(poisKey(token)) } catch {}
}

// ─── Lecture / MapLibre ───────────────────────────────────────────────────────

let protocol: Protocol | null = null

// Enregistre le protocole `pmtiles://` (une seule fois par page) et y attache l'archive
// du trajet. À appeler avant d'utiliser un style hors-ligne.
export async function registerOfflineArchive(token: string, maplibregl: { addProtocol: (s: string, h: unknown) => void }): Promise<void> {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
  const file = await readArchiveFile(token)
  protocol.add(new PMTiles(new FileSource(file)))
}

// Style MapLibre raster pointant sur l'archive locale (équivalent hors-ligne de swissGrauStyle).
export function offlineGrauStyle(token: string, maxZoom: number = OFFLINE_DEFAULTS.maxZoom): object {
  return {
    version: 8,
    sources: {
      'swissgrau-offline': {
        type: 'raster',
        tiles: [offlineTileUrl(token)],
        tileSize: 256,
        maxzoom: maxZoom,
        attribution: ATTRIBUTION,
      },
    },
    layers: [{ id: 'swissgrau-offline-base', type: 'raster', source: 'swissgrau-offline' }],
  }
}
