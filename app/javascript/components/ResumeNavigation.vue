<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import { loadNavSession } from '../navSession'

// Bouton « Reprendre la navigation » de la page d'accueil, à côté de « Tout rafraîchir ».
//
// Une séance interrompue (retour à l'accueil, app rouverte, téléphone rangé) laisse le
// tracé suivi dans le localStorage : plutôt que de le retrouver dans la liste, on propose
// de repartir là où on en était. Le bouton n'existe que si la session est encore valide —
// loadNavSession applique la péremption (12 h) et purge une entrée corrompue, donc rien
// à décider ici. Lecture au montage : ce que le serveur en sait est nul par construction.
//
// Le lien pointe vers /navigate SANS `fresh` : c'est justement le chemin qui restaure la
// session (cf. RouteNavigation), là où les menus l'effacent.

defineProps<{ href: string }>()

const session = loadNavSession()
const routeName = ref(session ? (session.name || t('routes.destination')) : null)
</script>

<template>
  <a
    v-if="routeName !== null"
    :href="href"
    class="btn btn-outline-primary d-flex align-items-center gap-2"
  >
    <i class="fa-solid fa-location-arrow" aria-hidden="true"></i>
    <span>{{ t('routes.resume_navigation') }}</span>
    <span class="resume-nav-name text-muted">{{ routeName }}</span>
  </a>
</template>

<style scoped>
/* Nom du tracé : secondaire, et tronqué pour qu'un nom à rallonge ne fasse pas déborder
   la rangée d'actions sur mobile. */
.resume-nav-name {
  max-width: 12rem;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.875rem;
}
</style>
