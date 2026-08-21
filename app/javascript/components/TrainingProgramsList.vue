<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import { formatDuration } from '../routeHelpers'
import CompanionStartWorkoutAction from './CompanionStartWorkoutAction.vue'

interface TrainingProgramSummary {
  id: number
  name: string
  share_token: string
  duration_seconds: number
  segment_count: number
  updated_at: string
}

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const programs = ref<TrainingProgramSummary[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function fetchPrograms() {
  loading.value = true
  try {
    const res = await fetch('/api/training_programs', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    programs.value = payload.training_programs ?? []
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function renameProgram(program: TrainingProgramSummary) {
  const raw = window.prompt(t('training_programs.rename'), program.name)
  if (raw == null) return
  const name = raw.trim().slice(0, 80)
  if (!name || name === program.name) return
  try {
    const res = await fetch(`/api/training_programs/${program.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const updated = payload.training_program
    const idx = programs.value.findIndex((p) => p.id === program.id)
    if (idx >= 0 && updated) programs.value[idx] = { ...programs.value[idx], name: updated.name, updated_at: updated.updated_at }
  } catch (e: any) {
    error.value = e.message
  }
}

async function duplicateProgram(program: TrainingProgramSummary) {
  const proposed = t('training_programs.copy_suffix') ? `${program.name} ${t('training_programs.copy_suffix')}` : program.name
  const raw = window.prompt(t('training_programs.duplicate'), proposed.slice(0, 80))
  if (raw == null) return
  const name = raw.trim().slice(0, 80) || proposed.slice(0, 80)
  try {
    const res = await fetch(`/api/training_programs/${program.id}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await fetchPrograms()
  } catch (e: any) {
    error.value = e.message
  }
}

async function removeProgram(program: TrainingProgramSummary) {
  if (!window.confirm(t('training_programs.confirm_delete'))) return
  try {
    const res = await fetch(`/api/training_programs/${program.id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    programs.value = programs.value.filter((p) => p.id !== program.id)
  } catch (e: any) {
    error.value = e.message
  }
}

onMounted(fetchPrograms)
</script>

<template>
  <div class="container py-4">
    <div class="d-flex align-items-center justify-content-between mb-3">
      <h1 class="h4 mb-0">{{ t('training_programs.list_title') }}</h1>
      <a :href="`${localePrefix}/training_programs/new`" class="btn btn-warning">
        <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('training_programs.new') }}
      </a>
    </div>

    <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

    <div v-if="!loading && programs.length === 0" class="text-body-secondary">
      {{ t('training_programs.empty') }}
    </div>

    <div v-else class="list-group">
      <div v-for="program in programs" :key="program.id" class="list-group-item d-flex align-items-center gap-3 flex-wrap">
        <a :href="`${localePrefix}/training_programs/${program.id}/edit`" class="flex-grow-1 text-decoration-none text-body">
          <span class="d-block fw-semibold">{{ program.name }}</span>
          <small class="text-body-secondary">
            {{ formatDuration(program.duration_seconds) }} · {{ t('training_programs.segment_count', { count: program.segment_count }) }}
          </small>
        </a>
        <div class="d-flex gap-1">
          <CompanionStartWorkoutAction :share-token="program.share_token" />
          <button type="button" class="btn btn-sm btn-link p-1" :title="t('training_programs.rename')" @click="renameProgram(program)">
            <i class="fa-solid fa-pen" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-link p-1" :title="t('training_programs.duplicate')" @click="duplicateProgram(program)">
            <i class="fa-regular fa-copy" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-link text-danger p-1" :title="t('training_programs.delete')" @click="removeProgram(program)">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
