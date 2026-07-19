<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, useTemplateRef, watch } from 'vue'
import { type PropType } from 'vue'
import { t } from '../i18n'
import { mapStyleFor, MAP_STYLES, ROUTE_LINE_LAYOUT } from '../mapStyles'
import MapStyleDropdown from './MapStyleDropdown.vue'

const props = defineProps({
  routes: { type: Array as PropType<Record<string, any>[]>, default: () => [] },
  localePrefix: { type: String, default: '' },
})

// `select-route` : depuis la popup, on demande au parent de rebasculer sur la
// liste et de surligner l'itinéraire cliqué.
const emit = defineEmits<{ (e: 'select-route', id: number): void }>()

// Catégorie d'activité + icône associée — même logique que RoutesList.
function activityOf(a: unknown) {
  return a === 'mtb' || a === 'hiking' ? a : 'cycling'
}
function sportIcon(a: unknown) {
  const s = activityOf(a)
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// Palette qualitative : une teinte par itinéraire (cyclée) pour distinguer les
// tracés qui se croisent. Lisible sur fond clair comme satellite.
const ROUTE_PALETTE = [
  '#f97316', '#2f8fed', '#16a34a', '#e0503f', '#9333ea',
  '#0891b2', '#ca8a04', '#db2777', '#4f46e5', '#65a30d',
]

// Imperative map state — non réactif (maplibre n'aime pas la réactivité profonde).
const mapEl = useTemplateRef('mapEl')
let mapInstance: any = null
let _maplibregl: any = null
let popup: any = null
// Itinéraire épinglé par un clic (popup ouverte) : le survol ne change pas la
// surbrillance tant qu'une popup est ouverte.
let pinnedId: number | null = null

const mapStyleId = ref(MAP_STYLES[0].id)

// Features prêtes pour la carte : uniquement les itinéraires avec une polyligne
// exploitable. L'index sert à cycler la palette.
const features = computed(() =>
  props.routes
    .filter((r) => Array.isArray(r.map_polyline) && r.map_polyline.length >= 2)
    .map((r, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: r.map_polyline },
      properties: {
        id: r.id,
        name: r.name || '',
        dist: r.distance_m ?? null,
        gain: r.elevation_gain_m ?? null,
        token: r.share_token || '',
        activity: activityOf(r.activity),
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
  mapInstance.addSource('routes', { type: 'geojson', data: featureCollection() })

  // Liseré sombre sous chaque tracé : détache les traits du fond de carte quel
  // qu'il soit (surtout les fonds clairs), pour qu'ils restent lisibles même quand
  // leur couleur est proche de celle du fond.
  mapInstance.addLayer({
    id: 'routes-casing',
    type: 'line',
    source: 'routes',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': 'rgba(0,0,0,0.45)', 'line-width': 6.5 },
  })
  // Tracés colorés.
  mapInstance.addLayer({
    id: 'routes-line',
    type: 'line',
    source: 'routes',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.95 },
  })
  // Surbrillance (survol / sélection) : liseré blanc + trait coloré plus épais,
  // filtrés sur l'id actif (aucun au départ).
  mapInstance.addLayer({
    id: 'routes-highlight-casing',
    type: 'line',
    source: 'routes',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': '#ffffff', 'line-width': 8 },
    filter: ['==', ['get', 'id'], -1],
  })
  mapInstance.addLayer({
    id: 'routes-highlight-line',
    type: 'line',
    source: 'routes',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 },
    filter: ['==', ['get', 'id'], -1],
  })
  // Couche de « touche » invisible et large, au-dessus : facilite le clic/survol
  // sur des tracés fins. Tous les événements y sont attachés.
  mapInstance.addLayer({
    id: 'routes-hit',
    type: 'line',
    source: 'routes',
    layout: ROUTE_LINE_LAYOUT,
    paint: { 'line-color': '#000000', 'line-width': 18, 'line-opacity': 0 },
  })

  mapInstance.on('mouseenter', 'routes-hit', () => {
    mapInstance.getCanvas().style.cursor = 'pointer'
  })
  mapInstance.on('mouseleave', 'routes-hit', () => {
    mapInstance.getCanvas().style.cursor = ''
    if (pinnedId == null) setHighlight(null)
  })
  mapInstance.on('mousemove', 'routes-hit', (e: any) => {
    if (pinnedId != null) return
    const f = e.features?.[0]
    if (f) setHighlight(f.properties.id)
  })
  mapInstance.on('click', 'routes-hit', (e: any) => {
    const f = e.features?.[0]
    if (f) openPopup(f.properties, e.lngLat)
  })
}

function setHighlight(id: number | null) {
  if (!mapInstance || !mapInstance.getLayer('routes-highlight-line')) return
  const filter = ['==', ['get', 'id'], id ?? -1]
  mapInstance.setFilter('routes-highlight-casing', filter)
  mapInstance.setFilter('routes-highlight-line', filter)
}

// ─── Popup ───────────────────────────────────────────────────────────────────
function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}

