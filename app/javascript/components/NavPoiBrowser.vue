<script setup lang="ts">
import { t } from '../i18n'
import { formatDistancePrecise } from '../routeHelpers'

// Parcours des points d'intérêt : bandeau de pilotage posé en bas de l'écran (même
// emplacement/look que NavPoiBanner) pour enchaîner les POI trouvés, du plus proche au
// plus loin. La caméra vole sur chaque POI (géré par RouteNavigation) ; ce bandeau ne
// porte que les commandes : précédent / suivant, le POI courant (pastille + nom +
// distance depuis la position), un compteur i / n et un bouton de fermeture.
const props = defineProps<{
  place: { name: string; icon: string; color: string }
  distM: number
  index: number   // 0-based
  total: number
}>()

defineEmits<{ (e: 'prev'): void; (e: 'next'): void; (e: 'close'): void }>()
</script>

<template>
  <div class="nav-poi-browser shadow">
    <button
      type="button"
      class="nav-poi-browser-nav"
      :disabled="index <= 0"
      :title="t('routes.poi_browse_prev')"
      :aria-label="t('routes.poi_browse_prev')"
      @click="$emit('prev')"
    >
      <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
    </button>

    <div class="nav-poi-browser-body">
      <span class="nav-poi-browser-icon" :style="{ background: props.place.color }">
        <i class="fa-solid" :class="props.place.icon" aria-hidden="true"></i>
      </span>
      <span class="nav-poi-browser-info">
        <span class="nav-poi-browser-name">{{ props.place.name }}</span>
        <span class="nav-poi-browser-meta">
          {{ formatDistancePrecise(props.distM) }} · {{ index + 1 }} / {{ total }}
        </span>
      </span>
    </div>

    <button
      type="button"
      class="nav-poi-browser-nav"
      :disabled="index >= total - 1"
      :title="t('routes.poi_browse_next')"
      :aria-label="t('routes.poi_browse_next')"
      @click="$emit('next')"
    >
      <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
    </button>

    <button
      type="button"
      class="nav-poi-browser-close"
      :title="t('routes.close')"
      :aria-label="t('routes.close')"
      @click="$emit('close')"
    >
      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
    </button>
  </div>
</template>

<style scoped>
/* Bandeau de parcours : pleine largeur en bas, à la même hauteur que la notification de
   proximité (NavPoiBanner, bottom: 6rem) qu'il remplace pendant le parcours. z-index 7 :
   au-dessus de la barre de stats (6) et de TOUTE la couche de marqueurs de la carte. */
.nav-poi-browser {
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: 6rem;
  z-index: 7;
  display: flex; align-items: center; gap: 0.5rem;
  background: #fff; padding: 0.55rem 0.6rem; border-radius: 1rem;
}
/* Boutons précédent / suivant : cibles tactiles confortables (tap au pouce sur la route). */
.nav-poi-browser-nav,
.nav-poi-browser-close {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 3rem; height: 3rem; border: none; border-radius: 0.7rem;
  background: #f1f3f5; color: #343a40; font-size: 1.3rem; cursor: pointer;
}
.nav-poi-browser-nav:disabled { opacity: 0.35; cursor: default; }
.nav-poi-browser-close { background: transparent; font-size: 1.4rem; color: #868e96; }
.nav-poi-browser-body {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; gap: 0.7rem;
}
/* Pastille colorée reprenant la couleur de catégorie du POI (comme NavPoiBanner). */
.nav-poi-browser-icon {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.6rem; height: 2.6rem; border-radius: 50%;
  color: #fff; font-size: 1.3rem;
}
.nav-poi-browser-info {
  display: flex; flex-direction: column; gap: 0.15rem; min-width: 0;
}
.nav-poi-browser-name {
  font-size: 1.15rem; font-weight: 700; color: #212529;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nav-poi-browser-meta { font-size: 0.95rem; font-weight: 600; color: #6c757d; }
</style>
