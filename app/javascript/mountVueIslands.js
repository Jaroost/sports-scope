import { createApp } from 'vue'
import HelloStrava from './components/HelloStrava.vue'
import ActivityDetail from './components/ActivityDetail.vue'

const registry = {
  HelloStrava,
  ActivityDetail,
}

export function mountVueIslands() {
  const nodes = document.querySelectorAll('[data-vue-component]')
  nodes.forEach((el) => {
    const name = el.dataset.vueComponent
    const Component = registry[name]
    if (!Component) {
      console.warn(`[vue-islands] Unknown component: ${name}`)
      return
    }
    const props = el.dataset.vueProps ? JSON.parse(el.dataset.vueProps) : {}
    createApp(Component, props).mount(el)
  })
}
