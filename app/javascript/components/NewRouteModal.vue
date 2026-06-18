<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { t } from '../i18n'
import { userPreferences } from '../userPreferences'
import type { Sport } from '../userPreferences'

// Modale réutilisable demandée à la création d'un itinéraire (page home, liste,
// import GPX) : récupère le nom et le type d'activité avant d'ouvrir le créateur.
const props = defineProps<{
  show: boolean
  // Nom pré-rempli (ex. nom de fichier GPX sans extension).
  initialName?: string
  initialSport?: Sport
}>()

const emit = defineEmits<{
  confirm: [payload: { name: string; sport: Sport }]
  close: []
}>()

const SPORTS: Sport[] = ['cycling', 'mtb', 'hiking']

function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

const name = ref('')
const sport = ref<Sport>(userPreferences().display.default_sport)
const nameInputEl = ref<HTMLInputElement | null>(null)

// À chaque ouverture, on réinitialise le formulaire à partir des valeurs
// pré-remplies et on place le focus sur le champ nom.
watch(() => props.show, (open) => {
  if (!open) return
  name.value = props.initialName ?? ''
  sport.value = props.initialSport ?? userPreferences().display.default_sport
  nextTick(() => {
    nameInputEl.value?.focus()
    nameInputEl.value?.select()
  })
})

function submit() {
  const trimmed = name.value.trim().slice(0, 80)
  if (!trimmed) return
  emit('confirm', { name: trimmed, sport: sport.value })
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-backdrop-newroute" @click.self="emit('close')">
      <div class="modal-dialog-newroute shadow-lg">
        <div class="modal-header-newroute">
          <strong>{{ t('routes.new') }}</strong>
          <button type="button" class="btn-close" @click="emit('close')" :aria-label="t('routes.cancel')"></button>
        </div>
        <div class="modal-body-newroute d-flex flex-column gap-3">
          <div>
            <label for="new-route-name" class="form-label small fw-semibold mb-1">
              {{ t('routes.name_label') }}
            </label>
            <input
              id="new-route-name"
              ref="nameInputEl"
              v-model="name"
              type="text"
              class="form-control"
              :placeholder="t('routes.name_placeholder')"
              :maxlength="80"
              @keydown.enter.prevent="submit"
            />
          </div>
          <div>
            <label class="form-label small fw-semibold mb-1 d-block">
              {{ t('routes.wt_sport') }}
            </label>
            <div class="btn-group btn-group-sm w-100" role="group" :aria-label="t('routes.wt_sport')">
              <button
                v-for="s in SPORTS"
                :key="s"
                type="button"
                class="btn"
                :class="sport === s ? 'btn-primary' : 'btn-outline-secondary'"
                :title="t(`routes.wt_sport_${s}`)"
                @click="sport = s"
              >
                <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
                <span class="ms-1">{{ t(`routes.wt_sport_${s}`) }}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="modal-footer-newroute d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" @click="emit('close')">
            {{ t('routes.cancel') }}
          </button>
          <button type="button" class="btn btn-warning" :disabled="!name.trim()" @click="submit">
            <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>
            {{ t('routes.create') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-backdrop-newroute {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}

.modal-dialog-newroute {
  width: 100%;
  max-width: 420px;
  background: var(--bs-body-bg, #fff);
  border-radius: 0.5rem;
  overflow: hidden;
}

.modal-header-newroute {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}

.modal-body-newroute {
  padding: 1rem;
}

.modal-footer-newroute {
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
