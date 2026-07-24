<script setup lang="ts">
import { formatDistancePrecise } from '../routeHelpers'

// Notification de proximité d'un point d'intérêt : bandeau compact posé en bas de
// l'écran, juste au-dessus de la barre de progression (NavStatsBar). Le pendant
// « POI » de la notification de virage (NavTurnBanner, en haut). La couleur reprend
// celle de la catégorie du POI ; le contenu : icône + nom + distance restante.
// screenOff : en veille, le bandeau doit passer au-dessus du voile noir (NavScreenOff,
// z-index 20) ET de la carte de col en veille (z-index 21) — d'où un z-index relevé.
defineProps<{
  poiHint: { name: string; icon: string; color: string; distM: number }
  screenOff?: boolean
}>()

// Un tap sur le bandeau bascule entre navigation et veille (comme la carte de col).
defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div class="nav-poi shadow" :class="{ 'nav-poi--sleep': screenOff }" :style="{ background: poiHint.color }" @click="$emit('toggle')">
    <i class="fa-solid nav-poi-icon" :class="poiHint.icon" aria-hidden="true"></i>
    <span class="nav-poi-info">
      <span class="nav-poi-name">{{ poiHint.name }}</span>
      <span class="nav-poi-dist">{{ formatDistancePrecise(poiHint.distM) }}</span>
    </span>
  </div>
</template>

<style scoped>
/* Bandeau POI : pleine largeur en bas, juste au-dessus de la barre de stats
   (nav-stats, bottom: 0.75rem, ~5rem de haut). z-index 7 : au-dessus de la barre de
   stats (z-index 6) — à hauteur égale elle l'emporterait (rendue après dans le DOM) et
   recouvrirait la notification, alors qu'on la veut « par-dessus la barre d'avancement ».
   Passe aussi au-dessus de TOUTE la couche de marqueurs de la carte (POI z1 … flèche z5),
   overlays DOM MapLibre remontés à la racine. Cliquable (cursor: pointer) : un tap
   bascule la veille. */
.nav-poi {
  /* --nav-bottom-inset (posé par RouteNavigation, hérité au travers des styles scopés)
     remonte le bandeau au-dessus du tiroir de commandes quand il est déployé en bas. */
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: calc(6rem + var(--nav-bottom-inset, 0rem));
  transition: bottom 0.28s ease;
  z-index: 7;
  display: flex; align-items: center; gap: 1rem;
  color: #fff; padding: 0.7rem 1.1rem; border-radius: 1rem;
  line-height: 1; cursor: pointer;
}
/* Veille : au-dessus du voile noir (NavScreenOff z-index 20) et de la carte de col en
   veille (.nav-climb--sleep z-index 21). En navigation normale, z-index 7 suffit (la
   carte de col vaut alors 6) ; ici on doit dépasser 21. */
.nav-poi--sleep { z-index: 22; }
.nav-poi-icon { font-size: 2rem; flex: 0 0 auto; }
.nav-poi-info {
  display: flex; flex-direction: column; gap: 0.2rem;
  min-width: 0;   /* autorise l'ellipse du nom dans le flex */
}
.nav-poi-name {
  font-size: 1.4rem; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nav-poi-dist { font-size: 1.1rem; font-weight: 600; opacity: 0.9; }
</style>
