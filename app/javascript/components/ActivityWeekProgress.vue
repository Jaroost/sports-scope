<script setup lang="ts">
// Contribution de CETTE sortie à la cible hebdomadaire (page Performances) — pour ne
// pas avoir à changer de page pour savoir où elle place la semaine en cours. Le calcul
// (cible = 7 × CTL + rampe selon l'objectif, fait = TSS réel depuis lundi) vit
// entièrement dans `useTrainingPlan.ts` (cf. son en-tête sur pourquoi il ne doit pas
// être dupliqué) : ce composant ne fait que le fetch + l'affichage, avec les mêmes
// chiffres que TrainingLoadPanel/TodayPlanWidget.
//
// Ne s'affiche que si la sortie tombe dans la semaine EN COURS (lundi → dimanche
// d'aujourd'hui) : `weekPlan` ne calcule QUE celle-ci (calé sur « aujourd'hui »), donc
// pour une activité plus ancienne le fait/cible affichés décriraient une autre
// semaine que celle où elle a eu lieu — trompeur plutôt qu'utile. Silencieux (rien ne
// s'affiche) dans ce cas, comme le reste du bandeau de conditions.
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'
import {
  useTrainingPlan, mondayOf, isoLocal, WEEK_PACE_COLOR,
  type LoadSummary,
} from '../composables/useTrainingPlan'

const props = defineProps({
  activityDate: { type: String, default: '' },
})

const loading = ref(true)
const data = ref<LoadSummary | null>(null)

async function fetchData() {
  try {
    const res = await fetch('/api/performance/training_load', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as LoadSummary
  } catch {
    // Widget contextuel discret : en cas d'échec, on n'affiche simplement rien.
    data.value = null
  } finally {
    loading.value = false
  }
}
onMounted(fetchData)

const { weekPlan } = useTrainingPlan(data)

const inCurrentWeek = computed(() => {
  if (!props.activityDate) return false
  const d = new Date(props.activityDate)
  if (Number.isNaN(d.getTime())) return false
  return isoLocal(mondayOf(d)) === isoLocal(mondayOf(new Date()))
})

const plan = computed(() => (inCurrentWeek.value ? weekPlan.value : null))

const pct = computed(() => {
  const p = plan.value
  if (!p || p.target <= 0) return 0
  return Math.min(100, Math.round((p.done / p.target) * 100))
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const performanceHref = `${lang ? `/${lang}` : ''}/performance#training-load`
</script>

<template>
  <div v-if="!loading && plan" class="card shadow-sm border-0 mb-3 week-progress-card">
    <div class="card-body py-2">
      <div class="d-flex align-items-center gap-2 mb-1">
        <i class="fa-solid fa-calendar-week text-warning" aria-hidden="true"></i>
        <span class="fw-semibold small">{{ t('strava.week_progress.title') }}</span>
        <span class="small ms-auto" :style="{ color: WEEK_PACE_COLOR[plan.pace] }">
          {{ t(`performance.load.week.pace_${plan.pace}`) }}
        </span>
      </div>
      <div class="progress week-progress-bar" style="height: 6px;">
        <div
          class="progress-bar"
          :style="{ width: `${pct}%`, backgroundColor: WEEK_PACE_COLOR[plan.pace] }"
        ></div>
      </div>
      <div class="d-flex align-items-baseline justify-content-between mt-1">
        <span class="small text-muted" :title="t('strava.week_progress.hint')">
          {{ t('performance.load.week.progress', { done: plan.done, target: plan.target }) }}
        </span>
        <a :href="performanceHref" class="small">{{ t('strava.week_progress.see_analysis') }}</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.week-progress-bar {
  background: var(--bs-tertiary-bg);
}
</style>
