// Écrivain PMTiles v3 minimal (côté navigateur), réservé aux petites archives raster
// d'un corridor d'itinéraire. La gem `pmtiles` ne fournit qu'un lecteur ; on réutilise
// son `zxyToTileId` (courbe de Hilbert) pour rester strictement compatible avec lui.
//
// Choix de format, alignés sur le lecteur (cf. dist/cjs de `pmtiles`) :
//   - répertoire racine unique (pas de répertoires « leaf ») : suffisant pour ~quelques
//     milliers de tuiles, et il tient dans les 16384 premiers octets que le lecteur lit
//     d'un coup au démarrage (d'où la compression gzip du répertoire pour garder la marge).
//   - compression interne (header + répertoire) = gzip ; compression des tuiles = aucune
//     (les JPEG swisstopo sont déjà compressés).
//   - archive « clustered » : entrées triées par tileId, données concaténées dans le même
//     ordre → les offsets se déduisent en chaîne (encodage court « 0 » du lecteur).
import { zxyToTileId } from 'pmtiles'

export interface RawTile { z: number; x: number; y: number; data: Uint8Array }

export interface PmtilesMeta {
  minZoom: number
  maxZoom: number
  /** [minLon, minLat, maxLon, maxLat] en degrés. */
  bounds: [number, number, number, number]
  attribution?: string
  name?: string
}

interface Entry { tileId: number; offset: number; length: number; runLength: number }

const HEADER_SIZE = 127

// LEB128 non signé. On utilise %128 / Math.floor (et non les opérateurs bit-à-bit,
// limités à 32 bits) car un tileId dépasse 2^32 dès le zoom ~16.
function writeVarint(out: number[], n: number): void {
  while (n >= 128) { out.push((n % 128) + 128); n = Math.floor(n / 128) }
  out.push(n)
}

// Sérialise le répertoire au format attendu par `deserializeIndex` du lecteur :
// count, puis 4 colonnes (deltas de tileId, runLengths, lengths, offsets).
function serializeDirectory(entries: Entry[]): Uint8Array {
  const out: number[] = []
  writeVarint(out, entries.length)
  let last = 0
  for (const e of entries) { writeVarint(out, e.tileId - last); last = e.tileId }
  for (const e of entries) writeVarint(out, e.runLength)
  for (const e of entries) writeVarint(out, e.length)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    // Offset chaîné : si la tuile suit immédiatement la précédente, le lecteur le
    // reconstitue → on écrit 0. Sinon on écrit offset+1 (0 est réservé au cas chaîné).
    if (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length) writeVarint(out, 0)
    else writeVarint(out, e.offset + 1)
  }
  return new Uint8Array(out)
}

// Écrit un entier (< 2^53) en uint64 little-endian, comme le lit `getUint64`.
function setU64(dv: DataView, off: number, n: number): void {
  dv.setUint32(off, n >>> 0, true)
  dv.setUint32(off + 4, Math.floor(n / 4294967296), true)
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  void writer.write(data as unknown as BufferSource)
  void writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

const e7 = (deg: number) => Math.round(deg * 1e7)

/** Assemble une archive PMTiles v3 (raster JPEG) à partir d'un lot de tuiles. */
export async function buildPmtilesArchive(tiles: RawTile[], meta: PmtilesMeta): Promise<Uint8Array> {
  const sorted = tiles
    .map((t) => ({ data: t.data, tileId: zxyToTileId(t.z, t.x, t.y) }))
    .sort((a, b) => a.tileId - b.tileId)

  const entries: Entry[] = []
  const blobs: Uint8Array[] = []
  let offset = 0
  for (const t of sorted) {
    entries.push({ tileId: t.tileId, offset, length: t.data.length, runLength: 1 })
    blobs.push(t.data)
    offset += t.data.length
  }
  const tileDataLength = offset

  const rootDir = await gzip(serializeDirectory(entries))
  const metaJson = new TextEncoder().encode(JSON.stringify({ attribution: meta.attribution ?? '', name: meta.name ?? '' }))
  const metaGz = await gzip(metaJson)

  const rootDirOffset = HEADER_SIZE
  const metaOffset = rootDirOffset + rootDir.length
  const tileDataOffset = metaOffset + metaGz.length
  const buf = new Uint8Array(tileDataOffset + tileDataLength)
  const dv = new DataView(buf.buffer)

  buf.set(new TextEncoder().encode('PMTiles'), 0)
  dv.setUint8(7, 3)                       // spec version
  setU64(dv, 8, rootDirOffset)
  setU64(dv, 16, rootDir.length)
  setU64(dv, 24, metaOffset)
  setU64(dv, 32, metaGz.length)
  setU64(dv, 40, 0)                       // leaf directory offset (aucun)
  setU64(dv, 48, 0)                       // leaf directory length
  setU64(dv, 56, tileDataOffset)
  setU64(dv, 64, tileDataLength)
  setU64(dv, 72, entries.length)          // numAddressedTiles
  setU64(dv, 80, entries.length)          // numTileEntries
  setU64(dv, 88, entries.length)          // numTileContents
  dv.setUint8(96, 1)                      // clustered
  dv.setUint8(97, 2)                      // internal compression = gzip
  dv.setUint8(98, 1)                      // tile compression = none
  dv.setUint8(99, 3)                      // tile type = JPEG
  dv.setUint8(100, meta.minZoom)
  dv.setUint8(101, meta.maxZoom)
  dv.setInt32(102, e7(meta.bounds[0]), true)
  dv.setInt32(106, e7(meta.bounds[1]), true)
  dv.setInt32(110, e7(meta.bounds[2]), true)
  dv.setInt32(114, e7(meta.bounds[3]), true)
  dv.setUint8(118, meta.minZoom)          // center zoom
  dv.setInt32(119, e7((meta.bounds[0] + meta.bounds[2]) / 2), true)
  dv.setInt32(123, e7((meta.bounds[1] + meta.bounds[3]) / 2), true)

  buf.set(rootDir, rootDirOffset)
  buf.set(metaGz, metaOffset)
  let p = tileDataOffset
  for (const b of blobs) { buf.set(b, p); p += b.length }
  return buf
}
