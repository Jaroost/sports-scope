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
    vibrate([250, 70, 250, 70, 400])
  } else {
    vibrate([200, 80, 300])
  }
}

// Deux buzz distincts au passage dans la zone orange (virage imminent, ≤ turn_urgent_m).
// Motif délibérément simple « buzz – pause – buzz » pour être reconnaissable sans
// regarder l'écran : ce n'est pas l'annonce initiale du virage mais le « tu y es ».
export function vibrateApproach(): void {
  vibrate([220, 150, 220])
}

// Buzz long et distinct : on a quitté l'itinéraire.
export function vibrateOffRoute(): void {
  vibrate([400, 120, 400])
}

// Court double buzz léger : on passe près d'un point d'intérêt. Volontairement
// discret (ce n'est pas une alerte de sécurité) et distinct des motifs de virage.
export function vibratePoi(): void {
  vibrate([120, 80, 120])
}
