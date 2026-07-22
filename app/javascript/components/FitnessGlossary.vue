<script setup lang="ts">
import { t } from '../i18n'

// Lexique commun aux trois sous-onglets (FTP · Forme & fatigue · Zones) : les sigles
// (TSS, CTL, IF…) sont inévitables dans les graphiques et les libellés, on les explique
// une bonne fois ici plutôt que d'alourdir chaque texte. Replié par défaut.
const TERMS = [
  'ftp',
  'lthr',
  'tss',
  'if',
  'np',
  'ctl',
  'atl',
  'tsb',
  'acwr',
  'wkg',
] as const
</script>

<template>
  <details class="glossary mt-4">
    <summary class="small fw-semibold text-primary">
      <i class="fa-solid fa-book me-1" aria-hidden="true"></i>{{ t('performance.glossary.title') }}
    </summary>
    <dl class="glossary-body small mt-2 mb-0">
      <template v-for="term in TERMS" :key="term">
        <dt>{{ t(`performance.glossary.${term}_term`) }}</dt>
        <dd>{{ t(`performance.glossary.${term}_def`) }}</dd>
      </template>
    </dl>
  </details>
</template>

<style scoped>
.glossary summary {
  cursor: pointer;
  list-style: revert;
}
/* Deux colonnes (terme / définition) dès qu'il y a la place ; empilé sur mobile pour
   ne pas écraser les définitions sur 15 caractères de large. */
.glossary-body {
  max-width: 72ch;
}
.glossary-body dt {
  font-weight: 600;
}
.glossary-body dd {
  margin-bottom: 0.6rem;
  color: var(--bs-secondary-color);
}
@media (min-width: 576px) {
  .glossary-body {
    display: grid;
    grid-template-columns: minmax(9rem, max-content) 1fr;
    column-gap: 1rem;
    row-gap: 0.5rem;
  }
  .glossary-body dd {
    margin-bottom: 0;
  }
}
</style>
