<script setup lang="ts">
import { computed } from 'vue'
import { radarStore } from '../stores/radarStore'
import { userPreferences } from '../userPreferences'

// `climbing` : un col est affiché (panneau bas pleine largeur). On raccourcit alors
// la barre pour ne jamais la recouvrir.
const props = defineProps<{ climbing?: boolean }>()

// Portée affichée : au-delà, on ne montre pas encore le véhicule. Le Varia détecte
// jusqu'à ~140 m ; on cale la barre dessus.
const RANGE_M = 140

// Option de profil : garder la barre visible en permanence (radar connecté) plutôt
// que de ne l'afficher qu'à l'approche d'un véhicule.
const alwaysVisible = userPreferences().navigation.radar_always_visible
// Seuil (m) de l'alerte rapprochée : sous cette distance le point passe au rouge
// (cohérent avec le bip insistant déclenché par la navigation).
const closeM = userPreferences().navigation.radar_close_m

const targets = computed(() => radarStore.targets.value)
const active = computed(() =>
  radarStore.isConnected.value && (alwaysVisible || targets.value.length > 0),
)
const nearest = computed(() => radarStore.nearest.value)

// Position verticale du point : le cycliste est en haut. 0 % = haut (collé au
// cycliste, distance nulle), 100 % = bas (à portée maximale). Le point monte donc
// vers le cycliste à mesure que la voiture se rapproche.
function topPct(distanceM: number): number {
  const clamped = Math.min(Math.max(distanceM, 0), RANGE_M)
  return (clamped / RANGE_M) * 100
}

// Couleur selon la proximité — vert (loin) → orange → rouge (collé).
function color(distanceM: number): string {
  if (distanceM <= closeM) return '#dc3545'
  if (distanceM <= closeM + 40) return '#fd7e14'
  return '#ffc107'
}
</script>

<template>
  <div v-if="active" class="radar-bar shadow" :class="{ 'radar-bar--climb': props.climbing }" aria-hidden="true">
    <!-- Le cycliste, en haut -->
    <i class="fa-solid fa-person-biking radar-rider"></i>
    <div class="radar-track">
      <!-- Un point par véhicule, positionné par sa distance -->
      <span
        v-for="tgt in targets"
        :key="tgt.id"
        class="radar-dot"
        :style="{ top: topPct(tgt.distanceM) + '%', background: color(tgt.distanceM) }"
      ></span>
    </div>
    <div v-if="nearest" class="radar-readout" :style="{ color: color(nearest.distanceM) }">
      {{ Math.round(nearest.distanceM) }}<small>m</small>
    </div>
    <i v-else class="fa-solid fa-tower-broadcast radar-idle" aria-hidden="true"></i>
  </div>
</template>

<style scoped>
.radar-bar {
  position: absolute;
  left: 0.75rem;
  /* Un peu sous le bouton « retour » (top 0.75rem + hauteur du bouton + marge). */
  top: 4.75rem;
  width: 34px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 4px;
  background: rgba(33, 37, 41, 0.82);
  border-radius: 18px;
  z-index: 5;
  pointer-events: none;
}
.radar-track {
  position: relative;
  width: 10px;
  /* Allongée par rapport au POC initial ; bornée en vh pour rester dans le haut de
     l'écran. Les points sont positionnés en % donc s'adaptent à la hauteur. */
  height: min(46vh, 300px);
  border-radius: 6px;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.18));
}
/* Un col occupe le bas de l'écran : on raccourcit la barre pour ne pas le recouvrir. */
.radar-bar--climb .radar-track {
  height: min(30vh, 190px);
}
.radar-rider {
  color: #fff;
  font-size: 14px;
}
.radar-dot {
  position: absolute;
  left: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 8px currentColor;
  transition: top 0.4s linear;
}
.radar-readout {
  font-weight: 700;
  font-size: 13px;
  line-height: 1;
}
.radar-readout small {
  font-size: 9px;
  opacity: 0.8;
}
/* Voie dégagée (radar connecté, aucune voiture) — petit témoin discret. */
.radar-idle {
  color: #20c997;
  font-size: 13px;
  opacity: 0.7;
}
</style>
