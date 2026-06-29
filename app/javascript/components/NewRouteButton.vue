<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import NewRouteModal from './NewRouteModal.vue'
import { buildNewRouteUrl } from '../routeHelpers'
import type { Sport } from '../userPreferences'

// Bouton « créer un itinéraire » : ouvre la modale nom + type puis redirige vers le
// créateur. Deux rendus selon l'emplacement :
//   - 'home' (défaut) : gros bouton jaune de la page d'accueil
//   - 'nav'            : lien de la barre de navigation (cf. NavbarHelper / layout)
const props = defineProps<{ variant?: 'home' | 'nav' }>()

const showModal = ref(false)

function onConfirm({ name, sport }: { name: string; sport: Sport }) {
  showModal.value = false
  window.location.href = buildNewRouteUrl({ name, sport })
}
</script>

<template>
  <button
    v-if="props.variant === 'nav'"
    type="button"
    class="nav-link border-0 bg-transparent"
    @click="showModal = true"
  >
    <i class="fa-solid fa-map-location-dot me-1" aria-hidden="true"></i>{{ t('nav.new_route') }}
  </button>
  <button v-else type="button" class="btn btn-warning btn-lg home-button" @click="showModal = true">
    <i class="fa-solid fa-map-location-dot me-2" aria-hidden="true"></i>{{ t('pages.feature_builder_cta') }}
  </button>
  <NewRouteModal :show="showModal" @confirm="onConfirm" @close="showModal = false" />
</template>
