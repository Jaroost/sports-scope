<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES, MAP_STYLE_GROUPS } from '../mapStyles'
import { radarStore } from '../stores/radarStore'
import { radarSupported } from '../variaRadar'
import type { PoiCategory } from '../poiCategories'

const props = defineProps<{
  controlsVisible: boolean
  screenOff?: boolean
  loggedIn: boolean
  debugMode: boolean
  mapStyleId: string
  soundOn: boolean
  soundVolume: number
  climbCardVisible?: boolean
  routeLoaded?: boolean
  canEdit?: boolean
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
  poiCounts: Record<string, number>
  poiLoading?: boolean
  poiBrowseCount?: number
  routeSearch?: boolean
  dbgRadar: boolean
  dbgClimb: boolean
  dbgPoi: boolean
  dbgTurnLabel: string | null
  // Panneau actif dans le tiroir ('route' | 'sound' | 'cam' | 'poi' | 'debug' | null).
  activePanel: string | null
}>()

const emit = defineEmits<{
  (e: 'arm-controls-hide'): void
  (e: 'open-route-picker'): void
  (e: 'unload-route'): void
  (e: 'toggle-edit'): void
  (e: 'set-map-style', id: string): void
  (e: 'toggle-sound'): void
  (e: 'update:soundVolume', v: number): void
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
  (e: 'update:activePanel', v: string | null): void
}>()

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

// Historique de navigation dans les panneaux : permet à « retour » de remonter à
// Settings plutôt qu'à la barre quand on navigue Settings → sous-panneau.
const prevPanel = ref<string | null>(null)

watch(() => props.activePanel, (val) => {
  if (val === null) prevPanel.value = null
})

function openSubPanel(panel: string) {
  prevPanel.value = props.activePanel
  emit('update:activePanel', panel)
}

function goBack() {
  const target = prevPanel.value
  prevPanel.value = null
  emit('update:activePanel', target)
}

const panelTitle = computed(() => {
  switch (props.activePanel) {
    case 'settings': return t('nav.settings')
    case 'route':    return t('routes.route_panel')
    case 'map':      return t('strava.map_style_label')
    case 'sound':    return t('routes.sound_settings')
    case 'cam':      return t('routes.camera_settings')
    case 'poi':      return t('routes.poi_settings')
    case 'debug':    return 'Débug navigation'
    default:         return ''
  }
})

const groupedStyles = computed(() =>
  MAP_STYLE_GROUPS
    .map(group => ({ group, styles: MAP_STYLES.filter(s => s.group === group) }))
    .filter(g => g.styles.length > 0),
)

const currentStyleIcon = computed(() =>
  MAP_STYLES.find(s => s.id === props.mapStyleId)?.icon ?? 'fa-map',
)
</script>

