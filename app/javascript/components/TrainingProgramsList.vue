<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import { formatHuman } from '../trainingProgramTime'
import CompanionStartWorkoutAction from './CompanionStartWorkoutAction.vue'
import TrainingProgramProfileChart from './TrainingProgramProfileChart.vue'
import { useAthleteState } from '../composables/useAthleteState'
import { FEAS_COLOR } from '../composables/useTrainingPlan'
import { estimateProgramLoad } from '../routeLoad'
import { serializeProgram, fileNameFor, downloadText, parseProgramFile, MAX_FILE_BYTES } from '../trainingProgramFile'

interface TrainingProgramSummary {
  id: number
  name: string
  sport: string
  share_token: string
  profile: { channels: string[]; steps: any[] } | null
  duration_seconds: number
  segment_count: number
  updated_at: string
}

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const programs = ref<TrainingProgramSummary[]>([])

// ─── Filtres ─────────────────────────────────────────────────────────────────
// Nom, puis une fourchette par mesure ciblée. Un programme porte une cible par bloc :
// on compare la valeur moyenne, pondérée par la durée des blocs qui la visent.
const CHANNEL_FILTERS = ['power', 'heart_rate', 'cadence'] as const
const FILTERS_STORAGE_KEY = 'sportsScope.trainingProgramsFilters'
const showFilters = ref(false)
const search = ref('')
const sportFilter = ref('')
const ranges = reactive<Record<string, { min: string; max: string }>>(
  Object.fromEntries(CHANNEL_FILTERS.map((c) => [c, { min: '', max: '' }])),
)

try {
  const saved = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? 'null')
  if (saved && typeof saved === 'object') {
    if (typeof saved.search === 'string') search.value = saved.search
    if (typeof saved.sport === 'string') sportFilter.value = saved.sport
    if (typeof saved.showFilters === 'boolean') showFilters.value = saved.showFilters
    for (const c of CHANNEL_FILTERS) {
      if (saved.ranges?.[c]) { ranges[c].min = String(saved.ranges[c].min ?? ''); ranges[c].max = String(saved.ranges[c].max ?? '') }
    }
  }
} catch { /* stockage indisponible : filtres vides */ }

watch([search, sportFilter, showFilters, () => JSON.stringify(ranges)], () => {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ search: search.value, sport: sportFilter.value, showFilters: showFilters.value, ranges }))
  } catch { /* ignoré */ }
})

function averageTarget(program: TrainingProgramSummary, channel: string): number | null {
  let weighted = 0
  let seconds = 0
  for (const step of program.profile?.steps ?? []) {
    const target = (step[channel] as (number | null)[] | undefined)?.[0]
    if (target == null) continue
    weighted += target * step.duration_seconds
    seconds += step.duration_seconds
  }
  return seconds > 0 ? weighted / seconds : null
}

const activeFilterCount = computed(() =>
  (search.value.trim() ? 1 : 0) + (sportFilter.value ? 1 : 0) +
  CHANNEL_FILTERS.filter((c) => ranges[c].min !== '' || ranges[c].max !== '').length,
)

function clearFilters() {
  search.value = ''
  sportFilter.value = ''
  for (const c of CHANNEL_FILTERS) { ranges[c].min = ''; ranges[c].max = '' }
}

const filteredPrograms = computed(() => {
  const q = search.value.trim().toLocaleLowerCase()
  return programs.value.filter((p) => {
    if (q && !p.name.toLocaleLowerCase().includes(q)) return false
    if (sportFilter.value && p.sport !== sportFilter.value) return false
    for (const c of CHANNEL_FILTERS) {
      const { min, max } = ranges[c]
      if (min === '' && max === '') continue
      const avg = averageTarget(p, c)
      if (avg == null) return false
      if (min !== '' && avg < Number(min)) return false
      if (max !== '' && avg > Number(max)) return false
    }
    return true
  })
})

// ─── Charge estimée ──────────────────────────────────────────────────────────
const { athlete } = useAthleteState()
const loads = computed(() => {
  const out = new Map<number, { tss: number; level: 'ok' | 'demanding' | 'hard' | null }>()
  if (!athlete.value) return out
  for (const p of programs.value) {
    const load = estimateProgramLoad(p.profile?.steps ?? [], p.duration_seconds, p.sport, athlete.value)
    if (load) out.set(p.id, load)
  }
  return out
})

