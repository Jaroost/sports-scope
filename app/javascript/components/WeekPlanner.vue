<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mondayOf, isoLocal, fmtDuration, WEEK_SEGMENT_COLOR, type WeekPlan } from '../composables/useTrainingPlan'
import { usePlannedRides, planTss, type PlannedRide } from '../composables/usePlannedRides'
import type { AthleteState } from '../routeLoad'
import { activityIcon } from '../activityHelpers'
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
// Une sortie réelle attachée à un jour : de quoi l'afficher, l'icôner (par sport) et
// lier vers sa page.
interface DoneActivity { source: string; external_id: string; name: string; tss: number; activity_type?: string | null }
interface DayDone { tss: number; count: number; at: string | null; activities?: DoneActivity[] }
// `fluid` : grille responsive « auto-fit » — au lieu des 7 colonnes fixes, les jours se
// mettent en ligne côte à côte tant qu'ils tiennent (largeur minimale garantie par
// jour, cf. --planner-day-min) et se replient sur plusieurs rangs sinon. Utile dans un
// widget dont la largeur varie. Sur petit écran, la liste verticale prend le relais.
// `weekPlans` : bilan (cible / prévu / reste à placer) par semaine, indexé comme `weeks`
// (0 = en cours, 1 = suivante). Optionnel — quand fourni pour une semaine, un mini-résumé
// (barre + reste à placer) s'affiche sous son libellé. On passe `null` pour une semaine
// déjà résumée ailleurs (la semaine en cours a sa grande carte au-dessus).
const props = withDefaults(
  defineProps<{
    athlete: AthleteState | null
    doneByDay?: Record<string, DayDone>
    fluid?: boolean
    weekPlans?: (WeekPlan | null)[]
  }>(),
  { doneByDay: () => ({}), fluid: false, weekPlans: () => [] },
)

// Résumé de planification d'une semaine (ou null si non fourni / pas de données).
function weekPlanFor(key: number): WeekPlan | null {
  return props.weekPlans?.[key] ?? null
}

// Bascule liste verticale : imposée par un écran étroit (téléphone). On écoute la media
// query pour rester réactif au redimensionnement / à la rotation.
const isNarrow = ref(false)
let mql: MediaQueryList | null = null
function syncNarrow() { isNarrow.value = mql?.matches ?? false }
onMounted(() => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    mql = window.matchMedia('(max-width: 575.98px)')
    syncNarrow()
    mql.addEventListener('change', syncNarrow)
  }
})
onBeforeUnmount(() => { mql?.removeEventListener('change', syncNarrow) })

const isVertical = computed(() => isNarrow.value)

const { plannedRides, addPlan, movePlan, reorderPlans, removePlan } = usePlannedRides()

// Jour avec au moins une sortie enregistrée (factuel).
function isDayTrained(iso: string): boolean {
  return iso in props.doneByDay
}
function doneTssFor(iso: string): number | null {
  return props.doneByDay[iso]?.tss ?? null
}

// Sorties réelles enregistrées ce jour-là (pour remplacer le repère « Sortie faite »
// générique par les activités elles-mêmes, cliquables).
function activitiesFor(iso: string): DoneActivity[] {
  return props.doneByDay[iso]?.activities ?? []
}

// Lien vers la page d'une activité (Strava ou importée), en respectant le préfixe de
// langue de l'URL courante (`localePrefix` déjà défini plus bas, cf. routeHref).
function activityHref(a: DoneActivity): string {
  const base = a.source === 'imported' ? '/imported_activities' : '/activities'
  return `${localePrefix}${base}/${a.external_id}`
}

// Dialogue « sorties du jour » : le jour inspecté (ISO) ou null (fermé). On y liste les
// activités réelles, chacune renvoyant vers sa page.
const detailDay = ref<string | null>(null)
const detailActivities = computed<DoneActivity[]>(() =>
  detailDay.value ? activitiesFor(detailDay.value) : [],
)
function openDoneDetail(iso: string) { detailDay.value = iso }
function closeDoneDetail() { detailDay.value = null }
function dateLong(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })
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

// En mode fluide (widget), toute la carte est cliquable et ouvre la feuille d'options
// (déplacer / voir / supprimer) : plus de petits boutons croix/déplacer sur la carte.
function onPlanClick(plan: PlannedRide) {
  if (props.fluid) openMove(plan)
}

