<script setup lang="ts">
// Historique d'un segment : le graphique de progression + le tableau des passages.
// Partagé par la liste des segments découverts (`ActivitySegments`) et le panneau de
// comparaison d'un tronçon choisi (`SegmentCompare`) — c'est le même contenu, seule
// l'origine de la plage change.
import type { PropType } from 'vue'
import { t } from '../i18n'
import { formatPace, paceMinPerKm, formatChrono } from '../activityHelpers'
import SegmentHistoryChart from './SegmentHistoryChart.vue'
import type { SegmentEffort } from '../segmentTypes'

const props = defineProps({
  efforts: { type: Array as PropType<SegmentEffort[]>, default: () => [] },
  // Passage de la sortie affichée : il ouvre le tableau et sert de référence aux écarts.
  currentDurationS: { type: Number, required: true },
  currentReverse: { type: Boolean, default: false },
  currentDate: { type: String, default: '' },
  // Total des passages connus — au-delà de ce que `efforts` en montre.
  count: { type: Number, default: 0 },
  distanceM: { type: Number, required: true },
  isRun: { type: Boolean, default: false },
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

const chrono = formatChrono

// Écart au temps du jour, signé (négatif = ce passage-là était plus rapide).
function delta(seconds: number, reference: number): string {
  const d = Math.round(seconds - reference)
  if (d === 0) return '='
  return `${d > 0 ? '+' : '−'}${chrono(Math.abs(d))}`
}

// Allure (course) ou vitesse moyenne (le reste) d'un passage sur le segment.
function speed(seconds: number): string {
  if (!seconds) return '–'
  const mps = props.distanceM / seconds
  if (props.isRun) return `${formatPace(paceMinPerKm(mps))} /km`
  return `${(mps * 3.6).toFixed(1)} km/h`
}

function activityUrl(effort: SegmentEffort): string {
  const path = effort.source === 'imported' ? 'imported_activities' : 'activities'
  return `${localePrefix}/${path}/${effort.external_id}`
}

function effortDate(effort: SegmentEffort): string {
  if (!effort.started_at) return '–'
  return new Date(effort.started_at).toLocaleDateString(lang || undefined, {
    day: '2-digit', month: '2-digit', year: '2-digit',
  })
}
</script>

<template>
  <div>
    <!-- Progression : un point par passage, date en x, chrono en y, un sens par série
         (le sens inverse n'est pas comparable au sens direct). -->
    <SegmentHistoryChart
      class="mb-3"
      :efforts="efforts"
      :current-duration-s="currentDurationS"
      :current-reverse="currentReverse"
      :current-date="currentDate"
    />
    <div class="table-responsive">
      <table class="table table-sm align-middle mb-1">
        <thead>
          <tr class="text-muted small">
            <th scope="col">{{ t('strava.segments.date') }}</th>
            <th scope="col">{{ t('strava.segments.time') }}</th>
            <th scope="col">{{ t('strava.segments.delta') }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          <tr class="table-active">
            <td>
              {{ t('strava.segments.this_activity') }}
              <span v-if="currentReverse" class="badge text-bg-light border ms-1">{{ t('strava.segments.reverse') }}</span>
            </td>
            <td class="fw-semibold">{{ chrono(currentDurationS) }}</td>
            <td class="text-muted">=</td>
            <td class="text-muted small">{{ speed(currentDurationS) }}</td>
          </tr>
          <tr v-for="effort in efforts" :key="`${effort.source}-${effort.external_id}-${effort.started_at}-${effort.duration_s}`">
            <td>{{ effortDate(effort) }}</td>
            <td>
              {{ chrono(effort.duration_s) }}
              <span v-if="effort.reverse" class="badge text-bg-light border ms-1">{{ t('strava.segments.reverse') }}</span>
            </td>
            <td :class="effort.duration_s < currentDurationS ? 'text-success' : 'text-danger'">
              {{ effort.reverse === currentReverse ? delta(effort.duration_s, currentDurationS) : '–' }}
            </td>
            <td class="small">
              <a :href="activityUrl(effort)" class="link-secondary text-decoration-none">
                {{ effort.name }}
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="efforts.length < count - 1" class="text-muted small mb-0">
      {{ t('strava.segments.truncated', { count: efforts.length }) }}
    </p>
  </div>
</template>
