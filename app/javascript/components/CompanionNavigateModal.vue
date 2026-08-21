<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import { companionLinkTarget } from '../companionBridge'
import { defaultPresetKey } from '../companionSettings'

// Modale de choix (profil de sortie + enregistrement automatique) avant
// d'ouvrir l'appli companion sur un tracé — partagée entre la page de partage
// (CompanionNavigateAction.vue) et la liste des itinéraires (RoutesList.vue)
// pour qu'elles proposent exactement le même choix, plutôt que deux logiques
// qui pourraient diverger.
//
// Un seul point d'entrée, `open(token)`, exposé au parent : il porte la
// décision d'ouvrir la modale ou de partir directement (compte sans profil
// configuré), pour que l'appelant n'ait qu'un tracé à fournir.

interface PresetOption {
  key: string
  name: string
  default_for?: string[]
}

interface TrainingProgramOption {
  id: number
  name: string
  share_token: string
}

const show = ref(false)
const presets = ref<PresetOption[]>([])
const selectedKey = ref('')
const record = ref(false)
const shareToken = ref('')
// Programme d'entraînement optionnel à coupler à la navigation (?workout=<token>) —
// faire le HIIT tout en suivant un tracé. Absent (chaîne vide) : lien de route seul.
const trainingPrograms = ref<TrainingProgramOption[]>([])
const selectedWorkoutToken = ref('')

function plainHref(): string {
  const url = new URL(`sportsscope://navigate/${shareToken.value}`)
  if (selectedWorkoutToken.value) url.searchParams.set('workout', selectedWorkoutToken.value)
  return url.toString()
}

async function openPlain(): Promise<void> {
  window.location.href = await companionLinkTarget(plainHref())
}

// [activity] est le type de l'itinéraire qu'on s'apprête à suivre
// (cycling/mtb/hiking), quand l'appelant le connaît : il sert uniquement à
// présélectionner le profil que l'utilisateur a marqué par défaut pour ce
// type (`defaultPresetKey`) — le choix reste modifiable dans la modale.
async function open(token: string, activity?: string | null): Promise<void> {
  shareToken.value = token
  selectedWorkoutToken.value = ''
  fetchTrainingPrograms()

  try {
    const res = await fetch('/api/companion_settings', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error('unavailable')
    const data = (await res.json()) as { presets?: { key?: string; name?: string; default_for?: string[] }[] }
    presets.value = (data.presets ?? []).filter(
      (p): p is PresetOption => typeof p.key === 'string' && p.key !== '' && typeof p.name === 'string',
    )
  } catch {
    await openPlain()
    return
  }

  if (presets.value.length === 0) {
    await openPlain()
    return
  }

  selectedKey.value = defaultPresetKey(presets.value, activity) ?? presets.value[0].key
  record.value = false
  show.value = true
}

// Best-effort : une erreur laisse simplement le sélecteur vide (pas de programme
// à coupler), jamais bloquant pour l'ouverture de la navigation elle-même.
async function fetchTrainingPrograms(): Promise<void> {
  try {
    const res = await fetch('/api/training_programs', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error('unavailable')
    const data = (await res.json()) as { training_programs?: TrainingProgramOption[] }
    trainingPrograms.value = data.training_programs ?? []
  } catch {
    trainingPrograms.value = []
  }
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

defineExpose({ open })
</script>

<template>
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
            <div v-if="trainingPrograms.length">
              <label class="form-label small fw-semibold mb-1 d-block" for="companion-nav-workout">
                {{ t('training_programs.combine_with_route') }}
              </label>
              <select id="companion-nav-workout" v-model="selectedWorkoutToken" class="form-select form-select-sm">
                <option value="">{{ t('training_programs.combine_none') }}</option>
                <option v-for="p in trainingPrograms" :key="p.id" :value="p.share_token">{{ p.name }}</option>
              </select>
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
