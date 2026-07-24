<script setup lang="ts">
// Fond de carte de l'aperçu, sur la page de partage publique. L'îlot se monte sur le
// bloc qui contient déjà l'aperçu SVG rendu par le serveur : celui-ci reste le repli
// pour les crawlers d'aperçu des messageries (qui n'exécutent pas de JS) et le temps
// que MapLibre se charge.
//
// Carte volontairement non interactive : c'est une vignette dans une page qui défile,
// pas un outil. Le tracé complet est visible d'emblée, et sur téléphone le doigt fait
// défiler la page au lieu de déplacer la carte. Un clic ailleurs que sur un repère
// ouvre la vue en lecture seule — l'aperçu se comporte comme le lien « Voir le tracé »
// qu'il illustre.
import { onMounted, onBeforeUnmount, useTemplateRef } from 'vue'
import { type PropType } from 'vue'
import { mapStyleFor, ROUTE_LINE_LAYOUT } from '../mapStyles'
import { markerMeta, markerKindLabel, type RouteMarker } from '../routeMarkers'
import { escapeHtml } from '../activityHelpers'
import { t } from '../i18n'

const props = defineProps({
  // Polyligne simplifiée `[[lng, lat], ...]` (routes.map_polyline), passée en props
  // plutôt que rechargée : elle est déjà en base, sous-échantillonnée pour être légère.
  polyline: { type: Array as PropType<[number, number][]>, default: () => [] },
  // Repères posés dans le créateur (routes.markers) : départ / arrivée / parking. Ils
  // situent le point de rendez-vous sans avoir à ouvrir le tracé complet.
  markers: { type: Array as PropType<RouteMarker[]>, default: () => [] },
  // Fond de carte : les sentiers se lisent mieux sur le fond topo, les routes sur CyclOSM.
  styleId: { type: String, default: 'cyclosm' },
  // Vue en lecture seule (/routes/:token/view) ouverte au clic sur la carte. Vide = la
  // vignette reste inerte.
  viewUrl: { type: String, default: '' },
})

const viewLabel = t('routes.summary.view')

// Classe de mise en évidence de la ligne visée, définie avec la page (application.scss) :
// la liste est rendue par le serveur, hors de ce composant.
const FLASH_CLASS = 'route-summary-marker-flash'

// Animation du tracé : durée d'un passage, puis temps d'arrêt sur le tracé complet
// avant de recommencer. Assez lent pour qu'on suive le sens du trajet, assez court pour
// qu'un lecteur qui arrive sur la page voie un cycle entier sans attendre.
const DRAW_MS = 4500
const HOLD_MS = 1400

const mapEl = useTemplateRef('mapEl')
// État impératif, hors réactivité Vue (maplibre n'aime pas la réactivité profonde).
let mapInstance: any = null
let animationFrame: number | null = null
let visibilityObserver: IntersectionObserver | null = null
// La vignette peut très bien être déjà hors de l'écran quand la carte finit de charger
// (page ouverte puis défilée) : l'observateur fait foi, pas l'ordre des événements.
let isVisible = true

