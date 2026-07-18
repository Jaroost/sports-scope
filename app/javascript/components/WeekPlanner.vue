<script setup lang="ts">
import { ref, computed } from 'vue'
import { t } from '../i18n'
import { mondayOf, isoLocal } from '../composables/useTrainingPlan'
import { usePlannedRides, planTss, type PlannedRide } from '../composables/usePlannedRides'
import type { AthleteState } from '../routeLoad'
import RoutePickerModal from './RoutePickerModal.vue'

// ─── Composer sa semaine ──────────────────────────────────────────────────────
// Sept colonnes lundi→dimanche : on y accroche des itinéraires, dont le TSS estimé
// vient nourrir le segment orange de la barre de charge juste au-dessus.
//
// L'état athlète arrive en prop plutôt que via `useAthleteState` : le parent a déjà
// le payload complet de /api/performance/training_load, inutile de le redemander.

// `doneByDay` : bilan des sorties réelles par jour (cf. TrainingLoadPanel).
//   • Niveau JOUR (fond vert, ✓ d'en-tête, « Sortie faite ») = factuel : y a-t-il eu
//     une sortie ce jour-là ? → présence de la clé.
//   • Niveau ITINÉRAIRE (carte orange → verte) = combien de plans marquer réalisés ?
//     On prend les N premiers plans (N = nombre de sorties du jour), par ordre de
//     création, parmi ceux posés AVANT la dernière sortie. Ainsi : 2 plans prévus + 1
//     sortie → seul le premier passe vert ; un plan ajouté après la sortie reste orange.
interface DayDone { tss: number; count: number; at: string | null }
const props = withDefaults(
  defineProps<{ athlete: AthleteState | null; doneByDay?: Record<string, DayDone> }>(),
  { doneByDay: () => ({}) },
)

const { plannedRides, addPlan, movePlan, reorderPlans, removePlan } = usePlannedRides()

// Jour avec au moins une sortie enregistrée (factuel).
function isDayTrained(iso: string): boolean {
  return iso in props.doneByDay
}
function doneTssFor(iso: string): number | null {
  return props.doneByDay[iso]?.tss ?? null
}

// Ids des plans considérés réalisés : comptage pur. Par jour, on marque fait les
// `count` PREMIERS itinéraires (count = nombre de sorties enregistrées ce jour-là),
// dans l'ordre choisi par l'utilisateur (`position`). Ainsi 2 plans + 1 sortie → le
// premier passe vert, le second orange ; tu choisis lequel en le remontant en tête.
const donePlanIds = computed<Set<number>>(() => {
  const done = new Set<number>()
  const byDay = new Map<string, PlannedRide[]>()
  for (const p of plannedRides.value) {
    const list = byDay.get(p.planned_on)
    if (list) list.push(p)
    else byDay.set(p.planned_on, [p])
  }
  for (const [day, plans] of byDay) {
    const count = props.doneByDay[day]?.count ?? 0
    if (!count) continue
    const ordered = plans.slice().sort(byPosition)
    for (const p of ordered.slice(0, count)) done.add(p.id)
  }
  return done
})

function isPlanDone(plan: PlannedRide): boolean {
  return donePlanIds.value.has(plan.id)
}

// Jour en cours de sélection (ISO) : ouvre la modale de choix d'itinéraire. null =
// fermée. Le chargement/filtrage de la liste vit dans RoutePickerModal.
const pickerDay = ref<string | null>(null)

const today = new Date()
const todayISO = isoLocal(today)
const monday = mondayOf(today)

