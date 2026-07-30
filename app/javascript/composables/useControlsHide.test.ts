// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { useControlsHide } from './useControlsHide'

// useControlsHide appelle onBeforeUnmount → il doit tourner dans un effect scope.
function inScope(enabled?: boolean) {
  const closePanels = vi.fn()
  const scope = effectScope()
  const hide = scope.run(() => useControlsHide({
    isPanelOpen: () => false,
    closePanels,
    enabled,
  }))!
  return { scope, closePanels, ...hide }
}

describe('useControlsHide', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('affiche les commandes au départ puis les estompe après 4 s', () => {
    const { scope, controlsVisible, armControlsHide } = inScope()

    expect(controlsVisible.value).toBe(true)
    armControlsHide()
    vi.advanceTimersByTime(3999)
    expect(controlsVisible.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(controlsVisible.value).toBe(false)

    scope.stop()
  })

  it('un rappel réaffiche et réarme le minuteur', () => {
    const { scope, controlsVisible, showControls } = inScope()

    showControls()
    vi.advanceTimersByTime(4000)
    expect(controlsVisible.value).toBe(false)

    showControls()
    expect(controlsVisible.value).toBe(true)

    scope.stop()
  })

  describe('désactivé (application mobile)', () => {
    // La coquille native possède le bas de l'écran : la page n'a plus de zone pour
    // rappeler son tiroir. Le laisser s'ouvrir quelques secondes au départ volerait de
    // la carte pour quelque chose qu'on ne peut plus refermer autrement qu'en attendant.
    it('le tiroir ne s’ouvre jamais, pas même au démarrage', () => {
      const { scope, controlsVisible, showControls, armControlsHide } = inScope(false)

      expect(controlsVisible.value).toBe(false)

      showControls()
      expect(controlsVisible.value).toBe(false)

      armControlsHide()
      vi.advanceTimersByTime(10_000)
      expect(controlsVisible.value).toBe(false)

      scope.stop()
    })

    it('la fermeture reste sans effet plutôt que de jeter', () => {
      // Plusieurs chemins de la page appellent hideControls sans se demander si le
      // tiroir existe (tap sur la carte, arrivée, reroutage).
      const { scope, controlsVisible, hideControls, closePanels } = inScope(false)

      hideControls()

      expect(controlsVisible.value).toBe(false)
      expect(closePanels).toHaveBeenCalled()

      scope.stop()
    })
  })
})
