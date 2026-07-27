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

// elevated — la veille d'écran recouvre la carte d'un voile noir ; les capteurs
// restent lisibles au-dessus, comme le bandeau radar.
defineProps<{ elevated?: boolean }>()

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
  <div v-if="visible" class="companion-sensors shadow" :class="{ 'companion-sensors--elevated': elevated }">
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
/* Aligné sur le bandeau radar : même largeur, même marge, juste au-dessus de la
   barre de stats du bas. --nav-bottom-inset est posé par RouteNavigation et
   remonte l'ensemble quand le tiroir de commandes se déploie. */
.companion-sensors {
  position: absolute;
  left: 0.75rem;
  right: 0.75rem;
  bottom: calc(5.5rem + var(--nav-bottom-inset, 0rem));
  z-index: 6;
  display: flex;
  justify-content: space-around;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border-radius: 0.5rem;
  background: rgba(33, 37, 41, 0.85);
  color: #fff;
  transition: bottom 0.28s ease;
}

/* Au-dessus du voile de veille, comme le radar : ce sont les deux seules
   informations qu'on veut encore pouvoir lire écran éteint. */
.companion-sensors--elevated {
  z-index: 1051;
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
