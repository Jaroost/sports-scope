// Styles (Bootstrap + Font Awesome + custom) live in entrypoints/application.scss
// so vite_stylesheet_tag emits a real <link> tag in both dev and prod — no FOUC.
import 'bootstrap'

import { setupI18n } from '../i18n'
import { mountVueIslands } from '../mountVueIslands'

const i18nReady = setupI18n()

// PWA : enregistre le service worker en production (HTTPS requis ; localhost OK).
// Désactivé en dev pour ne pas interférer avec le HMR de Vite.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // Échec silencieux : l'app reste pleinement fonctionnelle sans le SW.
    })
  })
}

function whenDomReady(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true })
  } else {
    fn()
  }
}

// La navbar `fixed-top` (navbar-expand-md) reste sur une ligne en large, mais avec
// beaucoup de menus, aux largeurs juste au-dessus du point de bascule (≈768px), les
// liens débordaient sur une deuxième ligne — ce qui cassait les pages en pleine
// hauteur et faisait passer les en-têtes collés sous la navbar.
//
// Deux garde-fous, gérés ici en JS car ni l'un ni l'autre n'est exprimable en CSS
// (dépend du nombre de menus, configurable, et de la longueur des libellés) :
//   1. Icônes seules quand ça serre : si, libellés affichés, la barre wrappe, on ajoute
//      `.navbar-compact` (le CSS masque alors les libellés). Une seule ligne.
//   2. Hauteur réelle publiée en `--navbar-h` sur <html> : même si la barre reste sur
//      deux lignes (compact insuffisant, cas rare), le body et les en-têtes collés
//      s'y adaptent (fallback 3.5/4rem avant la première mesure / page sans navbar).
function trackNavbar(): void {
  const nav = document.querySelector<HTMLElement>('nav.navbar.fixed-top')
  if (!nav) return
  const collapse = nav.querySelector('.navbar-collapse')
  let observer: ResizeObserver | null = null

  const update = () => {
    // Menu mobile déplié : la navbar s'étend en overlay par-dessus la page — on ne
    // recalcule rien, on garde la dernière valeur stable.
    if (collapse?.classList.contains('show') || collapse?.classList.contains('collapsing')) return
    // On se ré-observe soi-même : la bascule de classe change la taille de la navbar,
    // on suspend l'observation le temps de mesurer pour éviter une boucle.
    observer?.disconnect()

    // Décision prise libellés affichés : on retire `compact`, puis on regarde si un
    // élément de menu est passé sur une autre ligne (offsetTop différent du premier).
    nav.classList.remove('navbar-compact')
    const items = nav.querySelectorAll<HTMLElement>('.navbar-nav > li')
    const firstTop = items[0]?.offsetTop ?? 0
    let wrapped = false
    items.forEach((el) => { if (el.offsetTop > firstTop + 4) wrapped = true })
    if (wrapped) nav.classList.add('navbar-compact')

    document.documentElement.style.setProperty('--navbar-h', `${nav.offsetHeight}px`)
    observer?.observe(nav)
  }

  update()
  window.addEventListener('resize', update)
  observer = new ResizeObserver(update)
  observer.observe(nav)
}

whenDomReady(async () => {
  trackNavbar()
  await i18nReady
  mountVueIslands()
})
