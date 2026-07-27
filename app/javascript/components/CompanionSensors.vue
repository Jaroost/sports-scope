<script setup lang="ts">
import { computed } from 'vue'
import { companionStore } from '../stores/companionStore'
import { t } from '../i18n'

// Bandeau des capteurs BLE tenus par l'application mobile : cardio, puissance,
// cadence, vitesses Di2. N'apparaît que dans l'appli — dans un navigateur
// ordinaire le store reste vide, le bandeau ne se monte jamais.
//
// Il n'affiche rien non plus quand l'appli est muette depuis 10 s (WebView mis
// en veille, appli tuée) : une valeur de cardio figée est pire qu'une absence,
// elle se lit comme une mesure.

// Le composant ne se positionne pas lui-même : il s'insère dans la barre de
// stats, sous la barre d'avancement, et en navigation libre sous la vitesse.
// Les capteurs se lisent avec le reste des chiffres, pas dans un bandeau
// supplémentaire qui mangerait de la carte.

const visible = computed(() => companionStore.hasValues.value && !companionStore.stale.value)

const heartRate = computed(() => companionStore.heartRate.value)
const power = computed(() => companionStore.power.value)
const cadence = computed(() => companionStore.cadence.value)
const gears = computed(() => companionStore.gears.value)

// « 50 × 11 » si l'appli connaît la transmission, « 2 / 12 » sinon : les
// positions brutes valent mieux qu'un braquet inventé.
const gearLabel = computed(() => {
  const g = gears.value
  if (!g) return null
  if (g.frontTeeth != null && g.rearTeeth != null) return `${g.frontTeeth} × ${g.rearTeeth}`
  return `${g.front} / ${g.rear}`
})
</script>

<template>
  <div v-if="visible" class="companion-sensors">
    <div v-if="heartRate != null" class="companion-sensor">
      <i class="fa-solid fa-heart-pulse text-danger"></i>
      <span class="companion-value">{{ heartRate }}</span>
      <span class="companion-unit">bpm</span>
    </div>
    <div v-if="power != null" class="companion-sensor">
      <i class="fa-solid fa-bolt text-warning"></i>
      <span class="companion-value">{{ power }}</span>
      <span class="companion-unit">W</span>
    </div>
    <div v-if="cadence != null" class="companion-sensor">
      <i class="fa-solid fa-rotate text-info"></i>
      <span class="companion-value">{{ Math.round(cadence) }}</span>
      <span class="companion-unit">{{ t('routes.rpm') }}</span>
    </div>
    <div v-if="gearLabel" class="companion-sensor">
      <i class="fa-solid fa-gears text-secondary"></i>
      <span class="companion-value">{{ gearLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
/* Une ligne de plus dans la carte qui l'accueille, séparée par un filet : elle
   n'a ni fond ni ombre propres, et ne se positionne pas. */
.companion-sensors {
  display: flex;
  justify-content: space-around;
  gap: 0.5rem;
  margin-top: 0.4rem;
  padding-top: 0.4rem;
  border-top: 1px solid rgba(128, 128, 128, 0.25);
}

.companion-sensor {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  font-variant-numeric: tabular-nums;
}

.companion-value {
  font-size: 1.15rem;
  font-weight: 600;
}

.companion-unit {
  font-size: 0.7rem;
  opacity: 0.75;
}
</style>
