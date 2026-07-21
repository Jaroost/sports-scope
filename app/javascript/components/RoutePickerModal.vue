<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'
import { estimateRouteLoad } from '../routeLoad'
import type { AthleteState } from '../routeLoad'
import { speedForSport } from '../userPreferences'
import type { Sport } from '../userPreferences'

// ─── Modale de sélection d'un itinéraire à planifier ──────────────────────────
// Le choix se faisait via une mini-liste inline en bas du planificateur : peu
// visible et peu pratique. On ouvre désormais une vraie modale qui réutilise la
// MÊME API que la page liste (`/api/routes` : recherche + filtre sport + pagination),
// avec l'aperçu du tracé, les stats et le TSS estimé — mais sans les actions
// d'édition/partage/suppression : ici on ne fait que CHOISIR un jour où le caser.

const props = defineProps<{
  show: boolean
  // Jour ciblé (ISO local), pour le titre. null = modale fermée.
  day: string | null
  // Seuils athlète : pour estimer le TSS de chaque itinéraire (comme la liste).
  athlete: AthleteState | null
}>()

const emit = defineEmits<{
  select: [routeId: number]
  close: []
}>()

interface RouteOption {
  id: number
  name: string
  activity: Sport
  distance_m: number | null
  elevation_gain_m: number | null
  // Vitesse ajustée pour ce tracé, ou null s'il suit le réglage du profil.
  avg_speed_kmh: number | null
  preview_segments?: { d: string; c: number }[]
}

const routes = ref<RouteOption[]>([])
const loading = ref(false)
const hasLoaded = ref(false)
const activityOptions = ref<Sport[]>([])

const search = ref('')
const sportFilter = ref<string>('')
const page = ref(1)
const perPage = ref(12)
const totalPages = ref(1)
const filteredTotal = ref(0)

const searchInputEl = ref<HTMLInputElement | null>(null)

// Catégorie d'activité enregistrée avec l'itinéraire (cycling | mtb | hiking).
function activityOf(r: RouteOption): Sport {
  return r.activity === 'mtb' || r.activity === 'hiking' ? r.activity : 'cycling'
}

