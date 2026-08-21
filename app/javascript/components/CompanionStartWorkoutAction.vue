<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { shouldOfferCompanionApp, companionLinkTarget } from '../companionBridge'

// Bouton « Ouvrir dans l'application » d'un programme d'entraînement SEUL (pas
// d'itinéraire) — pendant vaut de CompanionNavigateAction.vue, mais sans la modale
// de choix de profil : un programme démarre en navigation libre côté appli
// (`sportsscope://navigate?workout=<token>`, cf. NavigationTarget côté companion),
// il n'y a donc rien d'autre à choisir avant de partir. N'importe où ailleurs
// qu'Android, ou déjà dans l'appli, l'élément ne s'affiche jamais.

const props = defineProps<{ shareToken: string }>()

const visible = ref(false)

onMounted(() => {
  visible.value = shouldOfferCompanionApp()
})

async function open(): Promise<void> {
  window.location.href = await companionLinkTarget(`sportsscope://navigate?workout=${props.shareToken}`)
}
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="btn btn-sm btn-outline-warning"
    :title="t('training_programs.open_in_app')"
    @click="open"
  >
    <i class="fa-solid fa-mobile-screen me-1" aria-hidden="true"></i>{{ t('training_programs.open_in_app') }}
  </button>
</template>
