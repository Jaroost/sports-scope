<script setup lang="ts">
import { ref, computed, onMounted, useTemplateRef, toRaw } from 'vue'
import { t } from '../i18n'
import { trainingProgramStore, openingMilestone, SOUNDS, MILESTONE_ICONS, CUE_TIMINGS, MAX_MILESTONES } from '../stores/trainingProgramStore'
import type { Milestone, Sound } from '../stores/trainingProgramStore'
import { csrfToken } from '../csrf'
import CompanionColorPicker from './CompanionColorPicker.vue'

const props = defineProps({
  trainingProgramId: { type: [String, Number], default: null },
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const saving = ref(false)
const saved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

const milestones = trainingProgramStore.milestones
const previewAudio = useTemplateRef<HTMLAudioElement>('previewAudio')

// Sélection multiple pour répéter un bloc (ex. effort/repos d'un fractionné) — par
// référence d'objet et non par index : `normalize()` retrie le tableau après chaque
// modif, un index se périmerait.
const selected = ref<Set<Milestone>>(new Set())
const repeatCount = ref(2)

function isSelected(milestone: Milestone): boolean {
  return selected.value.has(milestone)
}

function toggleSelected(milestone: Milestone) {
  const next = new Set(selected.value)
  if (next.has(milestone)) next.delete(milestone)
  else next.add(milestone)
  selected.value = next
}

// Indices (dans l'ordre chronologique courant) des jalons sélectionnés.
function selectedIndices(): number[] {
  return milestones.value
    .map((m, i) => (selected.value.has(m) ? i : -1))
    .filter((i) => i >= 0)
}

// Répéter suppose une sélection contiguë suivie d'au moins un jalon : ce jalon
// suivant sert de clôture (cf. repeatSelected) et doit déjà exister.
const canRepeatSelected = computed(() => {
  const indices = selectedIndices()
  if (indices.length === 0) return false
  for (let k = 1; k < indices.length; k++) {
    if (indices[k] !== indices[k - 1] + 1) return false
  }
  return indices[indices.length - 1] + 1 < milestones.value.length
})

const durationSeconds = computed(() => milestones.value[milestones.value.length - 1]?.offsetSeconds ?? 0)

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Accepte "m:ss" ou un nombre brut de secondes. `null` = saisie inexploitable
// (le champ est alors laissé tel quel, sans modifier le jalon).
function parseTime(text: string): number | null {
  const trimmed = text.trim()
  const withColon = trimmed.match(/^(\d+):([0-5]?\d)$/)
  if (withColon) return Number(withColon[1]) * 60 + Number(withColon[2])
  const bare = trimmed.match(/^\d+$/)
  return bare ? Number(bare[0]) : null
}

// Retri par le temps (décision retenue : pas de boutons monter/descendre, le
// temps saisi est la seule source d'ordre) + garanties attendues côté serveur :
// premier jalon toujours à 0, offsets strictement croissants.
function normalize() {
  const arr = [...milestones.value].sort((a, b) => a.offsetSeconds - b.offsetSeconds)
  let previous = -1
  arr.forEach((m, i) => {
    if (i === 0) {
      m.offsetSeconds = 0
    } else if (m.offsetSeconds <= previous) {
      m.offsetSeconds = previous + 1
    }
    previous = m.offsetSeconds
  })
  milestones.value = arr
}

// Champ "temps absolu" : fixe directement la position du jalon depuis le début.
function onTimeChange(milestone: Milestone, event: Event) {
  const parsed = parseTime((event.target as HTMLInputElement).value)
  if (parsed != null) milestone.offsetSeconds = Math.max(0, parsed)
  normalize()
}

// Champ "durée depuis le jalon précédent" : les deux champs pointent vers le même
// offsetSeconds, juste affiché différemment — modifier l'un met l'autre à jour.
function deltaSeconds(index: number): number {
  return milestones.value[index].offsetSeconds - milestones.value[index - 1].offsetSeconds
}

function onDeltaChange(index: number, event: Event) {
  const parsed = parseTime((event.target as HTMLInputElement).value)
  if (parsed != null) milestones.value[index].offsetSeconds = milestones.value[index - 1].offsetSeconds + Math.max(0, parsed)
  normalize()
}

function iconClass(icon: string): string {
  return MILESTONE_ICONS.find((i) => i.key === icon)?.icon ?? ''
}

function addMilestone() {
  if (milestones.value.length >= MAX_MILESTONES) return
  const last = milestones.value[milestones.value.length - 1]
  milestones.value.push({
    offsetSeconds: (last?.offsetSeconds ?? 0) + 60,
    sound: null,
    segmentName: '',
    icon: null,
    cueTiming: null,
    color: null,
    textColor: null,
  })
}

// Insère un jalon vide entre le jalon `index - 1` et le jalon `index` (ex. un
// rappel de boisson au milieu d'un long tronçon), à mi-chemin des deux.
function insertMilestoneBefore(index: number) {
  if (milestones.value.length >= MAX_MILESTONES) return
  const prev = milestones.value[index - 1]
  const curr = milestones.value[index]
  const mid = prev.offsetSeconds + Math.max(1, Math.round((curr.offsetSeconds - prev.offsetSeconds) / 2))
  milestones.value.splice(index, 0, {
    offsetSeconds: mid,
    sound: null,
    segmentName: '',
    icon: null,
    cueTiming: null,
    color: null,
    textColor: null,
  })
  normalize()
}

function duplicateMilestone(index: number) {
  if (milestones.value.length >= MAX_MILESTONES) return
  const copy = structuredClone(toRaw(milestones.value[index])) as Milestone
  copy.offsetSeconds += 1
  milestones.value.splice(index + 1, 0, copy)
  normalize()
}

// Répète un bloc contigu (ex. effort + repos d'un fractionné) `repeatCount` fois
// au total. Le jalon qui suit immédiatement la sélection sert de clôture : c'est
// lui qui donne la durée du dernier segment sélectionné (celle d'un jalon n'est
// jamais que l'écart jusqu'au suivant), donc il n'est jamais dupliqué — seulement
// repoussé, avec tout ce qui vient après lui, pour laisser la place aux copies.
// Sans ce jalon de clôture, dupliquer le bloc perdrait la durée de son dernier
// segment (d'où `canRepeatSelected`, qui exige sa présence).
function repeatSelected() {
  if (!canRepeatSelected.value) return
  const times = Math.max(2, Math.floor(repeatCount.value) || 2)
  const indices = selectedIndices()
  const closingIndex = indices[indices.length - 1] + 1
  const repeats = times - 1
  if (milestones.value.length + indices.length * repeats > MAX_MILESTONES) return

  const cycleLength = milestones.value[closingIndex].offsetSeconds - milestones.value[indices[0]].offsetSeconds
  if (cycleLength <= 0) return

  const body = indices.map((i) => milestones.value[i])
  const copies: Milestone[] = []
  for (let k = 1; k <= repeats; k++) {
    for (const m of body) {
      const copy = structuredClone(toRaw(m)) as Milestone
      copy.offsetSeconds = m.offsetSeconds + k * cycleLength
      copies.push(copy)
    }
  }

  const shift = repeats * cycleLength
  milestones.value.forEach((m, i) => { if (i >= closingIndex) m.offsetSeconds += shift })
  milestones.value.splice(closingIndex, 0, ...copies)
  normalize()
  selected.value = new Set()
}

function removeMilestone(index: number) {
  if (index === 0) return // le jalon d'ouverture (0:00) n'est jamais supprimable
  const [removed] = milestones.value.splice(index, 1)
  if (selected.value.has(removed)) {
    const next = new Set(selected.value)
    next.delete(removed)
    selected.value = next
  }
}

function soundUrl(sound: Sound): string {
  return `/sounds/${sound}.wav`
}

function playSound(sound: Sound | null) {
  if (!sound || !previewAudio.value) return
  previewAudio.value.src = soundUrl(sound)
  previewAudio.value.currentTime = 0
  previewAudio.value.play().catch(() => { /* lecture bloquée (autoplay) — pas grave, c'est un aperçu */ })
}

function soundLabel(sound: Sound): string {
  return t(`training_programs.sound_${sound}`)
}

async function fetchProgram(id: number) {
  try {
    const res = await fetch(`/api/training_programs/${id}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const p = payload.training_program
    trainingProgramStore.name.value = p.name || ''
    trainingProgramStore.shareToken.value = p.share_token || null
    const loaded = Array.isArray(p.milestones) ? p.milestones : []
    trainingProgramStore.milestones.value = loaded.length
      ? loaded.map((m: any) => ({
          offsetSeconds: Number(m.offset_seconds) || 0,
          sound: m.sound ?? null,
          segmentName: m.segment_name || '',
          icon: m.icon ?? null,
          cueTiming: m.cue_timing ?? null,
          color: m.color ?? null,
          textColor: m.text_color ?? null,
        }))
      : [openingMilestone()]
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
  saving.value = true
  trainingProgramStore.error.value = null
  try {
    normalize()
    const body = JSON.stringify({
      name: trainingProgramStore.name.value.trim(),
      milestones: milestones.value.map((m) => ({
        offset_seconds: m.offsetSeconds,
        sound: m.sound,
        segment_name: m.segmentName.trim(),
        icon: m.icon,
        cue_timing: m.cueTiming,
        color: m.color,
        text_color: m.textColor,
      })),
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
    <div class="d-flex align-items-center justify-content-between mb-3 gap-2">
      <a :href="`${localePrefix}/training_programs`" class="btn btn-sm btn-outline-secondary">
        <i class="fa-solid fa-arrow-left me-1" aria-hidden="true"></i>{{ t('training_programs.back') }}
      </a>
      <button type="button" class="btn btn-warning" :disabled="saving" @click="save">
        <i class="fa-solid fa-floppy-disk me-1" aria-hidden="true"></i>
        {{ saved ? t('training_programs.saved') : t('training_programs.save') }}
      </button>
    </div>

    <div v-if="trainingProgramStore.error.value" class="alert alert-danger py-2">
      {{ trainingProgramStore.error.value }}
    </div>

    <div class="mb-4">
      <input v-model="trainingProgramStore.name.value" type="text" class="form-control form-control-lg"
             :placeholder="t('training_programs.name_placeholder')" maxlength="80">
    </div>

    <p class="text-body-secondary small mb-4">
      {{ t('training_programs.duration', { duration: formatTime(durationSeconds) }) }}
    </p>

    <div v-if="selected.size > 0" class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <div class="d-flex align-items-center gap-1">
        <label class="small mb-0" for="tp-repeat-count">{{ t('training_programs.repeat_label') }}</label>
        <input id="tp-repeat-count" v-model.number="repeatCount" type="number" min="2" max="50"
               class="form-control form-control-sm" style="width: 4.5rem">
      </div>
      <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!canRepeatSelected" @click="repeatSelected">
        <i class="fa-solid fa-repeat me-1" aria-hidden="true"></i>{{ t('training_programs.repeat_selected') }}
      </button>
      <button type="button" class="btn btn-sm btn-link text-body-secondary" @click="selected = new Set()">
        {{ t('training_programs.clear_selection') }}
      </button>
      <span v-if="!canRepeatSelected" class="small text-body-secondary">{{ t('training_programs.repeat_hint') }}</span>
    </div>

    <div class="tp-timeline">
      <template v-for="(milestone, index) in milestones" :key="index">
        <div v-if="index !== 0" class="tp-connector d-flex align-items-center gap-1">
          <i class="fa-solid fa-arrow-down-long text-body-secondary" aria-hidden="true"></i>
          <input type="text" class="form-control form-control-sm tp-time-input"
                 :title="t('training_programs.time_delta_hint')"
                 :value="formatTime(deltaSeconds(index))" @change="onDeltaChange(index, $event)">
          <button type="button" class="btn btn-sm btn-link p-1" :disabled="milestones.length >= MAX_MILESTONES"
                  :title="t('training_programs.insert_milestone')" :aria-label="t('training_programs.insert_milestone')"
                  @click="insertMilestoneBefore(index)">
            <i class="fa-solid fa-plus" aria-hidden="true"></i>
          </button>
        </div>
        <div class="tp-milestone card mb-3" :class="{ 'tp-milestone-selected': isSelected(milestone) }"
             :style="milestone.color ? { '--tp-dot-color': milestone.color } : {}">
          <div class="card-body d-flex align-items-start gap-2 flex-wrap">
          <div class="form-check mt-1">
            <input type="checkbox" class="form-check-input" :checked="isSelected(milestone)"
                   :aria-label="t('training_programs.select_milestone')"
                   @change="toggleSelected(milestone)">
          </div>

          <div v-if="index === 0" class="tp-time">
            <label class="form-label small mb-1">0:00</label>
          </div>
          <div v-else class="tp-time">
            <input type="text" class="form-control form-control-sm tp-time-input"
                   :title="t('training_programs.time_absolute_hint')"
                   :value="formatTime(milestone.offsetSeconds)" @change="onTimeChange(milestone, $event)">
          </div>

          <div class="flex-grow-1" style="min-width: 12rem">
            <input v-model="milestone.segmentName" type="text" class="form-control form-control-sm"
                   :placeholder="t('training_programs.segment_name_placeholder')" maxlength="60">
          </div>

          <div class="d-flex align-items-center gap-1">
            <i v-if="milestone.icon" class="fa-solid tp-icon-preview" :class="iconClass(milestone.icon)" aria-hidden="true"></i>
            <select v-model="milestone.icon" class="form-select form-select-sm" style="width: auto">
              <option :value="null">{{ t('training_programs.icon_none') }}</option>
              <option v-for="icon in MILESTONE_ICONS" :key="icon.key" :value="icon.key">{{ t(`training_programs.icon_${icon.key}`) }}</option>
            </select>
          </div>

          <div class="d-flex align-items-center gap-1">
            <select v-model="milestone.sound" class="form-select form-select-sm" style="width: auto">
              <option :value="null">{{ t('training_programs.sound_none') }}</option>
              <option v-for="sound in SOUNDS" :key="sound" :value="sound">{{ soundLabel(sound) }}</option>
            </select>
            <button type="button" class="btn btn-sm btn-link p-1" :disabled="!milestone.sound"
                    :title="t('training_programs.play_preview')" :aria-label="t('training_programs.play_preview')"
                    @click="playSound(milestone.sound)">
              <i class="fa-solid fa-play" aria-hidden="true"></i>
            </button>
          </div>

          <div v-if="index !== 0 && milestone.sound" class="d-flex align-items-center gap-1">
            <select v-model="milestone.cueTiming" class="form-select form-select-sm" style="width: auto">
              <option v-for="timing in CUE_TIMINGS" :key="timing" :value="timing">{{ t(`training_programs.cue_timing_${timing}`) }}</option>
            </select>
          </div>

          <div class="d-flex align-items-center gap-1">
            <CompanionColorPicker v-model="milestone.color" fallback="#6c757d" :label="t('training_programs.segment_color')" />
            <CompanionColorPicker v-model="milestone.textColor" fallback="#ffffff" :label="t('training_programs.segment_text_color')" />
          </div>

          <div class="d-flex gap-1 ms-auto">
            <button type="button" class="btn btn-sm btn-link p-1" :disabled="milestones.length >= MAX_MILESTONES"
                    :title="t('training_programs.duplicate')" :aria-label="t('training_programs.duplicate')"
                    @click="duplicateMilestone(index)">
              <i class="fa-regular fa-copy" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-link text-danger p-1" :disabled="index === 0"
                    :title="t('training_programs.delete')" :aria-label="t('training_programs.delete')"
                    @click="removeMilestone(index)">
              <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        </div>
      </template>
    </div>

    <button type="button" class="btn btn-outline-secondary" :disabled="milestones.length >= MAX_MILESTONES" @click="addMilestone">
      <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('training_programs.add_milestone') }}
    </button>

    <audio ref="previewAudio"></audio>
  </div>
</template>

<style scoped>
.tp-timeline {
  position: relative;
  padding-left: 1.5rem;
}
.tp-timeline::before {
  content: '';
  position: absolute;
  left: 0.5rem;
  top: 0.25rem;
  bottom: 0.25rem;
  width: 2px;
  background: var(--bs-border-color);
}
.tp-milestone {
  position: relative;
}
.tp-milestone-selected {
  border-color: var(--bs-warning);
  box-shadow: 0 0 0 1px var(--bs-warning);
}
.tp-milestone::before {
  content: '';
  position: absolute;
  left: -1.5rem;
  top: 1.25rem;
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  background: var(--tp-dot-color, var(--bs-warning));
}
.tp-connector {
  margin: -0.25rem 0 0.75rem 0.1rem;
}
.tp-connector i {
  width: 0.9rem;
  text-align: center;
}
.tp-time {
  flex-shrink: 0;
}
.tp-time-input {
  width: 3.5rem;
}
.tp-icon-preview {
  width: 1.5rem;
  text-align: center;
  color: var(--bs-warning);
}
</style>
