<script setup lang="ts">
import { ref, computed } from 'vue'
import { t } from '../i18n'
import { formatDistancePrecise } from '../routeHelpers'

// Parcours des points d'intérêt : bandeau de pilotage posé en bas de l'écran (même
// emplacement/look que NavPoiBanner) pour enchaîner les POI trouvés, du plus proche au
// plus loin. La caméra vole sur chaque POI (géré par RouteNavigation) ; ce bandeau ne
// porte que les commandes : un sélecteur de catégorie (la pastille devient une liste
// déroulante), précédent / suivant, le POI courant (nom + distance depuis la position),
// un compteur i / n et un bouton de fermeture.
const props = defineProps<{
  place: { name: string; icon: string; color: string }
  distM: number
  index: number   // 0-based
  total: number
  // Catégories présentes dans la liste (pour le filtre), dans l'ordre du registre.
  cats: { key: string; icon: string; color: string; labelKey: string; count: number }[]
  // Catégorie filtrée, ou null = toutes.
  filter: string | null
}>()

const emit = defineEmits<{
  (e: 'prev'): void
  (e: 'next'): void
  (e: 'close'): void
  (e: 'set-filter', key: string | null): void
}>()

// Apparence de l'option « toutes les catégories » : icône générique distincte d'une
// catégorie précise, couleur neutre.
const ALL_ICON = 'fa-layer-group'
const ALL_COLOR = '#6b7280'

const open = ref(false)
// Catégorie sélectionnée (ou null) : pilote l'icône/couleur de la pastille déclencheuse.
const current = computed(() => props.cats.find((c) => c.key === props.filter) ?? null)
const triggerIcon = computed(() => current.value?.icon ?? ALL_ICON)
const triggerColor = computed(() => current.value?.color ?? ALL_COLOR)
// Total tous POI confondus (pour l'option « Tous » du menu).
const allCount = computed(() => props.cats.reduce((sum, c) => sum + c.count, 0))

function pick(key: string | null) {
  open.value = false
  emit('set-filter', key)
}
</script>

<template>
  <div class="nav-poi-browser shadow">
    <button
      type="button"
      class="nav-poi-browser-nav"
      :title="t('routes.poi_browse_prev')"
      :aria-label="t('routes.poi_browse_prev')"
      @click="$emit('prev')"
    >
      <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
    </button>

    <div class="nav-poi-browser-body">
      <!-- Pastille = sélecteur de catégorie (liste déroulante) : filtre les POI parcourus. -->
      <div class="nav-poi-browser-filter">
        <button
          type="button"
          class="nav-poi-browser-icon nav-poi-browser-icon--btn"
          :style="{ background: triggerColor }"
          :title="t('routes.poi_filter')"
          :aria-label="t('routes.poi_filter')"
          :aria-expanded="open"
          @click="open = !open"
        >
          <i class="fa-solid" :class="triggerIcon" aria-hidden="true"></i>
          <i class="fa-solid fa-caret-down nav-poi-browser-caret" aria-hidden="true"></i>
        </button>

        <ul v-if="open" class="nav-poi-browser-menu shadow">
          <li>
            <button
              type="button"
              class="nav-poi-browser-menu-item"
              :class="{ 'is-active': filter === null }"
              @click="pick(null)"
            >
              <span class="nav-poi-browser-menu-icon" :style="{ background: ALL_COLOR }">
                <i class="fa-solid" :class="ALL_ICON" aria-hidden="true"></i>
              </span>
              <span class="nav-poi-browser-menu-label">{{ t('routes.poi_filter_all') }}</span>
              <span class="nav-poi-browser-menu-count">{{ allCount }}</span>
            </button>
          </li>
          <li v-for="c in cats" :key="c.key">
            <button
              type="button"
              class="nav-poi-browser-menu-item"
              :class="{ 'is-active': filter === c.key }"
              @click="pick(c.key)"
            >
              <span class="nav-poi-browser-menu-icon" :style="{ background: c.color }">
                <i class="fa-solid" :class="c.icon" aria-hidden="true"></i>
              </span>
              <span class="nav-poi-browser-menu-label">{{ t(`profile.poi.${c.labelKey}`) }}</span>
              <span class="nav-poi-browser-menu-count">{{ c.count }}</span>
            </button>
          </li>
        </ul>
      </div>

      <span class="nav-poi-browser-info">
        <span class="nav-poi-browser-name">
          <i
            class="fa-solid nav-poi-browser-name-icon"
            :class="props.place.icon"
            :style="{ color: props.place.color }"
            aria-hidden="true"
          ></i>
          {{ props.place.name }}
        </span>
        <span class="nav-poi-browser-meta">
          {{ formatDistancePrecise(props.distM) }} · {{ index + 1 }} / {{ total }}
        </span>
      </span>
    </div>

    <button
      type="button"
      class="nav-poi-browser-nav"
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

    <!-- Voile transparent : un tap hors du menu le referme (mobile, pas de blur fiable). -->
    <div v-if="open" class="nav-poi-browser-backdrop" @click="open = false"></div>
  </div>
