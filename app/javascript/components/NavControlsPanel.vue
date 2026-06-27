<script setup lang="ts">
import { t } from '../i18n'
import MapStyleDropdown from './MapStyleDropdown.vue'
import { radarStore } from '../stores/radarStore'
import { radarSupported } from '../variaRadar'
import type { PoiCategory } from '../poiCategories'

const props = defineProps<{
  controlsVisible: boolean
  // En veille, le panneau doit passer au-dessus du voile noir (z 20) quand on l'ouvre.
  screenOff?: boolean
  loggedIn: boolean
  debugMode: boolean
  mapStyleId: string
  soundOn: boolean
  // Volume général des alertes (0–200 %), réglé en direct depuis le tiroir son.
  soundVolume: number
  showSoundPanel: boolean
  // Visibilité du profil des cols : undefined en mode libre (pas d'itinéraire → pas de
  // cols), auquel cas le bouton de bascule n'est pas affiché.
  climbCardVisible?: boolean
  // Vrai quand un itinéraire est chargé : affiche le bouton « ne plus suivre l'itinéraire ».
  routeLoaded?: boolean
  // Vrai quand l'itinéraire chargé porte ses points d'ancrage (éditable en séance).
  canEdit?: boolean
  // Mode édition de l'itinéraire actif : le bouton « modifier » passe en état « terminer ».
  editMode?: boolean
  radarKnown: boolean
  camPitch: number
  camZoom: number
  terrain3d: boolean
  zoomSaved: boolean
  camPitchMin: number
  camPitchMax: number
  camZoomMin: number
  camZoomMax: number
  poiCats: PoiCategory[]
  poiVisible: Record<string, boolean>
  // Nombre de lieux trouvés par catégorie à la dernière recherche (clé → compte).
  // Affiché à côté de chaque catégorie ; vide tant qu'aucune recherche n'a abouti.
  poiCounts: Record<string, number>
  // Recherche POI « autour de moi » en cours : grise le bouton et affiche un spinner.
  poiLoading?: boolean
  // Nombre de POI actuellement visibles (catégories non masquées) : active le bouton
  // « parcourir les POI ». Zéro → bouton désactivé (rien à parcourir).
  poiBrowseCount?: number
  // Vrai en navigation sur itinéraire (un tracé existe) : ajoute un bouton de recherche
  // POI le long du trajet, en plus de « autour de moi ». Absent en mode libre (pas de tracé).
  routeSearch?: boolean
  dbgRadar: boolean
  dbgClimb: boolean
  dbgPoi: boolean
  // Libellé d'état du scénario de virage débug (ex. « Approche »), ou null quand off.
  dbgTurnLabel: string | null
  showCamPanel: boolean
  showPoiPanel: boolean
  showDebugPanel: boolean
}>()

const emit = defineEmits<{
  (e: 'arm-controls-hide'): void
  (e: 'open-route-picker'): void
  (e: 'unload-route'): void
  (e: 'toggle-edit'): void
  (e: 'set-map-style', id: string): void
  (e: 'toggle-sound'): void
  (e: 'update:soundVolume', v: number): void
  (e: 'update:showSoundPanel', v: boolean): void
  (e: 'toggle-climb-card'): void
  (e: 'toggle-radar'): void
  (e: 'pitch-input'): void
  (e: 'persist-pitch-terrain'): void
  (e: 'zoom-input'): void
  (e: 'save-zoom'): void
  (e: 'toggle-terrain'): void
  (e: 'toggle-poi', key: string): void
  (e: 'search-pois'): void
  (e: 'search-pois-route'): void
  (e: 'browse-pois'): void
  (e: 'toggle-debug-radar'): void
  (e: 'toggle-debug-climb'): void
  (e: 'cycle-debug-turn'): void
  (e: 'toggle-debug-poi'): void
  (e: 'update:camPitch', v: number): void
  (e: 'update:camZoom', v: number): void
  (e: 'update:showCamPanel', v: boolean): void
  (e: 'update:showPoiPanel', v: boolean): void
  (e: 'update:showDebugPanel', v: boolean): void
}>()

