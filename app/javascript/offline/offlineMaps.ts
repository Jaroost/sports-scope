// Cartes hors-ligne pour la navigation : pré-télécharge le corridor du trajet en fond
// swisstopo gris (WMTS, JPEG), empaquète en une archive PMTiles unique stockée dans l'OPFS,
// puis l'expose à MapLibre via le protocole `pmtiles://`.
//
// Pourquoi swisstopo gris : c'est le seul fond utilisé en navigation dont les CGU autorisent
// explicitement l'usage hors-ligne (géodonnées OGD, gratuites y compris commercialement,
// seule condition : mention « © swisstopo »). Les autres fonds (CyclOSM, OpenTopoMap)
// interdisent le pré-téléchargement. Voir la discussion CGU du projet.
import { PMTiles, FileSource, Protocol } from 'pmtiles'
import { buildPmtilesArchive, type RawTile } from './pmtilesWriter'
import { corridorTiles, boundsOf, type CorridorOpts } from './tileMath'

const GRAU_TILE = (z: number, x: number, y: number) =>
  `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/${z}/${x}/${y}.jpeg`

const OPFS_DIR = 'offline-maps'
const ATTRIBUTION = '© swisstopo'
// Poids moyen observé d'une tuile JPEG grau, pour l'estimation affichée avant téléchargement.
const AVG_TILE_BYTES = 18 * 1024
// Nombre de requêtes WMTS simultanées : un petit burst ponctuel par trajet reste compatible
// avec le fair use swisstopo (la limite ~20 req/min vise la moyenne 24/7, pas un import unique).
const CONCURRENCY = 6

export const OFFLINE_DEFAULTS: CorridorOpts = { minZoom: 10, maxZoom: 16, bufferM: 400 }

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
  const tiles = corridorTiles(coords, opts)
  const total = tiles.length
  const collected: RawTile[] = []
  let done = 0
  let failed = 0
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < tiles.length) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const t = tiles[next++]
      try {
        const res = await fetch(GRAU_TILE(t.z, t.x, t.y), { signal })
        if (res.ok) {
          const data = new Uint8Array(await res.arrayBuffer())
          if (data.length > 0) collected.push({ z: t.z, x: t.x, y: t.y, data })
        } else {
          failed++
        }
      } catch (e) {
        if (signal?.aborted) throw e
        failed++ // tuile hors couverture / erreur réseau ponctuelle : on continue
      }
      done++
      onProgress?.({ done, total, failed })
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))
  if (collected.length === 0) throw new Error('offline_no_tiles')

  const archive = await buildPmtilesArchive(collected, {
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    bounds: boundsOf(coords),
    attribution: ATTRIBUTION,
  })
  await writeArchiveFile(token, archive)
  return { tiles: collected.length, bytes: archive.length }
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
