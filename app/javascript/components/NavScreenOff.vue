<script setup lang="ts">
import { t } from '../i18n'
import { formatDistancePrecise } from '../routeHelpers'
import { turnIcon, turnEta } from '../navHelpers'
import type { TurnHint, ClimbInfo } from '../navHelpers'

const props = defineProps<{
  turnHint: TurnHint | null
  followTurns?: TurnHint[]
  hasFix: boolean
  offRoute: boolean
  climbInfo: ClimbInfo | null
  urgentM: number
  speedKmh: number
  muted?: boolean
}>()

defineEmits<{ (e: 'resume'): void; (e: 'mute'): void }>()

const isUrgent = () => props.turnHint?.state === 'near' && props.turnHint.distM <= props.urgentM
</script>

<template>
  <!-- Battery saver: black screen — GPS and turn sounds still active -->
  <div class="nav-screen-off" @click="$emit('resume')">
    <div
      v-if="turnHint && hasFix && !offRoute"
      class="nav-turn-sleep shadow"
      :class="{
        'nav-turn-sleep--urgent': isUrgent(),
        'nav-turn-sleep--now': turnHint.state === 'now',
        'nav-turn-sleep--far': turnHint.state === 'far',
        'nav-turn-sleep--climb': climbInfo,
      }"
    >
      <div class="nav-turn-sleep-icons">
        <i v-if="isUrgent()" class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <i class="fa-solid" :class="turnIcon(turnHint)" aria-hidden="true"></i>
        <span v-if="turnHint.kind === 'roundabout' && turnHint.exitNumber" class="nav-turn-sleep-exit">{{ turnHint.exitNumber }}</span>
      </div>
      <span class="nav-turn-sleep-dist">{{ turnHint.state === 'now' ? t('routes.turn_now') : formatDistancePrecise(turnHint.distM) }}</span>
      <span v-if="turnHint.state !== 'now' && turnEta(turnHint.distM, speedKmh)" class="nav-turn-sleep-eta">
        <i class="fa-solid fa-clock me-2" aria-hidden="true"></i>{{ turnEta(turnHint.distM, speedKmh) }}
      </span>
      <!-- Rafale : les virages qui suivent le principal de très près (gauche-droite serré). -->
      <div v-if="followTurns && followTurns.length" class="nav-turn-sleep-follow">
        <span class="nav-turn-sleep-follow-label">{{ t('routes.then') }}</span>
        <span v-for="(f, i) in followTurns" :key="i" class="nav-turn-sleep-follow-item">
          <i class="fa-solid" :class="turnIcon(f)" aria-hidden="true"></i>
          <span v-if="f.kind === 'roundabout' && f.exitNumber" class="nav-turn-sleep-follow-exit">{{ f.exitNumber }}</span>
          <span class="nav-turn-sleep-follow-dist">{{ formatDistancePrecise(f.distM) }}</span>
          <span class="visually-hidden">{{ f.direction === 'right' ? t('routes.turn_right') : t('routes.turn_left') }}</span>
        </span>
      </div>
      <button
        v-if="turnHint.state === 'near'"
        class="nav-turn-sleep-mute"
        :aria-label="muted ? t('routes.unmute_turn_alerts') : t('routes.mute_turn_alerts')"
        :title="muted ? t('routes.unmute_turn_alerts') : t('routes.mute_turn_alerts')"
        @click.stop="$emit('mute')"
      >
        <i class="fa-solid" :class="muted ? 'fa-bell' : 'fa-bell-slash'" aria-hidden="true"></i>
      </button>
      <span class="visually-hidden">{{ turnHint.direction === 'right' ? t('routes.turn_right') : t('routes.turn_left') }}</span>
    </div>
    <div class="nav-screen-off-hint">
      <i class="fa-solid fa-eye me-2" aria-hidden="true"></i>{{ t('routes.tap_to_resume') }}
    </div>
  </div>
</template>

<style scoped>
.nav-screen-off {
  position: absolute; inset: 0; z-index: 20;
  background: #000;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 3rem;
  cursor: pointer;
}
.nav-screen-off-hint {
  position: absolute; bottom: 2.5rem;
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.85rem;
}
.nav-turn-sleep {
  display: flex; flex-direction: column; align-items: center; gap: 1.25rem;
  background: #7c3aed; color: #fff;
  padding: 3rem 4rem; border-radius: 1.5rem;
  width: calc(100% - 1.5rem); box-sizing: border-box;
  position: relative;
}
.nav-turn-sleep-icons {
  display: flex; align-items: center; gap: 0.75rem;
  font-size: 4.5rem; line-height: 1;
}
.nav-turn-sleep-dist { font-size: 3rem; font-weight: 700; line-height: 1; }
.nav-turn-sleep-eta {
  display: flex; align-items: center; justify-content: center;
  font-size: 1.7rem; font-weight: 600; opacity: 0.85; line-height: 1;
}
.nav-turn-sleep-eta i { font-size: 1.3rem; }
.nav-turn-sleep-exit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 3rem; height: 3rem; border-radius: 50%;
  background: rgba(255,255,255,0.25); font-size: 2rem; font-weight: 700;
}
.nav-turn-sleep.nav-turn-sleep--urgent { background: #f97316; }
/* Virage atteint (veille) : maintenu en vert quelques secondes comme confirmation. */
.nav-turn-sleep.nav-turn-sleep--now { background: #16a34a; }
/* Virage lointain (veille) : même gris-bleu discret qu'en navigation, pour distinguer
   d'un coup d'œil un virage encore loin (gris) d'un virage en approche (violet). */
.nav-turn-sleep.nav-turn-sleep--far { background: rgba(51, 65, 85, 0.92); }
/* Rafale (veille) : virages secondaires enchaînés, en petit sous le virage principal. */
.nav-turn-sleep-follow {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
  gap: 0.75rem 1.5rem;
  padding-top: 1rem; margin-top: 0.25rem;
  border-top: 1px solid rgba(255, 255, 255, 0.25);
  width: 100%;
}
.nav-turn-sleep-follow-label { font-size: 1.3rem; font-weight: 600; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
.nav-turn-sleep-follow-item { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 2.2rem; }
.nav-turn-sleep-follow-dist { font-size: 1.9rem; font-weight: 700; }
.nav-turn-sleep-follow-exit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2rem; height: 2rem; border-radius: 50%;
  background: rgba(255,255,255,0.25); font-size: 1.3rem; font-weight: 700;
}
/* Pendant un col en veille, la carte du col occupe le bas : on remonte l'indicateur
   de virage en haut pour qu'il ne soit pas masqué. */
.nav-turn-sleep--climb { position: absolute; top: 1.5rem; left: 50%; transform: translateX(-50%); }
/* Bouton de sourdine dans l'écran de veille. */
.nav-turn-sleep-mute {
  background: rgba(255,255,255,0.2); border: none; border-radius: 0.75rem;
  color: #fff; padding: 0.6rem 1rem; font-size: 1.7rem; cursor: pointer;
  line-height: 1; touch-action: manipulation;
}
.nav-turn-sleep-mute:active { background: rgba(255,255,255,0.4); }
</style>