</template>

<style scoped>
/* Bandeau de parcours : pleine largeur, collé TOUT EN BAS — pendant le parcours il est le
   seul habitant du bas de l'écran (la barre d'avancement / vitesse est escamotée, cf.
   RouteNavigation) et c'est lui qu'on pilote au pouce. z-index 9 : au-dessus de la zone de
   geste d'ouverture du tiroir (8), qui couvre justement cette bande — sans quoi ses
   boutons et son menu de catégories ne recevraient plus les taps. */
.nav-poi-browser {
  /* --nav-bottom-inset (posé par RouteNavigation, hérité au travers des styles scopés)
     remonte le bandeau au-dessus du tiroir de commandes quand il est déployé en bas. */
  position: absolute; left: 0.75rem; right: 0.75rem; bottom: calc(0.75rem + var(--nav-bottom-inset, 0rem));
  transition: bottom 0.28s ease;
  z-index: 9;
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
/* Conteneur du sélecteur : ancre le menu déroulant au-dessus de la pastille. */
.nav-poi-browser-filter { position: relative; flex: 0 0 auto; }
/* Pastille colorée reprenant la couleur de catégorie du POI (comme NavPoiBanner). */
.nav-poi-browser-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.6rem; height: 2.6rem; border-radius: 50%;
  color: #fff; font-size: 1.3rem;
}
/* Variante bouton : la pastille devient cliquable (ouvre le filtre), avec un petit chevron. */
.nav-poi-browser-icon--btn {
  position: relative; border: none; cursor: pointer; padding: 0;
}
.nav-poi-browser-caret {
  position: absolute; right: -0.05rem; bottom: -0.05rem;
  font-size: 0.7rem; color: #fff;
  background: rgba(0, 0, 0, 0.35); border-radius: 50%;
  width: 1rem; height: 1rem;
  display: inline-flex; align-items: center; justify-content: center;
}
/* Menu déroulant : remonte au-dessus de la pastille (bandeau collé en bas d'écran). */
.nav-poi-browser-menu {
  position: absolute; left: 0; bottom: calc(100% + 0.5rem);
  z-index: 9;
  margin: 0; padding: 0.3rem; list-style: none;
  background: #fff; border-radius: 0.8rem;
  min-width: 13rem; max-height: 50vh; overflow-y: auto;
}
.nav-poi-browser-menu-item {
  width: 100%; border: none; background: transparent; cursor: pointer;
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.45rem 0.5rem; border-radius: 0.6rem;
  font-size: 1.02rem; color: #212529; text-align: left;
}
.nav-poi-browser-menu-item.is-active { background: #f1f3f5; font-weight: 700; }
.nav-poi-browser-menu-icon {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.9rem; height: 1.9rem; border-radius: 50%;
  color: #fff; font-size: 0.95rem;
}
.nav-poi-browser-menu-label {
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nav-poi-browser-menu-count {
  flex: 0 0 auto; font-size: 0.9rem; font-weight: 600; color: #6c757d;
}
/* Voile de fermeture : couvre tout l'écran, sous le menu (9) mais au-dessus du reste. */
.nav-poi-browser-backdrop { position: fixed; inset: 0; z-index: 8; background: transparent; }
.nav-poi-browser-info {
  display: flex; flex-direction: column; gap: 0.15rem; min-width: 0;
}
.nav-poi-browser-name {
  font-size: 1.15rem; font-weight: 700; color: #212529;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Icône du type de POI courant, juste avant son nom (couleur de la catégorie). */
.nav-poi-browser-name-icon { margin-right: 0.4rem; }
.nav-poi-browser-meta { font-size: 0.95rem; font-weight: 600; color: #6c757d; }
</style>
