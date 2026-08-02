// Parsing d'un fichier GPX → liste de waypoints pour le créateur d'itinéraire.
//
// Mutualisé entre :
//  - RoutesList.vue        (bouton « importer un GPX »)
//  - RouteBuilder.vue      (ouverture d'un .gpx via le gestionnaire de fichiers PWA)
// L'échantillonnage lui-même vit dans `trackSampling.ts`, partagé avec l'import
// `.fit` : même trace, même itinéraire, quel que soit le format d'origine.
//
// Deux cas :
//  1. GPX exporté par Sports Scope (porte l'extension <ss:wp>) → on rejoue les
//     waypoints d'origine tels quels (avec leur flag `free`), sans re-sampling.
//  2. GPX étranger (montre, Komoot…) → on échantillonne la trace à un nombre
//     raisonnable de waypoints, en épinglant les extrémités d'origine.
// Dans les deux cas, le créateur relance BRouter pour le calage routier + altitude.

import { TRACK_IMPORT_MAX_WAYPOINTS, isValidLngLat, sampleTrackWaypoints } from './trackSampling'
import type { ImportWaypoint } from './trackSampling'

export type { ImportWaypoint }

export const GPX_IMPORT_MAX_WAYPOINTS = TRACK_IMPORT_MAX_WAYPOINTS
// Un GPX Sports Scope porte déjà des waypoints délibérés (pas une trace dense) :
// on les garde tous jusqu'au plafond MAX_WAYPOINTS=500 du contrôleur.
export const GPX_IMPORT_MAX_NATIVE_WAYPOINTS = 500

// Namespace de l'extension Sports Scope — doit rester aligné sur GPX_NS côté
// routes_controller.rb (build_gpx_extensions).
const SS_GPX_NS = 'https://sports.logicraft.ch/gpx/1'

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
    if (!isValidLngLat(lng, lat)) continue
    const wp: ImportWaypoint = { lng, lat }
    if (nodes[i].getAttribute('free') === 'true') wp.free = true
    if (nodes[i].getAttribute('uturn_ok') === 'true') wp.uturn_ok = true
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
      if (isValidLngLat(lng, lat)) out.push([lng, lat])
    }
    return out
  }
  return collect('trkpt').length ? collect('trkpt')
    : collect('rtept').length ? collect('rtept')
    : collect('wpt')
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

  return sampleTrackWaypoints(points)
}
