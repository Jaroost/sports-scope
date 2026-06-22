<script setup lang="ts">
import { t } from '../i18n'
import { formatDistanceShort } from '../routeHelpers'

defineProps<{ remainingM: number; remainingGainM: number; donePercent: number }>()
</script>

<template>
  <!-- Bottom stats -->
  <div class="nav-stats shadow">
    <div class="d-flex justify-content-around text-center mb-2">
      <div>
        <div class="nav-stat-value">{{ formatDistanceShort(remainingM) }}</div>
        <div class="nav-stat-label">{{ t('routes.remaining_distance') }}</div>
      </div>
      <div>
        <div class="nav-stat-value">+{{ Math.round(remainingGainM) }} m</div>
        <div class="nav-stat-label">{{ t('routes.remaining_elevation') }}</div>
      </div>
      <div>
        <div class="nav-stat-value">{{ donePercent }} %</div>
        <div class="nav-stat-label">{{ t('routes.progress') }}</div>
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
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.7rem 0.85rem;
}
.nav-stat-value { font-size: 1.25rem; font-weight: 700; line-height: 1.1; }
.nav-stat-label { font-size: 0.72rem; color: #6c757d; text-transform: uppercase; letter-spacing: 0.02em; }
.nav-progress { height: 0.5rem; border-radius: 999px; }
</style>