const sportIcon = (sport: string) => (sport === 'running' ? 'fa-person-running' : 'fa-bicycle')
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

// Exporte le programme tel que l'API le sert (blocs et groupes), dans un fichier JSON.
async function exportProgram(program: TrainingProgramSummary) {
  try {
    const res = await fetch(`/api/training_programs/${program.id}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const full = (await res.json()).training_program
    downloadText(fileNameFor(full.name), serializeProgram(full))
  } catch (e: any) {
    error.value = e.message
  }
}

const importInput = ref<HTMLInputElement | null>(null)

// Crée un nouveau programme à partir d'un fichier exporté. Le serveur le reconstruit et
// le valide (durées, sons qui se chevauchent, cibles) : son message d'erreur est affiché tel quel.
async function importProgram(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // permet de réimporter le même fichier
  if (!file) return
  error.value = null
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(t('training_programs.import_error_invalid'))
    const parsed = parseProgramFile(await file.text())
    const res = await fetch('/api/training_programs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ name: parsed.name.trim() || file.name.replace(/\.json$/i, ''), sport: parsed.sport, items: parsed.items }),
    })
    if (!res.ok) {
      const errPayload = await res.json().catch(() => null)
      throw new Error(errPayload?.error || `HTTP ${res.status}`)
    }
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
      <div class="d-flex gap-2">
        <button type="button" class="btn btn-outline-secondary" @click="importInput?.click()">
          <i class="fa-solid fa-file-import me-1" aria-hidden="true"></i>{{ t('training_programs.import') }}
        </button>
        <input ref="importInput" type="file" accept="application/json,.json" class="d-none" @change="importProgram">
        <a :href="`${localePrefix}/training_programs/new`" class="btn btn-warning">
          <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('training_programs.new') }}
        </a>
      </div>
    </div>

    <div v-if="error" class="alert alert-danger py-2">{{ error }}</div>

    <div v-if="!loading && programs.length === 0" class="text-body-secondary">
      {{ t('training_programs.empty') }}
    </div>

    <div v-else class="card shadow-sm border-0">
      <div class="card-header activity-card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h2 class="h5 mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-list-check text-warning" aria-hidden="true"></i>
          <span>{{ t('training_programs.list_heading') }}</span>
          <span class="badge rounded-pill text-bg-secondary">
            {{ activeFilterCount ? `${filteredPrograms.length} / ${programs.length}` : programs.length }}
          </span>
        </h2>
        <div class="btn-group btn-group-sm">
          <button type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                  :class="{ active: showFilters }" :aria-expanded="showFilters" @click="showFilters = !showFilters">
            <i class="fa-solid fa-filter" aria-hidden="true"></i>
            <span>{{ t('routes.filters.toggle') }}</span>
            <span v-if="activeFilterCount" class="badge rounded-pill text-bg-warning">{{ activeFilterCount }}</span>
          </button>
          <button v-if="activeFilterCount" type="button" class="btn btn-sm btn-danger d-flex align-items-center"
                  :title="t('routes.filters.clear')" :aria-label="t('routes.filters.clear')" @click="clearFilters">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <div v-if="showFilters" class="card-body border-bottom">
        <div class="row g-3">
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1">{{ t('training_programs.filter_name') }}</label>
            <input v-model="search" type="search" class="form-control form-control-sm" :placeholder="t('training_programs.filter_name_placeholder')">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1">{{ t('routes.filters.sport') }}</label>
            <select v-model="sportFilter" class="form-select form-select-sm">
              <option value="">{{ t('routes.filters.all_sports') }}</option>
              <option value="cycling">{{ t('training_programs.sport_cycling') }}</option>
              <option value="running">{{ t('training_programs.sport_running') }}</option>
            </select>
          </div>
          <div v-for="c in CHANNEL_FILTERS" :key="c" class="col-12 col-md-4">
            <label class="form-label small mb-1">{{ t(`training_programs.filter_avg_${c}`) }}</label>
            <div class="d-flex align-items-center gap-1">
              <input v-model="ranges[c].min" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('routes.filters.min')">
              <span class="text-muted">–</span>
              <input v-model="ranges[c].max" type="number" min="0" step="1" class="form-control form-control-sm" :placeholder="t('routes.filters.max')">
            </div>
          </div>
        </div>
        <div class="d-flex justify-content-between align-items-center mt-3">
          <small class="text-muted">{{ t('routes.filters.results', { count: filteredPrograms.length, total: programs.length }) }}</small>
          <div class="d-flex align-items-center gap-2">
            <button type="button" class="btn btn-sm btn-link text-decoration-none" :disabled="!activeFilterCount" @click="clearFilters">
              <i class="fa-solid fa-xmark me-1" aria-hidden="true"></i>{{ t('routes.filters.clear') }}
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" @click="showFilters = false">
              <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
              <span>{{ t('routes.filters.close') }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="filteredPrograms.length === 0" class="card-body text-body-secondary">
        {{ t('training_programs.none_match') }}
      </div>
      <div class="list-group list-group-flush">
        <div v-for="program in filteredPrograms" :key="program.id" class="list-group-item activity-row d-flex align-items-center gap-3 flex-wrap">
          <span class="program-icon" :title="t(`training_programs.sport_${program.sport}`)">
            <i :class="`fa-solid ${sportIcon(program.sport)}`" aria-hidden="true"></i>
          </span>
          <a :href="`${localePrefix}/training_programs/${program.id}/edit`" class="flex-grow-1 text-decoration-none text-body">
            <span class="d-block fw-semibold">{{ program.name }}</span>
            <small class="text-body-secondary d-flex flex-wrap align-items-center gap-x-3 gap-y-1">
              <span>{{ formatHuman(program.duration_seconds) }} · {{ t('training_programs.segment_count', { count: program.segment_count }) }}</span>
              <span v-if="loads.get(program.id)" class="d-inline-flex align-items-center gap-1" :title="t('routes.tss.hint_short')">
                <i class="fa-solid fa-bolt" style="color: #6f42c1" aria-hidden="true"></i>
                <span>{{ t('routes.tss.label') }} ≈ {{ loads.get(program.id)!.tss }}</span>
                <span v-if="loads.get(program.id)!.level" class="fw-semibold"
                      :style="{ color: FEAS_COLOR[loads.get(program.id)!.level!] }"
                      :title="t(`routes.tss.level_${loads.get(program.id)!.level}_hint`)">{{ t(`routes.tss.level_${loads.get(program.id)!.level}`) }}</span>
              </span>
            </small>
          </a>
          <div v-if="program.profile" class="program-chart">
            <TrainingProgramProfileChart :profile="program.profile" :sport="program.sport" wide />
          </div>
          <div class="d-flex gap-1 program-actions">
            <CompanionStartWorkoutAction :share-token="program.share_token" />
            <button type="button" class="btn btn-sm btn-outline-secondary" :title="t('training_programs.rename')" @click="renameProgram(program)">
              <i class="fa-solid fa-pen" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" :title="t('training_programs.export')" :aria-label="t('training_programs.export')" @click="exportProgram(program)">
              <i class="fa-solid fa-file-export" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" :title="t('training_programs.duplicate')" @click="duplicateProgram(program)">
              <i class="fa-regular fa-copy" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger" :title="t('training_programs.delete')" @click="removeProgram(program)">
              <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.program-icon {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  font-size: 1.25rem;
  /* Même fond sombre que l'aperçu d'un itinéraire ou d'une sortie. */
  background: radial-gradient(120% 100% at 30% 15%, #5c666f 0%, #4a545c 60%, #3d464d 100%);
  color: var(--bs-warning, #ffc107);
}
/* Téléphone : le graphique passe sur sa propre ligne, pleine largeur, sous le nom et
   les boutons. À partir de md il reprend sa place entre le nom et les boutons. */
.program-chart {
  order: 3;
  flex: 1 0 100%;
}
.program-actions {
  margin-left: auto;
  flex-shrink: 0;
}
@media (min-width: 768px) {
  .program-chart {
    order: 0;
    flex: 0 0 18rem;
  }
  .program-chart :deep(.tp-profile-svg) {
    height: 4rem;
  }
}
.gap-x-3 { column-gap: 0.75rem; }
.gap-y-1 { row-gap: 0.25rem; }
</style>
