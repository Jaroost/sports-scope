import { defineConfig } from 'vitest/config'

// Tests unitaires du code front (fonctions/composables purs). `environment: node` suffit
// tant qu'on ne teste que de la logique sans DOM ; passer à 'jsdom'/'happy-dom' le jour où
// l'on testera des composants Vue montés.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/javascript/**/*.{test,spec}.ts'],
  },
})
