<script setup lang="ts">
import { t } from '../i18n'
import MapStyleDropdown from './MapStyleDropdown.vue'
import { radarStore } from '../stores/radarStore'
import { radarSupported } from '../variaRadar'
import type { PoiCategory } from '../poiCategories'

const props = defineProps<{
  controlsVisible: boolean
  loggedIn: boolean
  debugMode: boolean
  mapStyleId: string
  soundOn: boolean
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
  dbgRadar: boolean
  dbgClimb: boolean
  // Libellé d'état du scénario de virage débug (ex. « Approche »), ou null quand off.
  dbgTurnLabel: string | null
  showCamPanel: boolean
  showPoiPanel: boolean
  showDebugPanel: boolean
}>()

const emit = defineEmits<{
  (e: 'arm-controls-hide'): void
  (e: 'set-map-style', id: string): void
  (e: 'toggle-sound'): void
  (e: 'toggle-radar'): void
  (e: 'pitch-input'): void
  (e: 'persist-pitch-terrain'): void
  (e: 'zoom-input'): void
  (e: 'save-zoom'): void
  (e: 'toggle-terrain'): void
  (e: 'toggle-poi', key: string): void
  (e: 'toggle-debug-radar'): void
  (e: 'toggle-debug-climb'): void
  (e: 'cycle-debug-turn'): void
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
</script>

<template>
  <!-- Panneau de commandes : glisse depuis le haut au swipe vers le bas. Regroupe
       TOUS les boutons (retour, profil, style de carte, son, radar, caméra, POI)
       pour libérer le haut de l'écran aux notifications pleine largeur (virage /
       radar). Masqué hors séance, rappelé par la zone de swipe. -->
  <div
    class="nav-controls-panel"
    :class="{ 'nav-controls-panel--hidden': !controlsVisible }"
    @pointerdown="$emit('arm-controls-hide')"
  >
    <div class="nav-panel-group">
      <a :href="`/routes`" class="btn btn-sm btn-light shadow-sm" :title="t('routes.back')" :aria-label="t('routes.back')">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
      </a>
      <button v-if="loggedIn" type="button" class="btn btn-sm btn-light shadow-sm" data-profile-trigger
        data-profile-sections="navigation,poi,climb"
        :title="t('nav.profile')" :aria-label="t('nav.profile')">
        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
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
        </div>
      </div>
    </div>
    <div class="nav-panel-group nav-panel-group--right">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="$emit('set-map-style', $event)" />
      <!-- Bouton « carte hors-ligne » (fourni par le parent : il a accès au token et à la géométrie). -->
      <slot name="map-extra" />
      <button
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :title="soundOn ? t('routes.sound_on') : t('routes.sound_off')"
        :aria-label="soundOn ? t('routes.sound_on') : t('routes.sound_off')"
        @click="$emit('toggle-sound')"
      >
        <i class="fa-solid" :class="soundOn ? 'fa-volume-high' : 'fa-volume-xmark'" aria-hidden="true"></i>
      </button>

      <button
        v-if="radarSupported()"
        type="button"
        class="btn btn-sm btn-light shadow-sm"
        :class="{ active: radarStore.isConnected.value, 'text-danger': radarStore.status.value === 'error' }"
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
          <label v-for="cat in poiCats" :key="cat.key" class="nav-cam-row nav-cam-row--switch">
            <span class="nav-cam-label nav-poi-label">
              <i class="fa-solid" :class="cat.icon" :style="{ color: cat.color }" aria-hidden="true"></i>
              {{ t(`profile.poi.${cat.labelKey}`) }}
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
  display: flex; align-items: flex-start; justify-content: space-between; gap: 0.6rem;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.94);
  border-bottom-left-radius: 1rem; border-bottom-right-radius: 1rem;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  transition: transform 0.28s ease, opacity 0.28s ease;
}
.nav-panel-group { display: flex; align-items: flex-start; gap: 0.6rem; }
.nav-panel-group--right { flex-wrap: wrap; justify-content: flex-end; }
/* Replié : le tiroir remonte hors champ et devient non cliquable (la zone de swipe
   prend le relais pour le rappeler). */
.nav-controls-panel--hidden {
  transform: translateY(-110%);
  opacity: 0;
  pointer-events: none;
}

/* Larger touch targets: these controls are tapped one-handed on a phone while
   riding. Min dimensions keep the icon-only buttons a comfortable ~3.25rem
   square while the map-style dropdown (which carries a text label on desktop)
   can still grow past it. */
.nav-controls-panel :deep(.btn) {
  min-width: 3.25rem; min-height: 3.25rem; padding: 0.5rem 0.75rem;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 1.35rem; border-radius: 0.7rem;
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

/* Panneau des filtres POI : même boîte que la caméra, lignes icône + libellé +
   interrupteur. Le libellé occupe la largeur disponible (textes longs : « Points
   de vue, sommets et cols »). */
.nav-poi-panel { width: 16rem; }
.nav-poi-panel .nav-cam-row + .nav-cam-row { margin-top: 0.6rem; }
.nav-poi-label {
  display: flex; align-items: center; gap: 0.55rem;
  width: auto; flex: 1; font-size: 0.9rem; line-height: 1.15;
}
.nav-poi-label i { width: 1.2rem; text-align: center; flex-shrink: 0; }

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
