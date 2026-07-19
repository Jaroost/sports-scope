<script setup lang="ts">
import { t } from '../i18n'
import { formatDistancePrecise } from '../routeHelpers'
import { turnIcon, turnEta } from '../navHelpers'
import type { TurnHint } from '../navHelpers'

const props = defineProps<{
  turnHint: TurnHint
  followTurns?: TurnHint[]
  urgentM: number
  radarBannerVisible: boolean
  speedKmh: number
  muted?: boolean
}>()

defineEmits<{ (e: 'mute'): void }>()

const isUrgent = () => props.turnHint.state === 'near' && props.turnHint.distM <= props.urgentM
</script>

<template>
  <div
    class="nav-turn shadow"
    :class="{
      'nav-turn--urgent': isUrgent(),
      'nav-turn--far': turnHint.state === 'far',
      'nav-turn--now': turnHint.state === 'now',
      'nav-turn--radar': radarBannerVisible,
    }"
  >
    <div class="nav-turn-main">
      <i v-if="isUrgent()" class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>
      <i class="fa-solid" :class="turnIcon(turnHint)" aria-hidden="true"></i>
      <span v-if="turnHint.kind === 'roundabout' && turnHint.exitNumber" class="nav-turn-exit">{{ turnHint.exitNumber }}</span>
      <span class="nav-turn-info">
        <span v-if="turnHint.state === 'now'" class="nav-turn-dist">{{ t('routes.turn_now') }}</span>
        <template v-else>
          <span class="nav-turn-dist">{{ formatDistancePrecise(turnHint.distM) }}</span>
          <span v-if="turnEta(turnHint.distM, speedKmh)" class="nav-turn-eta">
            <i class="fa-solid fa-clock" aria-hidden="true"></i>{{ turnEta(turnHint.distM, speedKmh) }}
          </span>
        </template>
      </span>
      <button
        v-if="turnHint.state === 'near'"
        class="nav-turn-mute"
        :aria-label="muted ? t('routes.unmute_turn_alerts') : t('routes.mute_turn_alerts')"
        :title="muted ? t('routes.unmute_turn_alerts') : t('routes.mute_turn_alerts')"
        @click.stop="$emit('mute')"
      >
        <i class="fa-solid" :class="muted ? 'fa-bell' : 'fa-bell-slash'" aria-hidden="true"></i>
      </button>
      <span class="visually-hidden">{{ turnHint.direction === 'right' ? t('routes.turn_right') : t('routes.turn_left') }}</span>
    </div>
    <!-- Rafale : les virages qui suivent le principal de très près (gauche-droite serré). -->
    <div v-if="followTurns && followTurns.length" class="nav-turn-follow">
      <span class="nav-turn-follow-label">{{ t('routes.then') }}</span>
      <span v-for="(f, i) in followTurns" :key="i" class="nav-turn-follow-item">
        <i class="fa-solid" :class="turnIcon(f)" aria-hidden="true"></i>
        <span v-if="f.kind === 'roundabout' && f.exitNumber" class="nav-turn-follow-exit">{{ f.exitNumber }}</span>
        <span class="nav-turn-follow-dist">{{ formatDistancePrecise(f.distM) }}</span>
        <span class="visually-hidden">{{ f.direction === 'right' ? t('routes.turn_right') : t('routes.turn_left') }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* Notification de virage : bandeau pleine largeur en haut de l'écran (les boutons
   sont désormais dans le tiroir, plus rien n'occupe les coins). */
/* z-index 7 : indispensable pour passer AU-DESSUS des marqueurs POI de la carte
   (.place-marker, z-index 1). Ceux-ci sont des marqueurs DOM MapLibre : .nav-map ne
   crée pas de stacking context, donc ils remontent dans le contexte racine et, sans
   z-index ici, recouvraient le bandeau. En posant le contexte d'empilement à 7, tout
   le sous-arbre (bandeau + bouton mute) passe aussi au-dessus de la nav-reveal-zone
   (z-index 6) — le mute reste donc tapable — tout en restant sous le tiroir de
   commandes (z-index 9). pointer-events: none laisse les taps/swipes traverser le
   bandeau (veille / révélation des boutons) ; seul le mute capte les siens. */
.nav-turn {
  position: absolute; top: 0.75rem; left: 0.75rem; right: 0.75rem;
  z-index: 7;
  display: flex; flex-direction: column; align-items: stretch; gap: 0.6rem;
  background: #7c3aed; color: #fff; padding: 1.1rem 1.5rem;
  border-radius: 1rem; font-size: 3rem; line-height: 1;
  pointer-events: none;
}
/* Ligne principale : le prochain virage en grand (icône + distance + ETA). */
.nav-turn-main {
  position: relative;
  display: flex; align-items: center; justify-content: center; gap: 1rem;
}
/* Rafale : bandeau secondaire des virages qui suivent de près (petit, sous le principal). */
.nav-turn-follow {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
  gap: 0.75rem 1.1rem; font-size: 1.4rem;
  padding-top: 0.5rem; border-top: 1px solid rgba(255, 255, 255, 0.25);
}
.nav-turn-follow-label { font-size: 1.1rem; font-weight: 600; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
.nav-turn-follow-item { display: inline-flex; align-items: center; gap: 0.4rem; }
.nav-turn-follow-item i { font-size: 1.6rem; }
.nav-turn-follow-dist { font-size: 1.4rem; font-weight: 700; }
.nav-turn-follow-exit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  background: rgba(255,255,255,0.25); font-size: 1rem; font-weight: 700;
}
/* Bandeau radar visible (pleine largeur en tout-haut) : on descend le virage dessous. */
.nav-turn--radar { top: 4.5rem; }
/* Distance (en avant) + temps estimé (en dessous, plus discret) du prochain virage. */
.nav-turn-info { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.nav-turn-dist { font-size: 2.1rem; font-weight: 700; }
.nav-turn-eta {
  display: flex; align-items: center; gap: 0.25rem;
  font-size: 1.4rem; font-weight: 600; opacity: 0.85;
}
.nav-turn-eta i { font-size: 1.2rem; }
.nav-turn-exit {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.75rem; height: 2.75rem; border-radius: 50%;
  background: rgba(255,255,255,0.25); font-size: 1.7rem; font-weight: 700;
}
.nav-turn.nav-turn--urgent { background: #f97316; }
/* Virage encore lointain (au-delà de turn_hint_m) : bandeau gris-bleu plus discret,
   pour qu'il reste informatif sans dominer la carte comme le virage rapproché (violet). */
.nav-turn.nav-turn--far { background: rgba(51, 65, 85, 0.92); }
/* Virage atteint : maintenu en vert quelques secondes comme confirmation « tournez ici ». */
.nav-turn.nav-turn--now { background: #16a34a; }
/* Bouton de sourdine des alertes sonores/haptiques du virage courant. */
/* pointer-events: auto pour capturer les taps malgré le pointer-events: none du
   parent .nav-turn. z-index local pour rester au-dessus du fond du bandeau ; c'est le
   stacking context du parent (.nav-turn, z-index 7) qui le place au-dessus de la
   nav-reveal-zone (6). */
.nav-turn-mute {
  position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%);
  z-index: 1; pointer-events: auto;
  background: rgba(255,255,255,0.2); border: none; border-radius: 0.5rem;
  color: #fff; padding: 0.45rem 0.6rem; font-size: 1.3rem; cursor: pointer;
  line-height: 1; touch-action: manipulation;
}
.nav-turn-mute:active { background: rgba(255,255,255,0.4); }
</style>
