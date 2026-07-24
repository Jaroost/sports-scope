// Geste de révélation (swipe depuis un bord de l'écran) d'un tiroir masqué. Partagé
// entre navigation libre et navigation sur itinéraire, et entre le tiroir de commandes
// (swipe vers le haut depuis le bas, via `direction: 'up'`) et le masquage groupé des
// overlays du bas (swipe de droite à gauche, via `direction: 'left'`).
//
// Capté par une fine zone transparente le long d'un bord, active uniquement quand le
// tiroir est masqué. Un vrai swipe dans le bon sens le déploie (onReveal) ; un simple
// tap quasi immobile déclenche onTap (soumis à canTap) — utilisé en haut pour la
// sémantique « tap carte » → mise en veille. `onReveal` omis = zone de tap pure (aucun
// swipe à écouter) : c'est le cas de la bande haute, qui ne fait plus que la veille.
const REVEAL_SWIPE_M = 40   // déplacement (px) au-delà duquel on révèle
const TAP_MAX_MOVE_M = 10   // déplacement (px) en deçà duquel on considère un tap

export function useRevealGesture(deps: {
  onReveal?: () => void
  onTap: () => void
  canTap: () => boolean
  // Sens du swipe qui déploie le tiroir : 'down' (depuis le haut, défaut), 'up'
  // (depuis le bas), 'left' (de droite à gauche) ou 'right' (de gauche à droite).
  direction?: 'down' | 'up' | 'left' | 'right'
}) {
  const { onReveal, onTap, canTap } = deps
  const direction = deps.direction ?? 'down'
  let revealStartY = 0
  let revealStartX = 0
  let revealTracking = false

  function onRevealDown(e: PointerEvent) {
    revealStartY = e.clientY
    revealStartX = e.clientX
    revealTracking = true
  }

  function onRevealMove(e: PointerEvent) {
    if (!revealTracking || !onReveal) return
    const dy = e.clientY - revealStartY
    const dx = e.clientX - revealStartX
    const passed = direction === 'down' ? dy > REVEAL_SWIPE_M
      : direction === 'up' ? dy < -REVEAL_SWIPE_M
      : direction === 'left' ? dx < -REVEAL_SWIPE_M
      : dx > REVEAL_SWIPE_M
    if (passed) {
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
