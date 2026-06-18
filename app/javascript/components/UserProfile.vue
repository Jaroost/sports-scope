<script setup lang="ts">
import { reactive, ref } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES } from '../mapStyles'

interface Preferences {
  points_of_interest: {
    show_cemeteries: boolean
    show_bakeries: boolean
    show_localities: boolean
    radius_m: number
  }
  map: {
    default_style: string
  }
  display: {
    units: string
    default_sport: string
    show_grade_colors: boolean
    show_elevation_chart: boolean
  }
  climb_detection: {
    min_grade: number
    min_gain_m: number
    min_length_m: number
  }
}

const props = defineProps<{ preferences: Preferences }>()

// Copie réactive locale : on n'écrit côté serveur qu'à la sauvegarde explicite.
const prefs = reactive<Preferences>(JSON.parse(JSON.stringify(props.preferences)))

const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

const SPORTS = ['cycling', 'mtb', 'hiking'] as const
const UNITS = ['metric', 'imperial'] as const

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function save() {
  saving.value = true
  error.value = null
  try {
    const res = await fetch('/api/profile/preferences', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ preferences: prefs }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    // On réaligne sur les valeurs assainies renvoyées par le serveur (clamps).
    Object.assign(prefs, payload.preferences)
    saved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { saved.value = false }, 2500)
  } catch (e) {
    error.value = (e as Error).message || 'error'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="user-profile" @submit.prevent="save">
    <!-- Points d'intérêt -->
    <section class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-location-dot text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.poi.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.poi.help') }}</p>
        <div class="form-check form-switch mb-2">
          <input id="poi-bakeries" v-model="prefs.points_of_interest.show_bakeries" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="poi-bakeries">
            <i class="fa-solid fa-bread-slice me-1 text-muted" aria-hidden="true"></i>{{ t('profile.poi.bakeries') }}
          </label>
        </div>
        <div class="form-check form-switch mb-2">
          <input id="poi-cemeteries" v-model="prefs.points_of_interest.show_cemeteries" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="poi-cemeteries">
            <i class="fa-solid fa-cross me-1 text-muted" aria-hidden="true"></i>{{ t('profile.poi.cemeteries') }}
          </label>
        </div>
        <div class="form-check form-switch mb-3">
          <input id="poi-localities" v-model="prefs.points_of_interest.show_localities" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="poi-localities">
            <i class="fa-solid fa-city me-1 text-muted" aria-hidden="true"></i>{{ t('profile.poi.localities') }}
          </label>
        </div>
        <label for="poi-radius" class="form-label mb-1">
          {{ t('profile.poi.radius') }} : <strong>{{ prefs.points_of_interest.radius_m }} m</strong>
        </label>
        <input id="poi-radius" v-model.number="prefs.points_of_interest.radius_m" type="range" class="form-range" min="200" max="5000" step="100">
      </div>
    </section>

    <!-- Type de carte -->
    <section class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-map text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.map.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.map.help') }}</p>
        <div class="d-flex flex-wrap gap-2">
          <label
            v-for="style in MAP_STYLES"
            :key="style.id"
            class="map-style-option"
            :class="{ active: prefs.map.default_style === style.id }"
          >
            <input v-model="prefs.map.default_style" class="visually-hidden" type="radio" name="map-style" :value="style.id">
            <i :class="`fa-solid ${style.icon}`" aria-hidden="true"></i>
            <span>{{ t(`profile.map.style_${style.id}`) }}</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Préférences d'affichage -->
    <section class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-eye text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.display.title') }}</h2>
      </div>
      <div class="card-body">
        <div class="row g-3 mb-1">
          <div class="col-sm-6">
            <label for="disp-sport" class="form-label">{{ t('profile.display.default_sport') }}</label>
            <select id="disp-sport" v-model="prefs.display.default_sport" class="form-select">
              <option v-for="s in SPORTS" :key="s" :value="s">{{ t(`profile.display.sport_${s}`) }}</option>
            </select>
          </div>
          <div class="col-sm-6">
            <label for="disp-units" class="form-label">{{ t('profile.display.units') }}</label>
            <select id="disp-units" v-model="prefs.display.units" class="form-select">
              <option v-for="u in UNITS" :key="u" :value="u">{{ t(`profile.display.units_${u}`) }}</option>
            </select>
          </div>
        </div>
        <hr class="my-3">
        <div class="form-check form-switch mb-2">
          <input id="disp-grade" v-model="prefs.display.show_grade_colors" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="disp-grade">{{ t('profile.display.show_grade_colors') }}</label>
        </div>
        <div class="form-check form-switch">
          <input id="disp-elev" v-model="prefs.display.show_elevation_chart" class="form-check-input" type="checkbox">
          <label class="form-check-label" for="disp-elev">{{ t('profile.display.show_elevation_chart') }}</label>
        </div>
      </div>
    </section>

    <!-- Détection de cols -->
    <section class="card mb-3 shadow-sm">
      <div class="card-header d-flex align-items-center gap-2">
        <i class="fa-solid fa-mountain text-primary" aria-hidden="true"></i>
        <h2 class="h5 mb-0">{{ t('profile.climb.title') }}</h2>
      </div>
      <div class="card-body">
        <p class="text-muted small mb-3">{{ t('profile.climb.help') }}</p>
        <div class="row g-3">
          <div class="col-sm-4">
            <label for="climb-grade" class="form-label">{{ t('profile.climb.min_grade') }}</label>
            <div class="input-group">
              <input id="climb-grade" v-model.number="prefs.climb_detection.min_grade" type="number" class="form-control" min="0" max="15" step="0.5">
              <span class="input-group-text">%</span>
            </div>
          </div>
          <div class="col-sm-4">
            <label for="climb-gain" class="form-label">{{ t('profile.climb.min_gain') }}</label>
            <div class="input-group">
              <input id="climb-gain" v-model.number="prefs.climb_detection.min_gain_m" type="number" class="form-control" min="0" max="1000" step="10">
              <span class="input-group-text">m</span>
            </div>
          </div>
          <div class="col-sm-4">
            <label for="climb-length" class="form-label">{{ t('profile.climb.min_length') }}</label>
            <div class="input-group">
              <input id="climb-length" v-model.number="prefs.climb_detection.min_length_m" type="number" class="form-control" min="50" max="5000" step="50">
              <span class="input-group-text">m</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Barre de sauvegarde -->
    <div class="d-flex align-items-center gap-3 sticky-bottom py-2">
      <button type="submit" class="btn btn-primary" :disabled="saving">
        <i class="fa-solid fa-floppy-disk me-1" aria-hidden="true"></i>
        {{ saving ? t('profile.saving') : t('profile.save') }}
      </button>
      <span v-if="saved" class="text-success">
        <i class="fa-solid fa-circle-check me-1" aria-hidden="true"></i>{{ t('profile.saved') }}
      </span>
      <span v-if="error" class="text-danger">
        <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ t('profile.save_error') }}
      </span>
    </div>
  </form>
</template>

<style scoped>
.user-profile {
  max-width: 720px;
}

.map-style-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  min-width: 84px;
  padding: 0.75rem 0.5rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 0.85rem;
  transition: border-color 0.15s, background-color 0.15s;
}

.map-style-option i {
  font-size: 1.25rem;
}

.map-style-option:hover {
  background-color: var(--bs-tertiary-bg);
}

.map-style-option.active {
  border-color: var(--bs-primary);
  background-color: var(--bs-primary-bg-subtle);
  color: var(--bs-primary);
}

.sticky-bottom {
  background: var(--bs-body-bg);
}
</style>