// Curseur inclinaison : on remonte la valeur au parent (update:camPitch) puis on
// signale l'input — l'ordre fait que le parent lit déjà la valeur à jour.
function onPitch(e: Event) {
  emit('update:camPitch', Number((e.target as HTMLInputElement).value))
  emit('pitch-input')
}
function onZoom(e: Event) {
  emit('update:camZoom', Number((e.target as HTMLInputElement).value))
  emit('zoom-input')
}
function onVolume(e: Event) {
  emit('update:soundVolume', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <!-- Panneau de commandes : glisse depuis le haut au swipe vers le bas. Regroupe
       TOUS les boutons (retour, profil, style de carte, son, radar, caméra, POI)
       pour libérer le haut de l'écran aux notifications pleine largeur (virage /
       radar). Masqué hors séance, rappelé par la zone de swipe. -->
  <div
    class="nav-controls-panel"
    :class="{ 'nav-controls-panel--hidden': !controlsVisible, 'nav-controls-panel--sleep': screenOff }"
    @pointerdown="$emit('arm-controls-hide')"
  >
    <div class="nav-panel-group">
      <a :href="`/routes`" class="btn btn-sm btn-light shadow-sm" :title="t('routes.back')" :aria-label="t('routes.back')">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
      </a>
      <button v-if="loggedIn" type="button" class="btn btn-sm btn-light shadow-sm" data-profile-trigger
        data-profile-sections="navigation,search,poi,climb"
        :title="t('nav.profile')" :aria-label="t('nav.profile')">
        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
      </button>

      <!-- Ouvre la dialogue de chargement d'un itinéraire (itinéraires sauvegardés +
           « naviguer vers un lieu »). Passe la page en navigation sur itinéraire. -->
      <button
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :title="t('routes.load_route')"
        :aria-label="t('routes.load_route')"
        @click="$emit('open-route-picker')"
      >
        <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
      </button>

      <!-- Modifie l'itinéraire courant sans quitter la navigation (déplacement / ajout /
           suppression de points d'ancrage). Disponible si le tracé porte ses points. -->
      <button
        v-if="routeLoaded && canEdit"
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :class="{ active: editMode }"
        :title="editMode ? t('routes.edit_done') : t('routes.edit_route')"
        :aria-label="editMode ? t('routes.edit_done') : t('routes.edit_route')"
        @click="$emit('toggle-edit')"
      >
        <i class="fa-solid" :class="editMode ? 'fa-check' : 'fa-pen'" aria-hidden="true"></i>
      </button>

      <!-- Revient à la navigation libre : ne plus suivre l'itinéraire courant. -->
      <button
        v-if="routeLoaded"
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :title="t('routes.unload_route')"
        :aria-label="t('routes.unload_route')"
        @click="$emit('unload-route')"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>

      <!-- Panneau de débug (comptes pouvant tout faire, ou ?debug=1). Injecte des
           overlays factices pour les prévisualiser sans GPS / col / radar réels. -->
      <div v-if="debugMode" class="position-relative">
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :class="{ active: showDebugPanel }"
          title="Débug navigation"
          aria-label="Débug navigation"
          @click="$emit('update:showDebugPanel', !showDebugPanel)"
        >
          <i class="fa-solid fa-flask" aria-hidden="true"></i>
        </button>
        <div v-if="showDebugPanel" class="nav-cam-panel nav-debug-panel shadow">
          <div class="nav-debug-title">Débug navigation</div>
          <button type="button" class="nav-debug-btn" :class="{ 'nav-debug-btn--on': dbgRadar }" @click="$emit('toggle-debug-radar')">
            <i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i>
            <span>Radar</span>
            <span class="nav-debug-state">{{ dbgRadar ? 'on' : 'off' }}</span>
          </button>
          <button type="button" class="nav-debug-btn" :class="{ 'nav-debug-btn--on': dbgClimb }" @click="$emit('toggle-debug-climb')">
            <i class="fa-solid fa-mountain" aria-hidden="true"></i>
            <span>Col</span>
            <span class="nav-debug-state">{{ dbgClimb ? 'on' : 'off' }}</span>
          </button>
          <button type="button" class="nav-debug-btn" :class="{ 'nav-debug-btn--on': dbgTurnLabel != null }" @click="$emit('cycle-debug-turn')">
            <i class="fa-solid fa-arrow-turn-up" aria-hidden="true"></i>
            <span>Virage</span>
            <span class="nav-debug-state">{{ dbgTurnLabel ?? 'off' }}</span>
          </button>
          <button type="button" class="nav-debug-btn" :class="{ 'nav-debug-btn--on': dbgPoi }" @click="$emit('toggle-debug-poi')">
            <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
            <span>POI</span>
            <span class="nav-debug-state">{{ dbgPoi ? 'on' : 'off' }}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="nav-panel-group nav-panel-group--right">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="$emit('set-map-style', $event)" />
      <!-- Bouton « carte hors-ligne » (fourni par le parent : il a accès au token et à la géométrie). -->
      <slot name="map-extra" />
      <!-- Réglages son : ouvre un tiroir pour couper le son et régler le volume de
           TOUTES les alertes (virages + radar). L'icône reflète l'état muet / actif. -->
      <div class="position-relative">
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :class="{ active: showSoundPanel }"
          :title="t('routes.sound_settings')"
          :aria-label="t('routes.sound_settings')"
          @click="$emit('update:showSoundPanel', !showSoundPanel)"
        >
          <i class="fa-solid" :class="soundOn ? 'fa-volume-high' : 'fa-volume-xmark'" aria-hidden="true"></i>
        </button>
        <div v-if="showSoundPanel" class="nav-cam-panel nav-sound-panel shadow">
          <label class="nav-cam-row nav-cam-row--switch">
            <span class="nav-cam-label">{{ t('routes.sound_label') }}</span>
            <span class="form-check form-switch m-0">
              <input
                class="form-check-input"
                type="checkbox"
                role="switch"
                :checked="soundOn"
                @change="$emit('toggle-sound')"
              />
            </span>
          </label>
          <div class="nav-sound-vol">
            <div class="nav-sound-vol-head">
              <span class="nav-cam-label">{{ t('routes.sound_volume') }}</span>
              <span class="nav-cam-val">{{ Math.round(soundVolume) }}%</span>
            </div>
            <input
              type="range"
              class="form-range nav-sound-range"
              min="0" max="200" step="10"
              :value="soundVolume"
              :disabled="!soundOn"
              @input="onVolume"
            />
          </div>
        </div>
      </div>

      <!-- Affiche / masque le profil des cols (carte d'altitude en bas d'écran). Activé
           par défaut ; certains préfèrent dégager le bas de l'écran. -->
      <button
        v-if="climbCardVisible !== undefined"
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :class="{ active: climbCardVisible }"
        :title="climbCardVisible ? t('routes.climb_card_hide') : t('routes.climb_card_show')"
        :aria-label="climbCardVisible ? t('routes.climb_card_hide') : t('routes.climb_card_show')"
        @click="$emit('toggle-climb-card')"
      >
        <i class="fa-solid fa-mountain" aria-hidden="true"></i>
      </button>

      <button
        v-if="radarSupported()"
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :class="{ 'nav-radar-btn--connected': radarStore.isConnected.value, 'text-danger': radarStore.status.value === 'error' }"
        :disabled="radarStore.status.value === 'connecting'"
        :title="radarStore.isConnected.value ? t('routes.radar_disconnect') : radarKnown ? t('routes.radar_reconnect') : t('routes.radar_connect')"
        :aria-label="radarStore.isConnected.value ? t('routes.radar_disconnect') : radarKnown ? t('routes.radar_reconnect') : t('routes.radar_connect')"
        @click="$emit('toggle-radar')"
      >
        <i
          class="fa-solid"
          :class="radarStore.status.value === 'connecting' ? 'fa-spinner fa-spin' : 'fa-tower-broadcast'"
          aria-hidden="true"
        ></i>
      </button>

      <div class="position-relative">
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :class="{ active: showCamPanel }"
          :title="t('routes.camera_settings')"
          :aria-label="t('routes.camera_settings')"
          @click="$emit('update:showCamPanel', !showCamPanel)"
        >
          <i class="fa-solid fa-video" aria-hidden="true"></i>
        </button>
        <div v-if="showCamPanel" class="nav-cam-panel shadow">
          <label class="nav-cam-row">
            <span class="nav-cam-label">{{ t('routes.camera_pitch') }}</span>
            <input
              type="range"
              class="form-range"
              :min="camPitchMin" :max="camPitchMax" step="1"
              :value="camPitch"
              @input="onPitch"
              @change="$emit('persist-pitch-terrain')"
            />
            <span class="nav-cam-val">{{ Math.round(camPitch) }}°</span>
          </label>
          <label class="nav-cam-row">
            <span class="nav-cam-label">{{ t('routes.camera_zoom') }}</span>
            <input
              type="range"
              class="form-range"
              :min="camZoomMin" :max="camZoomMax" step="0.5"
              :value="camZoom"
              @input="onZoom"
            />
            <span class="nav-cam-val">{{ camZoom.toFixed(1) }}</span>
          </label>
          <button
            v-if="loggedIn"
            type="button"
            class="nav-cam-savezoom"
            :class="{ 'nav-cam-savezoom--done': zoomSaved }"
            @click="$emit('save-zoom')"
          >
            <i class="fa-solid" :class="zoomSaved ? 'fa-check' : 'fa-floppy-disk'" aria-hidden="true"></i>
            {{ zoomSaved ? t('routes.camera_zoom_saved') : t('routes.camera_save_zoom') }}
          </button>
          <label class="nav-cam-row nav-cam-row--switch">
            <span class="nav-cam-label">{{ t('routes.camera_3d') }}</span>
            <span class="form-check form-switch m-0">
              <input
                class="form-check-input"
                type="checkbox"
                role="switch"
                :checked="terrain3d"
                @change="$emit('toggle-terrain')"
              />
            </span>
          </label>
        </div>
      </div>

      <div class="position-relative">
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :class="{ active: showPoiPanel }"
          :title="t('routes.poi_settings')"
          :aria-label="t('routes.poi_settings')"
          @click="$emit('update:showPoiPanel', !showPoiPanel)"
        >
          <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
        </button>
        <div v-if="showPoiPanel" class="nav-cam-panel nav-poi-panel shadow">
          <!-- Recherche le long du tracé (rayon / catégories du profil), seulement en
               navigation sur itinéraire où une géométrie existe. Action principale,
               donc en tête du panneau. -->
          <button
            v-if="routeSearch"
            type="button"
            class="btn btn-sm btn-primary w-100 nav-poi-search"
            :disabled="poiLoading"
            @click="$emit('search-pois-route')"
          >
            <i
              class="fa-solid me-1"
              :class="poiLoading ? 'fa-spinner fa-spin' : 'fa-route'"
              aria-hidden="true"
            ></i>
            {{ t('routes.poi_search_route') }}
          </button>
          <!-- Charge les POI autour de la position courante (Overpass). Réutilisé en
               navigation sur itinéraire (re-recherche) et en mode libre (seul moyen
               de charger les POI, faute de tracé). -->
          <button
            type="button"
            class="btn btn-sm w-100 nav-poi-search"
            :class="routeSearch ? 'btn-outline-primary' : 'btn-primary'"
            :disabled="poiLoading"
            @click="$emit('search-pois')"
          >
            <i
              class="fa-solid me-1"
              :class="poiLoading ? 'fa-spinner fa-spin' : 'fa-location-crosshairs'"
              aria-hidden="true"
            ></i>
            {{ t('routes.poi_search_around') }}
          </button>
          <!-- Parcours des POI : enchaîne les lieux visibles, du plus proche au plus loin,
               en zoomant la carte sur chacun. Désactivé tant qu'aucun POI n'est visible. -->
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary w-100 nav-poi-search nav-poi-browse"
            :disabled="!poiBrowseCount"
            @click="$emit('browse-pois')"
          >
            <i class="fa-solid fa-binoculars me-1" aria-hidden="true"></i>
            {{ t('routes.poi_browse') }}
          </button>
          <label v-for="cat in poiCats" :key="cat.key" class="nav-cam-row nav-cam-row--switch">
            <span class="nav-cam-label nav-poi-label">
              <i class="fa-solid" :class="cat.icon" :style="{ color: cat.color }" aria-hidden="true"></i>
              {{ t(`profile.poi.${cat.labelKey}`) }}
              <span
                v-if="poiCounts[cat.key] != null"
                class="nav-poi-count"
                :class="{ 'nav-poi-count--zero': poiCounts[cat.key] === 0 }"
              >{{ poiCounts[cat.key] }}</span>
            </span>
            <span class="form-check form-switch m-0">
              <input
                class="form-check-input"
                type="checkbox"
                role="switch"
                :checked="poiVisible[cat.key]"
                @change="$emit('toggle-poi', cat.key)"
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Anchor the map-style menu to the button's right edge so it never overflows
   the screen on this full-width page. */