<template>
  <div
    class="nav-controls-panel"
    :class="{
      'nav-controls-panel--hidden': !controlsVisible,
      'nav-controls-panel--sleep': screenOff,
      'nav-controls-panel--panel': activePanel !== null,
    }"
    @pointerdown="$emit('arm-controls-hide')"
  >

    <!-- ── Mode panneau : contenu du panneau actif ──────────────────────────── -->
    <template v-if="activePanel !== null">
      <div class="nav-panel-header">
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :aria-label="t('routes.back')"
          @click="goBack()"
        >
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
        </button>
        <span class="nav-panel-title">{{ panelTitle }}</span>
      </div>

      <div class="nav-panel-body">

        <!-- Réglages -->
        <template v-if="activePanel === 'settings'">
          <button v-if="loggedIn" type="button" class="nav-setting-row" data-profile-trigger
            data-profile-sections="navigation,search,poi,climb">
            <i class="fa-solid fa-sliders nav-setting-icon" aria-hidden="true"></i>
            <span class="nav-setting-label">{{ t('nav.profile') }}</span>
            <i class="fa-solid fa-chevron-right nav-setting-chevron" aria-hidden="true"></i>
          </button>
          <button type="button" class="nav-setting-row" @click="openSubPanel('map')">
            <i class="fa-solid nav-setting-icon" :class="currentStyleIcon" aria-hidden="true"></i>
            <span class="nav-setting-label">{{ t('strava.map_style_label') }}</span>
            <span class="nav-setting-value">{{ t(`strava.map_style_${mapStyleId}`) }}</span>
            <i class="fa-solid fa-chevron-right nav-setting-chevron" aria-hidden="true"></i>
          </button>
          <button type="button" class="nav-setting-row" @click="openSubPanel('sound')">
            <i class="fa-solid nav-setting-icon" :class="soundOn ? 'fa-volume-high' : 'fa-volume-xmark'" aria-hidden="true"></i>
            <span class="nav-setting-label">{{ t('routes.sound_settings') }}</span>
            <span class="nav-setting-value">{{ soundOn ? Math.round(soundVolume) + '%' : t('routes.sound_muted') }}</span>
            <i class="fa-solid fa-chevron-right nav-setting-chevron" aria-hidden="true"></i>
          </button>
          <label v-if="climbCardVisible !== undefined" class="nav-setting-row">
            <i class="fa-solid fa-mountain nav-setting-icon" :class="{ 'nav-setting-icon--on': climbCardVisible }" aria-hidden="true"></i>
            <span class="nav-setting-label">{{ t('routes.climb_card_show') }}</span>
            <span class="form-check form-switch m-0">
              <input class="form-check-input nav-setting-switch" type="checkbox" role="switch"
                :checked="climbCardVisible" @change="$emit('toggle-climb-card')" />
            </span>
          </label>
          <button type="button" class="nav-setting-row" @click="openSubPanel('cam')">
            <i class="fa-solid fa-video nav-setting-icon" aria-hidden="true"></i>
            <span class="nav-setting-label">{{ t('routes.camera_settings') }}</span>
            <i class="fa-solid fa-chevron-right nav-setting-chevron" aria-hidden="true"></i>
          </button>
          <button type="button" class="nav-setting-row" @click="openSubPanel('poi')">
            <i class="fa-solid fa-location-dot nav-setting-icon" aria-hidden="true"></i>
            <span class="nav-setting-label">{{ t('routes.poi_settings') }}</span>
            <i class="fa-solid fa-chevron-right nav-setting-chevron" aria-hidden="true"></i>
          </button>
          <button v-if="debugMode" type="button" class="nav-setting-row" @click="openSubPanel('debug')">
            <i class="fa-solid fa-flask nav-setting-icon" aria-hidden="true"></i>
            <span class="nav-setting-label">Débug navigation</span>
            <i class="fa-solid fa-chevron-right nav-setting-chevron" aria-hidden="true"></i>
          </button>
        </template>

        <!-- Itinéraire -->
        <template v-else-if="activePanel === 'route'">
          <button type="button" class="nav-route-action" @click="$emit('open-route-picker')">
            <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
            <span>{{ t('routes.load_route') }}</span>
          </button>
          <button
            v-if="routeLoaded && canEdit"
            type="button"
            class="nav-route-action"
            :class="{ 'nav-route-action--active': editMode }"
            @click="$emit('toggle-edit')"
          >
            <i class="fa-solid" :class="editMode ? 'fa-check' : 'fa-pen'" aria-hidden="true"></i>
            <span>{{ editMode ? t('routes.edit_done') : t('routes.edit_route') }}</span>
          </button>
          <button
            v-if="routeLoaded"
            type="button"
            class="nav-route-action nav-route-action--danger"
            @click="$emit('unload-route')"
          >
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            <span>{{ t('routes.unload_route') }}</span>
          </button>
        </template>

        <!-- Fond de carte -->
        <template v-else-if="activePanel === 'map'">
          <template v-for="(g, gi) in groupedStyles" :key="g.group">
            <div :class="{ 'nav-mapstyle-group-sep': gi > 0 }">
              <div class="nav-mapstyle-group-label">{{ t(`strava.map_style_group_${g.group}`) }}</div>
              <button
                v-for="s in g.styles"
                :key="s.id"
                type="button"
                class="nav-route-action"
                :class="{ 'nav-route-action--active': mapStyleId === s.id }"
                @click="$emit('set-map-style', s.id); $emit('update:activePanel', null)"
              >
                <i class="fa-solid" :class="s.icon" aria-hidden="true"></i>
                <span>{{ t(`strava.map_style_${s.id}`) }}</span>
                <i v-if="mapStyleId === s.id" class="fa-solid fa-check ms-auto" aria-hidden="true"></i>
              </button>
            </div>
          </template>
        </template>

        <!-- Son -->
        <template v-else-if="activePanel === 'sound'">
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
        </template>

        <!-- Caméra -->
        <template v-else-if="activePanel === 'cam'">
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
        </template>

        <!-- POI -->
        <template v-else-if="activePanel === 'poi'">
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
            <span class="nav-poi-label">
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
        </template>

        <!-- Debug -->
        <template v-else-if="activePanel === 'debug'">
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
        </template>

      </div>
    </template>

    <!-- ── Mode barre : 4 boutons ──────────────────────────────────────────── -->
    <template v-else>
      <div class="nav-panel-group">
        <a :href="`/routes`" class="btn btn-sm btn-light shadow-sm" :title="t('routes.back')" :aria-label="t('routes.back')">
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
        </a>
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :class="{ 'nav-route-btn--loaded': routeLoaded }"
          :title="t('routes.route_panel')"
          :aria-label="t('routes.route_panel')"
          @click="$emit('update:activePanel', 'route')"
        >
          <i class="fa-solid fa-route" aria-hidden="true"></i>
        </button>
      </div>

      <div class="nav-panel-group nav-panel-group--right">
        <slot name="map-extra" />
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
        <button
          type="button"
          class="btn btn-sm btn-light shadow-sm"
          :title="t('nav.settings')"
          :aria-label="t('nav.settings')"
          @click="$emit('update:activePanel', 'settings')"
        >
          <i class="fa-solid fa-gear" aria-hidden="true"></i>
        </button>
      </div>
    </template>

  </div>
