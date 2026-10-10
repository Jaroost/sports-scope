<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'
import { trainingProgramStore, newBlock, isGroup, SPORTS, MAX_REPEAT, DEFAULT_START_TIMING, DEFAULT_END_TIMING } from '../stores/trainingProgramStore'
import type { Block, Item, SoundIssue, SoundSlotRef, TargetRange } from '../stores/trainingProgramStore'
import * as editing from '../stores/trainingProgramEditing'
import { formatTime, formatHuman } from '../trainingProgramTime'
import { csrfToken } from '../csrf'
import TrainingProgramItemList from './TrainingProgramItemList.vue'
import TrainingProgramProfileChart from './TrainingProgramProfileChart.vue'

const props = defineProps({
  trainingProgramId: { type: [String, Number], default: null },
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const saving = ref(false)
const saved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

const items = trainingProgramStore.items
const { issues, targetIssues, durationSeconds, selected, repeatCount, profile } = editing

function slotLabel(ref: SoundSlotRef): string {
  return t(`training_programs.sound_slot_${ref.edge}`, { at: formatTime(editing.slotStart(ref)) })
}

function issueMessage(issue: SoundIssue): string {
  return issue.kind === 'overlap'
    ? t('training_programs.error_sounds_overlap', { a: slotLabel(issue.a), b: slotLabel(issue.b) })
    : t('training_programs.error_sound_before_start', { slot: slotLabel(issue.slot) })
}

const CHANNEL_I18N_KEYS = { power: 'target_power', heartRate: 'target_heart_rate', cadence: 'target_cadence' } as const

function targetIssueMessage(issue: editing.TargetIssue): string {
  const channel = issue.channel === 'speedKmh'
    ? (trainingProgramStore.sport.value === 'running' ? t('training_programs.target_pace') : t('training_programs.target_speed'))
    : t(`training_programs.${CHANNEL_I18N_KEYS[issue.channel]}`)
  const name = issue.block.segmentName.trim() || formatTime(editing.startSecondsOf(issue.block))
  return t(`training_programs.error_target_${issue.kind}`, { name, channel })
}

// Pourquoi « Répéter » est grisé, pour le dire plutôt que de laisser deviner.
const groupHint = computed(() => {
  const blocker = editing.groupBlocker.value
  return blocker ? t(`training_programs.group_hint_${blocker}`) : ''
})

// snake_case (API, `target_power`/`min_power`/`max_power`, ...) <-> TargetRange.
function targetRangeFromApi(m: any, field: string): TargetRange {
  return {
    target: m[`target_${field}`] ?? null,
    min: m[`min_${field}`] ?? null,
    max: m[`max_${field}`] ?? null,
  }
}

function targetRangeToApi(range: TargetRange, field: string): Record<string, number | null> {
  return {
    [`target_${field}`]: range.target,
    [`min_${field}`]: range.min,
    [`max_${field}`]: range.max,
  }
}

function blockFromApi(b: any): Block {
  return {
    durationSeconds: Math.max(1, Number(b.duration_seconds) || 1),
    startSound: b.start_sound ?? null,
    startCueTiming: b.start_cue_timing ?? DEFAULT_START_TIMING,
    endSound: b.end_sound ?? null,
    endCueTiming: b.end_cue_timing ?? DEFAULT_END_TIMING,
    segmentName: b.segment_name || '',
    description: b.description || '',
    icon: b.icon ?? null,
    color: b.color ?? null,
    textColor: b.text_color ?? null,
    power: targetRangeFromApi(b, 'power'),
    heartRate: targetRangeFromApi(b, 'heart_rate'),
    cadence: targetRangeFromApi(b, 'cadence'),
    speedKmh: targetRangeFromApi(b, 'speed_kmh'),
  }
}

function blockToApi(b: Block) {
  return {
    duration_seconds: b.durationSeconds,
    start_sound: b.startSound,
    start_cue_timing: b.startSound ? b.startCueTiming : null,
    end_sound: b.endSound,
    end_cue_timing: b.endSound ? b.endCueTiming : null,
    segment_name: b.segmentName.trim(),
    description: b.description.trim(),
    icon: b.icon,
    color: b.color,
    text_color: b.textColor,
    ...targetRangeToApi(b.power, 'power'),
    ...targetRangeToApi(b.heartRate, 'heart_rate'),
    ...targetRangeToApi(b.cadence, 'cadence'),
    ...targetRangeToApi(b.speedKmh, 'speed_kmh'),
  }
}

function itemFromApi(item: any): Item {
  return Array.isArray(item.items)
    ? { repeat: Math.min(Math.max(Number(item.repeat) || 2, 2), MAX_REPEAT), items: item.items.map(itemFromApi) }
    : blockFromApi(item)
}

function itemToApi(item: Item) {
  return isGroup(item) ? { repeat: item.repeat, items: item.items.map(itemToApi) } : blockToApi(item)
}

async function fetchProgram(id: number) {
  try {
    const res = await fetch(`/api/training_programs/${id}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const p = payload.training_program
    trainingProgramStore.name.value = p.name || ''
    trainingProgramStore.sport.value = SPORTS.includes(p.sport) ? p.sport : 'cycling'
    trainingProgramStore.shareToken.value = p.share_token || null
    const loaded: any[] = Array.isArray(p.items) ? p.items : []
    trainingProgramStore.items.value = loaded.length ? loaded.map(itemFromApi) : [newBlock()]
    selected.value = new Set()
  } catch (e: any) {
    trainingProgramStore.error.value = e.message
  }
}

async function save() {
  if (saving.value) return
  if (!trainingProgramStore.name.value.trim()) {
    trainingProgramStore.error.value = t('training_programs.error_name_required')
    return
  }
  if (issues.value.length || targetIssues.value.length) {
    trainingProgramStore.error.value = t('training_programs.error_fix_before_save')
    return
  }
  saving.value = true
  trainingProgramStore.error.value = null
  try {
    const body = JSON.stringify({
      name: trainingProgramStore.name.value.trim(),
      sport: trainingProgramStore.sport.value,
      items: items.value.map(itemToApi),
    })
    const url = trainingProgramStore.isEditMode.value
      ? `/api/training_programs/${trainingProgramStore.currentId.value}`
      : '/api/training_programs'
    const method = trainingProgramStore.isEditMode.value ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body,
    })
    if (!res.ok) {
      const errPayload = await res.json().catch(() => null)
      throw new Error(errPayload?.error || `HTTP ${res.status}`)
    }
    const payload = await res.json()
    const p = payload.training_program
    if (p?.share_token) trainingProgramStore.shareToken.value = p.share_token
    if (!trainingProgramStore.isEditMode.value && p?.id) {
      trainingProgramStore.currentId.value = p.id
      window.history.replaceState({}, '', `${localePrefix}/training_programs/${p.id}/edit`)
    }
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { saved.value = false }, 2500)
  } catch (e: any) {
    trainingProgramStore.error.value = e.message
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  trainingProgramStore.reset()
  trainingProgramStore.currentId.value = props.trainingProgramId ? Number(props.trainingProgramId) : null
  if (trainingProgramStore.currentId.value) fetchProgram(trainingProgramStore.currentId.value)
})
</script>

<template>
  <div class="container py-4 tp-builder">
    <!-- Une seule ligne : retour, nom, sport, enregistrer. Sur téléphone les boutons ne
         gardent que leur icône pour laisser la place au nom. -->
    <div class="d-flex align-items-center mb-3 gap-2 flex-nowrap">
      <a :href="`${localePrefix}/training_programs`" class="btn btn-outline-secondary flex-shrink-0"
         :title="t('training_programs.back')" :aria-label="t('training_programs.back')">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span class="d-none d-md-inline ms-1">{{ t('training_programs.back') }}</span>
      </a>
      <input v-model="trainingProgramStore.name.value" type="text" class="form-control flex-grow-1"
             style="min-width: 0" :placeholder="t('training_programs.name_placeholder')" maxlength="80">
      <select v-model="trainingProgramStore.sport.value" class="form-select flex-shrink-0" style="width: auto"
              :title="t('training_programs.sport_hint')">
        <option v-for="sport in SPORTS" :key="sport" :value="sport">{{ t(`training_programs.sport_${sport}`) }}</option>
      </select>
      <button type="button" class="btn btn-warning flex-shrink-0" :disabled="saving" :title="t('training_programs.save')" @click="save">
        <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
        <span class="d-none d-md-inline ms-1">{{ saved ? t('training_programs.saved') : t('training_programs.save') }}</span>
      </button>
    </div>

    <div v-if="trainingProgramStore.error.value" class="alert alert-danger py-2">
      {{ trainingProgramStore.error.value }}
    </div>

    <div v-if="issues.length || targetIssues.length" class="alert alert-warning py-2" role="alert">
      <div v-for="(issue, i) in issues" :key="`s${i}`">
        <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ issueMessage(issue) }}
      </div>
      <div v-for="(issue, i) in targetIssues" :key="`t${i}`">
        <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ targetIssueMessage(issue) }}
      </div>
    </div>

    <div class="mb-3">
      <TrainingProgramProfileChart :profile="profile ?? null" :sport="trainingProgramStore.sport.value" wide />
    </div>

    <div class="card shadow-sm border-0">
      <!-- L'en-tête porte toujours la sélection : sa hauteur ne change pas, que des blocs
           soient sélectionnés ou non, donc le formulaire dessous ne se décale plus. -->
      <div class="tp-sticky-top">
      <div class="card-header activity-card-header tp-card-header d-flex align-items-center gap-2 flex-wrap">
        <template v-if="selected.size > 0">
          <span class="fw-semibold small me-1">{{ t('training_programs.selected_count', { count: selected.size }) }}</span>
          <div class="d-flex align-items-center gap-1">
            <label class="small mb-0" for="tp-repeat-count">{{ t('training_programs.repeat_label') }}</label>
            <input id="tp-repeat-count" v-model.number="repeatCount" type="number" min="2" :max="MAX_REPEAT"
                   class="form-control form-control-sm" style="width: 4.5rem">
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!!editing.groupBlocker.value" @click="editing.groupSelected()">
            <i class="fa-solid fa-repeat me-1" aria-hidden="true"></i>{{ t('training_programs.repeat_selected') }}
          </button>
          <button type="button" class="btn btn-sm btn-link text-body-secondary" @click="editing.clearSelection()">
            {{ t('training_programs.clear_selection') }}
          </button>
          <span v-if="groupHint" class="small text-body-secondary">{{ groupHint }}</span>
        </template>
        <!-- Sans sélection, le profil en tout petit prend la place du message : l'en-tête
             garde sa hauteur. Sans cible nulle part, le message reste. -->
        <div v-else-if="profile" class="flex-grow-1" style="min-width: 0">
          <TrainingProgramProfileChart :profile="profile" :sport="trainingProgramStore.sport.value" mini />
        </div>
        <span v-else class="small text-body-secondary">{{ t('training_programs.selection_empty') }}</span>
        <span class="ms-auto small text-body-secondary text-nowrap">
          <i class="fa-regular fa-clock me-1" aria-hidden="true"></i>{{ t('training_programs.duration', { duration: formatHuman(durationSeconds) }) }}
        </span>
      </div>
      </div>

      <div class="card-body">
        <TrainingProgramItemList :items="items" :owner="null" leading />

        <button type="button" class="btn btn-outline-secondary" :disabled="!editing.canAdd(1, 1)" @click="editing.addBlock(null, 1)">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('training_programs.add_block') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Collé sous la navbar au défilement. Fond opaque : `card-header` est semi-transparent,
   la liste des blocs défilerait au travers. Le card n'a pas d'overflow, le sticky tient. */
.tp-sticky-top {
  position: sticky;
  top: var(--navbar-h, 3.5rem);
  z-index: 5;
  background: var(--bs-card-bg, var(--bs-body-bg));
  border-radius: var(--bs-card-border-radius) var(--bs-card-border-radius) 0 0;
}
.tp-card-header {
  min-height: 3.25rem;
}
</style>