// « Voir l'itinéraire » : on ne dispose que de l'id (pas du token de partage), donc on
// ouvre l'éditeur/carte par id — la voie id-based pour visualiser un itinéraire.
const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''
function routeHref(plan: PlannedRide): string {
  return `${localePrefix}/routes/${plan.route.id}/edit`
}

// « Naviguer » : mode GPS turn-by-turn, ouvert par token de partage (pas par id).
function navigateHref(plan: PlannedRide): string {
  return `${localePrefix}/routes/${plan.route.share_token}/navigate`
}

// Suppression depuis la feuille : on retire le plan puis on ferme.
function removeFromSheet() {
  const plan = moveTarget.value
  moveTarget.value = null
  if (plan) removePlan(plan.id)
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
  <div class="week-planner" :class="{ 'is-vertical': isVertical, 'is-fluid': props.fluid }">
    <div class="d-flex align-items-baseline gap-2 mb-2">
      <span class="fw-semibold small">{{ t('performance.load.week.planner_title') }}</span>
      <span class="small text-body-tertiary">{{ t('performance.load.week.planner_help') }}</span>
    </div>

    <div v-for="week in weeks" :key="week.key" class="planner-week">
      <div class="planner-week-label small text-body-tertiary text-uppercase">{{ week.label }}</div>

      <!-- Mini-résumé de la semaine : cible, prévu et reste à placer + barre. Affiché
           quand un bilan est fourni pour cette semaine (typiquement la semaine suivante,
           qui n'a pas de grande carte au-dessus). -->
      <div v-if="weekPlanFor(week.key)" class="planner-week-plan">
        <template v-for="wp in [weekPlanFor(week.key)!]" :key="'wp'">
          <div class="week-progress-wrap">
            <div class="progress planner-week-progress" role="progressbar" :aria-valuenow="wp.donePct" aria-valuemin="0" aria-valuemax="100">
              <div v-if="wp.donePct > 0" class="progress-bar" :style="{ width: `${wp.donePct}%`, backgroundColor: WEEK_SEGMENT_COLOR.done }"></div>
              <div class="progress-bar progress-bar-striped" :style="{ width: `${wp.plannedPct}%`, backgroundColor: WEEK_SEGMENT_COLOR.planned }"></div>
            </div>
            <div
              v-if="wp.overPlanned"
              class="week-target-marker"
              :style="{ left: `${wp.targetPct}%` }"
              :title="t('performance.load.week.target', { tss: wp.target })"
            ></div>
          </div>
          <div class="planner-week-plan-labels small">
            <span>
              {{ t('performance.load.week.target', { tss: wp.target }) }}
              <span v-if="wp.planned > 0" class="text-body-tertiary">· {{ t('performance.load.week.planned', { tss: wp.planned }) }}</span>
            </span>
            <span v-if="wp.remaining > 0" class="text-muted">
              {{ t('performance.load.week.remaining_to_plan', { tss: wp.remaining, days: wp.daysLeft, duration: fmtDuration(wp.minutesLeft) }) }}
            </span>
            <span v-else class="text-success">
              <i class="fa-solid fa-circle-check me-1" aria-hidden="true"></i>{{ t('performance.load.week.done_label') }}
            </span>
          </div>
        </template>
      </div>

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
              <!-- Aujourd'hui : repère « jour courant » (bleu), non coloriel, pour ne pas
                   dépendre du seul fond bleu. Sinon ✓ vert dès qu'une sortie est enregistrée. -->
              <i v-if="d.isToday" class="fa-solid fa-calendar-day planner-head-today" :title="t('performance.load.today')" aria-hidden="true"></i>
              <i v-else-if="isDayTrained(d.iso)" class="fa-solid fa-circle-check planner-head-check" :title="t('performance.load.week.day_tss')" aria-hidden="true"></i>
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
              :class="{ 'is-done': isPlanDone(plan), 'is-dragging': dragId === plan.id, 'is-clickable': props.fluid }"
              :title="props.fluid ? t('performance.load.week.open_plan') : (isPlanDone(plan) ? t('performance.load.week.plan_done') : t('performance.load.week.drag_hint'))"
              :role="props.fluid ? 'button' : undefined"
              draggable="true"
              @click="onPlanClick(plan)"
              @dragstart="onDragStart(plan, $event)"
              @dragend="onDragEnd"
            >
              <div class="planner-plan-main">
                <i
                  :class="isPlanDone(plan) ? 'fa-solid fa-circle-check planner-plan-icon' : `fa-solid ${sportIcon(plan.route.activity)} planner-plan-icon`"
                  aria-hidden="true"
                ></i>
                <span class="planner-plan-name" :title="plan.route.name">{{ plan.route.name }}</span>
                <!-- Réalisé : TSS réel du jour reste sur la ligne du nom. -->
                <span
                  v-if="isPlanDone(plan) && doneTssFor(d.iso) !== null"
                  class="planner-plan-tss"
                  :title="t('performance.load.week.day_tss')"
                >{{ doneTssFor(d.iso) }}</span>
                <!-- Mode fluide : la carte entière ouvre la feuille d'options, donc plus de
                     boutons déplacer/croix ici. Mode grille : on garde les deux. -->
                <template v-if="!props.fluid">
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
                </template>
              </div>
              <!-- Prévu (non réalisé) : le TSS estimé passe sous le nom pour lui laisser la place. -->
              <span
                v-if="!isPlanDone(plan) && tssOf(plan) !== null"
                class="planner-plan-tss planner-plan-tss-est"
              >≈ {{ tssOf(plan) }} TSS</span>
            </div>

            <!-- Jour où l'on est sorti sans itinéraire planifié : on montre les sorties
                 réelles elles-mêmes (cliquables → dialogue avec lien vers l'activité). -->
            <template v-if="isDayTrained(d.iso) && !plansFor(d.iso).length">
              <button
                v-for="act in activitiesFor(d.iso)"
                :key="`${act.source}-${act.external_id}`"
                type="button"
                class="planner-done-mark planner-done-mark-btn"
                :title="t('performance.load.week.view_activity')"
                @click="openDoneDetail(d.iso)"
              >
                <div class="planner-done-main">
                  <!-- Icône du sport, comme sur la liste des activités récentes. -->
                  <i :class="`fa-solid ${activityIcon(act.activity_type)} planner-done-icon`" aria-hidden="true"></i>
                  <span class="planner-done-name">{{ act.name }}</span>
                </div>
                <!-- TSS réalisé sur sa propre ligne, comme le TSS estimé des plans. -->
                <span class="planner-done-tss planner-done-tss-line">{{ Math.round(act.tss) }} TSS</span>
              </button>
              <!-- Repli : sortie enregistrée mais activité non détaillée (données partielles). -->
              <div v-if="!activitiesFor(d.iso).length" class="planner-done-mark" :title="t('performance.load.week.day_tss')">
                <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
                <span>{{ t('performance.load.week.day_done') }}</span>
                <span v-if="doneTssFor(d.iso) !== null" class="planner-done-tss">{{ doneTssFor(d.iso) }}</span>
              </div>
            </template>

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
            <!-- Plan réalisé : lien(s) vers la sortie réelle enregistrée ce jour-là, pour
                 voir l'activité correspondante. Présenté en tête, c'est ce qu'on cherche
                 en premier sur un tour déjà fait. -->
            <div v-if="isPlanDone(moveTarget) && activitiesFor(moveTarget.planned_on).length" class="move-section">
              <div class="move-label">{{ t('performance.load.week.done_activity_label') }}</div>
              <a
                v-for="act in activitiesFor(moveTarget.planned_on)"
                :key="`${act.source}-${act.external_id}`"
                :href="activityHref(act)"
                class="planner-detail-row"
              >
                <i :class="`fa-solid ${activityIcon(act.activity_type)} planner-detail-icon`" aria-hidden="true"></i>
                <span class="planner-detail-name">{{ act.name }}</span>
                <span class="planner-detail-tss">{{ Math.round(act.tss) }} TSS</span>
                <i class="fa-solid fa-arrow-up-right-from-square planner-detail-go" aria-hidden="true"></i>
              </a>
            </div>

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

            <!-- Voir / naviguer / retirer de la semaine. -->
            <div class="move-section move-actions">
              <a :href="routeHref(moveTarget)" class="btn btn-sm btn-outline-primary flex-fill">
                <i class="fa-solid fa-map-location-dot me-1" aria-hidden="true"></i>{{ t('performance.load.week.view_route') }}
              </a>
              <a :href="navigateHref(moveTarget)" class="btn btn-sm btn-outline-success flex-fill">
                <i class="fa-solid fa-location-arrow me-1" aria-hidden="true"></i>{{ t('performance.load.week.navigate_route') }}
              </a>
              <button type="button" class="btn btn-sm btn-outline-danger flex-fill" @click="removeFromSheet">
                <i class="fa-solid fa-trash-can me-1" aria-hidden="true"></i>{{ t('performance.load.week.remove_plan') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Dialogue « sorties du jour » : la liste des activités réelles enregistrées ce
         jour-là, chacune renvoyant vers sa page de détail. -->
    <Transition name="modal">
      <div v-if="detailDay" class="planner-detail-backdrop" @click.self="closeDoneDetail">
        <div class="planner-detail-dialog shadow-lg">
          <div class="planner-detail-head">
            <div class="min-width-0">
              <strong class="d-block">{{ t('performance.load.week.done_detail_title') }}</strong>
              <span class="small text-body-tertiary text-capitalize">{{ dateLong(detailDay) }}</span>
            </div>
            <button type="button" class="btn-close" @click="closeDoneDetail" :aria-label="t('performance.load.week.cancel')"></button>
          </div>
          <div class="planner-detail-body">
            <a
              v-for="act in detailActivities"
              :key="`${act.source}-${act.external_id}`"
              :href="activityHref(act)"
              class="planner-detail-row"
            >
              <i :class="`fa-solid ${activityIcon(act.activity_type)} planner-detail-icon`" aria-hidden="true"></i>
              <span class="planner-detail-name">{{ act.name }}</span>
              <span class="planner-detail-tss">{{ Math.round(act.tss) }} TSS</span>
              <i class="fa-solid fa-arrow-up-right-from-square planner-detail-go" aria-hidden="true"></i>
            </a>
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
/* Mini-résumé de planification d'une semaine (barre + reste à placer). */
.planner-week-plan {
  margin-bottom: 0.4rem;
}
.planner-week-progress {
  height: 0.5rem;
}
.planner-week-plan-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  justify-content: space-between;
  margin-top: 0.25rem;
}
/* Repère « objectif » : trait vertical coiffé d'un fanion, à la position de la cible
   quand fait + prévu la dépasse (même repère que la carte de la semaine en cours). */
.week-progress-wrap {
  position: relative;
}
.week-target-marker {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  background: var(--bs-body-color, #212529);
  border-radius: 1px;
  pointer-events: none;
}
.week-target-marker::before {
  content: "";
  position: absolute;
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--bs-body-color, #212529);
}
.planner-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0.375rem;
}
/* Mode fluide : autant de jours par ligne que la largeur le permet, avec une largeur
   minimale par jour (sous laquelle on passe au rang suivant). Le nombre de colonnes
   s'adapte donc au conteneur, au lieu d'être figé à 7. */
.week-planner.is-fluid .planner-grid {
  grid-template-columns: repeat(auto-fit, minmax(var(--planner-day-min, 8rem), 1fr));
}
/* Liste verticale, un jour par ligne pleine largeur. La grille 7 colonnes rend les
   cases minuscules — nom illisible et × impossible à viser. En ligne, le nom
   d'itinéraire respire et le bouton supprimer devient une vraie cible. Déclenchée soit
   par la prop `vertical` (widget étroit), soit automatiquement sur téléphone : les
   deux posent la classe `.is-vertical` sur la racine (cf. isVertical). */
.week-planner.is-vertical .planner-grid {
  grid-template-columns: 1fr;
  gap: 0.375rem;
}
.week-planner.is-vertical .planner-day {
  flex-direction: row;
  align-items: center;
  min-height: 0;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
}
/* En-tête réduit à une étiquette « lun 14 » calée à gauche, largeur fixe. */
.week-planner.is-vertical .planner-day-head {
  flex: 0 0 3.25rem;
  justify-content: flex-start;
  gap: 0.35rem;
}
.week-planner.is-vertical .planner-day-body {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.week-planner.is-vertical .planner-plan {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.4rem 0.5rem;
}
/* La largeur le permet : nom complet, plus de troncature. */
.week-planner.is-vertical .planner-plan-name {
  overflow: visible;
  white-space: normal;
}
.week-planner.is-vertical .planner-plan-remove {
  font-size: 0.9rem;
  padding: 0.4rem;
  margin: -0.25rem -0.15rem -0.25rem 0.15rem;
  border-radius: 50%;
}
.week-planner.is-vertical .planner-plan-move {
  font-size: 0.9rem;
  padding: 0.4rem;
  margin: -0.25rem 0;
}
.week-planner.is-vertical .planner-done-mark {
  flex: 1 1 auto;
  margin-top: 0;
}
/* Jour vide : le « + » se cale à droite de la ligne, en cible confortable. */
.week-planner.is-vertical .planner-add {
  margin-top: 0;
  margin-left: auto;
  padding: 0.45rem 1rem;
  font-size: 0.9rem;
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
/* Jour où l'on est sorti : vert franc, et il reprend son opacité même s'il est passé.
   Le fond est assez marqué pour se repérer d'un coup d'œil parmi les cases neutres. */
.planner-day.is-done {
  opacity: 1;
  border-color: #198754;
  background: rgba(25, 135, 84, 0.16);
}
/* Aujourd'hui : carte bleue franche pour repérer « où on en est ». Déclarée après
   `.is-done` pour l'emporter quand on s'est déjà entraîné aujourd'hui (le ✓ vert de
   l'en-tête indique encore la sortie faite). */
.planner-day.is-today {
  opacity: 1;
  border-color: var(--bs-primary);
  background: rgba(13, 110, 253, 0.16);
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
/* Repère du jour courant : bleu, cohérent avec le fond bleu de la carte du jour. */
.planner-head-today {
  color: var(--bs-primary);
  font-size: 0.8rem;
}
.planner-plan {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
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
/* Mode fluide : la carte entière est un bouton d'ouverture de la feuille d'options. */
.planner-plan.is-clickable {
  cursor: pointer;
}
/* Ligne principale de la carte : icône + nom + TSS réel + boutons. */
.planner-plan-main {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}
.planner-plan-icon {
  flex: 0 0 auto;
  color: #fd7e14;
}
/* TSS estimé rejeté sur sa propre ligne, aligné à droite sous le nom. */
.planner-plan-tss-est {
  align-self: flex-end;
  color: #fd7e14;
  font-size: 0.65rem;
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
  padding: 0.2rem 0.3rem;
  border-radius: 0.25rem;
  background: rgba(25, 135, 84, 0.22);
  border-left: 3px solid #198754;
  color: #146c43;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.2;
}
.planner-done-tss {
  margin-left: auto;
  font-weight: 700;
  flex: 0 0 auto;
}
/* Repère « sortie faite » devenu bouton : porte le nom réel de l'activité et ouvre le
   dialogue de détail. On neutralise le style bouton natif tout en gardant la barre verte. */
.planner-done-mark-btn {
  flex-direction: column;
  align-items: stretch;
  gap: 0.1rem;
  width: 100%;
  border: none;
  border-left: 3px solid #198754;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.planner-done-mark-btn + .planner-done-mark-btn {
  margin-top: 0.15rem;
}
.planner-done-mark-btn:hover,
.planner-done-mark-btn:focus-visible {
  background: rgba(25, 135, 84, 0.34);
}
/* Ligne principale de la pastille sortie : icône du sport + nom de l'activité. */
.planner-done-main {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}
.planner-done-icon {
  flex: 0 0 auto;
}
.planner-done-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* TSS réalisé rejeté sous le nom, aligné à droite (miroir de planner-plan-tss-est). */
.planner-done-tss-line {
  align-self: flex-end;
  margin-left: 0;
  font-size: 0.65rem;
}
/* ── Dialogue « sorties du jour » ─────────────────────────────────────────────── */
.planner-detail-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1060;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}
.planner-detail-dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 460px;
  max-height: calc(100dvh - 2rem);
  background: var(--bs-body-bg, #fff);
  border-radius: 0.5rem;
  overflow: hidden;
}
.planner-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--bs-border-color, #dee2e6);
}
.planner-detail-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0.5rem 0.75rem;
}
.planner-detail-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 0.5rem;
  border-radius: 0.5rem;
  color: inherit;
  text-decoration: none;
}
.planner-detail-row + .planner-detail-row {
  margin-top: 0.15rem;
}
.planner-detail-row:hover,
.planner-detail-row:focus-visible {
  background: var(--bs-tertiary-bg);
}
.planner-detail-icon {
  flex: 0 0 auto;
  color: #198754;
}
.planner-detail-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.planner-detail-tss {
  flex: 0 0 auto;
  font-weight: 700;
  color: #146c43;
}
.planner-detail-go {
  flex: 0 0 auto;
  color: var(--bs-secondary-color);
}
.planner-detail-row:hover .planner-detail-go,
.planner-detail-row:focus-visible .planner-detail-go {
  color: var(--bs-primary);
}
.min-width-0 {
  min-width: 0;
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
/* Rangée d'actions bas de feuille : voir / naviguer / supprimer. Chaque bouton garde
   une largeur lisible ; ils passent à la ligne si la feuille est trop étroite. */
.move-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.move-actions > * {
  flex: 1 1 8rem;
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
