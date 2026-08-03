// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { useSleepHold, SLEEP_HOLD_MS } from './useSleepHold'

// useSleepHold enregistre un onScopeDispose → il doit tourner dans un effect scope.
function inScope(canHold: () => boolean = () => true) {
  const onComplete = vi.fn()
  const scope = effectScope()
  const hold = scope.run(() => useSleepHold({ canHold, onComplete }))!
  return { scope, onComplete, ...hold }
}

function ptr(over: Partial<PointerEvent> = {}): PointerEvent {
  return { pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 200, ...over } as PointerEvent
}

describe('useSleepHold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('endort après l’appui complet, et pas avant', () => {
    const { scope, press, onComplete, onHoldDown } = inScope()

    onHoldDown(ptr())
    expect(press.value).toEqual({ x: 100, y: 200, id: 1 })

    vi.advanceTimersByTime(SLEEP_HOLD_MS - 1)
    expect(onComplete).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    // L'anneau s'efface : c'est le voile noir qui prend la suite.
    expect(press.value).toBeNull()

    scope.stop()
  })

  it('le doigt levé avant la fin ne fait rien', () => {
    const { scope, press, onComplete, onHoldDown, onHoldUp } = inScope()

    onHoldDown(ptr())
    vi.advanceTimersByTime(SLEEP_HOLD_MS - 50)
    expect(onHoldUp(ptr())).toBe(false)   // un vrai tap : l'appelant peut le traiter
    expect(press.value).toBeNull()

    vi.advanceTimersByTime(1000)
    expect(onComplete).not.toHaveBeenCalled()

    scope.stop()
  })

  // Le relâchement d'un appui abouti n'est pas un tap : la bande haute rallumerait sinon
  // l'écran que l'appui vient d'éteindre.
  it('signale à l’appelant le relâchement d’un appui abouti', () => {
    const { scope, onComplete, onHoldDown, onHoldUp } = inScope()

    onHoldDown(ptr())
    vi.advanceTimersByTime(SLEEP_HOLD_MS)
    expect(onComplete).toHaveBeenCalledTimes(1)

    expect(onHoldUp(ptr())).toBe(true)
    // Une seule fois : le relâchement suivant est un tap ordinaire.
    expect(onHoldUp(ptr())).toBe(false)

    scope.stop()
  })

  it('le doigt qui dérive annule (la main n’est pas immobile en roulant)', () => {
    const { scope, press, onComplete, onHoldDown, onHoldMove } = inScope()

    onHoldDown(ptr())
    // Sous la tolérance : on tient toujours.
    onHoldMove(ptr({ clientX: 110, clientY: 208 }))
    expect(press.value).not.toBeNull()

    onHoldMove(ptr({ clientX: 140, clientY: 200 }))
    expect(press.value).toBeNull()

    vi.advanceTimersByTime(SLEEP_HOLD_MS)
    expect(onComplete).not.toHaveBeenCalled()

    scope.stop()
  })

  it('un second doigt abandonne l’appui (déplacement, pinch, tap à deux doigts)', () => {
    const { scope, press, onComplete, onHoldDown } = inScope()

    onHoldDown(ptr({ pointerId: 1 }))
    onHoldDown(ptr({ pointerId: 2, clientX: 250 }))
    expect(press.value).toBeNull()

    vi.advanceTimersByTime(SLEEP_HOLD_MS)
    expect(onComplete).not.toHaveBeenCalled()

    scope.stop()
  })

  it('ne s’arme pas dans les modes qui ont déjà un usage du doigt', () => {
    const { scope, press, onComplete, onHoldDown } = inScope(() => false)

    onHoldDown(ptr())
    expect(press.value).toBeNull()

    vi.advanceTimersByTime(SLEEP_HOLD_MS)
    expect(onComplete).not.toHaveBeenCalled()

    scope.stop()
  })

  it('ignore le clic droit (la souris y ouvre la bulle coordonnées)', () => {
    const { scope, press, onHoldDown } = inScope()

    onHoldDown(ptr({ pointerType: 'mouse', button: 2 }))
    expect(press.value).toBeNull()

    scope.stop()
  })

  it('le rappel du geste s’efface tout seul', () => {
    const { scope, hint, showHint } = inScope()

    showHint()
    expect(hint.value).toBe(true)
    vi.advanceTimersByTime(2599)
    expect(hint.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hint.value).toBe(false)

    scope.stop()
  })

  it('un appui qui aboutit efface le rappel affiché', () => {
    const { scope, hint, showHint, onHoldDown } = inScope()

    showHint()
    onHoldDown(ptr())
    vi.advanceTimersByTime(SLEEP_HOLD_MS)
    expect(hint.value).toBe(false)

    scope.stop()
  })

  it('attach branche et débranche les écouteurs du canvas', () => {
    const { scope, press, attach } = inScope()
    const el = document.createElement('div')

    const detach = attach(el)
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 20 }))
    expect(press.value).not.toBeNull()

    detach()
    expect(press.value).toBeNull()   // le détachement annule l'appui en cours
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 20 }))
    expect(press.value).toBeNull()

    scope.stop()
  })
})
