<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { STRAVA_REFRESHED_EVENT } from '../stravaRefresh'
import {
  useTrainingPlan, zoneColor, formZone, fmtDuration, fmtSigned, eventDateFmt,
  athleteFromSummary,
  ACTION_STYLE, PHASE_COLOR, FEAS_COLOR, GOALS, WEEK_PACE_COLOR, WEEK_SEGMENT_COLOR,
  type LoadSummary,
} from '../composables/useTrainingPlan'
import { usePlannedLoads } from '../composables/usePlannedRides'
import WeekPlanner from './WeekPlanner.vue'

// Widget compact de la page d'accueil : reprend « sortie objectif » + « que faire
// aujourd'hui » du panneau de performance (même composable, même localStorage) dans
// un format resserré et éditable. Un lien mène à la page performance pour le détail.

// La prop reste déclarée (passée par la vue) mais n'est plus lue : le refresh est
// désormais géré par le bouton unique de la page.
defineProps<{ stravaLinked?: boolean }>()

const loading = ref(true)
const data = ref<LoadSummary | null>(null)

// La synchronisation Strava est déclenchée par le bouton unique « Tout rafraîchir »
// de la page ; on écoute son événement pour recharger la reco du jour (sans spinner
// de chargement, mise à jour silencieuse).
function onStravaRefreshed() { fetchData(true) }

// Seuils athlète dérivés de la charge déjà chargée : ils servent à estimer le TSS
// des itinéraires prévus, qui alimente le segment orange de la barre.
const athlete = computed(() => athleteFromSummary(data.value))
const { plannedLoads } = usePlannedLoads(athlete)

const {
  current, goal, targetEvent, eventInfo, feasibility, projection,
  editingEvent, evDate, evDistance, evIntensity, todayISO,
  openEventEditor, saveEvent, removeEvent, recommendation, weekPlan,
} = useTrainingPlan(data, plannedLoads)

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
// Le lien « voir l'analyse » descend directement sur la section Forme & fatigue
// (ancre gérée dans TrainingLoadPanel.vue, qui se monte de façon asynchrone).
const performanceHref = `${lang ? `/${lang}` : ''}/performance#training-load`

