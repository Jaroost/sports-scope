import { buildDistancesM, bearingBetween, type Coord } from './routeHelpers'
import { companionSimFix } from './companionBridge'

// Position simulée le long d'un tracé, et faux `navigator.geolocation` qui la diffuse.
// Aucune dépendance à Vue : la logique de projection vit ici, le panneau dans GpsSimulator.vue.

export interface SimState {
  distM: number        // abscisse curviligne le long du tracé
  speedKmh: number
  lateralM: number     // écart perpendiculaire (>0 = à droite) → simule un hors-trajet
  accuracyM: number
  signal: boolean      // false = plus aucun fix émis (tunnel, perte GPS)
}

export interface SimTrack { geom: Coord[]; cum: number[] }

export function buildTrack(geom: Coord[]): SimTrack {
  return { geom, cum: buildDistancesM(geom) }
}

export function trackLength(t: SimTrack): number { return t.cum[t.cum.length - 1] ?? 0 }

const M_PER_DEG = 111_320

export function pointAt(t: SimTrack, distM: number, lateralM = 0) {
  const { geom, cum } = t
  const d = Math.max(0, Math.min(distM, trackLength(t)))
  let i = 1
  while (i < cum.length - 1 && cum[i] < d) i++
  const a = geom[i - 1], b = geom[i]
  const seg = cum[i] - cum[i - 1]
  const f = seg > 0 ? (d - cum[i - 1]) / seg : 0
  let lng = a[0] + (b[0] - a[0]) * f
  let lat = a[1] + (b[1] - a[1]) * f
  const alt = a[2] != null && b[2] != null ? a[2] + (b[2] - a[2]) * f : null
  const heading = (bearingBetween(a, b) + 360) % 360
  if (lateralM) {
    const r = ((heading + 90) * Math.PI) / 180
    lat += (Math.cos(r) * lateralM) / M_PER_DEG
    lng += (Math.sin(r) * lateralM) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))
  }
  return { lng, lat, alt, heading }
}

type Ok = (p: GeolocationPosition) => void

// Remplace navigator.geolocation. Renvoie une fonction de restauration et `emit`,
// à appeler une fois par seconde avec l'état courant.
export function installFakeGeolocation() {
  const watchers = new Map<number, Ok>()
  let nextId = 1
  let last: GeolocationPosition | null = null
  const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation')

  const fake = {
    watchPosition(ok: Ok) { const id = nextId++; watchers.set(id, ok); if (last) ok(last); return id },
    clearWatch(id: number) { watchers.delete(id) },
    getCurrentPosition(ok: Ok) { if (last) ok(last) },
  }
  Object.defineProperty(navigator, 'geolocation', { value: fake, configurable: true })

  function emit(track: SimTrack, s: SimState) {
    if (!s.signal) return
    const p = pointAt(track, s.distM, s.lateralM)
    const pos = {
      coords: {
        latitude: p.lat, longitude: p.lng, altitude: p.alt, accuracy: s.accuracyM,
        altitudeAccuracy: null, heading: s.speedKmh > 0 ? p.heading : null, speed: s.speedKmh / 3.6,
        toJSON() { return this },
      },
      timestamp: Date.now(),
      toJSON() { return this },
    } as unknown as GeolocationPosition
    last = pos
    watchers.forEach((cb) => cb(pos))
    // Dans l'appli compagnon, Flutter doit voir la même position (no-op dans un navigateur).
    companionSimFix({
      lat: p.lat, lng: p.lng, altitudeM: p.alt, accuracyM: s.accuracyM,
      speedMps: s.speedKmh / 3.6, headingDeg: s.speedKmh > 0 ? p.heading : null,
      at: pos.timestamp,
    })
  }

  function restore() {
    if (original) Object.defineProperty(navigator, 'geolocation', original)
    else delete (navigator as any).geolocation
  }
  return { emit, restore }
}
