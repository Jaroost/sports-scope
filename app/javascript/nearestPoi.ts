import { haversine } from './routeHelpers'
import type { LngLat } from './routeHelpers'
import { POI_CATEGORIES } from './poiCategories'

// « La boulangerie la plus proche » dictée dans l'appli compagnon : ni un nom de lieu
// (Nominatim n'y répondrait pas), ni une recherche sur la carte — la catégorie de POI
// la plus proche de la position. Même catalogue et même route que les POI de la carte
// (/api/geocode/places), donc mêmes données hors ligne de Nominatim.

// Mots que le cycliste dit → clé de catégorie (`key` de poiCategories.ts). Volontairement
// restreint aux catégories ponctuelles : « la localité la plus proche » n'a pas de sens
// comme destination.
const KEYWORDS: Array<[key: string, pattern: RegExp]> = [
  ['bakeries', /\b(boulangeries?|boulanger|p[âa]tisseries?)\b/],
  ['water', /\b(fontaines?|points? d['’]eau|eau potable)\b/],
  ['food', /\b(restaurants?|restos?|caf[ée]s?|manger|auberges?)\b/],
  ['viewpoints', /\b(points? de vue|belv[ée]d[èe]res?)\b/],
  ['cols', /\bcols?\b/],
  ['toilets', /\b(toilettes?|wc)\b/],
  ['picnic', /\b(pique-?niques?|aires? de pique-?nique)\b/],
  ['parking', /\bparkings?\b/],
  ['cemeteries', /\bcimeti[èe]res?\b/],
]

// « …le/la plus proche », « près d'ici », « à proximité », « autour de moi ».
const NEAREST = /\b(plus proche|plus pr[èe]s|pr[èe]s d['’]ici|[àa] proximit[ée]|autour de moi|dans le coin)\b/

/**
 * Catégorie visée par une demande « le X le plus proche », ou `null` si la phrase
 * n'en est pas une (c'est alors un nom de lieu). Les deux conditions sont requises :
 * « Col de la Forclaz » nomme un lieu, il ne demande pas « le col le plus proche ».
 */
export function nearestPoiIntent(query: string): string | null {
  const text = query.toLowerCase()
  if (!NEAREST.test(text)) return null
  for (const [key, pattern] of KEYWORDS) if (pattern.test(text)) return key
  return null
}

export interface NearestPoi {
  name: string
  lat: number
  lng: number
  distM: number
}

// Rayons essayés de proche en proche : une boulangerie est presque toujours à 5 km, une
// aire de pique-nique rarement. Évite de tirer tout un massif pour trouver ce qui est en
// bas de la rue.
const RADII_KM = [3, 10, 30]

function bboxAround([lng, lat]: LngLat, km: number) {
  const dLat = km / 111
  const dLng = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng }
}

/**
 * Le POI de la catégorie [key] le plus proche de [from] à vol d'oiseau, ou `null`
 * (rien dans 30 km, catalogue indisponible). À vol d'oiseau et pas à l'itinéraire :
 * un calcul BRouter par candidat serait disproportionné, et c'est le trajet lancé
 * ensuite qui donnera la vraie distance.
 */
export async function findNearestPoi(key: string, from: LngLat): Promise<NearestPoi | null> {
  const category = POI_CATEGORIES.find((c) => c.key === key)
  if (!category) return null
  for (const km of RADII_KM) {
    const { south, west, north, east } = bboxAround(from, km)
    const res = await fetch(
      `/api/geocode/places?south=${south}&west=${west}&north=${north}&east=${east}&types=${key}`,
    )
    if (!res.ok) return null
    const places: Array<{ lat: number; lng: number; name: string }> = await res.json()
    let best: NearestPoi | null = null
    for (const p of places) {
      const distM = haversine(from, [p.lng, p.lat])
      if (!best || distM < best.distM) best = { name: p.name, lat: p.lat, lng: p.lng, distM }
    }
    // Le carré déborde du rayon dans ses coins : on ne retient que ce qui est
    // réellement dans le cercle, sinon on élargit.
    if (best && best.distM <= km * 1000) return best
  }
  return null
}

/** « 850 m », « 1,2 km », « 14 km » — dit à voix haute par l'appli. */
export function spokenDistance(distM: number): string {
  if (distM < 1000) return `${Math.round(distM / 10) * 10} mètres`
  const km = distM / 1000
  return `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} kilomètres`
}
