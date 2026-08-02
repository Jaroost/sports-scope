<script setup lang="ts">
// Badge « sens inverse », partout où un passage se compare au sens de référence du
// segment (liste des segments, tableau des passages).
//
// Sur téléphone, le libellé cède la place à une flèche qui va de droite à gauche : la
// ligne y est déjà à l'étroit et le mot poussait le reste dehors. Le sens du symbole
// EST l'information, il n'a pas besoin d'être lu. Le libellé reste porté par
// `aria-label` et l'infobulle, pour qui ne voit pas la flèche.
import { t } from '../i18n'
</script>

<template>
  <span
    class="badge text-bg-light border ms-1 reverse-badge"
    :title="t('strava.segments.reverse')"
    :aria-label="t('strava.segments.reverse')"
  >
    <i class="fa-solid fa-arrow-left-long" aria-hidden="true"></i>
    <span class="reverse-label">{{ t('strava.segments.reverse') }}</span>
  </span>
</template>

<style scoped>
.reverse-badge {
  white-space: nowrap;
}
.reverse-label {
  margin-left: 0.35em;
}

@media (max-width: 575.98px) {
  .reverse-label {
    display: none;
  }
}
</style>
