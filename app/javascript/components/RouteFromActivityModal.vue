<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { t } from '../i18n'
import { MAX_WAYPOINTS } from '../stores/routeStore'

// Modale ouverte depuis une activité (ActivityMapCard) pour créer un itinéraire éditable
// à partir de sa trace : on demande le nom et le nombre de points maximum, avec une aide
// expliquant l'effet du réglage. La trace est ensuite simplifiée (Ramer-Douglas-Peucker)
// puis re-routée par BRouter dans le créateur.
const props = defineProps<{
  show: boolean
  initialName?: string
  defaultMaxPoints?: number
  // Analyse en cours : la création interroge BRouter pour diagnostiquer puis corriger le
  // tracé (cf. routeRepair). Quelques secondes pendant lesquelles la modale reste ouverte.
  busy?: boolean
}>()

const emit = defineEmits<{
  confirm: [payload: { name: string; maxPoints: number }]
  close: []
}>()

const MIN_POINTS = 10
// Aligné sur le plafond du créateur : on ne crée pas un itinéraire au-delà de ce
// qu'on peut ensuite éditer.
const MAX_POINTS = MAX_WAYPOINTS
const FALLBACK_POINTS = 100

const name = ref('')
const maxPoints = ref(FALLBACK_POINTS)
// « Ne pas limiter » : on laisse la simplification garder tous les virages qu'elle juge
// significatifs, sans plafond arbitraire. Ce n'est pas pour autant la trace brute — le
// plafond de l'éditeur (MAX_WAYPOINTS) reste la borne dure, sinon l'itinéraire créé ne
// serait pas éditable derrière.
const unlimited = ref(false)
const nameInputEl = ref<HTMLInputElement | null>(null)

// À chaque ouverture, on réinitialise le formulaire et on focus le champ nom.
watch(() => props.show, (open) => {
  if (!open) return
  name.value = props.initialName ?? ''
  maxPoints.value = props.defaultMaxPoints ?? FALLBACK_POINTS
  unlimited.value = false
  nextTick(() => {
    nameInputEl.value?.focus()
    nameInputEl.value?.select()
  })
})

function clampPoints(): number {
  if (unlimited.value) return MAX_POINTS
  const n = Math.round(Number(maxPoints.value))
  if (!Number.isFinite(n)) return FALLBACK_POINTS
  return Math.min(MAX_POINTS, Math.max(MIN_POINTS, n))
}

function submit() {
  if (props.busy) return
  const trimmed = name.value.trim().slice(0, 80)
  if (!trimmed) return
  emit('confirm', { name: trimmed, maxPoints: clampPoints() })
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-backdrop-rfa" @click.self="busy || emit('close')">
      <div class="modal-dialog-rfa shadow-lg">
        <div class="modal-header-rfa">
          <strong>{{ t('routes.create_from_activity_modal_title') }}</strong>
          <button type="button" class="btn-close" :disabled="busy" @click="emit('close')" :aria-label="t('routes.cancel')"></button>
        </div>
        <div class="modal-body-rfa d-flex flex-column gap-3">
          <div>
            <label for="rfa-name" class="form-label small fw-semibold mb-1">
              {{ t('routes.name_label') }}
            </label>
            <input
              id="rfa-name"
              ref="nameInputEl"
              v-model="name"
              type="text"
              class="form-control"
              :placeholder="t('routes.name_placeholder')"
              :maxlength="80"
              :disabled="busy"
              @keydown.enter.prevent="submit"
            />
          </div>
          <div>
            <label for="rfa-points" class="form-label small fw-semibold mb-1">
              {{ t('routes.create_from_activity_points_label') }}
            </label>
            <input
              id="rfa-points"
              v-model.number="maxPoints"
              type="number"
              class="form-control"
              :min="MIN_POINTS"
              :max="MAX_POINTS"
              step="10"
              :disabled="unlimited || busy"
              @keydown.enter.prevent="submit"
            />
            <div class="form-check mt-2">
              <input id="rfa-unlimited" v-model="unlimited" class="form-check-input" type="checkbox" :disabled="busy" />
              <label class="form-check-label small" for="rfa-unlimited">
                {{ t('routes.create_from_activity_points_unlimited') }}
              </label>
            </div>
            <div class="form-text d-flex gap-2 mt-1">
              <i class="fa-solid fa-circle-info text-secondary mt-1" aria-hidden="true"></i>
              <span>
                {{ t('routes.create_from_activity_points_help') }}
                <template v-if="unlimited">
                  {{ t('routes.create_from_activity_points_unlimited_help', { max: MAX_POINTS }) }}
                </template>
              </span>
            </div>
          </div>
        </div>
        <div class="modal-footer-rfa d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" :disabled="busy" @click="emit('close')">
            {{ t('routes.cancel') }}
          </button>
          <button type="button" class="btn btn-warning" :disabled="!name.trim() || busy" @click="submit">
            <i
              class="fa-solid me-1"
              :class="busy ? 'fa-circle-notch fa-spin' : 'fa-route'"
              aria-hidden="true"
            ></i>
            {{ busy ? t('routes.create_from_activity_analyzing') : t('routes.create') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-backdrop-rfa {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}

.modal-dialog-rfa {
  width: 100%;
  max-width: 420px;
  background: var(--bs-body-bg, #fff);
  border-radius: 0.5rem;
  overflow: hidden;
}

.modal-header-rfa {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}

.modal-body-rfa {
  padding: 1rem;
}

.modal-footer-rfa {
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
