<script setup lang="ts">
import { computed } from 'vue'
import { radarStore } from '../stores/radarStore'
import { userPreferences } from '../userPreferences'
import { t } from '../i18n'

// Dès que le radar est connecté, le bandeau reste affiché en permanence : avec une ou
// plusieurs voitures il indique la distance (orange/rouge), sans voiture il reste un
// simple bandeau vert vide — un témoin que la voie arrière est dégagée.
// Seuil (m) de l'alerte rapprochée : sous cette distance le bandeau passe au rouge
// avec « Attention » (cohérent avec le bip insistant déclenché par la navigation).
const closeM = userPreferences().navigation.radar_close_m

// Élevé au-dessus du voile de veille : en mode veille, le bandeau radar doit rester
// visible (info de sécurité — véhicules approchant par l'arrière) alors que le voile
// noir recouvre tout le reste.
// expanded — en navigation libre et en veille, il n'y a aucune indication de virage à
// afficher : le bandeau radar s'agrandit en une grande carte centrée pour occuper
// l'espace libéré et rester lisible d'un coup d'œil.
const props = defineProps<{ elevated?: boolean; expanded?: boolean }>()

// Nombre maximal d'icônes voiture affichées ; au-delà on ajoute « ·N ».
const MAX_ICONS = 4

const targets = computed(() => radarStore.targets.value)
const count = computed(() => targets.value.length)
const nearest = computed(() => radarStore.nearest.value)
const active = computed(() => radarStore.isConnected.value)

// Voiture proche → bandeau rouge « Attention ».
const close = computed(() => !!nearest.value && nearest.value.distanceM <= closeM)
// Combien d'icônes voiture afficher (plafonnées), et faut-il un compteur « ·N ».
const iconCount = computed(() => Math.min(count.value, MAX_ICONS))
</script>

<template>
  <div
    v-if="active"
    class="radar-banner shadow"
    :class="[
      close ? 'radar-banner--danger' : count > 0 ? 'radar-banner--warn' : 'radar-banner--clear',
      { 'radar-banner--elevated': props.elevated, 'radar-banner--expanded': props.expanded },
    ]"
    role="status"
    aria-live="polite"
  >
    <template v-if="count > 0">
      <i v-if="close" class="fa-solid fa-triangle-exclamation radar-alert-icon" aria-hidden="true"></i>
      <span v-if="close" class="radar-alert-text">{{ t('routes.radar_warning') }}</span>
      <span class="radar-cars" aria-hidden="true">
        <i v-for="n in iconCount" :key="n" class="fa-solid fa-car"></i>
        <span v-if="count > MAX_ICONS" class="radar-cars-more">·{{ count }}</span>
      </span>
      <span class="radar-dist">
        {{ Math.round(nearest!.distanceM) }}<small>m</small>
      </span>
    </template>
    <!-- Voie dégagée (radar connecté, aucune voiture) : bandeau vert vide, sans texte. -->
  </div>
</template>

<style scoped>
.radar-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  /* Au-dessus de la carte, sous le tiroir de commandes (déployé en bas, il ne monte
     jusqu'ici qu'en mode panneau). La notification de virage (.nav-turn, z-index 7) ne
     chevauche pas ce bandeau : quand le radar est visible, elle descend en dessous
     (.nav-turn--radar { top: 4.5rem }). */
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  /* Bandeau pleine largeur : plus aucun bouton d'angle fixe à éviter (ils sont dans
     le tiroir), on garde juste une marge confortable. */
  padding: 0.85rem 1.25rem;
  border-bottom-left-radius: 1rem;
  border-bottom-right-radius: 1rem;
  font-weight: 700;
  line-height: 1;
  font-size: 1.2rem;
  pointer-events: none;
}
/* En veille : au-dessus du voile noir (.nav-screen-off, z-index 20) pour rester visible. */
.radar-banner--elevated {
  z-index: 25;
}
/* Navigation libre en veille : aucune indication de virage à afficher, on transforme le
   bandeau en grande carte centrée qui occupe l'espace libre — lisible d'un coup d'œil. */
.radar-banner--expanded {
  top: 50%;
  left: 0.75rem;
  right: 0.75rem;
  transform: translateY(-50%);
  flex-direction: column;
  gap: 1.5rem;
  padding: 3rem 2rem;
  border-radius: 1.5rem;
  font-size: 2rem;
}
.radar-banner--expanded .radar-alert-icon { font-size: 5rem; }
.radar-banner--expanded .radar-alert-text { font-size: 2.4rem; }
.radar-banner--expanded .radar-cars { font-size: 4rem; }
.radar-banner--expanded .radar-cars-more { font-size: 2.5rem; }
.radar-banner--expanded .radar-dist { font-size: 5.5rem; }
.radar-banner--expanded .radar-dist small { font-size: 2rem; }
.radar-banner--danger {
  background: #dc3545;
  color: #fff;
}
.radar-banner--warn {
  background: #fd7e14;
  color: #fff;
}
/* Voie dégagée : bandeau vert plein, vide (aucun contenu). On garde une hauteur via
   min-height car il n'y a plus de texte pour imposer la hauteur du bandeau. */
.radar-banner--clear {
  background: #198754;
  min-height: 1.5rem;
}
/* L'icône d'alerte « Attention » clignote doucement pour attirer l'œil. */
.radar-alert-icon {
  font-size: 1.65rem;
  animation: radar-blink 0.9s ease-in-out infinite;
}
@keyframes radar-blink {
  50% { opacity: 0.35; }
}
.radar-alert-text {
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-size: 1.3rem;
}
.radar-cars {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 1.5rem;
}
.radar-cars-more {
  font-size: 1.25rem;
  margin-left: 0.1rem;
}
.radar-dist {
  font-size: 1.7rem;
}
.radar-dist small {
  font-size: 0.9rem;
  opacity: 0.85;
  margin-left: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .radar-alert-icon { animation: none; }
}
</style>
