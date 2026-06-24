<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { formatDistanceShort } from '../routeHelpers'
import { remainingSeconds, arrivalClock } from '../navHelpers'

// speedKmh : vitesse instantanée (affichée). etaSpeedKmh : vitesse lissée servant
// uniquement au calcul de l'heure d'arrivée, pour une ETA stable malgré les arrêts.
const props = defineProps<{
  remainingM: number
  remainingGainM: number
  donePercent: number
  speedKmh: number
  etaSpeedKmh: number
}>()

// Heure d'arrivée estimée à la vitesse lissée ; « --:-- » tant qu'on n'a pas de
// vitesse exploitable (départ, arrêt).
const eta = computed(() => {
  const sec = remainingSeconds(props.remainingM, props.etaSpeedKmh)
  return sec == null ? '--:--' : arrivalClock(sec)
})
</script>

<template>
  <!-- Bottom stats -->
  <div class="nav-stats shadow">
    <div class="d-flex justify-content-around text-center mb-2">
      <div>
        <div class="nav-stat-value">{{ Math.round(speedKmh) }}<span class="nav-stat-unit"> km/h</span></div>
        <div class="nav-stat-label">{{ t('routes.speed') }}</div>
      </div>
      <div>
        <div class="nav-stat-value">{{ formatDistanceShort(remainingM) }}</div>
        <div class="nav-stat-label">{{ t('routes.remaining_distance') }}</div>
      </div>
      <div>
        <div class="nav-stat-value">+{{ Math.round(remainingGainM) }} m</div>
        <div class="nav-stat-label">{{ t('routes.remaining_elevation') }}</div>
      </div>
      <div>
        <div class="nav-stat-value">{{ eta }}</div>
        <div class="nav-stat-label">{{ t('routes.arrival') }}</div>
      </div>
    </div>
    <div class="progress nav-progress">
      <div class="progress-bar bg-primary" :style="{ width: `${donePercent}%` }"></div>
    </div>
  </div>
</template>

<style scoped>
.nav-stats {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0.75rem;
  /* z-index 6 : au-dessus de TOUTE la couche de marqueurs de la carte. Les marqueurs
     MapLibre (POI z1, pastilles de virage z2-4, destination z4, flèche du coureur z5)
     sont des overlays DOM qui remontent dans le contexte d'empilement racine ; à z3,
     ce bandeau se faisait recouvrir par la pastille de virage atteint, le marqueur de
     destination et la flèche du coureur. 6 dépasse le plus haut marqueur (5). */
  z-index: 6; background: #fff; border-radius: 0.75rem; padding: 0.7rem 0.85rem;
}
.nav-stat-value { font-size: 1.25rem; font-weight: 700; line-height: 1.1; white-space: nowrap; }
/* Unité accolée à la vitesse, plus discrète que le chiffre. */
.nav-stat-unit { font-size: 0.7rem; font-weight: 600; color: #6c757d; }
.nav-stat-label { font-size: 0.72rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.02em; }
.nav-progress { height: 0.5rem; border-radius: 999px; }
</style>