async function fetchData(silent = false) {
  if (!silent) loading.value = true
  try {
    const res = await fetch('/api/performance/training_load', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as LoadSummary
  } catch {
    // Widget d'accueil silencieux : en cas d'échec, on n'affiche simplement rien.
    data.value = null
  } finally {
    if (!silent) loading.value = false
  }
}

onMounted(() => {
  fetchData()
  window.addEventListener(STRAVA_REFRESHED_EVENT, onStravaRefreshed)
})
onBeforeUnmount(() => { window.removeEventListener(STRAVA_REFRESHED_EVENT, onStravaRefreshed) })
</script>

<template>
  <!-- Tant qu'on n'a pas de charge exploitable, on n'affiche rien (accueil épuré). -->
  <div v-if="loading" class="card border-0 shadow-sm text-start">
    <div class="card-body text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('performance.loading') }}</span>
    </div>
  </div>

  <!-- Même coquille que le widget de cirage (ChainWax compact) : card + header + body. -->
  <div v-else-if="current" class="card border-0 shadow-sm text-start">
    <div class="card-header activity-card-header d-flex align-items-center gap-2">
      <h2 class="h5 mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-heart-pulse text-warning" aria-hidden="true"></i>
        <span>{{ t('performance.load.reco.title') }}</span>
      </h2>
      <div class="ms-auto d-flex align-items-center gap-2">
        <a :href="performanceHref" class="btn btn-sm btn-outline-secondary">
          {{ t('performance.load.widget.see_analysis') }}
        </a>
      </div>
    </div>
    <div class="card-body d-flex flex-column gap-3">
      <!-- Fraîcheur du moment -->
      <div class="fresh-tile" :style="{ borderColor: zoneColor(current.form_zone) }">
        <div class="d-flex align-items-center gap-3">
          <span class="fresh-value" :style="{ color: zoneColor(current.form_zone) }">{{ fmtSigned(current.tsb) }}</span>
          <div class="flex-grow-1">
            <div class="small text-muted">
              {{ t('performance.load.tsb_label') }}
              <span class="text-body-tertiary">· {{ t('performance.load.tsb_sub') }}</span>
            </div>
            <span class="badge" :style="{ backgroundColor: zoneColor(current.form_zone) }">{{ t(`performance.load.zone_${current.form_zone}`) }}</span>
          </div>
        </div>
      </div>

      <!-- Recommandation du jour -->
      <div v-if="recommendation" class="reco-card" :style="{ borderColor: ACTION_STYLE[recommendation.action].color }">
        <div class="d-flex align-items-center gap-3">
          <span class="reco-icon" :style="{ backgroundColor: ACTION_STYLE[recommendation.action].color }">
            <i :class="`fa-solid ${ACTION_STYLE[recommendation.action].icon}`" aria-hidden="true"></i>
          </span>
          <div class="flex-grow-1">
            <div class="fw-bold" :style="{ color: ACTION_STYLE[recommendation.action].color }">
              {{ t(`performance.load.reco.action_${recommendation.action}`) }}
              <span v-if="recommendation.minutes" class="text-body fw-normal small">·
                ≈ {{ fmtDuration(recommendation.minutes) }}<template v-if="recommendation.distanceKm"> (<span
                  class="reco-distance"
                  :title="t('performance.load.reco.distance_cycling_hint', { speed: data?.thresholds?.typical_speed_kmh })"
                >{{ t('performance.load.reco.distance_cycling', { km: recommendation.distanceKm }) }}</span>)</template>
              </span>
            </div>
            <div class="small text-muted">
              {{ t(`performance.load.reco.${recommendation.reason}`, { tsb: recommendation.tsb, days: recommendation.days ?? 0 }) }}
            </div>
          </div>
        </div>
        <!-- Objectif générique (masqué pendant une prépa datée) -->
        <div v-if="!eventInfo || eventInfo.phase === 'past'" class="mt-2 d-flex align-items-center gap-2">
          <label class="small text-muted mb-0">{{ t('performance.load.reco.goal_label') }}</label>
          <select v-model="goal" class="form-select form-select-sm reco-goal">
            <option v-for="g in GOALS" :key="g" :value="g">{{ t(`performance.load.reco.goal_${g}`) }}</option>
          </select>
        </div>

        <!-- Semaine en cours : version resserrée (barre + avancée), détail sur /performance -->
        <div v-if="weekPlan" class="week-strip mt-2 pt-2">
          <div class="d-flex align-items-baseline gap-2 small">
            <span class="text-muted">{{ t('performance.load.week.title') }}</span>
            <span class="fw-semibold">{{ t('performance.load.week.progress', { done: weekPlan.done, target: weekPlan.target }) }}</span>
            <span v-if="weekPlan.planned > 0" :style="{ color: WEEK_SEGMENT_COLOR.planned }">
              {{ t('performance.load.week.planned', { tss: weekPlan.planned }) }}
            </span>
            <span class="ms-auto" :style="{ color: WEEK_PACE_COLOR[weekPlan.pace] }">{{ t(`performance.load.week.pace_${weekPlan.pace}`) }}</span>
          </div>
          <!-- Vert = fait, orange = prévu, gris = à placer (détail sur /performance). -->
          <div class="progress week-progress mt-1" role="progressbar" :aria-valuenow="weekPlan.donePct" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar" :style="{ width: `${weekPlan.donePct}%`, backgroundColor: WEEK_SEGMENT_COLOR.done }"></div>
            <div class="progress-bar progress-bar-striped" :style="{ width: `${weekPlan.plannedPct}%`, backgroundColor: WEEK_SEGMENT_COLOR.planned }"></div>
          </div>

          <!-- Planificateur : accrocher un itinéraire à un jour, comme sur /performance.
               Même composable partagé — un plan ajouté ici met à jour la barre juste au-dessus. -->
          <WeekPlanner :athlete="athlete" class="mt-2" />
        </div>
      </div>

      <!-- Sortie objectif datée -->
      <!-- Éditeur -->
      <div v-if="editingEvent" class="event-editor">
        <div class="d-flex flex-wrap align-items-end gap-2">
          <div>
            <label class="small text-muted d-block mb-1">{{ t('performance.load.event.date_label') }}</label>
            <input v-model="evDate" type="date" :min="todayISO" class="form-control form-control-sm" />
          </div>
          <div>
            <label class="small text-muted d-block mb-1">{{ t('performance.load.event.distance_label') }}</label>
            <div class="input-group input-group-sm" style="width:7rem">
              <input v-model="evDistance" type="number" min="1" max="1000" class="form-control" />
              <span class="input-group-text">km</span>
            </div>
          </div>
          <div>
            <label class="small text-muted d-block mb-1">{{ t('performance.load.event.intensity_label') }}</label>
            <select v-model="evIntensity" class="form-select form-select-sm" style="width:auto">
              <option value="easy">{{ t('performance.load.event.intensity_easy') }}</option>
              <option value="tempo">{{ t('performance.load.event.intensity_tempo') }}</option>
              <option value="race">{{ t('performance.load.event.intensity_race') }}</option>
            </select>
          </div>
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-sm btn-primary" :disabled="!evDate || !evDistance" @click="saveEvent">{{ t('performance.load.event.save') }}</button>
            <button v-if="targetEvent" type="button" class="btn btn-sm btn-outline-danger" @click="removeEvent">{{ t('performance.load.event.remove') }}</button>
            <button type="button" class="btn btn-sm btn-link text-muted" @click="editingEvent = false">{{ t('performance.load.event.cancel') }}</button>
          </div>
        </div>
      </div>

      <!-- Résumé de l'événement -->
      <div v-else-if="eventInfo && eventInfo.phase !== 'past'" class="event-card" :style="{ borderColor: PHASE_COLOR[eventInfo.phase] }">
        <div class="d-flex align-items-center gap-3">
          <span class="event-countdown" :style="{ backgroundColor: PHASE_COLOR[eventInfo.phase] }">
            <span class="event-countdown-num">{{ eventInfo.days === 0 ? '🎉' : `J-${eventInfo.days}` }}</span>
          </span>
          <div class="flex-grow-1">
            <div class="fw-semibold small">
              {{ t('performance.load.event.summary', { distance: eventInfo.distanceKm, date: eventDateFmt(eventInfo.date) }) }}
              <span class="badge ms-1" :style="{ backgroundColor: PHASE_COLOR[eventInfo.phase] }">{{ t(`performance.load.event.phase_${eventInfo.phase}`) }}</span>
            </div>
            <div v-if="feasibility" class="small" :style="{ color: FEAS_COLOR[feasibility.level] }">
              <i class="fa-solid fa-gauge-high me-1" aria-hidden="true"></i>{{ t(`performance.load.event.feasibility_${feasibility.level}`) }}
            </div>
            <div v-if="projection" class="small" :style="{ color: zoneColor(formZone(projection.tsb)) }">
              <i class="fa-solid fa-wand-magic-sparkles me-1" aria-hidden="true"></i>{{ t(`performance.load.event.projection_${projection.verdict}`, { tsb: fmtSigned(projection.tsb) }) }}
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0" @click="openEventEditor">{{ t('performance.load.event.edit') }}</button>
        </div>
      </div>

      <!-- Bouton d'ajout -->
      <button v-else type="button" class="btn btn-sm btn-outline-primary" @click="openEventEditor">
        <i class="fa-solid fa-calendar-check me-1" aria-hidden="true"></i>{{ t('performance.load.event.set') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.fresh-tile {
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-left-width: 4px;
  border-radius: 0.5rem;
}
.fresh-value {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
  flex: 0 0 auto;
  min-width: 2.5rem;
  text-align: center;
}
.reco-card,
.event-card {
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-left-width: 4px;
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}
.event-editor {
  padding: 0.75rem 1rem;
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.5rem;
}
.reco-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  flex: 0 0 auto;
  border-radius: 50%;
  color: #fff;
  font-size: 1.1rem;
}
.reco-goal {
  width: auto;
  min-width: 11rem;
}
.reco-distance {
  cursor: help;
  white-space: nowrap;
}
.week-strip {
  border-top: 1px solid var(--bs-border-color);
}
.week-progress {
  height: 0.5rem;
}
.event-countdown {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  flex: 0 0 auto;
  border-radius: 0.5rem;
  color: #fff;
}
.event-countdown-num {
  font-weight: 700;
  font-size: 0.9rem;
}
</style>
