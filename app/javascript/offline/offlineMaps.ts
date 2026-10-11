// Cartes hors-ligne pour la navigation : pré-télécharge le corridor du trajet depuis des
// fonds WMTS officiels (swisstopo, IGN), empaquète chaque couche en une archive PMTiles
// stockée dans l'OPFS, puis les expose à MapLibre via le protocole `pmtiles://`.
//
// Pourquoi seulement ces fonds-là : ce sont les seuls fonds utilisés en navigation dont les
// CGU autorisent explicitement l'usage hors-ligne — géodonnées ouvertes (OGD suisse, Licence
// Ouverte / Etalab pour l'IGN), gratuites y compris commercialement, seule condition une
// mention d'attribution. Les autres fonds (CyclOSM, OpenTopoMap) interdisent le
// pré-téléchargement. Voir la discussion CGU du projet.
//
// Hors de leur couverture (swisstopo en France, IGN en Suisse…), les deux services ne se
// comportent PAS pareil — vérifié en direct plutôt que supposé :
//   - swisstopo (wmts.geo.admin.ch) ne renvoie pas d'erreur : il répond 200 avec une tuile
//     JPEG uniforme de 668 octets. Le zoom maximal réellement servi dépend donc du lieu (z17
//     sur le Plateau, z15 vers Aoste, z14 vers Annecy).
//   - IGN (data.geopf.fr) répond 404 (corps XML) dès qu'aucune donnée française ne couvre la
//     tuile — sauf le plan (`ignplan`), qui garde un fond mondial jusqu'à des zooms assez fins
//     près de la frontière avant de basculer en 404 à son tour.
//   Les deux signalent la même chose (« rien ici ») et sont donc traités pareil : on descend
//   la pyramide zoom par zoom, une tuile « vide » (au sens de l'un ou l'autre) élague ses
//   descendants sans les demander. Les niveaux ainsi élagués restent ABSENTS de l'archive : au
//   delà de la frontière la carte s'affiche vide quand on zoome, et il suffit de dézoomer. On
//   avait essayé de les fabriquer en agrandissant le niveau du dessus (flou mais lisible) ;
//   c'était beaucoup trop long sur un téléphone pour un long tracé.
//
// `swissimage` et `ignortho` font exception : hors de leur pays, ils servent un fond mondial
// basse résolution au lieu d'une absence de données (vérifié en direct jusqu'en Suisse pour
// l'ortho IGN). L'élagage ne s'y déclenche donc quasi jamais et l'archive couvre tout le
// corridor — ce qui donne le bon résultat visuel, sans code spécifique. Attention en revanche :
// cette imagerie hors frontière n'est vraisemblablement pas de la donnée nationale du fond
// concerné, et sort donc du cadre OGD/Etalab ci-dessus.
//
// Format des tuiles : swisstopo et `ignortho` sont du JPEG, `ignplan` du PNG (texte/vecteur,
// la compression avec perte le rendrait illisible). Le format de chaque couche est porté par
// `LAYER_SPECS` et suit tout le pipeline — téléchargement, et
// octet `tileType` de l'archive PMTiles — pour ne jamais mélanger les deux dans une archive.
import { PMTiles, FileSource, Protocol } from 'pmtiles'
import { buildPmtilesArchive, type RawTile } from './pmtilesWriter'
import { corridorTiles, corridorTilesByZoom, boundsOf, type CorridorOpts, type Tile } from './tileMath'

// Fonds téléchargeables. Les identifiants sont ceux de `mapStyles.ts` (MAP_STYLES), pour que
// le style actif en navigation désigne directement son archive.
export const OFFLINE_LAYERS = ['swissgrau', 'swisstopo', 'swissimage', 'ignplan', 'ignortho'] as const
export type OfflineLayer = (typeof OFFLINE_LAYERS)[number]

type TileFormat = 'jpeg' | 'png'

const SWISSTOPO_ATTRIBUTION = '© swisstopo'
const IGN_ATTRIBUTION = '© IGN'

const geoAdminUrl = (wmts: string) => (z: number, x: number, y: number) =>
  `https://wmts.geo.admin.ch/1.0.0/${wmts}/default/current/3857/${z}/${x}/${y}.jpeg`

const geopfUrl = (layer: string, format: TileFormat) => (z: number, x: number, y: number) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
  `&STYLE=normal&FORMAT=image/${format}&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`

