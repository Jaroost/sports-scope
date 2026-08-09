// Réglage de l'opacité du tracé par glissé vertical (bord gauche de l'écran, en
// navigation). Le tracé peut cacher un repère de la carte juste en dessous ; contrairement
// au réglage du profil (UserProfile.vue), c'est un ajustement de séance, pas une
// préférence — jamais persisté, remis au réglage du profil dès qu'on change de sport
// (cf. le watch sur sportNav dans RouteNavigation.vue).
//
// Glissé continu et non un seuil comme useRevealGesture : chaque pointermove recale
// l'opacité depuis la valeur de départ du geste, glisser vers le haut l'éclaircit.
import { ref } from 'vue'

const DRAG_RANGE_PX = 220   // glissé (px) pour aller du minimum au maximum
export const TRACK_OPACITY_MIN = 0.1
export const TRACK_OPACITY_MAX = 1

export function useTrackOpacityDrag(deps: {
  getOpacity: () => number
  setOpacity: (v: number) => void
}) {
  const { getOpacity, setOpacity } = deps
  const dragging = ref(false)
  let startY = 0
  let startOpacity = 0

  function onDown(e: PointerEvent) {
    startY = e.clientY
    startOpacity = getOpacity()
    dragging.value = true
    // Capture : la zone est une fine bande, le doigt la quitte dès que le glissé dépasse
    // sa hauteur. Sans capture, pointermove partirait vers ce qui se trouve dessous (la
    // carte) dès que le geste sort de la bande.
    if (e.pointerId != null) (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId)
  }

  function onMove(e: PointerEvent) {
    if (!dragging.value) return
    const dy = startY - e.clientY   // glissé vers le haut = positif
    const next = startOpacity + dy / DRAG_RANGE_PX
    setOpacity(Math.min(TRACK_OPACITY_MAX, Math.max(TRACK_OPACITY_MIN, next)))
  }

  function onUp() { dragging.value = false }
  function cancel() { dragging.value = false }

  return { dragging, onDown, onMove, onUp, cancel }
}
