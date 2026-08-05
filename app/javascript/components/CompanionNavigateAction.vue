<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { shouldOfferCompanionApp, companionLinkTarget } from '../companionBridge'
import CompanionNavigateModal from './CompanionNavigateModal.vue'

// Action « Naviguer dans l'application » de la page de partage. Connecté, un
// clic ouvre la modale de choix (CompanionNavigateModal, partagée avec
// RoutesList.vue : profil de sortie, enregistrement automatique) pour que
// l'appli reçoive ces choix dans le lien et n'ait plus rien à redemander au
// démarrage (cf. `openNavigation`, dépôt companion). Anonyme, pas de compte
// donc pas de profil à choisir : le lien brut s'ouvre tel quel.
//
// N'importe où ailleurs que sur Android, ou déjà dans l'appli, l'élément ne
// s'affiche jamais — même logique que `revealCompanionLinks` pour le lien qu'il
// remplace ici, mais tranchée au montage plutôt qu'en retouchant le DOM après coup.

const props = defineProps<{
  shareToken: string
  signedIn: boolean
}>()

const visible = ref(false)
const loading = ref(false)
const modal = ref<InstanceType<typeof CompanionNavigateModal> | null>(null)

onMounted(() => {
  visible.value = shouldOfferCompanionApp()
})

async function open(): Promise<void> {
  if (!props.signedIn) {
    window.location.href = await companionLinkTarget(`sportsscope://navigate/${props.shareToken}`)
    return
  }

  loading.value = true
  try {
    await modal.value?.open(props.shareToken)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="list-group-item list-group-item-action d-flex align-items-center gap-3"
    :disabled="loading"
    @click="open"
  >
    <i class="fa-solid fa-mobile-screen fa-fw text-warning" aria-hidden="true"></i>
    <span>
      <span class="d-block fw-semibold">{{ t('routes.summary.navigate_app') }}</span>
      <small class="text-body-secondary">{{ t('routes.summary.navigate_app_hint') }}</small>
    </span>
  </button>

  <CompanionNavigateModal ref="modal" />
</template>
