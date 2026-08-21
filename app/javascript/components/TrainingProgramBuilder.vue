<script setup lang="ts">
import { ref, computed, onMounted, useTemplateRef, toRaw } from 'vue'
import { t } from '../i18n'
import { trainingProgramStore, openingMilestone, SOUNDS, MAX_MILESTONES } from '../stores/trainingProgramStore'
import type { Milestone, Sound } from '../stores/trainingProgramStore'
import { csrfToken } from '../csrf'

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

function onTimeChange(milestone: Milestone, event: Event) {
  const parsed = parseTime((event.target as HTMLInputElement).value)
  if (parsed != null) milestone.offsetSeconds = Math.max(0, parsed)
  normalize()
}

function addMilestone() {
  if (milestones.value.length >= MAX_MILESTONES) return
  const last = milestones.value[milestones.value.length - 1]
  milestones.value.push({ offsetSeconds: (last?.offsetSeconds ?? 0) + 60, sound: null, segmentName: '' })
}

function duplicateMilestone(index: number) {
  if (milestones.value.length >= MAX_MILESTONES) return
  const copy = structuredClone(toRaw(milestones.value[index])) as Milestone
  copy.offsetSeconds += 1
  milestones.value.splice(index + 1, 0, copy)
  normalize()
}

function removeMilestone(index: number) {
  if (index === 0) return // le jalon d'ouverture (0:00) n'est jamais supprimable
  milestones.value.splice(index, 1)
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
        }))
      : [openingMilestone()]
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

    <div class="tp-timeline">
      <div v-for="(milestone, index) in milestones" :key="index" class="tp-milestone card mb-3">
        <div class="card-body d-flex align-items-start gap-2 flex-wrap">
          <div class="tp-time">
            <label class="form-label small mb-1">{{ index === 0 ? '0:00' : '' }}</label>
            <input v-if="index !== 0" type="text" class="form-control form-control-sm tp-time-input"
                   :value="formatTime(milestone.offsetSeconds)" @change="onTimeChange(milestone, $event)">
          </div>

          <div class="flex-grow-1" style="min-width: 12rem">
            <input v-model="milestone.segmentName" type="text" class="form-control form-control-sm"
                   :placeholder="t('training_programs.segment_name_placeholder')" maxlength="60">
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
.tp-milestone::before {
  content: '';
  position: absolute;
  left: -1.5rem;
  top: 1.25rem;
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  background: var(--bs-warning);
}
.tp-time {
  width: 4.5rem;
  flex-shrink: 0;
}
.tp-time-input {
  width: 4.5rem;
}
</style>