</template>

<style scoped>
.nav-controls-panel {
  position: absolute; top: 0; left: 0; right: 0; z-index: 8;
  display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.6rem;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.94);
  border-bottom-left-radius: 1rem; border-bottom-right-radius: 1rem;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  transition: transform 0.28s ease, opacity 0.28s ease;
}
.nav-panel-group { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.6rem; }
.nav-panel-group--right { flex: 1 1 auto; justify-content: flex-end; }
.nav-controls-panel--hidden {
  transform: translateY(-110%);
  opacity: 0;
  pointer-events: none;
}
.nav-controls-panel--sleep { z-index: 21; }

/* Mode panneau : le tiroir passe en colonne pour afficher le contenu du panneau actif. */
.nav-controls-panel--panel {
  flex-direction: column;
  flex-wrap: nowrap;
  justify-content: flex-start;
  align-items: stretch;
  gap: 0;
}

/* En-tête du panneau actif : flèche retour + titre. */
.nav-panel-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.nav-panel-title {
  font-size: 1rem;
  font-weight: 700;
  color: #343a40;
}

/* Corps du panneau : contenu pleine largeur, colonnes verticales. */
.nav-panel-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.nav-controls-panel :deep(.btn) {
  min-width: 3.25rem; min-height: 3.25rem; padding: 0.5rem 0.75rem;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 1.35rem; border-radius: 0.7rem;
}

.nav-radar-btn--connected,
.nav-radar-btn--connected:hover,
.nav-radar-btn--connected:focus,
.nav-radar-btn--connected:active,
.nav-climb-btn--visible,
.nav-climb-btn--visible:hover,
.nav-climb-btn--visible:focus,
.nav-climb-btn--visible:active {
  background-color: #198754 !important;
  border-color: #198754 !important;
  color: #fff !important;
}

/* Indicateur visuel : point vert en coin quand un itinéraire est chargé. */
.nav-route-btn--loaded {
  position: relative;
}
.nav-route-btn--loaded::after {
  content: '';
  position: absolute; top: 0.3rem; right: 0.3rem;
  width: 0.55rem; height: 0.55rem;
  border-radius: 50%; background: #198754;
  border: 2px solid #fff;
  pointer-events: none;
}

/* ── Contenu des panneaux (affiché pleine largeur dans le tiroir) ─────────── */

