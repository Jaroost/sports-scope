// Parsing d'un fichier GPX → liste de waypoints pour le créateur d'itinéraire.
//
// Mutualisé entre :
//  - RoutesList.vue        (bouton « importer un GPX »)
//  - RouteBuilder.vue      (ouverture d'un .gpx via le gestionnaire de fichiers PWA)
//
// Deux cas :
//  1. GPX exporté par Sports Scope (porte l'extension <ss:wp>) → on rejoue les
//     waypoints d'origine tels quels (avec leur flag `free`), sans re-sampling.
//  2. GPX étranger (montre, Komoot…) → on échantillonne la trace à un nombre
//     raisonnable de waypoints, en épinglant les extrémités d'origine.
// Dans les deux cas, le créateur relance BRouter pour le calage routier + altitude.

export type ImportWaypoint = { lng: number; lat: number; free?: boolean }

// Plafond des waypoints transmis au créateur en échantillonnant une trace étrangère.
// 25 laisse de la marge pour en insérer d'autres au glisser une fois l'itinéraire chargé.
export const GPX_IMPORT_MAX_WAYPOINTS = 25
// Un GPX Sports Scope porte déjà des waypoints délibérés (pas une trace dense) :
// on les garde tous jusqu'au plafond MAX_WAYPOINTS=500 du contrôleur.
export const GPX_IMPORT_MAX_NATIVE_WAYPOINTS = 500

// Namespace de l'extension Sports Scope — doit rester aligné sur GPX_NS côté
// routes_controller.rb (build_gpx_extensions).
const SS_GPX_NS = 'https://sports-scope.app/gpx/1'

// Erreur d'import typée : `code` permet aux appelants de choisir le message i18n.
export class GpxImportError extends Error {
  code: 'invalid' | 'no_points'
  constructor(code: 'invalid' | 'no_points') {
    super(code)
    this.code = code
    this.name = 'GpxImportError'
  }
}

// Waypoints d'origine embarqués par Sports Scope, avec le flag `free`. Vide si le
// GPX vient d'une autre source.
function parseSportsScopeWaypoints(doc: Document): ImportWaypoint[] {
  const nodes = doc.getElementsByTagNameNS(SS_GPX_NS, 'wp')
  const out: ImportWaypoint[] = []
  for (let i = 0; i < nodes.length && out.length < GPX_IMPORT_MAX_NATIVE_WAYPOINTS; i++) {
    const lat = parseFloat(nodes[i].getAttribute('lat') || '')
    const lng = parseFloat(nodes[i].getAttribute('lon') || '')
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    const wp: ImportWaypoint = { lng, lat }
    if (nodes[i].getAttribute('free') === 'true') wp.free = true
    out.push(wp)
  }
  return out
}

// [[lng, lat], ...] — <trkpt> d'abord (exports d'appareils), puis <rtept> (routes
// planifiées type Komoot), enfin <wpt> en dernier recours.
function parseGpxPoints(doc: Document): [number, number][] {
  const collect = (tag: string): [number, number][] => {
    const out: [number, number][] = []
    const nodes = doc.getElementsByTagName(tag)
    for (let i = 0; i < nodes.length; i++) {
      const lat = parseFloat(nodes[i].getAttribute('lat') || '')
      const lng = parseFloat(nodes[i].getAttribute('lon') || '')
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        out.push([lng, lat])
      }
    }
    return out
  }
  return collect('trkpt').length ? collect('trkpt')
    : collect('rtept').length ? collect('rtept')
    : collect('wpt')
}

function downsample(arr: [number, number][], maxPoints: number): [number, number][] {
  if (arr.length <= maxPoints) return arr.slice()
  const step = arr.length / maxPoints
  const out: [number, number][] = []
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)])
  return out
}

// Parse le texte d'un fichier GPX en waypoints exploitables par le créateur.
// Lève GpxImportError('invalid') si le XML est illisible, GpxImportError('no_points')
// s'il ne contient aucun point géographique.
export function parseGpxWaypoints(text: string): ImportWaypoint[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new GpxImportError('invalid')
  }

  const ssWaypoints = parseSportsScopeWaypoints(doc)
  if (ssWaypoints.length >= 2) return ssWaypoints

  const points = parseGpxPoints(doc)
  if (!points.length) throw new GpxImportError('no_points')

  const sampled = downsample(points, GPX_IMPORT_MAX_WAYPOINTS)
  // Épingle les extrémités d'origine pour qu'elles survivent à l'échantillonnage.
  if (sampled.length >= 2) {
    sampled[0] = points[0]
    sampled[sampled.length - 1] = points[points.length - 1]
  }
  return sampled.map((p) => ({ lng: p[0], lat: p[1] }))
}
