<script setup lang="ts">
import { ref, computed } from 'vue'
import { t } from '../i18n'
import { mondayOf, isoLocal } from '../composables/useTrainingPlan'
import { usePlannedRides, planTss, type PlannedRide } from '../composables/usePlannedRides'
import type { AthleteState } from '../routeLoad'
import type { Sport } from '../userPreferences'

// ─── Composer sa semaine ──────────────────────────────────────────────────────
// Sept colonnes lundi→dimanche : on y accroche des itinéraires, dont le TSS estimé
// vient nourrir le segment orange de la barre de charge juste au-dessus.
//
// L'état athlète arrive en prop plutôt que via `useAthleteState` : le parent a déjà
// le payload complet de /api/performance/training_load, inutile de le redemander.

const props = defineProps<{ athlete: AthleteState | null }>()

const { plannedRides, addPlan, removePlan } = usePlannedRides()

// Itinéraires de l'utilisateur, pour le sélecteur. Chargés à l'ouverture seulement :
// la liste n'est utile qu'au moment d'ajouter.
interface RouteOption { id: number; name: string; activity: Sport; distance_m: number | null; elevation_gain_m: number | null }
const routes = ref<RouteOption[]>([])
const routesLoaded = ref(false)
const pickerDay = ref<string | null>(null)
const search = ref('')

const today = new Date()
const todayISO = isoLocal(today)
const monday = mondayOf(today)

// Les 7 jours de la semaine en cours, avec leur libellé localisé.
const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    const iso = isoLocal(d)
    return {
      iso,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      dayNum: d.getDate(),
      past: iso < todayISO,
      isToday: iso === todayISO,
    }
  }),
)

// Plans indexés par jour — évite un filtre par colonne à chaque rendu.
const byDay = computed(() => {
  const out = new Map<string, PlannedRide[]>()
  for (const plan of plannedRides.value) {
    const list = out.get(plan.planned_on)
    if (list) list.push(plan)
    else out.set(plan.planned_on, [plan])
  }
  return out
})

function plansFor(iso: string): PlannedRide[] {
  return byDay.value.get(iso) ?? []
}

function tssOf(plan: PlannedRide): number | null {
  return planTss(plan, props.athlete)
}

async function loadRoutes() {
  if (routesLoaded.value) return
  try {
    // Sans `page` : l'endpoint renvoie l'historique complet (cf. RoutesController#index).
    const res = await fetch('/api/routes', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    routes.value = Array.isArray(payload.routes) ? payload.routes : []
  } catch {
    /* ignore — le sélecteur restera vide */
  } finally {
    routesLoaded.value = true
  }
}

function openPicker(iso: string) {
  pickerDay.value = iso
  search.value = ''
  loadRoutes()
}

const filteredRoutes = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = q ? routes.value.filter((r) => r.name.toLowerCase().includes(q)) : routes.value
  return list.slice(0, 50)
})

async function pick(routeId: number) {
  const day = pickerDay.value
  if (!day) return
  pickerDay.value = null
  await addPlan(routeId, day)
}

function sportIcon(sport: string): string {
  if (sport === 'hiking') return 'fa-person-hiking'
  if (sport === 'mtb') return 'fa-mountain-sun'
  return 'fa-person-biking'
}

function fmtKm(m: number | null): string {
  return m ? `${Math.round(m / 1000)} km` : '–'
}
</script>