// Deux semaines glissantes (en cours + prochaine) : on planifie toujours à
// l'avance, donc la semaine suivante est visible en permanence. Chaque semaine
// porte son libellé et ses 7 jours localisés.
const weeks = computed(() =>
  Array.from({ length: 2 }, (_, w) => {
    const weekMonday = new Date(monday)
    weekMonday.setDate(weekMonday.getDate() + w * 7)
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekMonday)
      d.setDate(d.getDate() + i)
      const iso = isoLocal(d)
      return {
        iso,
        label: d.toLocaleDateString(undefined, { weekday: 'short' }),
        dayNum: d.getDate(),
        past: iso < todayISO,
        isToday: iso === todayISO,
      }
    })
    return {
      key: w,
      label: t(w === 0 ? 'performance.load.week.this_week' : 'performance.load.week.next_week'),
      days,
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

// Ordre d'affichage intra-jour = position choisie (id départage les ex æquo).
const byPosition = (a: PlannedRide, b: PlannedRide) => a.position - b.position || a.id - b.id

function plansFor(iso: string): PlannedRide[] {
  return (byDay.value.get(iso) ?? []).slice().sort(byPosition)
}

function tssOf(plan: PlannedRide): number | null {
  return planTss(plan, props.athlete)
}

function openPicker(iso: string) {
  pickerDay.value = iso
}

// Sélection depuis la modale : on accroche l'itinéraire au jour ciblé puis on ferme.
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

// ─── Glisser-déposer d'un plan d'un jour à l'autre ────────────────────────────
// HTML5 drag-and-drop (desktop). `movePlan` fait le PATCH côté serveur ; les jours
// passés ne sont pas des cibles valides (leur charge est déjà écrite).
const dragId = ref<number | null>(null)
const dragOverDay = ref<string | null>(null)

function onDragStart(plan: PlannedRide, ev: DragEvent) {
  dragId.value = plan.id
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', String(plan.id))
  }
}

function onDragEnd() {
  dragId.value = null
  dragOverDay.value = null
}

function onDragOver(ev: DragEvent, day: { iso: string; past: boolean }) {
  if (day.past || dragId.value == null) return // pas de dépôt sur un jour passé
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  dragOverDay.value = day.iso
}

function onDragLeave(iso: string) {
  if (dragOverDay.value === iso) dragOverDay.value = null
}

function onDrop(day: { iso: string; past: boolean }) {
  const id = dragId.value
  dragOverDay.value = null
  dragId.value = null
  if (id == null || day.past) return
  const plan = plannedRides.value.find((p) => p.id === id)
  if (!plan) return
  // Déposé sur son propre jour → l'itinéraire passe en tête (donc « réalisé » en
  // priorité). Sinon, déplacement vers le jour cible.
  if (plan.planned_on === day.iso) {
    const dayPlans = plansFor(day.iso)
    if (dayPlans.length < 2 || dayPlans[0].id === id) return
    reorderPlans([id, ...dayPlans.filter((p) => p.id !== id).map((p) => p.id)])
    return
  }
  movePlan(id, day.iso)
}

// ─── Alternative tactile : feuille « déplacer » ───────────────────────────────
// Le drag-and-drop HTML5 ne fonctionne pas au doigt : un bouton par carte ouvre une
// petite feuille pour réordonner l'itinéraire dans son jour, ou le déplacer vers un
// autre jour (boutons simples → tactile ET souris).
const moveTarget = ref<PlannedRide | null>(null)

function openMove(plan: PlannedRide) {
  moveTarget.value = plan
}

// Contexte du plan en cours de déplacement : ses voisins du jour + son rang (pour
// griser Monter/Descendre aux extrémités). Recalculé après chaque réordonnancement.
const moveContext = computed(() => {
  const plan = moveTarget.value
  if (!plan) return null
  const dayPlans = plansFor(plan.planned_on)
  return { dayPlans, idx: dayPlans.findIndex((p) => p.id === plan.id), count: dayPlans.length }
})

function moveWithinDay(dir: -1 | 1) {
  const ctx = moveContext.value
  if (!ctx) return
  const swap = ctx.idx + dir
  if (swap < 0 || swap >= ctx.count) return
  const ids = ctx.dayPlans.map((p) => p.id)
  ;[ids[ctx.idx], ids[swap]] = [ids[swap], ids[ctx.idx]]
  reorderPlans(ids)
}