// `avgTileBytes` : poids moyen d'une tuile, mesuré sur des corridors réels (swisstopo :
// Lausanne→Aigle, zooms 10–17 ; IGN : autour de Lyon, mêmes zooms). Sert uniquement à
// l'estimation affichée avant téléchargement ; le poids dépend surtout du paysage traversé,
// et `ignplan` (vecteur rendu en PNG, texte compris) pèse nettement plus qu'une photo aérienne.
const LAYER_SPECS: Record<OfflineLayer, { url: (z: number, x: number, y: number) => string; avgTileBytes: number; format: TileFormat; attribution: string }> = {
  swissgrau:  { url: geoAdminUrl('ch.swisstopo.pixelkarte-grau'),  avgTileBytes: 20.0 * 1024, format: 'jpeg', attribution: SWISSTOPO_ATTRIBUTION },
  swisstopo:  { url: geoAdminUrl('ch.swisstopo.pixelkarte-farbe'), avgTileBytes: 21.5 * 1024, format: 'jpeg', attribution: SWISSTOPO_ATTRIBUTION },
  swissimage: { url: geoAdminUrl('ch.swisstopo.swissimage'),       avgTileBytes: 17.9 * 1024, format: 'jpeg', attribution: SWISSTOPO_ATTRIBUTION },
  ignplan:    { url: geopfUrl('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'png'), avgTileBytes: 45.0 * 1024, format: 'png',  attribution: IGN_ATTRIBUTION },
  ignortho:   { url: geopfUrl('ORTHOIMAGERY.ORTHOPHOTOS', 'jpeg'),         avgTileBytes: 20.0 * 1024, format: 'jpeg', attribution: IGN_ATTRIBUTION },
}

export function isOfflineLayer(id: string): id is OfflineLayer {
  return (OFFLINE_LAYERS as readonly string[]).includes(id)
}

const tileUrl = (layer: OfflineLayer, z: number, x: number, y: number) => LAYER_SPECS[layer].url(z, x, y)

const OPFS_DIR = 'offline-maps'
// Nombre de requêtes WMTS simultanées : un petit burst ponctuel par trajet reste compatible
// avec le fair use de ces services (la limite ~20 req/min de swisstopo vise la moyenne 24/7,
// pas un import unique) ; même prudence appliquée à data.geopf.fr, faute de chiffre publié.
const CONCURRENCY = 6
// La tuile « hors couverture » de swisstopo pèse 668 o (JPEG uniforme, toujours identique).
// Toute tuile aussi légère est traitée comme vide : une tuile réelle mais unie (grand lac)
// est gardée dans l'archive telle quelle (seuls ses descendants sont élagués). IGN, lui, signale le
// hors-couverture par un 404 explicite (cf. en-tête du fichier) : géré à part dans la boucle
// de téléchargement, ce seuil ne le concerne pas.
const BLANK_MAX_BYTES = 1024

export const OFFLINE_DEFAULTS: CorridorOpts = { minZoom: 10, maxZoom: 17, bufferM: 400 }
// Marges proposées de part et d'autre du tracé (m). Le nombre de tuiles croît à peu près
// comme la marge : au-delà de 1,5 km un long itinéraire devient très lourd.
export const OFFLINE_BUFFER_CHOICES = [200, 400, 800, 1500] as const
export function isOfflineBuffer(m: number): boolean {
  return (OFFLINE_BUFFER_CHOICES as readonly number[]).includes(m)
}

// Étapes d'un téléchargement : les tuiles (la barre), puis deux temps de traitement local
// sans tuile à compter — l'assemblage de l'archive et son écriture.
export type DownloadPhase = 'tiles' | 'build' | 'write'

// `sub` : avancement 0-100 à l'intérieur de l'étape, quand elle sait le dire.
export interface DownloadProgress { done: number; total: number; failed: number; phase: DownloadPhase; sub?: number }

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

const safe = (token: string) => token.replace(/[^a-zA-Z0-9_-]/g, '')

// Nom de fichier OPFS = clé du protocole PMTiles. Le `pmtiles://<clé>/{z}/{x}/{y}` du style
// DOIT correspondre à `FileSource.getKey()`, qui renvoie `file.name`.
function archiveName(token: string, layer: OfflineLayer): string {
  return `route-${safe(token)}-${layer}.pmtiles`
}

export function offlineTileUrl(token: string, layer: OfflineLayer): string {
  return `pmtiles://${archiveName(token, layer)}/{z}/{x}/{y}`
}

async function opfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_DIR, { create: true })
}

export async function hasOfflineArchive(token: string, layer: OfflineLayer): Promise<boolean> {
  try {
    const dir = await opfsDir()
    await dir.getFileHandle(archiveName(token, layer))
    return true
  } catch {
    return false
  }
}

export async function deleteOfflineArchive(token: string, layer: OfflineLayer): Promise<void> {
  try {
    const dir = await opfsDir()
    await dir.removeEntry(archiveName(token, layer))
  } catch {
    /* déjà absent */
  }
}