<template>
  <div class="week-planner">
    <div class="d-flex align-items-baseline gap-2 mb-2">
      <span class="fw-semibold small">{{ t('performance.load.week.planner_title') }}</span>
      <span class="small text-body-tertiary">{{ t('performance.load.week.planner_help') }}</span>
    </div>

    <div class="planner-grid">
      <div v-for="d in days" :key="d.iso" class="planner-day" :class="{ 'is-past': d.past, 'is-today': d.isToday }">
        <div class="planner-day-head">
          <span class="text-capitalize">{{ d.label }}</span>
          <span class="text-body-tertiary">{{ d.dayNum }}</span>
        </div>

        <div v-for="plan in plansFor(d.iso)" :key="plan.id" class="planner-plan">
          <i :class="`fa-solid ${sportIcon(plan.route.activity)} planner-plan-icon`" aria-hidden="true"></i>
          <span class="planner-plan-name" :title="plan.route.name">{{ plan.route.name }}</span>
          <span v-if="tssOf(plan) !== null" class="planner-plan-tss">≈ {{ tssOf(plan) }}</span>
          <button
            type="button"
            class="btn-close btn-close-sm planner-plan-remove"
            :aria-label="t('performance.load.week.remove_plan')"
            @click="removePlan(plan.id)"
          ></button>
        </div>

        <!-- Les jours passés ne se planifient plus : leur charge est déjà écrite. -->
        <button
          v-if="!d.past"
          type="button"
          class="btn btn-sm btn-outline-secondary planner-add"
          @click="openPicker(d.iso)"
        >
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
        </button>
      </div>
    </div>

    <!-- Sélecteur d'itinéraire -->
    <div v-if="pickerDay" class="picker mt-2">
      <div class="d-flex align-items-center gap-2 mb-2">
        <input
          v-model="search"
          type="search"
          class="form-control form-control-sm"
          :placeholder="t('performance.load.week.search_route')"
        />
        <button type="button" class="btn btn-sm btn-link text-muted" @click="pickerDay = null">
          {{ t('performance.load.week.cancel') }}
        </button>
      </div>

      <div v-if="!routesLoaded" class="small text-muted">{{ t('performance.loading') }}</div>
      <div v-else-if="!filteredRoutes.length" class="small text-muted">
        {{ t('performance.load.week.no_route') }}
      </div>
      <div v-else class="picker-list">
        <button
          v-for="r in filteredRoutes"
          :key="r.id"
          type="button"
          class="picker-item"
          @click="pick(r.id)"
        >
          <i :class="`fa-solid ${sportIcon(r.activity)} text-body-tertiary`" aria-hidden="true"></i>
          <span class="picker-item-name">{{ r.name }}</span>
          <span class="small text-body-tertiary">{{ fmtKm(r.distance_m) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.planner-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0.375rem;
}
/* Sur téléphone, 7 colonnes seraient illisibles : on passe à 2 lignes de 4/3. */
@media (max-width: 575.98px) {
  .planner-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.planner-day {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-height: 5rem;
  padding: 0.375rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.375rem;
  background: var(--bs-body-bg);
}
.planner-day.is-past {
  opacity: 0.55;
  background: var(--bs-tertiary-bg);
}
.planner-day.is-today {
  border-color: var(--bs-primary);
}
.planner-day-head {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
}
.planner-plan {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.3rem;
  border-radius: 0.25rem;
  background: rgba(253, 126, 20, 0.14);
  border-left: 3px solid #fd7e14;
  font-size: 0.7rem;
  line-height: 1.2;
}
.planner-plan-icon {
  flex: 0 0 auto;
  color: #fd7e14;
}
.planner-plan-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.planner-plan-tss {
  flex: 0 0 auto;
  font-weight: 600;
  white-space: nowrap;
}
.planner-plan-remove {
  flex: 0 0 auto;
  font-size: 0.5rem;
  padding: 0.1rem;
}
.planner-add {
  margin-top: auto;
  padding: 0.1rem 0.25rem;
  font-size: 0.7rem;
  line-height: 1.2;
  border-style: dashed;
}
.picker {
  padding: 0.75rem;
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.5rem;
}
.picker-list {
  max-height: 14rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.picker-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: 0;
  border-radius: 0.25rem;
  background: transparent;
  text-align: left;
  font-size: 0.85rem;
}
.picker-item:hover {
  background: var(--bs-tertiary-bg);
}
.picker-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
