<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { WORKSHOP_BY_SPORT, profilesForSport } from '../brouter'
import type { Sport } from '../userPreferences'
import {
  PARAM_GROUPS,
  buildSpec,
  defaultValue,
  isCustomizable,
  paramDef,
  paramKeysInGroup,
  parseSpec,
  type ParamValue,
} from '../routingProfile'
import { customProfileForSpec, deleteRoutingProfile, saveRoutingProfile } from '../routingProfiles'

// Éditeur d'un profil de routage personnalisé : profil de base + réglages (revêtement par
// type, trafic, dénivelé, ambiance, accès). Un profil se SAUVE sous un nom (réutilisable
// partout) ou s'APPLIQUE tel quel, sans nom, à l'itinéraire en cours. Dans les deux cas ce
// qui sort est un spec (cf. routingProfile.ts) ; seuls les réglages qui s'écartent du
// défaut du profil de base y figurent.
const props = defineProps<{
  show: boolean
  sport: Sport
  spec: string // profil actuellement sélectionné (base ou personnalisé)
  createNew?: boolean // ouvrir un nouveau profil plutôt qu'éditer le nommé courant
  hideApply?: boolean // gestion depuis le profil : pas d'« appliquer sans enregistrer »
}>()

const emit = defineEmits<{
  close: []
  apply: [spec: string]
}>()

// Profils de base réglables + l'atelier du sport (« partir de zéro »), toujours en dernier.
const bases = computed(() => [...profilesForSport(props.sport).filter(isCustomizable), WORKSHOP_BY_SPORT[props.sport]])
const base = ref('')
const values = ref<Record<string, ParamValue>>({})
const name = ref('')
const editingId = ref<number | null>(null)
const busy = ref(false)
const error = ref('')

function load() {
  error.value = ''
  const parsed = parseSpec(props.spec)
  const named = props.createNew ? undefined : customProfileForSpec(props.spec, props.sport)
  editingId.value = named?.id ?? null
  name.value = named?.name ?? ''
  base.value = bases.value.includes(parsed.base) ? parsed.base : bases.value[0]
  values.value = bases.value.includes(parsed.base) ? { ...parsed.params } : {}
}

watch(() => props.show, (v) => v && load(), { immediate: true })

function onBaseChange(b: string) {
  base.value = b
  values.value = {} // les réglages d'un profil n'ont pas de sens sur un autre
}

const spec = computed(() => buildSpec(base.value, values.value))
const groups = computed(() =>
  PARAM_GROUPS.map((g) => ({ id: g, keys: paramKeysInGroup(base.value, g) })).filter((g) => g.keys.length),
)

function current(key: string): ParamValue {
  return key in values.value ? values.value[key] : defaultValue(base.value, key)
}
function setValue(key: string, v: ParamValue) {
  values.value = { ...values.value, [key]: v }
}
function reset() {
  values.value = {}
}

const COST_LABEL: Record<number, string> = { 1: 'allowed', 2: 'avoided', 10000: 'forbidden' }
const LEVEL_LABEL: Record<number, string> = { 1: 'ideal', 1.5: 'slight', 3: 'avoided', 10: 'strong', 10000: 'forbidden' }

// Groupes qui ont une phrase d'aide sous leur titre.
const HELPED_GROUPS = new Set(['roads', 'surface', 'difficulty'])

function choiceLabel(key: string, v: number): string {
  switch (paramDef(key)?.labels) {
    case 'sac': return `T${v}`
    case 'mtb': return `S${v}`
    case 'level': return t(`routes.routing_profile.level.${LEVEL_LABEL[v]}`)
    default: return t(`routes.routing_profile.cost.${COST_LABEL[v]}`)
  }
}

