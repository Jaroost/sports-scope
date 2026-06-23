// Geste de révélation (swipe vers le bas depuis le bandeau haut) des boutons masqués.
// Partagé entre navigation libre et navigation sur itinéraire.
//
// Capté par une fine zone transparente en haut de l'écran, active uniquement quand les
// boutons sont masqués. Un vrai swipe vers le bas les rappelle (onReveal) ; un simple
// tap quasi immobile conserve la sémantique du « tap carte » → mise en veille (onTap,
// soumis à canTap pour ne pas re-basculer quand l'écran est déjà en veille).
const REVEAL_SWIPE_M = 40   // déplacement vertical (px) au-delà duquel on révèle
const TAP_MAX_MOVE_M = 10   // déplacement (px) en deçà duquel on considère un tap

export function useRevealGesture(deps: {
  onReveal: () => void
  onTap: () => void
  canTap: () => boolean
}) {
  const { onReveal, onTap, canTap } = deps
  let revealStartY = 0
  let revealStartX = 0
  let revealTracking = false

  function onRevealDown(e: PointerEvent) {
    revealStartY = e.clientY
    revealStartX = e.clientX
    revealTracking = true
  }

  function onRevealMove(e: PointerEvent) {
    if (!revealTracking) return
    if (e.clientY - revealStartY > REVEAL_SWIPE_M) {
      revealTracking = false
      onReveal()
    }
  }

  function onRevealUp(e: PointerEvent) {
    if (!revealTracking) return
    revealTracking = false
    const moved = Math.hypot(e.clientX - revealStartX, e.clientY - revealStartY)
    if (moved < TAP_MAX_MOVE_M && canTap()) onTap()
  }

  function cancel() { revealTracking = false }

  return { onRevealDown, onRevealMove, onRevealUp, cancel }
}
