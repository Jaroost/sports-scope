// Échantillonnage d'une trace dense en waypoints pour le créateur d'itinéraire.
//
// Mutualisé entre `gpxImport.ts` et `fitImport.ts` : les deux formats décrivent la
// même chose — une suite de positions relevées à ~1 Hz par un appareil — et doivent
// donner le MÊME itinéraire pour la même sortie. Deux échantillonneurs séparés
// auraient dérivé l'un de l'autre au premier ajustement.
//
// Sans DOM, contrairement au parsing GPX qui a besoin de `DOMParser` : c'est ce qui
// rend la règle testable, vitest tournant en `environment: node`.

export type ImportWaypoint = { lng: number; lat: number; free?: boolean; uturn_ok?: boolean }

// Plafond des waypoints transmis au créateur en échantillonnant une trace.
// 25 laisse de la marge pour en insérer d'autres au glisser une fois l'itinéraire chargé.
export const TRACK_IMPORT_MAX_WAYPOINTS = 25

// Une position exploitable. Le contrôle n'est pas cosmétique : un `.fit` marque les
// champs manquants avec une valeur sentinelle, et un GPX étranger porte parfois des
// attributs vides — les deux ressortent en NaN ou en coordonnées hors monde.
export function isValidLngLat(lng: number, lat: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

function downsample(arr: [number, number][], maxPoints: number): [number, number][] {
  if (arr.length <= maxPoints) return arr.slice()
  const step = arr.length / maxPoints
  const out: [number, number][] = []
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)])
  return out
}

// [[lng, lat], ...] → waypoints, plafonnés à `maxPoints`.
export function sampleTrackWaypoints(
  points: [number, number][],
  maxPoints: number = TRACK_IMPORT_MAX_WAYPOINTS,
): ImportWaypoint[] {
  const sampled = downsample(points, maxPoints)
  // Épingle les extrémités d'origine pour qu'elles survivent à l'échantillonnage :
  // un pas régulier rate la fin de la trace, et l'itinéraire s'arrêterait avant
  // l'arrivée réelle.
  if (sampled.length >= 2) {
    sampled[0] = points[0]
    sampled[sampled.length - 1] = points[points.length - 1]
  }
  return sampled.map((p) => ({ lng: p[0], lat: p[1] }))
}