function buildPopupHtml(p: any) {
  const km = p.dist ? `${(p.dist / 1000).toFixed(1)} km` : ''
  const gain = p.gain != null ? `+${Math.round(p.gain)} m` : ''
  const meta = [km, gain].filter(Boolean).join(' · ')
  const editUrl = `${props.localePrefix}/routes/${p.id}/edit`
  const navUrl = `${props.localePrefix}/routes/${esc(p.token)}/navigate`
  return `
    <div class="routes-popup">
      <div class="routes-popup-title">
        <i class="fa-solid ${sportIcon(p.activity)}" aria-hidden="true"></i>
        <span>${esc(p.name)}</span>
      </div>
      ${meta ? `<div class="routes-popup-meta">${esc(meta)}</div>` : ''}
      <div class="routes-popup-actions">
        <a href="${editUrl}" class="btn btn-sm btn-warning">
          <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> ${esc(t('routes.open'))}
        </a>
        <a href="${navUrl}" class="btn btn-sm btn-outline-primary">
          <i class="fa-solid fa-location-arrow" aria-hidden="true"></i> ${esc(t('routes.navigate'))}
        </a>
      </div>
      <button type="button" class="btn btn-sm btn-outline-secondary routes-popup-select js-select-in-list">
        <i class="fa-solid fa-list-ul" aria-hidden="true"></i> ${esc(t('routes.show_in_list'))}
      </button>
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
  // Le bouton « voir dans la liste » est du HTML injecté : on câble son clic à la
  // main pour remonter l'événement au parent (bascule d'onglet + surbrillance).
  popup.getElement()?.querySelector('.js-select-in-list')
    ?.addEventListener('click', () => emit('select-route', p.id))
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

// Les itinéraires arrivent en asynchrone dans le parent : quand la liste change,
// on rafraîchit la source et on recadre.
watch(features, () => {
  if (!mapInstance) return
  const src = mapInstance.getSource('routes')
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
      <span>{{ t('routes.map_empty') }}</span>
    </div>
    <span v-else class="routes-map-badge">{{ t('routes.map_count', { count: shownCount }) }}</span>
  </div>
</template>

<style scoped>
.routes-map-wrap {
  position: relative;
  /* Contexte d'empilement isolé : les z-index internes de la carte (contrôles,
     badge, canvas MapLibre) restent piégés ici et ne remontent pas dans la page.
     Sans ça, `.routes-map-controls` (z-index 5) rivalise avec le header sticky de
     la liste (`.activity-sticky-top`, z-index 5) et, à égalité, passe par-dessus le
     panneau de filtres à cause de l'ordre du DOM. */
  isolation: isolate;
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

<!-- Popup construite via setHTML → hors du scope Vue, styles globaux. -->
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
.routes-popup .routes-popup-select {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  width: 100%;
  margin-top: 0.4rem;
}
</style>
