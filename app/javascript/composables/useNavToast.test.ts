// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { useNavToast } from './useNavToast'

// useNavToast appelle onScopeDispose → il doit tourner dans un effect scope, qu'on arrête
// explicitement pour simuler le démontage du composant.
function inScope() {
  const scope = effectScope()
  const toast = scope.run(() => useNavToast())!
  return { scope, ...toast }
}

describe('useNavToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('affiche un toast puis l’efface automatiquement après 3 s', () => {
    const { scope, poiToast, showPoiToast } = inScope()

    showPoiToast(true, 'ok')
    expect(poiToast.value).toEqual({ ok: true, text: 'ok' })

    vi.advanceTimersByTime(2999)
    expect(poiToast.value).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(poiToast.value).toBeNull()

    scope.stop()
  })

  it('réarme le minuteur à chaque nouvel appel', () => {
    const { scope, poiToast, showPoiToast } = inScope()

    showPoiToast(false, 'err1')
    vi.advanceTimersByTime(2000)
    showPoiToast(true, 'ok2')          // réarme le minuteur à 3 s
    vi.advanceTimersByTime(2000)       // 4 s depuis le 1er, mais 2 s depuis le 2e
    expect(poiToast.value).toEqual({ ok: true, text: 'ok2' })
    vi.advanceTimersByTime(1000)       // 3 s depuis le 2e
    expect(poiToast.value).toBeNull()

    scope.stop()
  })

  it('annule le minuteur en attente au démontage (onScopeDispose)', () => {
    const { scope, poiToast, showPoiToast } = inScope()

    showPoiToast(true, 'ok')
    scope.stop()                       // onScopeDispose → clearTimeout
    vi.advanceTimersByTime(5000)
    // Le minuteur ayant été annulé, l'auto-effacement ne se déclenche pas.
    expect(poiToast.value).toEqual({ ok: true, text: 'ok' })
  })
})
