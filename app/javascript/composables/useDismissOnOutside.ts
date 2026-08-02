import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Referme un menu quand un geste tombe en dehors de son conteneur.
 *
 * Deux précautions, sans lesquelles ça ne marche pas au-dessus d'une carte :
 * — on écoute en phase CAPTURE, parce que le canvas MapLibre avale les gestes avant
 *   qu'ils ne remontent jusqu'à `document` (cf. RouteNavigation, même problème) ;
 * — on écoute `pointerdown` ET `touchstart` : sur mobile le clic synthétique n'est pas
 *   toujours émis (MapLibre annule le touchstart pour ses propres gestes), et `touchstart`
 *   reste le signal le plus fiable. Les deux peuvent arriver pour un même appui, d'où un
 *   `onOutside` qui doit être idempotent.
 *
 * `onOutside` reçoit la cible du geste : l'appelant peut avoir besoin de neutraliser ce
 * que ce geste déclencherait par ailleurs (poser un point sur la carte, par exemple) —
 * un geste qui referme un menu ne doit rien faire d'autre.
 */
export function useDismissOnOutside(
  getContainer: () => HTMLElement | null | undefined,
  onOutside: (target: HTMLElement | null) => void,
) {
  function onGesture(ev: Event) {
    const target = ev.target as HTMLElement | null
    const container = getContainer()
    if (container && target && container.contains(target)) return
    onOutside(target)
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onGesture, true)
    document.addEventListener('touchstart', onGesture, true)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onGesture, true)
    document.removeEventListener('touchstart', onGesture, true)
  })
}