async function save() {
  const trimmed = name.value.trim()
  if (!trimmed || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const saved = await saveRoutingProfile(editingId.value, { name: trimmed, spec: spec.value, sport: props.sport })
    emit('apply', saved.spec)
    emit('close')
  } catch (e: any) {
    error.value = e?.message || t('routes.routing_profile.save_failed')
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (editingId.value == null || busy.value) return
  if (!window.confirm(t('routes.routing_profile.confirm_delete', { name: name.value }))) return
  busy.value = true
  try {
    await deleteRoutingProfile(editingId.value)
    // L'itinéraire garde son tracé : il retombe sur le profil de base, sans les réglages.
    emit('apply', base.value)
    emit('close')
  } catch (e: any) {
    error.value = e?.message || t('routes.routing_profile.save_failed')
  } finally {
    busy.value = false
  }
}

function applyOnly() {
  emit('apply', spec.value)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="rpe-fade">
      <div v-if="show" class="rpe-backdrop" @click.self="emit('close')">
        <div class="rpe-dialog shadow-lg" role="dialog" aria-modal="true" :aria-label="t('routes.routing_profile.title')">
          <div class="rpe-header">
            <strong>{{ t('routes.routing_profile.title') }}</strong>
            <button type="button" class="btn-close" :aria-label="t('routes.cancel')" @click="emit('close')"></button>
          </div>

          <div class="rpe-body">
            <div class="mb-3">
              <label class="form-label small fw-semibold mb-1" for="rpe-name">{{ t('routes.routing_profile.name') }}</label>
              <input id="rpe-name" v-model="name" class="form-control form-control-sm" maxlength="60"
                     :placeholder="t('routes.routing_profile.name_placeholder')" />
            </div>

            <div class="mb-3">
              <label class="form-label small fw-semibold mb-1" for="rpe-base">{{ t('routes.routing_profile.base') }}</label>
              <select id="rpe-base" class="form-select form-select-sm" :value="base"
                      @change="onBaseChange(($event.target as HTMLSelectElement).value)">
                <option v-for="b in bases" :key="b" :value="b">{{ t(`routes.brouter_profile.${b}`) }}</option>
              </select>
              <p class="form-text mb-0">{{ t(`routes.brouter_profile.${base}_desc`) }}</p>
            </div>

            <div class="rpe-groups">
            <fieldset v-for="g in groups" :key="g.id" class="rpe-group">
              <legend>{{ t(`routes.routing_profile.group.${g.id}`) }}</legend>
              <p v-if="HELPED_GROUPS.has(g.id)" class="form-text mt-0">{{ t(`routes.routing_profile.help.${g.id}`) }}</p>
              <div v-for="key in g.keys" :key="key" class="rpe-row">
                <template v-if="paramDef(key)?.type === 'bool'">
                  <div class="form-check form-switch">
                    <input :id="`rpe-${key}`" class="form-check-input" type="checkbox" role="switch"
                           :checked="current(key) === true"
                           @change="setValue(key, ($event.target as HTMLInputElement).checked)" />
                    <label class="form-check-label" :for="`rpe-${key}`">{{ t(`routes.routing_profile.param.${key}`) }}</label>
                  </div>
                </template>
                <template v-else-if="paramDef(key)?.type === 'choice'">
                  <label class="rpe-label" :for="`rpe-${key}`">{{ t(`routes.routing_profile.param.${key}`) }}</label>
                  <select :id="`rpe-${key}`" class="form-select form-select-sm rpe-choice" :value="current(key)"
                          @change="setValue(key, Number(($event.target as HTMLSelectElement).value))">
                    <option v-for="v in paramDef(key)!.values" :key="v" :value="v">
                      {{ choiceLabel(key, v) }}
                    </option>
                  </select>
                </template>
                <template v-else>
                  <label class="rpe-label" :for="`rpe-${key}`">
                    {{ t(`routes.routing_profile.param.${key}`) }}
                    <span class="text-muted">· {{ current(key) }}</span>
                  </label>
                  <input :id="`rpe-${key}`" class="form-range" type="range"
                         :min="paramDef(key)!.min" :max="paramDef(key)!.max" :step="paramDef(key)!.step"
                         :value="current(key)"
                         @input="setValue(key, Number(($event.target as HTMLInputElement).value))" />
                </template>
              </div>
            </fieldset>
            </div>

            <p v-if="error" class="text-danger small mb-0">{{ error }}</p>
          </div>

          <div class="rpe-footer">
            <button v-if="editingId != null" type="button" class="btn btn-sm btn-outline-danger me-auto"
                    :disabled="busy" @click="remove">
              <i class="fa-solid fa-trash me-1" aria-hidden="true"></i>{{ t('routes.routing_profile.delete') }}
            </button>
            <button type="button" class="btn btn-sm btn-link" @click="reset">{{ t('routes.routing_profile.reset') }}</button>
            <button v-if="!hideApply" type="button" class="btn btn-sm btn-outline-secondary" @click="applyOnly">
              {{ t('routes.routing_profile.apply_only') }}
            </button>
            <button type="button" class="btn btn-sm btn-warning" :disabled="!name.trim() || busy" @click="save">
              {{ t('routes.routing_profile.save') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.rpe-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1080;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}
.rpe-dialog {
  width: 100%;
  max-width: 1040px;
  max-height: 100%;
  height: min(100%, 860px);
  display: flex;
  flex-direction: column;
  background: var(--bs-body-bg, #fff);
  color: var(--bs-body-color, #212529);
  border-radius: 0.5rem;
  overflow: hidden;
}
.rpe-header, .rpe-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
}
.rpe-header { justify-content: space-between; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
.rpe-footer { flex-wrap: wrap; justify-content: flex-end; border-top: 1px solid var(--bs-border-color, #dee2e6); }
.rpe-body { padding: 1rem 1.25rem; overflow-y: auto; flex: 1 1 auto; }
.rpe-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); column-gap: 2rem; align-items: start; }
.rpe-group { margin: 0 0 1rem; padding: 0; border: 0; }
.rpe-group legend { float: none; width: auto; margin-bottom: 0.4rem; padding: 0; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--bs-secondary-color, #6c757d); }
.rpe-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.2rem 0; }
.rpe-label { flex: 1; font-size: 0.9rem; margin: 0; }
.rpe-choice { width: auto; flex: 0 0 9rem; }
.rpe-row .form-range { flex: 0 0 9rem; }
.rpe-fade-enter-active, .rpe-fade-leave-active { transition: opacity 0.15s ease; }
.rpe-fade-enter-from, .rpe-fade-leave-to { opacity: 0; }
</style>
