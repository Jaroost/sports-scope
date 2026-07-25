import { describe, expect, it } from 'vitest'
import { stopInsertIndex, waypointInsertIndex } from './navRoute'
import type { Waypoint } from './navRoute'
import type { Coord, LngLat } from './routeHelpers'

// Rang d'insertion d'un nouveau point d'ancrage : la seule logique pure de navRoute
// (le reste appelle BRouter). Elle décide où tombe un point tapé sur la carte dans la
// liste des ancrages — s'il atterrit au mauvais rang, l'itinéraire recalculé fait des
// allers-retours.

// Tracé rectiligne d'ouest en est, un sommet tous les ~800 m (0,01° de longitude).
const geometry: Coord[] = Array.from({ length: 11 }, (_, i) => [6.0 + i * 0.01, 46.5, 500] as Coord)

function wp(lng: number): Waypoint { return { lng, lat: 46.5 } }

describe('waypointInsertIndex', () => {
  it('insère entre les deux ancrages qui encadrent le point', () => {
    const waypoints = [wp(6.0), wp(6.05), wp(6.1)]

    expect(waypointInsertIndex(geometry, waypoints, 6.02, 46.5)).toBe(1)   // 1er tronçon
    expect(waypointInsertIndex(geometry, waypoints, 6.07, 46.5)).toBe(2)   // 2e tronçon
  })

  it('renvoie le premier tronçon pour un point posé sur un ancrage intermédiaire', () => {
    const waypoints = [wp(6.0), wp(6.05), wp(6.1)]
    // Le sommet le plus proche est la borne commune aux deux tronçons : le premier gagne.
    expect(waypointInsertIndex(geometry, waypoints, 6.05, 46.5)).toBe(1)
  })

  it('ajoute en fin quand le point est au-delà du dernier ancrage', () => {
    const waypoints = [wp(6.0), wp(6.05)]
    // Le dernier ancrage tombe au sommet 5 : rien n'encadre le sommet 9.
    expect(waypointInsertIndex(geometry, waypoints, 6.09, 46.5)).toBe(2)
  })

  it('ajoute en fin quand il n’y a pas de quoi encadrer', () => {
    expect(waypointInsertIndex(geometry, [], 6.05, 46.5)).toBe(0)
    expect(waypointInsertIndex(geometry, [wp(6.0)], 6.05, 46.5)).toBe(1)
    expect(waypointInsertIndex([], [wp(6.0), wp(6.1)], 6.05, 46.5)).toBe(2)
  })

  it('respecte l’ordre des ancrages sur un tracé parcouru d’est en ouest', () => {
    const reversed = [...geometry].reverse()
    const waypoints = [wp(6.1), wp(6.05), wp(6.0)]

    expect(waypointInsertIndex(reversed, waypoints, 6.08, 46.5)).toBe(1)
    expect(waypointInsertIndex(reversed, waypoints, 6.02, 46.5)).toBe(2)
  })

  it('utilise le sommet fourni plutôt que de le recalculer', () => {
    const waypoints = [wp(6.0), wp(6.05), wp(6.1)]
    // Le point est géographiquement dans le 1er tronçon, mais l'appelant impose le
    // sommet 8 (2e tronçon) : c'est lui qui décide.
    expect(waypointInsertIndex(geometry, waypoints, 6.02, 46.5, 8)).toBe(2)
  })

  it('range le point d’après le tracé, pas d’après la distance à vol d’oiseau', () => {
    // Tracé en U : il descend, longe, puis remonte. Un point près du bas du U est loin
    // du départ à vol d'oiseau mais appartient bien au tronçon du milieu.
    const u: Coord[] = [
      [6.0, 46.5, 500], [6.0, 46.4, 500], [6.05, 46.4, 500],
      [6.1, 46.4, 500], [6.1, 46.5, 500],
    ]
    const waypoints = [wp(6.0), { lng: 6.05, lat: 46.4 }, wp(6.1)]

    expect(waypointInsertIndex(u, waypoints, 6.02, 46.4)).toBe(1)
    expect(waypointInsertIndex(u, waypoints, 6.08, 46.4)).toBe(2)
  })
})

// Rang d'insertion d'une étape tapée sur le trajet d'aperçu (mode « cible »). Même enjeu
// que ci-dessus, mais la séquence commence par la position GPS — qui n'est PAS une étape :
// tout se décale d'un rang. Un mauvais rang fait faire un aller-retour au trajet.
describe('stopInsertIndex', () => {
  const origin: LngLat = [6.0, 46.5]
  const stop = (lng: number): LngLat => [lng, 46.5]

  it('insère l’étape entre les deux étapes que le tronçon tapé relie', () => {
    const stops = [stop(6.05), stop(6.1)]
    // Tap avant la 1re étape → rang 0 (entre la position GPS et elle).
    expect(stopInsertIndex(geometry, origin, stops, stop(6.02))).toBe(0)
    // Tap entre les deux étapes → rang 1.
    expect(stopInsertIndex(geometry, origin, stops, stop(6.07))).toBe(1)
  })

  it('ajoute en fin quand le tap est au-delà de la dernière étape', () => {
    const stops = [stop(6.05)]
    expect(stopInsertIndex(geometry, origin, stops, stop(6.09))).toBe(1)
  })

  it('ajoute en fin sans géométrie exploitable', () => {
    const stops = [stop(6.05), stop(6.1)]
    expect(stopInsertIndex([], origin, stops, stop(6.02))).toBe(2)
    expect(stopInsertIndex([geometry[0]], origin, stops, stop(6.02))).toBe(2)
  })

  it('place le tap avant l’unique étape d’un trajet direct', () => {
    // Une destination simple devient une étape intermédiaire dès qu'on tape le trajet.
    expect(stopInsertIndex(geometry, origin, [stop(6.1)], stop(6.05))).toBe(0)
  })

  it('range le tap d’après le trajet, pas d’après la distance à vol d’oiseau', () => {
    // Trajet en U depuis la position GPS : le bas du U est loin du départ à vol d'oiseau.
    const u: Coord[] = [
      [6.0, 46.5, 500], [6.0, 46.4, 500], [6.05, 46.4, 500],
      [6.1, 46.4, 500], [6.1, 46.5, 500],
    ]
    const stops: LngLat[] = [[6.05, 46.4], [6.1, 46.5]]

    expect(stopInsertIndex(u, origin, stops, [6.02, 46.4])).toBe(0)
    expect(stopInsertIndex(u, origin, stops, [6.08, 46.4])).toBe(1)
  })

  it('sur une étape existante, insère juste avant elle (pas de doublon en fin)', () => {
    const stops = [stop(6.05), stop(6.1)]
    expect(stopInsertIndex(geometry, origin, stops, stop(6.05))).toBe(0)
    expect(stopInsertIndex(geometry, origin, stops, stop(6.1))).toBe(1)
  })
})
