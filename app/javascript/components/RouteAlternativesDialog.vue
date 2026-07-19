<script setup lang="ts">
// Dialogue de comparaison des variantes d'un tronçon. Rejoue le tronçon actuel (en
// référence, tracé neutre) et les variantes BRouter (colorées) sur une carte MapLibre
// dédiée. Un clic sur une variante ouvre une infobulle (distance, dénivelé, écarts) avec
// un bouton « Choisir » qui émet `select`. Le montage/démontage de la carte suit le
// cycle de vie du composant (la modale est montée via v-if côté parent).
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor } from '../mapStyles'
import { formatDistancePrecise, formatDistanceShort } from '../routeHelpers'
import type { Coord } from '../routeHelpers'

interface AltView {
  idx: number
  coords: Coord[]
  distanceM: number
  gainM: number
  lossM: number
  color: string
  deltaDistanceM: number
  deltaGainM: number
}

const props = defineProps<{
  alternatives: AltView[]
  currentCoords: Coord[]
  mapStyleId: string
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  select: [altId: number]
}>()

const mapEl = ref<HTMLElement | null>(null)
const hoveredId = ref<number | null>(null)

// Instance MapLibre + module (chargés dynamiquement, comme la carte principale).
let mapInstance: any = null
let _maplibregl: any = null
let mapReady = false
let popup: any = null
let activeStateId: number | null = null

const CURRENT_COLOR = '#64748b' // gris ardoise : le tronçon actuel, en référence

// Écart d'une variante vs le tronçon actuel, avec signe explicite (± quand nul).
function fmtDelta(m: number, kind: 'dist' | 'elev'): string {
  const sign = m > 0 ? '+' : m < 0 ? '−' : '±'
  const abs = Math.abs(Math.round(m))
  return kind === 'elev' ? `${sign}${abs} m` : `${sign}${formatDistanceShort(abs)}`
}

async function initMap() {
  if (!mapEl.value) return
  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')
  _maplibregl = maplibregl
  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(props.mapStyleId) as any,
    center: [8.23, 46.8],
    zoom: 7,
    attributionControl: false,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showZoom: false }), 'top-right')
  mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }))
  mapInstance.on('styleimagemissing', (e: any) => {
    mapInstance.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
  })
  mapInstance.on('load', () => {
    installLayers()
    mapReady = true
    renderAlternatives()
    mapInstance.resize()
  })
}

function installLayers() {
  // Tronçon actuel : trait pointillé neutre, sous les variantes (référence visuelle).
  mapInstance.addSource('alt-current', { type: 'geojson', data: emptyFeature() })
  mapInstance.addLayer({
    id: 'alt-current-line', type: 'line', source: 'alt-current',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': CURRENT_COLOR, 'line-width': 4, 'line-dasharray': [1.6, 1.4], 'line-opacity': 0.9 },
  })
  // Variantes : bordure sombre + trait coloré ; la variante survolée/active est élargie
  // via l'état de feature `active`.
  mapInstance.addSource('alt-variants', { type: 'geojson', data: emptyCollection() })
  mapInstance.addLayer({
    id: 'alt-variants-border', type: 'line', source: 'alt-variants',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': 'rgba(0,0,0,0.45)', 'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 12, 9] },
  })
  mapInstance.addLayer({
    id: 'alt-variants-line', type: 'line', source: 'alt-variants',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 7.5, 5],
      'line-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 1, 0.85],
    },
  })
  mapInstance.on('mousemove', 'alt-variants-line', onLineMove)
  mapInstance.on('mouseleave', 'alt-variants-line', onLineLeave)
  mapInstance.on('click', 'alt-variants-line', onLineClick)
}

function emptyFeature() {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } } as any
}
function emptyCollection() {
  return { type: 'FeatureCollection', features: [] } as any
}

// (Re)pose le tronçon actuel + les variantes et recadre la carte sur l'ensemble.
function renderAlternatives() {
  if (!mapReady || !mapInstance) return
  closePopup()
  setActive(null)

  const cur = mapInstance.getSource('alt-current')
  if (cur) {
    cur.setData({
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: props.currentCoords.map(([lng, lat]) => [lng, lat]) },
    })
  }

  const variants = mapInstance.getSource('alt-variants')
  if (variants) {
    variants.setData({
      type: 'FeatureCollection',
      features: props.alternatives.map((alt, i) => ({
        type: 'Feature', id: i,
        properties: { altId: i, color: alt.color },
        geometry: { type: 'LineString', coordinates: alt.coords.map(([lng, lat]) => [lng, lat]) },
      })),
    })
  }

  fitToAll()
}