// Les archives mono-couche s'appelaient `route-<token>.pmtiles` (gris implicite). Elles ne
// sont plus lisibles depuis que le nom porte la couche : on libère l'OPFS au passage.
export async function purgeLegacyArchive(token: string): Promise<void> {
  try {
    const dir = await opfsDir()
    await dir.removeEntry(`route-${safe(token)}.pmtiles`)
  } catch {
    /* rien à purger */
  }
}

async function readArchiveFile(token: string, layer: OfflineLayer): Promise<File> {
  const dir = await opfsDir()
  const handle = await dir.getFileHandle(archiveName(token, layer))
  return handle.getFile()
}

async function writeArchiveFile(token: string, layer: OfflineLayer, bytes: Uint8Array): Promise<void> {
  const dir = await opfsDir()
  const handle = await dir.getFileHandle(archiveName(token, layer), { create: true })
  const writable = await handle.createWritable()
  await writable.write(bytes as unknown as BufferSource)
  await writable.close()
}

/**
 * Estimation (nombre de tuiles à télécharger + Mo) affichée avant le téléchargement, pour
 * l'ensemble des couches demandées. Le corridor est identique d'une couche à l'autre : seul
 * le poids moyen des tuiles change.
 */
export function estimateOffline(
  coords: [number, number][],
  layers: readonly OfflineLayer[],
  opts: CorridorOpts = OFFLINE_DEFAULTS,
): { tiles: number; mb: number } {
  const perLayer = corridorTiles(coords, opts).length
  const bytes = layers.reduce((sum, l) => sum + perLayer * LAYER_SPECS[l].avgTileBytes, 0)
  return { tiles: perLayer * layers.length, mb: bytes / (1024 * 1024) }
}