.nav-controls-panel :deep(.dropdown-menu) {
  right: 0;
  left: auto;
}

/* Panneau de commandes en tiroir : barre pleine largeur ancrée en haut, qui glisse
   depuis le bord supérieur. z-index 8 pour passer au-dessus du bandeau radar (5) et
   des notifications de virage (3) quand on le déploie. */
.nav-controls-panel {
  position: absolute; top: 0; left: 0; right: 0; z-index: 8;
  /* flex-wrap : sur un écran étroit (téléphone), le groupe de droite passe sous celui
     de gauche au lieu d'être poussé hors champ et masqué. */
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.6rem;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.94);
  border-bottom-left-radius: 1rem; border-bottom-right-radius: 1rem;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  transition: transform 0.28s ease, opacity 0.28s ease;
}
/* Les deux groupes enveloppent leurs boutons ; le groupe de droite occupe la largeur
   restante et reste aligné à droite (sur la même ligne ou rejeté sur la suivante). */
.nav-panel-group { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.6rem; }
.nav-panel-group--right { flex: 1 1 auto; justify-content: flex-end; }
/* Replié : le tiroir remonte hors champ et devient non cliquable (la zone de swipe
   prend le relais pour le rappeler). */
.nav-controls-panel--hidden {
  transform: translateY(-110%);
  opacity: 0;
  pointer-events: none;
}
/* En veille, le voile noir (NavScreenOff, z 20) recouvre tout : on remonte le tiroir
   au-dessus pour qu'il reste visible et cliquable quand on l'ouvre écran éteint. */
