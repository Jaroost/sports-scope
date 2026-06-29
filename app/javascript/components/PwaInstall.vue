<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { t } from '../i18n'

// Bannière d'installation PWA.
//  - Android / Chrome : capte `beforeinstallprompt`, propose un bouton qui déclenche
//    l'invite native d'installation.
//  - iOS / Safari : pas d'API d'install programmatique → on affiche les instructions
//    manuelles (Partager → Sur l'écran d'accueil).
// La bannière reste masquée si l'app tourne déjà en mode installé (standalone) ou si
// l'utilisateur l'a récemment écartée.

// Événement non encore typé dans lib.dom.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'pwa-install-dismissed-at'
const DISMISS_TTL = 1000 * 60 * 60 * 24 * 14 // 2 semaines

const visible = ref(false)
const isIos = ref(false)
let deferredPrompt: BeforeInstallPromptEvent | null = null

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  )
}

function recentlyDismissed(): boolean {
  const at = Number(localStorage.getItem(DISMISS_KEY) || 0)
  return at > 0 && Date.now() - at < DISMISS_TTL
}

function detectIos(): boolean {
  const ua = window.navigator.userAgent
  const iosDevice = /iPad|iPhone|iPod/.test(ua)
  // iPadOS 13+ se présente comme un Mac : on le détecte via le tactile.
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  return (iosDevice || iPadOs) && isSafari
}

function onBeforeInstallPrompt(e: Event) {
  e.preventDefault()
  deferredPrompt = e as BeforeInstallPromptEvent
  if (!isStandalone() && !recentlyDismissed()) visible.value = true
}

function onAppInstalled() {
  visible.value = false
  deferredPrompt = null
}

async function install() {
  if (!deferredPrompt) return
  await deferredPrompt.prompt()
  await deferredPrompt.userChoice
  deferredPrompt = null
  visible.value = false
}

function dismiss() {
  localStorage.setItem(DISMISS_KEY, String(Date.now()))
  visible.value = false
}

onMounted(() => {
  if (isStandalone() || recentlyDismissed()) return

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('appinstalled', onAppInstalled)

  // iOS n'émet jamais `beforeinstallprompt` : on affiche directement les instructions.
  if (detectIos()) {
    isIos.value = true
    visible.value = true
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('appinstalled', onAppInstalled)
})
</script>

<template>
  <div v-if="visible" class="pwa-install-banner shadow-lg" role="dialog" aria-live="polite">
    <div class="d-flex align-items-start gap-3">
      <i class="fa-solid fa-mountain-sun text-warning fa-2x mt-1" aria-hidden="true"></i>
      <div class="flex-grow-1">
        <div class="fw-semibold">{{ isIos ? t('pwa.ios_title') : t('pwa.install_title') }}</div>
        <p v-if="!isIos" class="small text-body-secondary mb-2">{{ t('pwa.install_text') }}</p>
        <p v-else class="small text-body-secondary mb-2">
          {{ t('pwa.ios_step_share') }}
          <i class="fa-solid fa-arrow-up-from-bracket mx-1" aria-hidden="true"></i>
          {{ t('pwa.ios_step_add') }}
        </p>
        <div class="d-flex gap-2">
          <button v-if="!isIos" type="button" class="btn btn-warning btn-sm" @click="install">
            <i class="fa-solid fa-download me-1" aria-hidden="true"></i>{{ t('pwa.install_button') }}
          </button>
          <button type="button" class="btn btn-outline-secondary btn-sm" @click="dismiss">
            {{ t('pwa.dismiss') }}
          </button>
        </div>
      </div>
      <button type="button" class="btn-close" :aria-label="t('pwa.dismiss')" @click="dismiss"></button>
    </div>
  </div>
</template>

<style scoped>
.pwa-install-banner {
  position: fixed;
  left: max(0.75rem, env(safe-area-inset-left));
  right: max(0.75rem, env(safe-area-inset-right));
  bottom: max(0.75rem, env(safe-area-inset-bottom));
  z-index: 1080;
  max-width: 28rem;
  margin-inline: auto;
  padding: 1rem;
  background: var(--bs-body-bg);
  border: 1px solid var(--bs-border-color);
  border-radius: 0.75rem;
}
</style>
