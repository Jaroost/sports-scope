import '../stylesheets/application.scss'
import 'bootstrap'

import { setupI18n } from '../i18n'
import { mountVueIslands } from '../mountVueIslands'

setupI18n()

document.addEventListener('DOMContentLoaded', () => {
  mountVueIslands()
})