function bounds(): [[number, number], [number, number]] | null {
  if (props.polyline.length < 2) return null
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  // Les repères entrent dans le cadrage : un parking posé un peu à l'écart du tracé
  // sortirait sinon de la vignette.
  const points = [...props.polyline, ...props.markers.map((m) => [m.lng, m.lat] as [number, number])]
  for (const [lng, lat] of points) {
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  return [[minLng, minLat], [maxLng, maxLat]]
}

// Fait défiler la page jusqu'à la ligne du repère dans la liste rendue par le serveur
// (route_summary.html.erb pose l'id, même index que le tableau des props) et la fait
// clignoter une fois : après un défilement de plusieurs centaines de pixels, il faut
// dire au lecteur ce qui a bougé.
function revealMarkerInList(index: number) {
  const row = document.getElementById(`route-summary-marker-${index}`)
  if (!row) return
  row.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
  // Retirer puis remettre la classe redémarre l'animation si on reclique sur la même
  // pastille avant la fin (sinon le navigateur la considère déjà jouée).
  row.classList.remove(FLASH_CLASS)
  void row.offsetWidth
  row.classList.add(FLASH_CLASS)
  row.addEventListener('animationend', () => row.classList.remove(FLASH_CLASS), { once: true })
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// Pastille d'un repère, calquée sur celle du créateur d'itinéraire. Seule interaction
// de cette vignette : le clic renvoie à la ligne correspondante de la liste, qui porte
// les liens Google Maps.
function buildMarkerEl(marker: RouteMarker, index: number): HTMLElement {
  const meta = markerMeta(marker.kind)
  const kindLabel = markerKindLabel(marker.kind)
  const text = marker.label && marker.label !== kindLabel ? `${kindLabel} · ${marker.label}` : kindLabel
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'shared-route-marker'
  el.style.color = meta?.color ?? '#6b7280'
  el.title = text
  el.innerHTML = `<i class="fa-solid ${meta?.icon ?? 'fa-location-dot'}" aria-hidden="true"></i>`
    + `<span class="shared-route-marker-label">${escapeHtml(text)}</span>`
  // `stopPropagation` : sans lui le clic remonterait au conteneur, qui ouvre la vue en
  // lecture seule — un clic sur un repère doit rester un clic sur le repère.
  el.addEventListener('click', (event) => {
    event.stopPropagation()
    revealMarkerInList(index)
  })
  return el
}

// Clic sur la carte : on ouvre le tracé en lecture seule. Les repères ont déjà arrêté
// leur clic ; restent les contrôles MapLibre (attribution et ses liens), qu'on laisse
// se comporter normalement.
function openView(event: MouseEvent) {
  if (!props.viewUrl) return
  if ((event.target as HTMLElement | null)?.closest('.maplibregl-ctrl')) return
  window.location.href = props.viewUrl
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
      // `lineMetrics` : indispensable à `line-gradient`, qui a besoin de la distance
      // parcourue le long de la ligne (`line-progress`) pour animer le tracé.
      lineMetrics: true,
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
    // Tracé complet en sourdine : l'animation dessine par-dessus, mais l'itinéraire
    // reste lisible d'un bout à l'autre à tout instant du cycle — c'est un aperçu avant
    // d'être une animation, et la première image ne doit pas être une carte vide.
    mapInstance.addLayer({
      id: 'route-line-base',
      type: 'line',
      source: 'route',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': '#f97316', 'line-width': 3.5, 'line-opacity': 0.35 },
    })
    mapInstance.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: ROUTE_LINE_LAYOUT,
      paint: { 'line-color': '#f97316', 'line-width': 3.5 },
    })
    props.markers.forEach((marker, i) => {
      new maplibregl.Marker({ element: buildMarkerEl(marker, i), anchor: 'bottom-left' })
        .setLngLat([marker.lng, marker.lat])
        .addTo(mapInstance)
    })
    startDrawLoop()
  })
}

// Curseur du profil altimétrique, rendu par le serveur hors de ce composant
// (route_summary.html.erb) : son abscisse est la distance parcourue, comme celle de la
// tête du tracé, les deux se déplacent donc du même pas.
function setProfileCursor(progress: number | null) {
  const cursor = document.getElementById('route-summary-profile-cursor')
  if (!cursor) return
  if (progress === null) return cursor.classList.remove('is-active')
  const x = String(progress * 100)
  cursor.setAttribute('x1', x)
  cursor.setAttribute('x2', x)
  cursor.classList.add('is-active')
}

// Position de la « tête » du tracé, de 0 (départ) à 1 (arrivée). Au-delà de 1 le tracé
// est entièrement peint : c'est le temps d'arrêt avant le passage suivant.
function setProgress(progress: number) {
  // Le curseur s'efface pendant le temps d'arrêt : arrivé au bout, il n'indique plus
  // rien, et une barre plantée à droite se lirait comme un élément du graphique.
  setProfileCursor(progress >= 1 ? null : progress)
  if (!mapInstance?.getLayer('route-line')) return
  if (progress >= 1) {
    // Un dégradé à un seul palier reviendrait à une ligne pleine, mais coûte une
    // recompilation d'expression à chaque image : on repasse en couleur simple.
    mapInstance.setPaintProperty('route-line', 'line-gradient', null)
    return
  }
  // Le dernier segment peint est éclairci : ça donne une tête au tracé, et c'est elle
  // qui rend le sens de parcours lisible. Les paliers doivent rester strictement
  // croissants, d'où les bornes.
  const head = Math.max(progress - 0.05, 0.0001)
  mapInstance.setPaintProperty('route-line', 'line-gradient', [
    'interpolate', ['linear'], ['line-progress'],
    0, '#f97316',
    head, '#f97316',
    progress, '#fff7ed',
    Math.min(progress + 0.0005, 1), 'rgba(249,115,22,0)',
    1, 'rgba(249,115,22,0)',
  ])
}