const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`

/**
 * Télécharge le corridor, construit l'archive PMTiles et la stocke dans l'OPFS.
 * Renvoie le nombre de tuiles effectivement stockées et la taille de l'archive.
 */
export async function downloadOfflineArchive(
  token: string,
  layer: OfflineLayer,
  coords: [number, number][],
  opts: CorridorOpts = OFFLINE_DEFAULTS,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ tiles: number; bytes: number }> {
  const byZoom = corridorTilesByZoom(coords, opts)
  const total = [...byZoom.values()].reduce((n, list) => n + list.length, 0)
  const real = new Map<string, Uint8Array>() // tuiles réellement servies par le fond
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
          const res = await fetch(tileUrl(layer, t.z, t.x, t.y), { signal })
          if (res.ok) {
            const data = new Uint8Array(await res.arrayBuffer())
            // Une tuile légère (hors couverture, ou unie comme un lac) élague ses descendants
            // mais reste dans l'archive : sans quoi un lac s'afficherait vide à ce niveau.
            real.set(tileKey(t.z, t.x, t.y), data)
            if (data.length <= BLANK_MAX_BYTES) blank.add(tileKey(t.z, t.x, t.y))
          } else if (res.status === 404) {
            // Hors-couverture façon IGN (cf. en-tête du fichier) : même sémantique que la
            // tuile vide de swisstopo, donc même élagage — jamais atteint pour swisstopo, qui
            // répond toujours 200.
            blank.add(tileKey(t.z, t.x, t.y))
          } else {
            failed++
          }
        } catch (e) {
          if (signal?.aborted) throw e
          failed++ // erreur réseau ponctuelle : on continue, la tuile restera vide
        }
        done++
        onProgress?.({ done, total, failed, phase: 'tiles' })
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
    onProgress?.({ done, total, failed, phase: 'tiles' })
    await fetchTiles(toFetch)
  }

  // Rien que des tuiles vides : tracé hors de la couverture de ce fond, inutile d'archiver du blanc.
  if (![...real.values()].some((d) => d.length > BLANK_MAX_BYTES)) throw new Error('offline_no_tiles')

  const collected: RawTile[] = [...real].map(([key, data]) => {
    const [z, x, y] = key.split('/').map(Number)
    return { z, x, y, data }
  })
  // Les tuiles hors couverture ne sont PAS comblées : elles restent absentes de l'archive et
  // s'affichent vides. On avait essayé de les fabriquer en agrandissant le niveau du dessus
  // (flou mais lisible) ; c'était beaucoup trop long sur un téléphone pour un long tracé.
  const report = (phase: DownloadPhase) => onProgress?.({ done, total, failed, phase })
  report('build')
  const archive = await buildPmtilesArchive(collected, {
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    bounds: boundsOf(coords, opts.bufferM),
    attribution: LAYER_SPECS[layer].attribution,
    tileType: LAYER_SPECS[layer].format,
  })
  report('write')
  await writeArchiveFile(token, layer, archive)
  return { tiles: collected.length, bytes: archive.length }
}

// ─── Signature du tracé archivé (localStorage) ───────────────────────────────
// L'archive ne couvre qu'un corridor autour du tracé tel qu'il était au moment du
// téléchargement. Si l'itinéraire change ensuite (reroutage, détour, édition en
// séance), les tuiles manquent le long du nouveau tracé : on mémorise une empreinte
// de la géométrie archivée pour pouvoir proposer un re-téléchargement.

function sigKey(token: string, layer: OfflineLayer): string {
  return `offline-sig-${safe(token)}-${layer}`
}

/** Empreinte FNV-1a du tracé, coordonnées arrondies au 1e-5 (~1 m). */
export function routeSignature(coords: [number, number][]): string {
  let h = 0x811c9dc5
  for (const [lng, lat] of coords) {
    const s = `${lng.toFixed(5)},${lat.toFixed(5)};`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  return `${coords.length}-${(h >>> 0).toString(16)}`
}

export function saveArchiveSignature(token: string, layer: OfflineLayer, signature: string): void {
  try { localStorage.setItem(sigKey(token, layer), signature) } catch { /* quota */ }
}

/** Empreinte du tracé archivé, ou `null` si inconnue (archive antérieure à ce suivi). */
export function archiveSignature(token: string, layer: OfflineLayer): string | null {
  try { return localStorage.getItem(sigKey(token, layer)) } catch { return null }
}

export function deleteArchiveSignature(token: string, layer: OfflineLayer): void {
  try { localStorage.removeItem(sigKey(token, layer)); localStorage.removeItem(bufferKey(token, layer)) } catch {}
}

// Marge du couloir archivé, par couche : pour savoir qu'une marge plus large demandée depuis
// reste à télécharger. Absente = archive d'avant ce réglage, donc la marge d'alors.
function bufferKey(token: string, layer: OfflineLayer): string {
  return `offline-buf-${safe(token)}-${layer}`
}

export function saveArchiveBuffer(token: string, layer: OfflineLayer, bufferM: number): void {
  try { localStorage.setItem(bufferKey(token, layer), String(bufferM)) } catch { /* quota */ }
}

// Dernière marge choisie, pour tous les itinéraires : propre à cet appareil (localStorage de
// la page, que partagent la navigation et la page de téléchargement de l'appli).
const BUFFER_PREF_KEY = 'offline-buffer-pref'

export function loadBufferPref(): number {
  try {
    const n = Number(localStorage.getItem(BUFFER_PREF_KEY))
    return isOfflineBuffer(n) ? n : OFFLINE_DEFAULTS.bufferM
  } catch { return OFFLINE_DEFAULTS.bufferM }
}

export function saveBufferPref(bufferM: number): void {
  try { localStorage.setItem(BUFFER_PREF_KEY, String(bufferM)) } catch { /* quota */ }
}

export function archiveBuffer(token: string, layer: OfflineLayer): number {
  try {
    const n = Number(localStorage.getItem(bufferKey(token, layer)))
    return Number.isFinite(n) && n > 0 ? n : OFFLINE_DEFAULTS.bufferM
  } catch { return OFFLINE_DEFAULTS.bufferM }
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

// Enregistre le protocole `pmtiles://` (une seule fois par page) et y attache l'archive d'une
// couche du trajet. À appeler avant d'utiliser le style hors-ligne correspondant. Chaque
// archive a sa propre clé (nom de fichier), plusieurs couches coexistent donc sans conflit ;
// ré-attacher la même clé remplace l'entrée, ce qui est le comportement voulu après un
// re-téléchargement.
export async function registerOfflineArchive(
  token: string,
  layer: OfflineLayer,
  maplibregl: { addProtocol: (s: string, h: unknown) => void },
): Promise<void> {
  if (!protocol) {
    protocol = new Protocol()
    maplibregl.addProtocol('pmtiles', protocol.tile)
  }
  const file = await readArchiveFile(token, layer)
  protocol.add(new PMTiles(new FileSource(file)))
}

// Style MapLibre raster pointant sur l'archive locale (équivalent hors-ligne du style en ligne
// de la même couche).
export function offlineStyle(token: string, layer: OfflineLayer, maxZoom: number = OFFLINE_DEFAULTS.maxZoom): object {
  return {
    version: 8,
    sources: {
      [`${layer}-offline`]: {
        type: 'raster',
        tiles: [offlineTileUrl(token, layer)],
        tileSize: 256,
        maxzoom: maxZoom,
        attribution: LAYER_SPECS[layer].attribution,
      },
    },
    layers: [{ id: `${layer}-offline-base`, type: 'raster', source: `${layer}-offline` }],
  }
}
