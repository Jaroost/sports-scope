// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { useDismissOnOutside } from './useDismissOnOutside'

// Fermeture des menus de la toolbar de carte. Le piège est mobile : le canvas MapLibre
// avale les gestes tactiles, d'où l'écoute en capture et le touchstart en plus du
// pointerdown — c'est ce que ces tests verrouillent.

function setup() {
  const root = document.createElement('div')
  document.body.appendChild(root)

  const container = document.createElement('div')
  const inside = document.createElement('button')
  container.appendChild(inside)
  const outside = document.createElement('div')
  document.body.append(container, outside)

  const onOutside = vi.fn()
  const app = createApp(defineComponent({
    setup() {
      useDismissOnOutside(() => container, onOutside)
      return () => h('div')
    },
  }))
  app.mount(root)

  return { app, container, inside, outside, onOutside }
}

/** Geste tactile complet tel que l'émet un navigateur mobile. */
function tap(el: HTMLElement) {
  el.dispatchEvent(new Event('touchstart', { bubbles: true }))
}

function press(el: HTMLElement) {
  el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

let s: ReturnType<typeof setup>
beforeEach(() => { s = setup() })
afterEach(() => { s.app.unmount(); document.body.innerHTML = '' })

describe('useDismissOnOutside', () => {
  it('ferme au clic hors du conteneur', () => {
    press(s.outside)
    expect(s.onOutside).toHaveBeenCalledWith(s.outside)
  })

  it('ferme aussi au toucher — le clic synthétique n’arrive pas toujours sur mobile', () => {
    tap(s.outside)
    expect(s.onOutside).toHaveBeenCalledWith(s.outside)
  })

  it('ne ferme pas sur un geste dans le conteneur, même en profondeur', () => {
    press(s.inside)
    tap(s.inside)
    expect(s.onOutside).not.toHaveBeenCalled()
  })

  it('écoute en capture : un geste dont la propagation est stoppée ferme quand même', () => {
    s.outside.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    press(s.outside)
    expect(s.onOutside).toHaveBeenCalledTimes(1)
  })

  it('ne laisse rien derrière lui une fois démonté', () => {
    s.app.unmount()
    press(s.outside)
    tap(s.outside)
    expect(s.onOutside).not.toHaveBeenCalled()
  })
})
