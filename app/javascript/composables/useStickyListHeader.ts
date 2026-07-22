import { ref, watch, onBeforeUnmount, type Ref } from 'vue'

// Header de liste collé sous la navbar, avec panneau de filtres en superposition
// (listes d'activités et d'itinéraires).
//
// Le panneau est sorti du flux (position: absolute sous le header) : il flotte
// par-dessus la liste au lieu de réserver de la place en haut, la liste garde donc
// toute la hauteur visible. Reste à le borner en hauteur — sur mobile il dépasse
// l'écran, et son bas deviendrait inaccessible (le défilement de la page ne le
// ramène pas, il est collé). Sa hauteur disponible vaut :
//
//   100dvh - offset de la navbar - (hauteur du header)
//
// La hauteur du header n'est pas exprimable en CSS : elle varie avec la largeur (les
// boutons passent sur plusieurs lignes en étroit) et avec le contenu (badge,
// horodatage). On la mesure et on l'expose en variable CSS `--sticky-header-h` sur
// le conteneur, où le panneau (descendant) en hérite pour son calc().
//
// Le ref renvoyé se pose sur le conteneur sticky, pas sur le header : le panneau
// étant hors flux, la hauteur du conteneur est exactement celle du header — une
// mesure de moins à synchroniser.
export function useStickyListHeader(): { stickyEl: Ref<HTMLElement | null> } {
  const stickyEl = ref<HTMLElement | null>(null)
  let observer: ResizeObserver | null = null

  watch(
    stickyEl,
    (el) => {
      observer?.disconnect()
      observer = null
      if (!el) return
      const publish = () => el.style.setProperty('--sticky-header-h', `${el.offsetHeight}px`)
      publish()
      observer = new ResizeObserver(publish)
      observer.observe(el)
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(() => observer?.disconnect())

  return { stickyEl }
}
