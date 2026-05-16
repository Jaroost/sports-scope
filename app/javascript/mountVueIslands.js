import { createApp } from 'vue'
import HelloStrava from './components/HelloStrava.vue'
import ActivityDetail from './components/ActivityDetail.vue'
import RoutesList from './components/RoutesList.vue'
import RouteBuilder from './components/RouteBuilder.vue'
import ImportFitActivity from './components/ImportFitActivity.vue'

const registry = {
  HelloStrava,
  ActivityDetail,
  RoutesList,
  RouteBuilder,
  ImportFitActivity,
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
