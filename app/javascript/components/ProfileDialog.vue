<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Modal } from 'bootstrap'
import { t } from '../i18n'
import UserProfile from './UserProfile.vue'

// Boîte de dialogue « profil » montée une seule fois dans le layout (îlot global).
// S'ouvre quand on clique sur n'importe quel élément portant `data-profile-trigger`
// (lien Profil de la navbar, bouton du créateur d'itinéraire…). À la fermeture, si
// les préférences ont été enregistrées, on recharge la page pour les appliquer.
const props = defineProps<{
  preferences: Record<string, unknown>
  defaults: Record<string, unknown>
  stravaLinked: boolean
  canLinkStrava: boolean
  unlinkPath: string
}>()

const modalEl = ref<HTMLElement | null>(null)
// Le contenu (et donc la carte d'aperçu MapLibre de UserProfile) n'est monté que
// lorsque la modale est visible : on évite un contexte WebGL inutile sur chaque page,
// et la carte s'initialise dans un conteneur correctement dimensionné.
const contentReady = ref(false)
const changed = ref(false)

let modal: Modal | null = null

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

function onDocClick(e: MouseEvent) {
  const trigger = (e.target as HTMLElement | null)?.closest('[data-profile-trigger]')
  if (!trigger) return
  e.preventDefault()
  modal?.show()
}

function onShown() {
  contentReady.value = true
}

function onHidden() {
  if (changed.value) {
    window.location.reload()
    return
  }
  contentReady.value = false
}

function confirmUnlink(e: Event) {
  if (!window.confirm(t('profile.strava.unlink_confirm'))) e.preventDefault()
}

onMounted(() => {
  if (!modalEl.value) return
  modal = new Modal(modalEl.value)
  modalEl.value.addEventListener('shown.bs.modal', onShown)
  modalEl.value.addEventListener('hidden.bs.modal', onHidden)
  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  modalEl.value?.removeEventListener('shown.bs.modal', onShown)
  modalEl.value?.removeEventListener('hidden.bs.modal', onHidden)
  modal?.dispose()
})
</script>

<template>
  <div ref="modalEl" class="modal fade" tabindex="-1" aria-hidden="true">
    <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title d-flex align-items-center gap-2">
            <i class="fa-solid fa-sliders" aria-hidden="true"></i>{{ t('profile.title') }}
          </h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="t('strava.close')"></button>
        </div>
        <div class="modal-body">
          <!-- Compte Strava — mêmes actions que la page /profile (navigation pleine page). -->
          <section class="card mb-3 shadow-sm">
            <div class="card-header d-flex align-items-center gap-2">
              <i class="fa-brands fa-strava text-warning" aria-hidden="true"></i>
              <h2 class="h6 mb-0">{{ t('profile.strava.title') }}</h2>
            </div>
            <div class="card-body">
              <div v-if="stravaLinked" class="d-flex align-items-center gap-3 flex-wrap">
                <span class="badge bg-success-subtle text-success d-inline-flex align-items-center gap-1 fs-6">
                  <i class="fa-solid fa-circle-check" aria-hidden="true"></i>{{ t('profile.strava.connected') }}
                </span>
                <form :action="unlinkPath" method="post" class="ms-sm-auto" @submit="confirmUnlink">
                  <input type="hidden" name="_method" value="delete" />
                  <input type="hidden" name="authenticity_token" :value="csrfToken()" />
                  <button type="submit" class="btn btn-outline-danger btn-sm">
                    <i class="fa-solid fa-link-slash me-1" aria-hidden="true"></i>{{ t('profile.strava.unlink') }}
                  </button>
                </form>
              </div>
              <template v-else-if="canLinkStrava">
                <p class="text-muted small mb-3">{{ t('profile.strava.help') }}</p>
                <form action="/auth/strava" method="post">
                  <input type="hidden" name="authenticity_token" :value="csrfToken()" />
                  <button type="submit" class="btn btn-warning">
                    <i class="fa-brands fa-strava me-1" aria-hidden="true"></i>{{ t('profile.strava.link') }}
                  </button>
                </form>
              </template>
              <p v-else class="text-muted small mb-0">{{ t('profile.strava.not_allowed') }}</p>
            </div>
          </section>

          <UserProfile
            v-if="contentReady"
            :preferences="(preferences as any)"
            :defaults="(defaults as any)"
            @saved="changed = true"
          />
        </div>
      </div>
    </div>
  </div>
</template>
