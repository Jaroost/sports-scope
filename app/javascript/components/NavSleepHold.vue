<script setup lang="ts">
// Retour visuel de la mise en veille par appui long (cf. useSleepHold) : l'anneau qui se
// remplit sous le doigt, et la pastille qui dit ce que la veille fait — et surtout ce
// qu'elle ne coupe pas. « Écran noir » sans plus d'explication, en pleine sortie, se lit
// « je perds le guidage » : on ne le tente pas, ou on le défait aussitôt.
//
// La même pastille sert de rappel après un tap simple, qui n'endort plus (`hint`) : c'est
// le seul moment où l'on sait à coup sûr que quelqu'un cherchait la veille.
import { computed } from 'vue'
import { t } from '../i18n'
import { SLEEP_HOLD_MS } from '../composables/useSleepHold'
import type { SleepPress } from '../composables/useSleepHold'

const props = defineProps<{
  press: SleepPress | null
  hint: boolean
}>()

// Rayon 45 sur une boîte de 100 : circonférence = 2πr, le dash de départ de l'arc.
const ARC_LEN = 2 * Math.PI * 45

// Position fixe (viewport) : les coordonnées viennent d'un PointerEvent, et .nav-page ne
// porte aucune transformation — clientX/Y y sont directement des pixels d'écran.
const ringStyle = computed(() => (props.press
  ? { left: `${props.press.x}px`, top: `${props.press.y}px` }
  : undefined))

// La pastille suit le doigt en hauteur mais reste centrée en largeur : un appui près d'un
// bord la ferait sortir de l'écran, et une explication tronquée ne vaut rien. Bornée haut
// et bas pour ne pas passer sous le bandeau de virage ni sous la barre du bas.
const pillStyle = computed(() => {
  const h = window.innerHeight || 800
  if (!props.press) return { top: `${Math.round(h * 0.58)}px` }
  return { top: `${Math.min(Math.max(props.press.y + 76, 96), h - 132)}px` }
})
</script>

<template>
  <div
    v-if="press"
    :key="press.id"
    class="nav-sleep-ring"
    :style="ringStyle"
    aria-hidden="true"
  >
    <svg viewBox="0 0 100 100">
      <circle class="nav-sleep-track" cx="50" cy="50" r="45" />
      <circle
        class="nav-sleep-arc"
        cx="50" cy="50" r="45"
        :stroke-dasharray="ARC_LEN"
        :stroke-dashoffset="ARC_LEN"
        :style="{ animationDuration: `${SLEEP_HOLD_MS}ms` }"
      />
    </svg>
    <i class="fa-solid fa-moon" aria-hidden="true"></i>
  </div>

  <Transition name="nav-sleep-pill">
    <div v-if="press || hint" class="nav-sleep-pill" :style="pillStyle" role="status">
      <span class="nav-sleep-pill-title">
        {{ press ? t('routes.sleep_hold_title') : t('routes.sleep_hold_hint') }}
      </span>
      <span class="nav-sleep-pill-text">{{ t('routes.sleep_hold_explain') }}</span>
    </div>
  </Transition>
</template>

<style scoped>
/* Au-dessus de tout ce qui vit en navigation éveillée (tiroir z 10, poignées z 8) mais
   sous le voile de veille (z 20) : quand l'appui aboutit, l'anneau disparaît de toute
   façon — c'est le voile qui prend la suite. pointer-events: none, sinon l'anneau volerait
   au doigt la fin de son propre appui. */
.nav-sleep-ring {
  position: fixed; z-index: 15;
  width: 6.5rem; height: 6.5rem;
  margin-left: -3.25rem; margin-top: -3.25rem;
  pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  color: #fff;
}
.nav-sleep-ring svg {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  /* L'arc part à midi et tourne dans le sens des aiguilles. */
  transform: rotate(-90deg);
}
.nav-sleep-ring i { font-size: 1.9rem; opacity: 0.9; }
/* Disque sombre translucide : l'anneau doit rester lisible sur une carte claire comme sur
   une photo aérienne. */
.nav-sleep-track {
  fill: rgba(15, 23, 42, 0.62);
  stroke: rgba(255, 255, 255, 0.28);
  stroke-width: 6;
}
.nav-sleep-arc {
  fill: none;
  stroke: #a78bfa;
  stroke-width: 6;
  stroke-linecap: round;
  animation-name: nav-sleep-fill;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
/* Le remplissage EST la jauge du temps restant : pas de repli en mouvement réduit, sinon
   l'appui redevient un trou noir. */
@keyframes nav-sleep-fill {
  to { stroke-dashoffset: 0; }
}

.nav-sleep-pill {
  position: fixed; left: 50%; transform: translateX(-50%);
  z-index: 15; pointer-events: none;
  max-width: min(22rem, calc(100vw - 2rem));
  display: flex; flex-direction: column; align-items: center; gap: 0.15rem;
  padding: 0.55rem 1rem; border-radius: 1rem;
  background: rgba(15, 23, 42, 0.82); color: #fff;
  text-align: center; line-height: 1.25;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.nav-sleep-pill-title { font-size: 1rem; font-weight: 600; }
.nav-sleep-pill-text { font-size: 0.85rem; opacity: 0.8; }
.nav-sleep-pill-enter-active, .nav-sleep-pill-leave-active { transition: opacity 0.2s; }
.nav-sleep-pill-enter-from, .nav-sleep-pill-leave-to { opacity: 0; }
</style>
