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

whenDomReady(async () => {
  await i18nReady
  mountVueIslands()
})