function startDrawLoop() {
  // Mouvement réduit demandé : le tracé reste peint en entier, sans boucle.
  if (prefersReducedMotion() || !isVisible) { setProgress(1); return }
  if (animationFrame !== null) return

  const start = performance.now()
  const step = (now: number) => {
    const elapsed = (now - start) % (DRAW_MS + HOLD_MS)
    setProgress(Math.min(elapsed / DRAW_MS, 1))
    animationFrame = requestAnimationFrame(step)
  }
  animationFrame = requestAnimationFrame(step)
}

function stopDrawLoop() {
  if (animationFrame !== null) { cancelAnimationFrame(animationFrame); animationFrame = null }
}

// Une vignette hors de l'écran ne doit pas continuer à redessiner : la page de partage
// s'ouvre souvent sur un téléphone, et la boucle tournerait pendant tout le défilement.
function watchVisibility() {
  if (!mapEl.value || !window.IntersectionObserver) return
  visibilityObserver = new IntersectionObserver(([entry]) => {
    isVisible = entry.isIntersecting
    if (isVisible) {
      if (mapInstance?.getLayer('route-line')) startDrawLoop()
    } else {
      stopDrawLoop()
      setProgress(1)
    }
  })
  visibilityObserver.observe(mapEl.value)
}

onMounted(() => {
  renderMap()
  watchVisibility()
})

onBeforeUnmount(() => {
  stopDrawLoop()
  visibilityObserver?.disconnect()
  visibilityObserver = null
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <!-- Le conteneur MapLibre reste vide : la pastille d'invite est posée à côté, dans un
       parent positionné. MapLibre s'attend à un conteneur qu'il est seul à peupler. -->
  <div class="route-summary-map-wrap" :class="{ 'is-clickable': viewUrl }"
       :title="viewUrl ? viewLabel : undefined" @click="openView">
    <div ref="mapEl" class="route-summary-map"></div>
    <!-- Raccourci à la souris/au doigt : au clavier, c'est le lien « Voir le tracé » de la
         liste d'actions, juste en dessous, qui mène au même endroit. -->
    <span v-if="viewUrl" class="route-summary-map-hint">
      <i class="fa-solid fa-eye" aria-hidden="true"></i>
      {{ viewLabel }}
    </span>
  </div>
</template>

<!-- Non scoped : les pastilles sont créées en JS (hors template), elles ne portent donc
     pas l'attribut data-v du composant. -->
<style>
.route-summary-map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.route-summary-map-wrap.is-clickable { cursor: pointer; }

/* Invite discrète : la carte n'a pas l'air d'un lien, il faut le dire. Transparente aux
   clics pour ne pas voler celui du conteneur ni celui d'un repère qui passerait dessous. */
.route-summary-map-hint {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 2;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.16rem 0.5rem;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
  color: #212529;
  font-size: 0.7rem;
  font-weight: 600;
  box-shadow: 0 3px 8px -3px rgba(0, 0, 0, 0.35);
}
.route-summary-map-hint i { font-size: 0.7rem; color: #f97316; }

.shared-route-marker {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  background: rgba(255, 255, 255, 0.96);
  padding: 0.16rem 0.45rem 0.16rem 0.38rem;
  border-radius: 12px;
  font-size: 0.68rem;
  font-weight: 600;
  white-space: nowrap;
  border: 1.5px solid currentColor;
  box-shadow: 0 3px 8px -3px rgba(0, 0, 0, 0.35);
  line-height: 1.4;
  user-select: none;
  transform-origin: bottom left;
  /* La carte reste non déplaçable : le clic sur la pastille renvoie à la ligne du repère
     dans la liste, ailleurs il ouvre la vue en lecture seule. Le doigt, lui, continue de
     faire défiler la page. */
  cursor: pointer;
  /* Pas d'effet en `transform` : MapLibre écrit le positionnement de la pastille dans
     le `transform` de cet élément même, il serait écrasé. */
  transition: box-shadow 0.1s ease;
}
.shared-route-marker:hover,
.shared-route-marker:focus-visible {
  box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.45);
}
.shared-route-marker i { font-size: 0.7rem; }
.shared-route-marker-label { color: #212529; }
</style>