function fitToAll() {
  const all: [number, number][] = []
  for (const [lng, lat] of props.currentCoords) all.push([lng, lat])
  for (const alt of props.alternatives) for (const [lng, lat] of alt.coords) all.push([lng, lat])
  if (all.length < 2) return
  const bounds = new _maplibregl.LngLatBounds(all[0], all[0])
  for (const c of all) bounds.extend(c)
  mapInstance.fitBounds(bounds, { padding: 60, duration: 0 })
}

function setActive(id: number | null) {
  if (!mapInstance) return
  if (activeStateId != null) mapInstance.setFeatureState({ source: 'alt-variants', id: activeStateId }, { active: false })
  activeStateId = id
  if (id != null) mapInstance.setFeatureState({ source: 'alt-variants', id }, { active: true })
  hoveredId.value = id
}

function onLineMove(e: any) {
  const f = e.features?.[0]
  if (!f) return
  mapInstance.getCanvas().style.cursor = 'pointer'
  const id = f.properties?.altId ?? null
  if (id !== activeStateId) setActive(id)
}

function onLineLeave() {
  mapInstance.getCanvas().style.cursor = ''
  if (!popup) setActive(null)
}

function onLineClick(e: any) {
  const f = e.features?.[0]
  if (!f) return
  const id = f.properties?.altId ?? 0
  openPopup(id, [e.lngLat.lng, e.lngLat.lat])
}

// Ouvre l'infobulle d'une variante (stats + écarts + bouton « Choisir »). `at` est le
// point d'ancrage : le point cliqué sur la carte, ou le milieu de la variante depuis la
// légende.
function openPopup(id: number, at: [number, number]) {
  const alt = props.alternatives[id]
  if (!alt || !mapInstance) return
  setActive(id)
  closePopup()

  const wrap = document.createElement('div')
  wrap.className = 'raltd-popup'
  const deltaDistClass = alt.deltaDistanceM <= 0 ? 'raltd-pos' : 'raltd-neg'
  const deltaGainClass = alt.deltaGainM <= 0 ? 'raltd-pos' : 'raltd-neg'
  wrap.innerHTML = `
    <div class="raltd-popup-head">
      <span class="raltd-swatch" style="background:${alt.color}"></span>
      <strong>${t('routes.alternatives_variant', { n: id + 1 })}</strong>
    </div>
    <div class="raltd-popup-row">
      <i class="fa-solid fa-ruler-horizontal"></i>
      <span>${formatDistancePrecise(alt.distanceM)}</span>
      <span class="raltd-delta ${deltaDistClass}">${fmtDelta(alt.deltaDistanceM, 'dist')}</span>
    </div>
    <div class="raltd-popup-row">
      <i class="fa-solid fa-arrow-trend-up"></i>
      <span>+${Math.round(alt.gainM)} m</span>
      <span class="raltd-delta ${deltaGainClass}">${fmtDelta(alt.deltaGainM, 'elev')}</span>
    </div>
    <button type="button" class="raltd-choose">${t('routes.apply_alternative')}</button>`
  wrap.querySelector('.raltd-choose')?.addEventListener('click', () => emit('select', id))

  popup = new _maplibregl.Popup({ offset: 16, closeButton: true, closeOnClick: false, className: 'raltd-popup-container' })
    .setLngLat(at)
    .setDOMContent(wrap)
    .addTo(mapInstance)
  popup.on('close', () => { popup = null; setActive(null) })
}

function closePopup() {
  if (popup) { const p = popup; popup = null; p.remove() }
}

// Légende : survol → surligne la variante ; clic → ouvre son infobulle en son milieu.
function onChipEnter(id: number) { if (!popup) setActive(id) }
function onChipLeave() { if (!popup) setActive(null) }
function onChipClick(id: number) {
  const alt = props.alternatives[id]
  if (!alt || !alt.coords.length) return
  const mid = alt.coords[Math.floor(alt.coords.length / 2)]
  openPopup(id, [mid[0], mid[1]])
}

function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }

// Recadre / re-pose dès que les variantes arrivent (la modale s'ouvre pendant le
// chargement, la carte est déjà montée).
watch(() => props.alternatives, () => renderAlternatives(), { deep: false })