/* Lignes label + slider + valeur (caméra, son). */
.nav-cam-row {
  display: flex; align-items: center; gap: 0.65rem; margin: 0;
}
.nav-cam-label { font-size: 0.95rem; font-weight: 600; color: #495057; width: 6rem; flex-shrink: 0; }
.nav-cam-row .form-range { flex: 1; margin: 0; height: 1.6rem; }
.nav-cam-val { font-size: 0.95rem; font-weight: 700; width: 3rem; text-align: right; flex-shrink: 0; }
.nav-cam-row .form-range::-webkit-slider-thumb { width: 1.5rem; height: 1.5rem; }
.nav-cam-row .form-range::-moz-range-thumb { width: 1.5rem; height: 1.5rem; }
.nav-cam-row--switch .form-check-input { width: 3rem; height: 1.5rem; }

/* Bouton sauvegarder le zoom par défaut. */
.nav-cam-savezoom {
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  width: 100%; padding: 0.5rem 0.75rem;
  border: 1px solid #7c3aed; border-radius: 0.5rem;
  background: #fff; color: #7c3aed; font-size: 0.9rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s ease, color 0.12s ease;
}
.nav-cam-savezoom:hover { background: #f3effd; }
.nav-cam-savezoom--done { background: #198754; border-color: #198754; color: #fff; }

/* Panneau son : volume sur sa propre ligne pleine largeur. */
.nav-sound-vol { margin-top: 0.25rem; }
.nav-sound-vol-head {
  display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.5rem;
}
.nav-sound-vol-head .nav-cam-label { width: auto; }
.nav-sound-vol-head .nav-cam-val { width: auto; }
.nav-sound-range { width: 100%; margin: 0; height: 2.2rem; }
.nav-sound-range::-webkit-slider-thumb { width: 2rem; height: 2rem; }
.nav-sound-range::-moz-range-thumb { width: 2rem; height: 2rem; }

/* Panneau POI : boutons de recherche + liste de catégories. */
.nav-poi-search { margin-bottom: 0.25rem; font-weight: 600; }
.nav-poi-label {
  display: flex; align-items: center; gap: 0.55rem;
  flex: 1; font-size: 0.9rem; line-height: 1.15;
}
.nav-poi-label i { width: 1.2rem; text-align: center; flex-shrink: 0; }
.nav-poi-count {
  margin-left: auto; flex-shrink: 0;
  min-width: 1.5rem; padding: 0.05rem 0.4rem;
  border-radius: 999px; background: #e9ecef; color: #495057;
  font-size: 0.78rem; font-weight: 600; text-align: center;
}
.nav-poi-count--zero { opacity: 0.5; }

/* Panneau fond de carte : en-têtes de groupe + boutons de style. */
.nav-mapstyle-group-label {
  font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: #6c757d; margin-bottom: 0.4rem;
}
.nav-mapstyle-group-sep { margin-top: 0.75rem; }

/* Lignes du panneau Réglages (style iOS settings). */
.nav-setting-row {
  display: flex; align-items: center; gap: 0.75rem; width: 100%;
  padding: 0.65rem 0; border: none; background: none;
  border-bottom: 1px solid #f0f0f0; cursor: pointer; text-align: left;
  transition: background 0.1s ease;
}
.nav-setting-row:last-child { border-bottom: none; }
.nav-setting-row:hover { background: #f8f9fa; margin: 0 -1rem; padding-left: 1rem; padding-right: 1rem; width: calc(100% + 2rem); }
.nav-setting-icon {
  width: 1.6rem; height: 1.6rem; display: flex; align-items: center; justify-content: center;
  font-size: 0.95rem; color: #6c757d; flex-shrink: 0;
}
.nav-setting-icon--on { color: #198754; }
.nav-setting-label { flex: 1; font-size: 0.95rem; font-weight: 500; color: #212529; }
.nav-setting-value { font-size: 0.85rem; color: #6c757d; white-space: nowrap; }
.nav-setting-chevron { color: #ced4da; font-size: 0.8rem; flex-shrink: 0; }
.nav-setting-switch { width: 2.5rem !important; height: 1.35rem !important; }

/* Actions du panneau itinéraire. */
.nav-route-action {
  display: flex; align-items: center; gap: 0.6rem; width: 100%;
  padding: 0.6rem 0.75rem; border: 1px solid #dee2e6; border-radius: 0.5rem;
  background: #fff; color: #495057; font-size: 0.95rem; font-weight: 600;
  cursor: pointer; text-align: left;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.nav-route-action i { width: 1.2rem; text-align: center; flex-shrink: 0; }
.nav-route-action:hover { background: #f8f9fa; }
.nav-route-action--active { background: #ede7fb; border-color: #7c3aed; color: #5b21b6; }
.nav-route-action--active:hover { background: #e4d8f8; }
.nav-route-action--danger { color: #dc3545; border-color: #f5c2c7; }
.nav-route-action--danger:hover { background: #fff5f5; border-color: #dc3545; }

/* Boutons du panneau debug. */
.nav-debug-btn {
  display: flex; align-items: center; gap: 0.6rem; width: 100%;
  padding: 0.5rem 0.7rem; border: 1px solid #dee2e6; border-radius: 0.5rem;
  background: #fff; color: #495057; font-size: 0.95rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s ease, border-color 0.12s ease;
}
.nav-debug-btn i { width: 1.2rem; text-align: center; }
.nav-debug-state { margin-left: auto; font-size: 0.85rem; opacity: 0.7; }
.nav-debug-btn--on { background: #ede7fb; border-color: #7c3aed; color: #5b21b6; }
.nav-debug-btn--on .nav-debug-state { opacity: 1; }
</style>
