<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { shouldOfferCompanionApp, companionLinkTarget } from '../companionBridge'

// Action « Naviguer dans l'application » de la page de partage. Remplace le lien
// brut d'avant : connecté, un clic ouvre d'abord une modale (profil de sortie,
// enregistrement automatique) pour que l'appli reçoive ces choix dans le lien et
// n'ait plus rien à redemander au démarrage (cf. `openNavigation`, dépôt companion).
//
// N'importe où ailleurs que sur Android, ou déjà dans l'appli, l'élément ne
// s'affiche jamais — même logique que `revealCompanionLinks` pour le lien qu'il
// remplace ici, mais tranchée au montage plutôt qu'en retouchant le DOM après coup.

const props = defineProps<{
  shareToken: string
  signedIn: boolean
}>()

interface PresetOption {
  key: string
  name: string
}

const visible = ref(false)
const show = ref(false)
const loading = ref(false)
const presets = ref<PresetOption[]>([])
const selectedKey = ref('')
const record = ref(false)

onMounted(() => {
  visible.value = shouldOfferCompanionApp()
})

function plainHref(): string {
  return `sportsscope://navigate/${props.shareToken}`
}

async function openPlain(): Promise<void> {
  window.location.href = await companionLinkTarget(plainHref())
}

// Anonyme, pas de compte donc pas de profil à choisir : le lien s'ouvre tel
// quel, comme avant cette modale. Un échec du serveur (hors ligne, session
// expirée) retombe sur le même comportement — le confort d'un choix ne doit
// jamais empêcher de partir.
async function open(): Promise<void> {
  if (!props.signedIn) {
    await openPlain()
    return
  }

  loading.value = true
  try {
    const res = await fetch('/api/companion_settings', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error('unavailable')
    const data = (await res.json()) as { presets?: { key?: string; name?: string }[] }
    presets.value = (data.presets ?? []).filter(
      (p): p is PresetOption => typeof p.key === 'string' && p.key !== '' && typeof p.name === 'string',
    )
  } catch {
    await openPlain()
    return
  } finally {
    loading.value = false
  }

  if (presets.value.length === 0) {
    await openPlain()
    return
  }

  selectedKey.value = presets.value[0].key
  record.value = false
  show.value = true
}

function close(): void {
  show.value = false
}

async function confirm(): Promise<void> {
  show.value = false

  const url = new URL(plainHref())
  url.searchParams.set('preset', selectedKey.value)
  url.searchParams.set('record', record.value ? '1' : '0')
  window.location.href = await companionLinkTarget(url.toString())
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

  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-backdrop-companion-nav" @click.self="close">
        <div class="modal-dialog-companion-nav shadow-lg">
          <div class="modal-header-companion-nav">
            <strong>{{ t('routes.summary.navigate_app') }}</strong>
            <button type="button" class="btn-close" @click="close" :aria-label="t('routes.cancel')"></button>
          </div>
          <div class="modal-body-companion-nav d-flex flex-column gap-3">
            <div v-if="presets.length > 1">
              <label class="form-label small fw-semibold mb-1 d-block">
                {{ t('routes.summary.navigate_app_preset') }}
              </label>
              <div class="d-flex flex-column gap-1">
                <div v-for="p in presets" :key="p.key" class="form-check">
                  <input
                    :id="`companion-nav-preset-${p.key}`"
                    v-model="selectedKey"
                    class="form-check-input"
                    type="radio"
                    :value="p.key"
                  />
                  <label class="form-check-label" :for="`companion-nav-preset-${p.key}`">{{ p.name }}</label>
                </div>
              </div>
            </div>
            <div>
              <div class="form-check">
                <input id="companion-nav-record" v-model="record" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="companion-nav-record">
                  {{ t('routes.summary.navigate_app_record') }}
                </label>
              </div>
              <p class="small text-muted mb-0 mt-1">{{ t('routes.summary.navigate_app_record_hint') }}</p>
            </div>
          </div>
          <div class="modal-footer-companion-nav d-flex justify-content-end gap-2">
            <button type="button" class="btn btn-outline-secondary" @click="close">
              {{ t('routes.cancel') }}
            </button>
            <button type="button" class="btn btn-warning" @click="confirm">
              <i class="fa-solid fa-mobile-screen me-1" aria-hidden="true"></i>
              {{ t('routes.summary.navigate_app') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-backdrop-companion-nav {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}

.modal-dialog-companion-nav {
  width: 100%;
  max-width: 420px;
  background: var(--bs-body-bg, #fff);
  border-radius: 0.5rem;
  overflow: hidden;
}

.modal-header-companion-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}

.modal-body-companion-nav {
  padding: 1rem;
}

.modal-footer-companion-nav {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--bs-border-color, #dee2e6);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.15s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
