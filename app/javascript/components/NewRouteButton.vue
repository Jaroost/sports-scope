<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import NewRouteModal from './NewRouteModal.vue'
import { buildNewRouteUrl } from '../routeHelpers'
import type { Sport } from '../userPreferences'

// Bouton « créer un itinéraire » de la page home : ouvre la modale nom + type
// puis redirige vers le créateur.
const showModal = ref(false)

function onConfirm({ name, sport }: { name: string; sport: Sport }) {
  showModal.value = false
  window.location.href = buildNewRouteUrl({ name, sport })
}
</script>

<template>
  <button type="button" class="btn btn-warning btn-lg home-button" @click="showModal = true">
    <i class="fa-solid fa-map-location-dot me-2" aria-hidden="true"></i>{{ t('pages.feature_builder_cta') }}
  </button>
  <NewRouteModal :show="showModal" @confirm="onConfirm" @close="showModal = false" />
</template>
