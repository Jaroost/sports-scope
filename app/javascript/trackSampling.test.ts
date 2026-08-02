import { describe, it, expect } from 'vitest'
import { TRACK_IMPORT_MAX_WAYPOINTS, isValidLngLat, sampleTrackWaypoints } from './trackSampling'

const trace = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [6 + i / 1000, 46 + i / 1000] as [number, number])

describe('isValidLngLat', () => {
  it('rejette le NaN d\'un attribut vide et les coordonnées hors monde', () => {
    expect(isValidLngLat(NaN, 46)).toBe(false)
    expect(isValidLngLat(6, 91)).toBe(false)
    expect(isValidLngLat(181, 46)).toBe(false)
    expect(isValidLngLat(6.14, 46.2)).toBe(true)
  })
})

describe('sampleTrackWaypoints', () => {
  it('laisse passer une trace déjà courte sans y toucher', () => {
    const points = trace(5)
    expect(sampleTrackWaypoints(points)).toEqual(points.map(([lng, lat]) => ({ lng, lat })))
  })

  it('plafonne une trace dense', () => {
    expect(sampleTrackWaypoints(trace(4000))).toHaveLength(TRACK_IMPORT_MAX_WAYPOINTS)
  })

  // La règle qui compte : un pas régulier rate le dernier point, et l'itinéraire
  // s'arrêterait avant l'arrivée réelle de la sortie.
  it('épingle les deux extrémités d\'origine', () => {
    const points = trace(4000)
    const out = sampleTrackWaypoints(points)
    expect([out[0].lng, out[0].lat]).toEqual(points[0])
    expect([out[out.length - 1].lng, out[out.length - 1].lat]).toEqual(points[points.length - 1])
  })

  it('ne cherche pas à épingler quoi que ce soit sur un point unique', () => {
    expect(sampleTrackWaypoints([[6, 46]])).toEqual([{ lng: 6, lat: 46 }])
    expect(sampleTrackWaypoints([])).toEqual([])
  })
})
