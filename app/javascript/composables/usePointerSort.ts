import { ref } from 'vue'

// Réorganisation d'une liste par glisser-déposer via Pointer Events — fonctionne à la
// souris ET au tactile, contrairement au drag-and-drop natif HTML5 (`draggable`) qui
// est inopérant sur mobile (aucun événement `dragstart` n'y est émis).
//
// Le geste démarre sur la poignée (`onDown` câblé au grip), à laquelle on applique
// `touch-action: none` pour empêcher le défilement de la page de l'intercepter. Chaque
// élément de liste doit porter `data-sort-index="i"` afin d'être localisé sous le
// pointeur pendant le déplacement. Le réordonnancement n'est appliqué qu'au relâcher,
// via le callback `reorder(from, to)`.
const SORT_THRESHOLD_M = 6 // déplacement (px) au-delà duquel on considère un vrai tri

export function usePointerSort(reorder: (from: number, to: number) => void) {
  const dragIndex = ref<number | null>(null)
  const overIndex = ref<number | null>(null)
  let startX = 0
  let startY = 0
  let active = false

  function indexAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest('[data-sort-index]')
    if (!el) return null
    const n = Number((el as HTMLElement).dataset.sortIndex)
    return Number.isNaN(n) ? null : n
  }

  function onDown(i: number, e: PointerEvent) {
    dragIndex.value = i
    overIndex.value = i
    startX = e.clientX
    startY = e.clientY
    active = false
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function onMove(e: PointerEvent) {
    if (dragIndex.value === null) return
    // Ignore un micro-déplacement (tap involontaire) avant d'activer le tri.
    if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < SORT_THRESHOLD_M) return
    active = true
    e.preventDefault()
    const i = indexAt(e.clientX, e.clientY)
    if (i !== null) overIndex.value = i
  }

  function onUp() {
    const from = dragIndex.value
    const to = overIndex.value
    if (active && from !== null && to !== null && from !== to) reorder(from, to)
    dragIndex.value = null
    overIndex.value = null
    active = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  return { dragIndex, overIndex, onDown }
}