.nav-controls-panel--sleep { z-index: 21; }

/* Larger touch targets: these controls are tapped one-handed on a phone while
   riding. Min dimensions keep the icon-only buttons a comfortable ~3.25rem
   square while the map-style dropdown (which carries a text label on desktop)
   can still grow past it. */
.nav-controls-panel :deep(.btn) {
  min-width: 3.25rem; min-height: 3.25rem; padding: 0.5rem 0.75rem;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 1.35rem; border-radius: 0.7rem;
}

/* Radar connecté : bouton vert (au lieu du gris « active » de Bootstrap) pour
   signaler d'un coup d'œil que le flux de menaces est actif. !important pour
   l'emporter sur les états :hover/:focus de .btn-light. */
.nav-radar-btn--connected,
.nav-radar-btn--connected:hover,
.nav-radar-btn--connected:focus,
.nav-radar-btn--connected:active {
  background-color: #198754 !important;
  border-color: #198754 !important;
  color: #fff !important;
}

/* Small camera-settings popover anchored under its toggle button. The toggle lives
   in the controls drawer near the right edge, so anchor the panel to the button's
   right edge to keep it from overflowing off the right side of the screen. */
.nav-cam-panel {
  position: absolute; top: calc(100% + 0.4rem); right: 0; left: auto;
  z-index: 5; width: 18rem;
  background: #fff; border-radius: 0.7rem; padding: 0.9rem 1rem;
}
.nav-cam-row {
  display: flex; align-items: center; gap: 0.65rem; margin: 0;
}
.nav-cam-row + .nav-cam-row { margin-top: 0.85rem; }
.nav-cam-label { font-size: 0.95rem; font-weight: 600; color: #495057; width: 5.5rem; }
.nav-cam-row .form-range { flex: 1; margin: 0; height: 1.6rem; }
.nav-cam-val { font-size: 0.95rem; font-weight: 700; width: 3rem; text-align: right; }
/* Bigger thumb so the sliders are easy to drag with a thumb on the road. */
.nav-cam-row .form-range::-webkit-slider-thumb { width: 1.5rem; height: 1.5rem; }
.nav-cam-row .form-range::-moz-range-thumb { width: 1.5rem; height: 1.5rem; }
.nav-cam-row--switch .form-check-input { width: 3rem; height: 1.5rem; }
.nav-cam-savezoom {
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  width: 100%; margin-top: 0.85rem; padding: 0.5rem 0.75rem;
  border: 1px solid #7c3aed; border-radius: 0.5rem;
  background: #fff; color: #7c3aed; font-size: 0.9rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s ease, color 0.12s ease;
}
.nav-cam-savezoom:hover { background: #f3effd; }
.nav-cam-savezoom--done { background: #198754; border-color: #198754; color: #fff; }

/* Tiroir des réglages son : mute + volume. Le volume occupe sa propre ligne pleine
   largeur (label/valeur au-dessus, slider en dessous) pour offrir une grande course
   facile à viser au pouce sur la route. */
.nav-sound-panel { width: 15rem; }
.nav-sound-vol { margin-top: 0.9rem; }
.nav-sound-vol-head {
  display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.5rem;
}
.nav-sound-vol-head .nav-cam-label { width: auto; }
.nav-sound-vol-head .nav-cam-val { width: auto; }
/* Piste large et curseur surdimensionné : la course couvre toute la largeur du tiroir
   et la cible tactile est nettement plus grande que les sliders caméra. */
.nav-sound-range { width: 100%; margin: 0; height: 2.2rem; }
.nav-sound-range::-webkit-slider-thumb { width: 2rem; height: 2rem; }
.nav-sound-range::-moz-range-thumb { width: 2rem; height: 2rem; }

/* Panneau des filtres POI : même boîte que la caméra, lignes icône + libellé +
   interrupteur. Le libellé occupe la largeur disponible (textes longs : « Points
   de vue, sommets et cols »). */
.nav-poi-panel { width: 16rem; }
.nav-poi-panel .nav-cam-row + .nav-cam-row { margin-top: 0.6rem; }
/* Bouton « chercher autour de moi » en tête du panneau, séparé de la liste des filtres. */
.nav-poi-search { margin-bottom: 0.7rem; font-weight: 600; }
.nav-poi-label {
  display: flex; align-items: center; gap: 0.55rem;
  width: auto; flex: 1; font-size: 0.9rem; line-height: 1.15;
}
.nav-poi-label i { width: 1.2rem; text-align: center; flex-shrink: 0; }
/* Compteur de lieux trouvés, collé à droite du libellé (avant l'interrupteur). */
.nav-poi-count {
  margin-left: auto; flex-shrink: 0;
  min-width: 1.5rem; padding: 0.05rem 0.4rem;
  border-radius: 999px; background: #e9ecef; color: #495057;
  font-size: 0.78rem; font-weight: 600; text-align: center;
}
.nav-poi-count--zero { opacity: 0.5; }

/* Panneau de débug : titre + une ligne-bouton par overlay simulable. Ancré à GAUCHE
   (le bouton vit dans le groupe de gauche) : il s'ouvre vers la droite pour ne pas
   déborder du bord gauche de l'écran, contrairement aux autres popovers (caméra/POI). */
.nav-debug-panel { width: 14rem; left: 0; right: auto; }
.nav-debug-title {
  font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
  color: #6c757d; margin-bottom: 0.6rem;
}
.nav-debug-btn {
  display: flex; align-items: center; gap: 0.6rem; width: 100%;
  padding: 0.5rem 0.7rem; border: 1px solid #dee2e6; border-radius: 0.5rem;
  background: #fff; color: #495057; font-size: 0.95rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s ease, border-color 0.12s ease;
}
.nav-debug-btn + .nav-debug-btn { margin-top: 0.5rem; }
.nav-debug-btn i { width: 1.2rem; text-align: center; }
.nav-debug-state { margin-left: auto; font-size: 0.85rem; opacity: 0.7; }
.nav-debug-btn--on { background: #ede7fb; border-color: #7c3aed; color: #5b21b6; }
.nav-debug-btn--on .nav-debug-state { opacity: 1; }
</style>
