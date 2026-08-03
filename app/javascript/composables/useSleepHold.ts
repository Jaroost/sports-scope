import { ref, onScopeDispose } from 'vue'
import { vibrateSleep } from '../navHaptics'

// Mise en veille par appui long, avec l'anneau qui se remplit sous le doigt.
//
// Le tap simple ne l'endort plus. En roulant on tape la carte pour tout et pour rien —
// fermer une bulle, viser un bouton qu'on rate, se rattraper sur un cahot — et l'écran
// s'éteignait précisément au moment où on le regardait. Même raison que le déplacement à
// deux doigts (TWO_FINGER_PAN dans RouteNavigation) : il faut à la veille un geste qu'on
// ne fait pas par accident.
//
// Le réveil, lui, reste un tap n'importe où sur le voile : sortir de veille doit rester le
// geste le plus facile de la page, y compris pour une main gantée sur un pavé.
//
// L'anneau n'est pas une décoration : c'est ce qui rend le geste réversible. Sans lui, un
// appui long est un trou noir — rien ne se passe, puis tout se passe. L'anneau dit « ça
// vient, lève le doigt si ce n'est pas ça que tu veux », et c'est aussi ce qui apprend le
// geste à celui qui pressait la carte par habitude.
export const SLEEP_HOLD_MS = 700
// Tolérance de dérive du doigt. Plus large que le clickTolerance de la carte (10 px) : on
// tient 700 ms sur un vélo qui roule, la main n'est pas immobile. Au-delà, c'est un geste
// de carte (ou un doigt qui part) et non une veille.
const HOLD_MOVE_TOL_PX = 16
// Durée du rappel « maintenez pour la veille » affiché après un tap qui, avant, endormait.
const HINT_MS = 2600

export interface SleepPress { x: number; y: number; id: number }

export function useSleepHold(deps: {
  // Faux dans les modes où le tap a déjà un rôle (édition, cible), quand le tiroir est
  // ouvert, ou en veille (on n'endort pas ce qui dort déjà — le tap y réveille).
  canHold: () => boolean
  onComplete: () => void
}) {
  // Position du doigt pendant l'appui : c'est elle qui place l'anneau. `null` = pas
  // d'appui en cours.
  const press = ref<SleepPress | null>(null)
  const hint = ref(false)
  let pressSeq = 0
  let pointerId: number | null = null
  // Pointeur dont l'appui a abouti et qui n'est pas encore relevé. Le relâchement qui
  // suivra n'est PAS un tap : sans cette mémoire, la zone de veille du bandeau haut
  // rallumerait l'écran que l'appui vient d'éteindre (son tap réveille).
  let completedId: number | null = null
  let sx = 0
  let sy = 0
  let timer: number | null = null
  let hintTimer: number | null = null

  function stop() {
    if (timer != null) { clearTimeout(timer); timer = null }
    pointerId = null
    press.value = null
  }

  function complete() {
    timer = null
    completedId = pointerId
    stop()
    hideHint()
    vibrateSleep()
    deps.onComplete()
  }

  function onHoldDown(e: PointerEvent) {
    // Un second doigt pendant l'appui : c'est un déplacement, un pinch ou le tap à deux
    // doigts de la bulle coordonnées. On abandonne la veille plutôt que de la disputer.
    if (pointerId != null) { stop(); return }
    if (e.pointerType === 'mouse' && e.button !== 0) return
    completedId = null
    if (!deps.canHold()) return
    pointerId = e.pointerId
    sx = e.clientX
    sy = e.clientY
    press.value = { x: sx, y: sy, id: ++pressSeq }
    timer = window.setTimeout(complete, SLEEP_HOLD_MS)
  }

  function onHoldMove(e: PointerEvent) {
    if (pointerId == null || e.pointerId !== pointerId) return
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > HOLD_MOVE_TOL_PX) stop()
  }

  // Le doigt se lève avant la fin : rien ne s'est passé, l'anneau s'efface. Renvoie vrai
  // quand ce relâchement clôt un appui qui, lui, a abouti — à l'appelant de ne pas le
  // traiter en plus comme un tap.
  function onHoldUp(e: PointerEvent): boolean {
    if (completedId != null && e.pointerId === completedId) { completedId = null; return true }
    if (pointerId != null && e.pointerId !== pointerId) return false
    stop()
    return false
  }

  function cancelHold() { stop() }

  function showHint() {
    hint.value = true
    if (hintTimer != null) clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => { hint.value = false; hintTimer = null }, HINT_MS)
  }

  function hideHint() {
    if (hintTimer != null) { clearTimeout(hintTimer); hintTimer = null }
    hint.value = false
  }

  // Branchement sur un élément impératif (le canvas de la carte, qui n'est pas rendu par
  // Vue). Passif : aucun preventDefault, pour ne rien voler aux gestes de MapLibre.
  function attach(target: HTMLElement): () => void {
    const opts = { passive: true } as AddEventListenerOptions
    target.addEventListener('pointerdown', onHoldDown, opts)
    target.addEventListener('pointermove', onHoldMove, opts)
    target.addEventListener('pointerup', onHoldUp, opts)
    target.addEventListener('pointercancel', cancelHold, opts)
    // Le doigt qui sort de l'élément (bord d'écran) ne renvoie pas toujours de pointerup.
    target.addEventListener('pointerleave', cancelHold, opts)
    return () => {
      stop()
      target.removeEventListener('pointerdown', onHoldDown)
      target.removeEventListener('pointermove', onHoldMove)
      target.removeEventListener('pointerup', onHoldUp)
      target.removeEventListener('pointercancel', cancelHold)
      target.removeEventListener('pointerleave', cancelHold)
    }
  }

  onScopeDispose(() => { stop(); hideHint() })

  return { press, hint, onHoldDown, onHoldMove, onHoldUp, cancelHold, showHint, hideHint, attach }
}
