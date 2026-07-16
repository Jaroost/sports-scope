<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, useTemplateRef, watch } from 'vue'
import { type PropType } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, MAP_STYLES, ROUTE_LINE_LAYOUT } from '../mapStyles'
import MapStyleDropdown from './MapStyleDropdown.vue'
import { activityIcon } from '../activityHelpers'

const props = defineProps({
  activities: { type: Array as PropType<Record<string, any>[]>, default: () => [] },
  localePrefix: { type: String, default: '' },
})

// Palette qualitative : une teinte par sortie (cyclée) pour distinguer les tracés
// qui se croisent. Lisible sur fond clair comme satellite.
const ROUTE_PALETTE = [
  '#f97316', '#2f8fed', '#16a34a', '#e0503f', '#9333ea',
  '#0891b2', '#ca8a04', '#db2777', '#4f46e5', '#65a30d',
]

// Imperative map state — non réactif (maplibre n'aime pas la réactivité profonde).
const mapEl = useTemplateRef('mapEl')
let mapInstance: any = null
let _maplibregl: any = null
let popup: any = null
// Sortie épinglée par un clic (popup ouverte) : le survol ne change pas la
// surbrillance tant qu'une popup est ouverte.
let pinnedId: number | null = null

const mapStyleId = ref(MAP_STYLES[0].id)

// Features prêtes pour la carte : uniquement les sorties avec un tracé exploitable.
// L'index sert à cycler la palette.
const features = computed(() =>
  props.activities
    .filter((a) => Array.isArray(a.map_polyline) && a.map_polyline.length >= 2)
    .map((a, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: a.map_polyline },
      properties: {
        id: a.id,
        name: a.name || '',
        type: a.type || '',
        dist: a.distance ?? null,
        gain: a.total_elevation_gain ?? null,
        date: a.start_date_local || '',
        color: ROUTE_PALETTE[i % ROUTE_PALETTE.length],
      },
    })),
)

const shownCount = computed(() => features.value.length)

function featureCollection() {
  return { type: 'FeatureCollection' as const, features: features.value }
}

function boundsOfAll(): [[number, number], [number, number]] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const f of features.value) {
    for (const [lng, lat] of f.geometry.coordinates as [number, number][]) {
      if (lng < minLng) minLng = lng
      if (lat < minLat) minLat = lat
      if (lng > maxLng) maxLng = lng
      if (lat > maxLat) maxLat = lat
    }
  }
  if (minLng === Infinity) return null
  return [[minLng, minLat], [maxLng, maxLat]]
}

// ─── Layers ────────────────────────────────────────────────────────────────
function installLayers() {
  if (!mapInstance) return
  mapInstance.addSource('activities', { type: 'geojson', data: featureCollection() })

  // Liseré sombre sous chaque tracé : détache les traits du fond de carte quel
  // qu'il soit (surtout les fonds clairs), pour qu'ils restent lisibles même quand
  // leur couleur est proche de celle du fond.
  mapInstance.addLayer({
    id: 'activities-casing',
    type: 'line',
    source: 'activities',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': 'rgba(0,0,0,0.45)', 'line-width': 6.5 },
  })
  // Tracés colorés.
  mapInstance.addLayer({
    id: 'activities-line',
    type: 'line',
    source: 'activities',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.95 },
  })
  // Surbrillance (survol / sélection) : liseré blanc + trait coloré plus épais,
  // filtrés sur l'id actif (aucun au départ).
  mapInstance.addLayer({
    id: 'activities-highlight-casing',
    type: 'line',
    source: 'activities',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': '#ffffff', 'line-width': 8 },
    filter: ['==', ['get', 'id'], -1],
  })
  mapInstance.addLayer({
    id: 'activities-highlight-line',
    type: 'line',
    source: 'activities',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 },
    filter: ['==', ['get', 'id'], -1],
  })
  // Couche de « touche » invisible et large, au-dessus : facilite le clic/survol
  // sur des tracés fins. Tous les événements y sont attachés.
  mapInstance.addLayer({
    id: 'activities-hit',
    type: 'line',
    source: 'activities',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': '#000000', 'line-width': 18, 'line-opacity': 0 },
  })

  mapInstance.on('mouseenter', 'activities-hit', () => {
    mapInstance.getCanvas().style.cursor = 'pointer'
  })
  mapInstance.on('mouseleave', 'activities-hit', () => {
    mapInstance.getCanvas().style.cursor = ''
    if (pinnedId == null) setHighlight(null)
  })
  mapInstance.on('mousemove', 'activities-hit', (e: any) => {
    if (pinnedId != null) return
    const f = e.features?.[0]
    if (f) setHighlight(f.properties.id)
  })
  mapInstance.on('click', 'activities-hit', (e: any) => {
    const f = e.features?.[0]
    if (f) openPopup(f.properties, e.lngLat)
  })
}

