// Retour haptique (vibration) pour la navigation. Complète les sons : en vélo le
// téléphone est souvent en poche / sacoche et le vent couvre les bips — une
// vibration à l'approche d'un virage ou hors-trace reste perceptible. L'API
// Vibration n'existe que sur mobile (Android principalement ; iOS Safari ne
// l'expose pas), d'où la garde de capacité — un no-op silencieux ailleurs.
import type { Maneuver } from './routeHelpers'

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch { /* non supporté ou bloqué */ }
}

// Buzz d'annonce d'un virage. Un demi-tour ou un virage serré vibre plus fort /
// plus longtemps (motif insistant) qu'un virage normal, pour que l'urgence se
// ressente sans regarder l'écran.
export function vibrateManeuver(kind: Maneuver): void {
  if (kind === 'sharp' || kind === 'uturn') {
    vibrate([90, 60, 90, 60, 160])
  } else {
    vibrate([60, 80, 120])
  }
}

// Buzz long et distinct : on a quitté l'itinéraire.
export function vibrateOffRoute(): void {
  vibrate([200, 100, 200])
}
