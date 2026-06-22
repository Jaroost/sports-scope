<script setup lang="ts">
import { formatDistancePrecise } from '../routeHelpers'
import type { ClimbInfo } from '../navHelpers'

defineProps<{ climbInfo: ClimbInfo; screenOff: boolean }>()
defineEmits<{ (e: 'resume'): void }>()
</script>

<template>
  <!-- Climb card: full graded elevation profile with a position cursor.
       Reste visible (au-dessus du voile noir) en mode veille ; un tap réveille. -->
  <div
    class="nav-climb shadow"
    :class="{ 'nav-climb--sleep': screenOff }"
    @click="screenOff && $emit('resume')"
  >
    <div class="d-flex align-items-center justify-content-between mb-1">
      <span class="fw-semibold">
        <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
      </span>
      <span class="d-flex align-items-center gap-2">
        <!-- Distance restante du col, mise en avant. -->
        <span class="nav-climb-remaining-dist">{{ formatDistancePrecise(climbInfo.climb.lengthM * (1 - climbInfo.ratio)) }}</span>
        <span class="nav-climb-grade" :style="{ background: climbInfo.gradeColor, color: climbInfo.gradeText }">{{ Math.round(climbInfo.grade) }} %</span>
      </span>
    </div>
    <div class="nav-climb-graph">
      <svg class="nav-climb-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <clipPath id="nav-climb-done-clip">
            <rect x="0" y="0" :width="climbInfo.posX" height="100" />
          </clipPath>
        </defs>
        <path v-for="(seg, i) in climbInfo.segments" :key="i" :d="seg.d" :fill="seg.color" />
        <!-- Done section: the profile redrawn in a flat grey, clipped up to the rider. -->
        <path :d="climbInfo.areaD" fill="#9ca3af" clip-path="url(#nav-climb-done-clip)" />
      </svg>
      <div class="nav-climb-cursor" :style="{ left: `${climbInfo.posX}%` }">
        <!-- Remaining vertical gain: from the rider's altitude up to the summit. -->
        <span
          class="nav-climb-remain"
          :style="{ top: `${climbInfo.topY}%`, height: `${Math.max(0, climbInfo.posY - climbInfo.topY)}%` }"
        ></span>
        <span
          class="nav-climb-remain-label"
          :class="{ 'nav-climb-remain-label--left': climbInfo.posX > 50 }"
          :style="{ top: `${(climbInfo.topY + climbInfo.posY) / 2}%` }"
        >
          <span class="nav-climb-remain-gain">+{{ Math.round(climbInfo.remainingGainM) }} m</span>
          <span class="nav-climb-remain-pct">{{ Math.round(climbInfo.ratio * 100) }} %</span>
        </span>
        <span class="nav-climb-dot" :style="{ top: `${climbInfo.posY}%` }"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nav-climb {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 6.25rem;
  z-index: 3; background: #fff; border-radius: 0.75rem; padding: 0.6rem 0.85rem;
}
/* Mode veille : la carte du col passe au-dessus du voile noir (z 20). On garde sa
   position par défaut pour laisser l'indice « tap pour reprendre » visible dessous. */
.nav-climb--sleep { z-index: 21; }
.nav-climb-grade {
  font-weight: 700; font-size: 1.1rem; line-height: 1;
  padding: 0.15rem 0.45rem; border-radius: 0.4rem;
}
/* Distance restante du col, mise en avant dans l'en-tête. */
.nav-climb-remaining-dist {
  font-weight: 800; font-size: 1.5rem; line-height: 1; color: #111827;
}
.nav-climb-graph {
  position: relative; height: 210px; width: 100%;
}
.nav-climb-svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  border-radius: 0.4rem; background: #f8f9fa;
}
/* Vertical "you are here" cursor over the profile; the dot rides the altitude line. */
.nav-climb-cursor {
  position: absolute; top: 0; bottom: 0; width: 2px;
  background: rgba(17, 24, 39, 0.55); transform: translateX(-1px);
}
.nav-climb-dot {
  position: absolute; left: 50%; width: 12px; height: 12px;
  background: #111827; border: 2px solid #fff; border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
/* Remaining vertical gain: dashed segment from the rider up to the summit. */
.nav-climb-remain {
  position: absolute; left: 50%; width: 0;
  border-left: 2px dashed #f97316; transform: translateX(-1px);
}
.nav-climb-remain-label {
  position: absolute; left: 8px; transform: translateY(-50%);
  display: flex; flex-direction: column; align-items: flex-start;
  white-space: nowrap; line-height: 1.1;
  background: rgba(255, 255, 255, 0.9); padding: 0.1rem 0.35rem; border-radius: 0.3rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.nav-climb-remain-gain { font-size: 1.05rem; font-weight: 800; color: #c2410c; }
.nav-climb-remain-pct { font-size: 0.8rem; font-weight: 700; color: #6c757d; }
/* Passé la moitié du graphique, on bascule le label à gauche de la ligne pour
   qu'il ne soit pas coupé par le bord droit. */
.nav-climb-remain-label--left { left: auto; right: 8px; align-items: flex-end; }
</style>
