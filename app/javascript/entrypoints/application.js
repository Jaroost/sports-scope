import '../stylesheets/application.scss'
import 'bootstrap'

import { setupI18n } from '../i18n'
import { mountVueIslands } from '../mountVueIslands'

const i18nReady = setupI18n()

function whenDomReady(fn) {
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
