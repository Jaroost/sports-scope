<script setup lang="ts">
// Fond de carte de l'aperçu, sur la page de partage publique. L'îlot se monte sur le
// bloc qui contient déjà l'aperçu SVG rendu par le serveur : celui-ci reste le repli
// pour les crawlers d'aperçu des messageries (qui n'exécutent pas de JS) et le temps
// que MapLibre se charge.
//
// Carte volontairement non interactive : c'est une vignette dans une page qui défile,
// pas un outil. Le tracé complet est visible d'emblée, et sur téléphone le doigt fait
// défiler la page au lieu de déplacer la carte.
import { onMounted, onBeforeUnmount, useTemplateRef } from 'vue'
import { type PropType } from 'vue'
import { mapStyleFor, ROUTE_LINE_LAYOUT } from '../mapStyles'

const props = defineProps({
  // Polyligne simplifiée `[[lng, lat], ...]` (routes.map_polyline), passée en props
  // plutôt que rechargée : elle est déjà en base, sous-échantillonnée pour être légère.
  polyline: { type: Array as PropType<[number, number][]>, default: () => [] },
  // Fond de carte : les sentiers se lisent mieux sur le fond topo, les routes sur CyclOSM.
  styleId: { type: String, default: 'cyclosm' },
})

const mapEl = useTemplateRef('mapEl')
// État impératif, hors réactivité Vue (maplibre n'aime pas la réactivité profonde).
let mapInstance: any = null

function bounds(): [[number, number], [number, number]] | null {
  if (props.polyline.length < 2) return null
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const [lng, lat] of props.polyline) {
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  return [[minLng, minLat], [maxLng, maxLat]]
}

async function renderMap() {
  const box = bounds()
  if (!mapEl.value || mapInstance || !box) return
  const maplibregl = (await import('maplibre-gl')).default
  await import('maplibre-gl/dist/maplibre-gl.css')

  mapInstance = new maplibregl.Map({
    container: mapEl.value,
    style: mapStyleFor(props.styleId) as any,
    bounds: box as any,
    fitBoundsOptions: { padding: 24 },
    interactive: false,
    // Attribution posée à gauche (cf. addControl) : par défaut MapLibre la met en bas à
    // droite, où elle passerait sous les boutons « Voir le tracé » / « GPX ».
    attributionControl: false,
  })
  // L'attribution des fournisseurs de tuiles reste obligatoire, même sur une vignette.
  mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
  // Version repliée : une pastille « i » qu'on déploie d'un clic. MapLibre ne replie
  // de lui-même qu'en dessous d'une certaine largeur, mesurée avant que le conteneur
  // ait sa taille — sur une vignette, l'attribution dépliée mange l'image.
  mapInstance.once('load', () => {
    mapEl.value?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show')
  })

  mapInstance.on('load', () => {
    // Le conteneur tire sa hauteur d'un aspect-ratio CSS : à la construction, MapLibre
    // le mesure parfois encore vide et cadre alors sur du vide. On remesure et on
    // recadre une fois la carte prête, sinon le tracé peut tomber hors de la vue.
    mapInstance.resize()
    mapInstance.fitBounds(box as any, { padding: 24, duration: 0 })
    mapInstance.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: props.polyline } },
    })
    // Liseré sombre sous le tracé : le rend lisible quel que soit le fond.
    mapInstance.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': 'rgba(0,0,0,0.45)', 'line-width': 6 },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': '#f97316', 'line-width': 3.5 },
    })
  })
}

onMounted(() => renderMap())

onBeforeUnmount(() => {
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <div ref="mapEl" class="route-summary-map"></div>
</template>