async function moveToDay(iso: string) {
  const plan = moveTarget.value
  moveTarget.value = null
  if (!plan || plan.planned_on === iso) return
  await movePlan(plan.id, iso)
}
</script>

<template>
  <div class="week-planner">
    <div class="d-flex align-items-baseline gap-2 mb-2">
      <span class="fw-semibold small">{{ t('performance.load.week.planner_title') }}</span>
      <span class="small text-body-tertiary">{{ t('performance.load.week.planner_help') }}</span>
    </div>

    <div v-for="week in weeks" :key="week.key" class="planner-week">
      <div class="planner-week-label small text-body-tertiary text-uppercase">{{ week.label }}</div>
      <div class="planner-grid">
        <div
          v-for="d in week.days"
          :key="d.iso"
          class="planner-day"
          :class="{ 'is-past': d.past, 'is-today': d.isToday, 'is-done': isDayTrained(d.iso), 'is-drop-target': dragOverDay === d.iso }"
          @dragover="onDragOver($event, d)"
          @dragleave="onDragLeave(d.iso)"
          @drop="onDrop(d)"
        >
          <div class="planner-day-head">
            <span class="text-capitalize d-inline-flex align-items-center gap-1">
              <!-- ✓ vert dès qu'une activité a été enregistrée ce jour-là : repère non
                   coloriel (icône), pour ne pas dépendre du seul fond vert. -->
              <i v-if="isDayTrained(d.iso)" class="fa-solid fa-circle-check planner-head-check" :title="t('performance.load.week.day_tss')" aria-hidden="true"></i>
              {{ d.label }}
            </span>
            <span class="text-body-tertiary">{{ d.dayNum }}</span>
          </div>

          <!-- Corps du jour : colonne sur desktop, ligne sur mobile (cf. media query). -->
          <div class="planner-day-body">
            <div
              v-for="plan in plansFor(d.iso)"
              :key="plan.id"
              class="planner-plan"
              :class="{ 'is-done': isPlanDone(plan), 'is-dragging': dragId === plan.id }"
              :title="isPlanDone(plan) ? t('performance.load.week.plan_done') : t('performance.load.week.drag_hint')"
              draggable="true"
              @dragstart="onDragStart(plan, $event)"
              @dragend="onDragEnd"
            >
              <i
                :class="isPlanDone(plan) ? 'fa-solid fa-circle-check planner-plan-icon' : `fa-solid ${sportIcon(plan.route.activity)} planner-plan-icon`"
                aria-hidden="true"
              ></i>
              <span class="planner-plan-name" :title="plan.route.name">{{ plan.route.name }}</span>
              <!-- Réalisé : TSS réel du jour. Sinon : TSS estimé de l'itinéraire (≈). -->
              <span
                v-if="isPlanDone(plan) && doneTssFor(d.iso) !== null"
                class="planner-plan-tss"
                :title="t('performance.load.week.day_tss')"
              >{{ doneTssFor(d.iso) }}</span>
              <span v-else-if="!isPlanDone(plan) && tssOf(plan) !== null" class="planner-plan-tss">≈ {{ tssOf(plan) }}</span>
              <button
                type="button"
                class="planner-plan-move"
                :aria-label="t('performance.load.week.move')"
                :title="t('performance.load.week.move')"
                @click.stop="openMove(plan)"
              >
                <i class="fa-solid fa-up-down-left-right" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                class="btn-close btn-close-sm planner-plan-remove"
                :aria-label="t('performance.load.week.remove_plan')"
                @click="removePlan(plan.id)"
              ></button>
            </div>

            <!-- Jour où l'on est sorti sans itinéraire planifié : on le signale quand même. -->
            <div v-if="isDayTrained(d.iso) && !plansFor(d.iso).length" class="planner-done-mark" :title="t('performance.load.week.day_tss')">
              <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
              <span>{{ t('performance.load.week.day_done') }}</span>
              <span v-if="doneTssFor(d.iso) !== null" class="planner-done-tss">{{ doneTssFor(d.iso) }}</span>
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
      </div>
    </div>

    <!-- Sélecteur d'itinéraire : modale filtrable (recherche + sport), réutilise
         l'API /api/routes comme la page liste. -->
    <RoutePickerModal
      :show="pickerDay !== null"
      :day="pickerDay"
      :athlete="props.athlete"
      @select="pick"
      @close="pickerDay = null"
    />

    <!-- Feuille « déplacer » : alternative tactile au drag-and-drop + réordonnancement
         intra-jour. Boutons simples, donc utilisable au doigt comme à la souris. -->
    <Transition name="modal">
      <div v-if="moveTarget" class="move-backdrop" @click.self="moveTarget = null">
        <div class="move-sheet shadow-lg">
          <div class="move-head">
            <strong class="text-truncate">{{ moveTarget.route.name }}</strong>
            <button type="button" class="btn-close" @click="moveTarget = null" :aria-label="t('performance.load.week.cancel')"></button>
          </div>
          <div class="move-body">
            <div v-if="moveContext && moveContext.count > 1" class="move-section">
              <div class="move-label">{{ t('performance.load.week.reorder_day') }}</div>
              <div class="d-flex gap-2">
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary flex-fill"
                  :disabled="moveContext.idx <= 0"
                  @click="moveWithinDay(-1)"
                >
                  <i class="fa-solid fa-arrow-up me-1" aria-hidden="true"></i>{{ t('performance.load.week.move_up') }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary flex-fill"
                  :disabled="moveContext.idx >= moveContext.count - 1"
                  @click="moveWithinDay(1)"
                >
                  <i class="fa-solid fa-arrow-down me-1" aria-hidden="true"></i>{{ t('performance.load.week.move_down') }}
                </button>
              </div>
            </div>

            <div class="move-section">
              <div class="move-label">{{ t('performance.load.week.move_to_day') }}</div>
              <div v-for="week in weeks" :key="week.key" class="mb-2">
                <div class="small text-body-tertiary text-uppercase mb-1">{{ week.label }}</div>
                <div class="move-days">
                  <button
                    v-for="d in week.days"
                    :key="d.iso"
                    type="button"
                    class="btn btn-sm move-day-btn text-capitalize"
                    :class="d.iso === moveTarget.planned_on ? 'btn-primary' : 'btn-outline-secondary'"
                    :disabled="d.past || d.iso === moveTarget.planned_on"
                    @click="moveToDay(d.iso)"
                  >
                    {{ d.label }} {{ d.dayNum }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.planner-week + .planner-week {
  margin-top: 0.625rem;
}
.planner-week-label {
  margin-bottom: 0.25rem;
  letter-spacing: 0.03em;
}
.planner-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0.375rem;
}
/* Sur téléphone : liste verticale, un jour par ligne pleine largeur. La grille 7
   colonnes rendait les cases minuscules — nom illisible et × impossible à viser. En
   ligne, le nom d'itinéraire respire et le bouton supprimer devient une vraie cible. */
@media (max-width: 575.98px) {
  .planner-grid {
    grid-template-columns: 1fr;
    gap: 0.375rem;
  }
  .planner-day {
    flex-direction: row;
    align-items: center;
    min-height: 0;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
  }
  /* En-tête réduit à une étiquette « lun 14 » calée à gauche, largeur fixe. */
  .planner-day-head {
    flex: 0 0 3.25rem;
    justify-content: flex-start;
    gap: 0.35rem;
  }
  .planner-day-body {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .planner-plan {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.4rem 0.5rem;
  }
  /* La largeur le permet : nom complet, plus de troncature. */
  .planner-plan-name {
    overflow: visible;
    white-space: normal;
  }
  .planner-plan-remove {
    font-size: 0.9rem;
    padding: 0.4rem;
    margin: -0.25rem -0.15rem -0.25rem 0.15rem;
    border-radius: 50%;
  }
  .planner-plan-move {
    font-size: 0.9rem;
    padding: 0.4rem;
    margin: -0.25rem 0;
  }
  .planner-done-mark {
    flex: 1 1 auto;
    margin-top: 0;
  }
  /* Jour vide : le « + » se cale à droite de la ligne, en cible confortable. */
  .planner-add {
    margin-top: 0;
    margin-left: auto;
    padding: 0.45rem 1rem;
    font-size: 0.9rem;
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
/* Cible de dépôt survolée pendant un glisser : bordure bleue franche. */
.planner-day.is-drop-target {
  border-color: var(--bs-primary);
  background: rgba(13, 110, 253, 0.1);
  outline: 2px dashed var(--bs-primary);
  outline-offset: -3px;
}
/* Corps du jour : sous l'en-tête, il empile les plans + le bouton « + ». En colonne
   sur desktop (grille), il passe en ligne sur mobile (liste verticale). */
.planner-day-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1 1 auto;
}
.planner-day.is-past {
  opacity: 0.55;
  background: var(--bs-tertiary-bg);
}
.planner-day.is-today {
  border-color: var(--bs-primary);
}
/* Jour où l'on est sorti : vert franc, et il reprend son opacité même s'il est passé.
   Le fond est assez marqué pour se repérer d'un coup d'œil parmi les cases neutres. */
.planner-day.is-done {
  opacity: 1;
  border-color: #198754;
  background: rgba(25, 135, 84, 0.16);
}
.planner-day-head {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
}
.planner-head-check {
  color: #198754;
  font-size: 0.8rem;
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
  cursor: grab;
}
.planner-plan.is-dragging {
  opacity: 0.4;
  cursor: grabbing;
}
.planner-plan-icon {
  flex: 0 0 auto;
  color: #fd7e14;
}
/* Plan accompli : la carte passe d'orange (à faire) à vert (fait), bien marqué. */
.planner-plan.is-done {
  background: rgba(25, 135, 84, 0.22);
  border-left-color: #198754;
}
.planner-plan.is-done .planner-plan-icon {
  color: #198754;
}
/* TSS réel sur une carte accomplie : vert, pour le distinguer de l'estimé orange. */
.planner-plan.is-done .planner-plan-tss {
  color: #198754;
}
.planner-done-mark {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: auto;
  padding: 0.2rem 0.35rem;
  border-radius: 0.25rem;
  background: rgba(25, 135, 84, 0.22);
  border-left: 3px solid #198754;
  color: #146c43;
  font-size: 0.7rem;
  font-weight: 600;
}
.planner-done-tss {
  margin-left: auto;
  font-weight: 700;
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
/* Bouton « déplacer » (alternative tactile au drag) : discret dans la carte. */
.planner-plan-move {
  flex: 0 0 auto;
  padding: 0.1rem 0.15rem;
  border: 0;
  background: transparent;
  color: var(--bs-secondary-color);
  font-size: 0.6rem;
  line-height: 1;
  cursor: pointer;
}
.planner-plan-move:hover {
  color: var(--bs-primary);
}
.planner-add {
  margin-top: auto;
  padding: 0.1rem 0.25rem;
  font-size: 0.7rem;
  line-height: 1.2;
  border-style: dashed;
}

/* ─── Feuille « déplacer » ──────────────────────────────────────────────────── */
.move-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}
.move-sheet {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 420px;
  max-height: calc(100dvh - 2rem);
  background: var(--bs-body-bg, #fff);
  border-radius: 0.5rem;
  overflow: hidden;
}
.move-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}
.move-body {
  padding: 1rem;
  overflow-y: auto;
}
.move-section + .move-section {
  margin-top: 1rem;
}
.move-label {
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.move-days {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.35rem;
}
.move-day-btn {
  padding: 0.4rem 0.25rem;
  font-size: 0.75rem;
}
</style>
