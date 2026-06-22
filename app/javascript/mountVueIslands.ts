import { createApp, type Component } from 'vue'
import HelloStrava from './components/HelloStrava.vue'
import ActivityDetail from './components/ActivityDetail.vue'
import RoutesList from './components/RoutesList.vue'
import RouteBuilder from './components/RouteBuilder.vue'
import RouteNavigation from './components/RouteNavigation.vue'
import ImportFitActivity from './components/ImportFitActivity.vue'
import UserProfile from './components/UserProfile.vue'
import ProfileDialog from './components/ProfileDialog.vue'
import NewRouteButton from './components/NewRouteButton.vue'

const registry: Record<string, Component> = {
  HelloStrava,
  ActivityDetail,
  RoutesList,
  RouteBuilder,
  RouteNavigation,
  ImportFitActivity,
  UserProfile,
  ProfileDialog,
  NewRouteButton,
}

export function mountVueIslands(): void {
  const nodes = document.querySelectorAll<HTMLElement>('[data-vue-component]')
  nodes.forEach((el) => {
    const name = el.dataset.vueComponent
    if (!name) return
    const Component = registry[name]
    if (!Component) {
      console.warn(`[vue-islands] Unknown component: ${name}`)
      return
    }
    const props = el.dataset.vueProps ? JSON.parse(el.dataset.vueProps) as Record<string, unknown> : {}
    createApp(Component, props).mount(el)
  })
}