function setHighlight(id: number | null) {
  if (!mapInstance || !mapInstance.getLayer('activities-highlight-line')) return
  const filter = ['==', ['get', 'id'], id ?? -1]
  mapInstance.setFilter('activities-highlight-casing', filter)
  mapInstance.setFilter('activities-highlight-line', filter)
}

// ─── Popup ───────────────────────────────────────────────────────────────────
function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

function formatDate(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

function buildPopupHtml(p: any) {
  const km = p.dist ? `${(p.dist / 1000).toFixed(1)} km` : ''
  const gain = p.gain != null ? `+${Math.round(p.gain)} m` : ''
  const date = formatDate(p.date)
  const meta = [km, gain, date].filter(Boolean).join(' · ')
  const url = `${props.localePrefix}/activities/${p.id}`
  return `
    <div class="routes-popup">
      <div class="routes-popup-title">
        <i class="fa-solid ${activityIcon(p.type)}" aria-hidden="true"></i>
        <span>${esc(p.name)}</span>
      </div>
      ${meta ? `<div class="routes-popup-meta">${esc(meta)}</div>` : ''}
      <div class="routes-popup-actions">
        <a href="${url}" class="btn btn-sm btn-warning">
          <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${esc(t('routes.open'))}
        </a>
      </div>
    </div>`
}

function openPopup(p: any, lngLat: any) {
  pinnedId = p.id
  setHighlight(p.id)
  if (popup) popup.remove()
  popup = new _maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '260px' })
    .setLngLat(lngLat)
    .setHTML(buildPopupHtml(p))
    .addTo(mapInstance)
  popup.on('close', () => {
    pinnedId = null
    setHighlight(null)
  })
}

// ─── Style switch ────────────────────────────────────────────────────────────
function setMapStyle(id: string) {
  if (!mapInstance || id === mapStyleId.value) return
  mapStyleId.value = id
  // `diff: false` force un wipe complet — nos sources/couches appartiennent au
  // style et sont réinstallées à la volée.
  mapInstance.setStyle(mapStyleFor(id) as any, { diff: false })
  mapInstance.once('style.load', () => installLayers())
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function renderMap() {
  if (!mapEl.value || mapInstance) return
  const maplibregl = (await import('maplibre-gl')).default
  _maplibregl = maplibregl
  await import('maplibre-gl/dist/maplibre-gl.css')

  const bounds = boundsOfAll()
  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(mapStyleId.value) as any,
    bounds: (bounds ?? undefined) as any,
    fitBoundsOptions: { padding: 48 },
    center: bounds ? undefined : [6.14, 46.2],
    zoom: bounds ? undefined : 7,
  })
  mapInstance.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
  mapInstance.on('load', () => installLayers())
}

// Les sorties arrivent en asynchrone dans le parent : quand la liste change, on
// rafraîchit la source et on recadre.
watch(features, () => {
  if (!mapInstance) return
  const src = mapInstance.getSource('activities')
  if (src) src.setData(featureCollection())
  const b = boundsOfAll()
  if (b) mapInstance.fitBounds(b, { padding: 48, duration: 400 })
})

onMounted(() => renderMap())

onBeforeUnmount(() => {
  if (popup) { popup.remove(); popup = null }
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <div class="routes-map-wrap">
    <div ref="mapEl" class="routes-map"></div>
    <div class="routes-map-controls">
      <MapStyleDropdown :model-value="mapStyleId" @update:model-value="setMapStyle" />
    </div>
    <div v-if="shownCount === 0" class="routes-map-empty">
      <i class="fa-solid fa-map-location-dot" aria-hidden="true"></i>
      <span>{{ t('strava.map_empty') }}</span>
    </div>
    <span v-else class="routes-map-badge">{{ t('strava.map_count', { count: shownCount }) }}</span>
  </div>
</template>

<style scoped>
.routes-map-wrap {
  position: relative;
}
.routes-map {
  height: min(70vh, 640px);
  width: 100%;
  border-radius: 0.5rem;
  overflow: hidden;
}
.routes-map-controls {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
}
.routes-map-badge {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 5;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  pointer-events: none;
}
.routes-map-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--bs-secondary-color, #6c757d);
  pointer-events: none;
}
</style>

<!-- Popup construite via setHTML → hors du scope Vue, styles globaux. Dupliqués
     depuis RoutesOverviewMap car ce composant peut être monté seul (accueil). -->
<style>
.routes-popup .routes-popup-meta {
  color: #6c757d;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
  margin-bottom: 0.5rem;
}
.routes-popup .routes-popup-actions {
  display: flex;
  gap: 0.4rem;
}
.routes-popup .routes-popup-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
  margin-bottom: 0.15rem;
}
.routes-popup .routes-popup-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
</style>