onMounted(() => {
  initMap()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  closePopup()
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <div class="raltd-backdrop" @click.self="emit('close')">
    <div class="raltd-dialog shadow-lg">
      <div class="raltd-header">
        <span class="raltd-title">
          <i class="fa-solid fa-code-branch me-1" aria-hidden="true"></i>
          {{ t('routes.alternatives_title') }}
        </span>
        <button type="button" class="raltd-close" :aria-label="t('routes.close')" @click="emit('close')">×</button>
      </div>

      <div class="raltd-body">
        <div class="raltd-map-wrap">
          <div ref="mapEl" class="raltd-map"></div>

          <div v-if="loading" class="raltd-overlay">
            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
            {{ t('routes.alternatives_loading') }}
          </div>
          <div v-else-if="error" class="raltd-overlay text-danger">
            {{ error }}
          </div>
          <div v-else-if="!alternatives.length" class="raltd-overlay">
            {{ t('routes.alternatives_none') }}
          </div>
        </div>

        <div v-if="!loading && !error && alternatives.length" class="raltd-legend">
          <span class="raltd-hint">{{ t('routes.alternatives_hint') }}</span>
          <div class="raltd-chips">
            <span class="raltd-chip raltd-chip--current">
              <span class="raltd-swatch raltd-swatch--dashed"></span>
              {{ t('routes.alternatives_current') }}
            </span>
            <button
              v-for="(alt, i) in alternatives"
              :key="alt.idx"
              type="button"
              class="raltd-chip"
              :class="{ 'raltd-chip--active': hoveredId === i }"
              @mouseenter="onChipEnter(i)"
              @mouseleave="onChipLeave"
              @click="onChipClick(i)"
            >
              <span class="raltd-swatch" :style="{ background: alt.color }"></span>
              {{ t('routes.alternatives_variant', { n: i + 1 }) }}
              <span class="raltd-chip-delta" :class="alt.deltaDistanceM <= 0 ? 'raltd-pos' : 'raltd-neg'">
                {{ fmtDelta(alt.deltaDistanceM, 'dist') }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.raltd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.raltd-dialog {
  background: #fff;
  border-radius: 0.75rem;
  width: min(1280px, 96vw);
  height: min(860px, 92vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.raltd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid #e5e7eb;
  flex: none;
}
.raltd-title { font-weight: 600; }
.raltd-close {
  border: none;
  background: transparent;
  font-size: 1.5rem;
  line-height: 1;
  color: #6b7280;
  cursor: pointer;
  padding: 0 0.25rem;
}
.raltd-close:hover { color: #111827; }
.raltd-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.raltd-map-wrap {
  position: relative;
  flex: 1;
  min-height: 260px;
}
.raltd-map { position: absolute; inset: 0; }
.raltd-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.82);
  font-size: 0.95rem;
  color: #374151;
  z-index: 1;
}
.raltd-legend {
  flex: none;
  padding: 0.7rem 1rem 0.9rem;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
}
.raltd-hint {
  display: block;
  font-size: 0.8rem;
  color: #6b7280;
  margin-bottom: 0.5rem;
}
.raltd-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.raltd-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 999px;
  padding: 0.3rem 0.7rem;
  font-size: 0.85rem;
  color: #111827;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.raltd-chip:hover, .raltd-chip--active {
  border-color: #0096c7;
  box-shadow: 0 0 0 1px #0096c7;
}
.raltd-chip--current { cursor: default; color: #6b7280; }
.raltd-chip--current:hover { border-color: #d1d5db; box-shadow: none; }
.raltd-chip-delta { font-weight: 600; }
.raltd-swatch {
  width: 14px;
  height: 4px;
  border-radius: 2px;
  display: inline-block;
}
.raltd-swatch--dashed {
  background: repeating-linear-gradient(90deg, #64748b 0 4px, transparent 4px 7px);
}
.raltd-pos { color: #16a34a; }
.raltd-neg { color: #6b7280; }

/* Sur téléphone : plein écran pour laisser la carte respirer et faciliter le clic. */
@media (max-width: 640px) {
  .raltd-backdrop { padding: 0; }
  .raltd-dialog {
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
  .raltd-legend { padding: 0.6rem 0.8rem 0.75rem; }
  .raltd-hint { margin-bottom: 0.4rem; }
}
</style>

<!-- Styles de l'infobulle MapLibre : non-scoped car son DOM est créé dynamiquement et
     injecté hors de l'arbre scopé du composant. -->
<style>
.raltd-popup-container .maplibregl-popup-content {
  border-radius: 0.6rem;
  padding: 0.7rem 0.85rem;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.raltd-popup { min-width: 168px; font-size: 0.85rem; color: #111827; }
.raltd-popup-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.5rem;
}
.raltd-popup-head .raltd-swatch { width: 16px; height: 5px; border-radius: 2px; }
.raltd-popup-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.3rem;
}
.raltd-popup-row i { width: 1rem; color: #6b7280; text-align: center; }
.raltd-popup .raltd-delta { margin-left: auto; font-weight: 600; }
.raltd-popup .raltd-pos { color: #16a34a; }
.raltd-popup .raltd-neg { color: #6b7280; }
.raltd-choose {
  margin-top: 0.55rem;
  width: 100%;
  border: none;
  border-radius: 0.45rem;
  background: #0096c7;
  color: #fff;
  font-weight: 600;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
}
.raltd-choose:hover { background: #007ea7; }
</style>