function sportIcon(s: Sport): string {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// Couleur d'un segment de l'aperçu selon la pente (1 = montée, 2 = descente, 0 = plat),
// mêmes teintes que la page liste, lisibles en thème clair comme sombre.
function gradeColor(cat: number): string {
  if (cat === 1) return '#e0503f'
  if (cat === 2) return '#2f8fed'
  return '#9aa0a6'
}

function fmtKm(m: number | null): string {
  return m != null ? `${(m / 1000).toFixed(1)} km` : '–'
}

// Libellé du jour ciblé, à partir de l'ISO local (pas de dérive UTC).
const dayLabel = computed(() => {
  if (!props.day) return ''
  const [y, m, d] = props.day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
})

// Vitesse propre à l'itinéraire (réglée dans le créateur), ou null s'il suit celle du
// profil. Mêmes bornes que speedForSport : hors bornes, la valeur n'est pas un réglage.
function speedOverrideOf(r: RouteOption): number | null {
  const v = r.avg_speed_kmh
  return typeof v === 'number' && Number.isFinite(v) && v >= 3 && v <= 80 ? v : null
}

// TSS estimé d'un itinéraire, avec les seuils du moment et la vitesse retenue pour ce
// tracé — même modèle et même règle de vitesse que le planificateur (routeLoad.ts,
// planSpeedKmh) : le chiffre lu ici doit être celui qu'on verra une fois planifié.
function tssOf(r: RouteOption): number | null {
  if (!props.athlete) return null
  const sport = activityOf(r)
  const load = estimateRouteLoad(
    {
      distanceM: r.distance_m ?? 0,
      elevGainM: r.elevation_gain_m ?? 0,
      speedKmh: speedOverrideOf(r) ?? speedForSport(sport),
      sport,
    },
    props.athlete,
  )
  return load?.tss ?? null
}

function buildQuery(): string {
  const p = new URLSearchParams()
  if (search.value.trim()) p.set('q', search.value.trim())
  if (sportFilter.value) p.set('sport', sportFilter.value)
  p.set('page', String(page.value))
  p.set('per', String(perPage.value))
  return p.toString()
}

async function fetchRoutes() {
  loading.value = true
  try {
    const res = await fetch(`/api/routes?${buildQuery()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    routes.value = Array.isArray(payload.routes) ? payload.routes : []
    totalPages.value = payload.total_pages ?? 1
    perPage.value = payload.per_page ?? perPage.value
    filteredTotal.value = payload.filtered_total ?? routes.value.length
    if (payload.page) page.value = payload.page
    if (Array.isArray(payload.activities)) activityOptions.value = payload.activities
  } catch {
    /* ignore — la liste restera vide */
  } finally {
    loading.value = false
    hasLoaded.value = true
  }
}

// Un changement de filtre ramène en page 1, avec un léger debounce (frappe).
let filterTimer: ReturnType<typeof setTimeout> | undefined
function onFilterChange() {
  page.value = 1
  clearTimeout(filterTimer)
  filterTimer = setTimeout(fetchRoutes, 300)
}
watch([search, sportFilter], onFilterChange)

function goToPage(p: number) {
  if (p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
  fetchRoutes()
}

// À l'ouverture : (re)charge la liste et met le focus sur la recherche.
watch(
  () => props.show,
  (open) => {
    if (!open) return
    fetchRoutes()
    nextTick(() => searchInputEl.value?.focus())
  },
)

function choose(id: number) {
  emit('select', id)
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-backdrop-picker" @click.self="emit('close')">
      <div class="modal-dialog-picker shadow-lg">
        <div class="modal-header-picker">
          <div class="min-width-0">
            <strong class="d-block">{{ t('performance.load.week.picker_title') }}</strong>
            <span v-if="dayLabel" class="small text-body-tertiary text-capitalize">{{ dayLabel }}</span>
          </div>
          <button type="button" class="btn-close" @click="emit('close')" :aria-label="t('performance.load.week.cancel')"></button>
        </div>

        <div class="modal-filters-picker">
          <div class="row g-2">
            <div class="col-12 col-sm">
              <input
                ref="searchInputEl"
                v-model="search"
                type="search"
                class="form-control form-control-sm"
                :placeholder="t('performance.load.week.search_route')"
              />
            </div>
            <div class="col-12 col-sm-auto">
              <select v-model="sportFilter" class="form-select form-select-sm">
                <option value="">{{ t('routes.filters.all_sports') }}</option>
                <option v-for="s in activityOptions" :key="s" :value="s">{{ t(`routes.wt_sport_${s}`) }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="modal-body-picker">
          <div v-if="loading && !hasLoaded" class="text-muted small d-flex align-items-center gap-2 p-2">
            <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
            <span>{{ t('performance.loading') }}</span>
          </div>
          <div v-else-if="!routes.length" class="text-muted small p-2">
            {{ t('performance.load.week.no_route') }}
          </div>
          <ul v-else class="list-unstyled mb-0 d-flex flex-column gap-1" :class="{ 'opacity-50': loading }">
            <li v-for="r in routes" :key="r.id">
              <button type="button" class="picker-row" @click="choose(r.id)">
                <span class="picker-preview" :title="t(`routes.wt_sport_${activityOf(r)}`)">
                  <svg
                    v-if="r.preview_segments && r.preview_segments.length"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="xMidYMid meet"
                    aria-hidden="true"
                  >
                    <path
                      v-for="(s, i) in r.preview_segments"
                      :key="i"
                      :d="s.d"
                      fill="none"
                      :stroke="gradeColor(s.c)"
                      stroke-width="6"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                    />
                  </svg>
                  <i v-else :class="`fa-solid ${sportIcon(activityOf(r))}`" aria-hidden="true"></i>
                </span>
                <span class="min-width-0 flex-grow-1 text-start">
                  <span class="picker-name text-truncate d-block fw-semibold">{{ r.name }}</span>
                  <small class="text-muted d-flex flex-wrap align-items-center gap-x-3 gap-y-1">
                    <span class="d-inline-flex align-items-center gap-1">
                      <i :class="`fa-solid ${sportIcon(activityOf(r))}`" aria-hidden="true"></i>{{ t(`routes.wt_sport_${activityOf(r)}`) }}
                    </span>
                    <span class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>{{ fmtKm(r.distance_m) }}
                    </span>
                    <span v-if="r.elevation_gain_m != null" class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>+{{ Math.round(r.elevation_gain_m) }} m
                    </span>
                    <span v-if="tssOf(r) !== null" class="d-inline-flex align-items-center gap-1">
                      <i class="fa-solid fa-bolt" style="color: #6f42c1" aria-hidden="true"></i>{{ t('routes.tss.label') }} ≈ {{ tssOf(r) }}
                    </span>
                    <!-- Vitesse propre au tracé : dit d'où sort le TSS ci-dessus, qui
                         sinon semble en désaccord avec la vitesse moyenne du profil. -->
                    <span
                      v-if="speedOverrideOf(r) !== null"
                      class="d-inline-flex align-items-center gap-1"
                      :title="t('performance.load.week.own_speed_hint', { speed: speedOverrideOf(r) })"
                    >
                      <i class="fa-solid fa-gauge-high" aria-hidden="true"></i>{{ speedOverrideOf(r) }} km/h
                    </span>
                  </small>
                </span>
                <i class="fa-solid fa-plus picker-add-icon" aria-hidden="true"></i>
              </button>
            </li>
          </ul>
        </div>

        <div v-if="hasLoaded && totalPages > 1" class="modal-footer-picker">
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="page <= 1 || loading"
            @click="goToPage(page - 1)"
          >
            <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
            <span>{{ t('routes.pagination.prev') }}</span>
          </button>
          <small class="text-muted">{{ t('routes.pagination.page', { page, total: totalPages }) }}</small>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            :disabled="page >= totalPages || loading"
            @click="goToPage(page + 1)"
          >
            <span>{{ t('routes.pagination.next') }}</span>
            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-backdrop-picker {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}
.modal-dialog-picker {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  max-height: calc(100dvh - 2rem);
  background: var(--bs-body-bg, #fff);
  border-radius: 0.5rem;
  overflow: hidden;
}
.modal-header-picker {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}
.modal-filters-picker {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}
/* Corps défilant : la liste peut être longue, le header/filtres/footer restent fixes. */
.modal-body-picker {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0.5rem 0.75rem;
  min-height: 6rem;
}
.modal-footer-picker {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--bs-border-color, #dee2e6);
}

.min-width-0 {
  min-width: 0;
}
.gap-x-3 {
  column-gap: 0.75rem;
}
.gap-y-1 {
  row-gap: 0.25rem;
}

/* Ligne cliquable de sélection : toute la surface est un bouton (grande cible). */
.picker-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.5rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: transparent;
  text-align: left;
}
.picker-row:hover,
.picker-row:focus-visible {
  background: var(--bs-tertiary-bg);
  border-color: var(--bs-border-color);
}
.picker-preview {
  flex-shrink: 0;
  width: 2.75rem;
  height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.04));
  color: var(--bs-warning, #ffc107);
}
.picker-preview svg {
  width: 100%;
  height: 100%;
}
.picker-add-icon {
  flex-shrink: 0;
  color: var(--bs-secondary-color);
}
.picker-row:hover .picker-add-icon,
.picker-row:focus-visible .picker-add-icon {
  color: var(--bs-primary);
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
