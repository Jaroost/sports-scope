<script setup lang="ts">
// Dialogue de comparaison des variantes d'un tronçon. Rejoue le tronçon actuel (en
// référence, tracé neutre) et les variantes BRouter (colorées) sur une carte MapLibre
// dédiée. Un clic sur une variante (carte ou pastille) la sélectionne : ses stats et le
// bouton « Choisir » apparaissent alors dans la barre du bas — pas en infobulle sur la
// carte, qui masquerait justement les tracés qu'on compare. Le montage/démontage de la
// carte suit le cycle de vie du composant (la modale est montée via v-if côté parent).
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor } from '../mapStyles'
import { profilesForSport } from '../brouter'
import { computeGainLoss, formatDistancePrecise, formatDistanceShort, haversine } from '../routeHelpers'
import type { Coord } from '../routeHelpers'
import type { Sport } from '../userPreferences'

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
  // Sport + profil BRouter utilisés pour chercher les variantes de CE tronçon : le
  // parent les initialise sur ceux de l'itinéraire, la dialogue permet d'en changer
  // (relance de la recherche) sans modifier l'itinéraire.
  sport: Sport
  profile: string
  loading: boolean
  // Passe d'élargissement en cours : les variantes déjà trouvées restent affichées.
  widening: boolean
  // Reste-t-il un palier de rayon à essayer ?
  canWiden: boolean
  // Rayon du prochain palier, et progression dans les paliers praticables sur ce tronçon.
  widenRadiusM: number
  widenStep: number
  widenLevels: number
  // Message court quand un élargissement n'a rien apporté de neuf.
  widenNote: string | null
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  select: [altId: number]
  'update:sport': [sport: Sport]
  'update:profile': [profile: string]
  widen: []
}>()

const SPORTS: Sport[] = ['cycling', 'mtb', 'hiking']
function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

const mapEl = ref<HTMLElement | null>(null)
// Survol (carte ou pastille) et tracé choisi. Le choisi l'emporte : tant qu'il est là,
// promener la souris ailleurs ne défait pas la mise en avant. `CURRENT_ID` désigne le
// tracé actuel, manipulé comme une variante de plus (survol, sélection, mise en retrait
// des autres) — le choisir revient à ne rien changer, donc à fermer la modale.
const CURRENT_ID = -1
const hoveredId = ref<number | null>(null)
const selectedId = ref<number | null>(null)
const highlightedId = computed(() => selectedId.value ?? hoveredId.value)

function chooseSelected() {
  if (selectedId.value == null) return
  if (selectedId.value === CURRENT_ID) emit('close')
  else emit('select', selectedId.value)
}

// Instance MapLibre + module (chargés dynamiquement, comme la carte principale).
let mapInstance: any = null
let _maplibregl: any = null
let mapReady = false
// Marqueurs des deux extrémités du tronçon : elles sont communes au tracé actuel et à
// toutes les variantes, ce sont les seuls points fixes de la comparaison.
let endpointMarkers: any[] = []

const CURRENT_COLOR = '#64748b' // gris ardoise : le tronçon actuel, en référence
// Quand un tracé est survolé/choisi, les autres sont carrément masqués : on ne compare
// bien qu'un tracé à la fois. Les pastilles, elles, restent visibles (à 30 %, cf. CSS) —
// ce sont elles qui permettent de revenir sur les tracés cachés.
const DIM_OPACITY = 0

// Écart d'une variante vs le tronçon actuel, avec signe explicite (± quand nul).
function fmtDelta(m: number, kind: 'dist' | 'elev'): string {
  const sign = m > 0 ? '+' : m < 0 ? '−' : '±'
  const abs = Math.abs(Math.round(m))
  return kind === 'elev' ? `${sign}${abs} m` : `${sign}${formatDistanceShort(abs)}`
}

// Pente moyenne : le D+ rapporté à la longueur (et non le dénivelé net), comme pour les
// montées — c'est ce qui dit à quel point ça grimpe.
function avgGrade(gainM: number, distanceM: number): number {
  return distanceM > 0 ? (gainM / distanceM) * 100 : 0
}

// Stats du tronçon actuel : les variantes arrivent chiffrées du parent, le tracé actuel
// n'est passé qu'en géométrie — on le mesure ici pour pouvoir l'afficher comme les autres.
const currentStats = computed(() => {
  const c = props.currentCoords
  let distanceM = 0
  for (let i = 1; i < c.length; i++) distanceM += haversine(c[i - 1], c[i])
  return { distanceM, gainM: computeGainLoss(c).gain }
})

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
  // Tronçon actuel : trait pointillé neutre, sous les variantes (référence visuelle). Il
  // se survole et se sélectionne comme une variante, d'où le calque de saisie invisible :
  // un pointillé de 4 px est trop fin pour être visé au doigt ou à la souris.
  mapInstance.addSource('alt-current', { type: 'geojson', data: emptyFeature() })
  mapInstance.addLayer({
    id: 'alt-current-line', type: 'line', source: 'alt-current',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': CURRENT_COLOR, 'line-width': 4, 'line-dasharray': [1.6, 1.4], 'line-opacity': 0.9 },
  })
  mapInstance.addLayer({
    id: 'alt-current-hit', type: 'line', source: 'alt-current',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': CURRENT_COLOR, 'line-width': 16, 'line-opacity': 0 },
  })
  // Variantes : bordure sombre + trait coloré ; la variante survolée/active est élargie
  // via l'état de feature `active`, et les autres reculent (`dimmed`) pour qu'on suive
  // celle qu'on regarde sans être brouillé par les tracés voisins.
  mapInstance.addSource('alt-variants', { type: 'geojson', data: emptyCollection() })
  mapInstance.addLayer({
    id: 'alt-variants-border', type: 'line', source: 'alt-variants',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': 'rgba(0,0,0,0.45)',
      'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 12, 9],
      'line-opacity': ['case', ['boolean', ['feature-state', 'dimmed'], false], DIM_OPACITY, 1],
    },
  })
  mapInstance.addLayer({
    id: 'alt-variants-line', type: 'line', source: 'alt-variants',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 7.5, 5],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'active'], false], 1,
        ['boolean', ['feature-state', 'dimmed'], false], DIM_OPACITY,
        0.85,
      ],
    },
  })
  mapInstance.on('mousemove', 'alt-variants-line', onLineMove)
  mapInstance.on('mouseleave', 'alt-variants-line', onLineLeave)
  mapInstance.on('click', 'alt-variants-line', onLineClick)
  mapInstance.on('mousemove', 'alt-current-hit', onCurrentMove)
  mapInstance.on('mouseleave', 'alt-current-hit', onLineLeave)
  mapInstance.on('click', 'alt-current-hit', onCurrentClick)
  mapInstance.on('click', onMapClick)
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
  // La liste change (nouvelle passe d'élargissement) : les index ne désignent plus les
  // mêmes tracés, on repart sans sélection.
  selectedId.value = null
  hoveredId.value = null

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
  // Les états de feature survivent au setData : on les remet à plat sur la nouvelle liste.
  paintHighlight(null)

  renderEndpoints()
  fitToAll()
}

// Repose les deux marqueurs d'extrémité. Le sens est celui du tronçon dans l'itinéraire
// (départ = borne basse de la sélection), pour que la lecture des variantes suive le sens
// de parcours.
function renderEndpoints() {
  clearEndpoints()
  const coords = props.currentCoords
  if (!mapInstance || !_maplibregl || coords.length < 2) return

  const ends: Array<{ at: Coord; cls: string; icon: string; label: string }> = [
    { at: coords[0], cls: 'raltd-end-marker raltd-end-marker--start', icon: 'fa-flag', label: t('routes.alternatives_start') },
    { at: coords[coords.length - 1], cls: 'raltd-end-marker raltd-end-marker--finish', icon: 'fa-flag-checkered', label: t('routes.alternatives_end') },
  ]
  for (const e of ends) {
    const el = document.createElement('div')
    el.className = e.cls
    el.title = e.label
    el.setAttribute('aria-label', e.label)
    el.innerHTML = `<i class="fa-solid ${e.icon}" aria-hidden="true"></i>`
    endpointMarkers.push(
      new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([e.at[0], e.at[1]]).addTo(mapInstance),
    )
  }
}

function clearEndpoints() {
  endpointMarkers.forEach((m) => m.remove())
  endpointMarkers = []
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

// Peint la mise en avant : le tracé visé passe en trait large et pleine opacité, tous les
// autres — tracé actuel compris — tombent à `DIM_OPACITY`. `null` remet tout à plat.
function paintHighlight(id: number | null) {
  if (!mapReady || !mapInstance) return
  for (let i = 0; i < props.alternatives.length; i++) {
    mapInstance.setFeatureState(
      { source: 'alt-variants', id: i },
      { active: id === i, dimmed: id != null && id !== i },
    )
  }
  // Le tracé actuel n'a qu'une feature : sa mise en avant passe par le paint du calque.
  const curActive = id === CURRENT_ID
  const curDimmed = id != null && !curActive
  mapInstance.setPaintProperty('alt-current-line', 'line-width', curActive ? 6 : 4)
  mapInstance.setPaintProperty('alt-current-line', 'line-opacity', curActive ? 1 : curDimmed ? DIM_OPACITY : 0.9)
}

watch(highlightedId, (id) => paintHighlight(id))

// Un point de la carte est-il sur une variante ? Les variantes passent devant le tracé
// actuel : quand les deux se superposent, c'est la variante qui répond au survol/clic.
function overVariant(point: any): boolean {
  return mapInstance
    .queryRenderedFeatures(point, { layers: ['alt-variants-line'] })
    .some((f: any) => isInteractive(f.properties?.altId ?? 0))
}

// Tant qu'un tracé est sélectionné, les autres sont masqués : ils ne doivent plus
// répondre à la souris. On ne vise pas ce qu'on ne voit pas, et un clic dans ce qui est
// devenu du vide doit désélectionner, pas attraper un tracé invisible.
function isInteractive(id: number): boolean {
  return selectedId.value == null || selectedId.value === id
}

function onLineMove(e: any) {
  const f = e.features?.[0]
  if (!f) return
  const id = f.properties?.altId ?? 0
  if (!isInteractive(id)) return
  mapInstance.getCanvas().style.cursor = 'pointer'
  hoveredId.value = id
}

function onLineLeave() {
  mapInstance.getCanvas().style.cursor = ''
  hoveredId.value = null
}

function onLineClick(e: any) {
  const f = e.features?.[0]
  if (!f) return
  const id = f.properties?.altId ?? 0
  if (isInteractive(id)) selectedId.value = id
}

function onCurrentMove(e: any) {
  if (!isInteractive(CURRENT_ID) || overVariant(e.point)) return
  mapInstance.getCanvas().style.cursor = 'pointer'
  hoveredId.value = CURRENT_ID
}

function onCurrentClick(e: any) {
  if (!isInteractive(CURRENT_ID) || overVariant(e.point)) return
  selectedId.value = CURRENT_ID
}

// Clic à côté de tout tracé visible : on désélectionne (les handlers de calque ci-dessus
// ont déjà traité le cas « sur un tracé »).
function onMapClick(e: any) {
  const hits = mapInstance.queryRenderedFeatures(e.point, { layers: ['alt-variants-line', 'alt-current-hit'] })
  const onVisible = hits.some((f: any) =>
    isInteractive(f.layer.id === 'alt-current-hit' ? CURRENT_ID : f.properties?.altId ?? 0),
  )
  if (!onVisible) selectedId.value = null
}

// Légende : survol → surligne la variante ; clic → la sélectionne (re-clic = désélection).
function onChipEnter(id: number) { hoveredId.value = id }
function onChipLeave() { hoveredId.value = null }
function onChipClick(id: number) {
  selectedId.value = selectedId.value === id ? null : id
}

// Échap : d'abord abandonner la sélection en cours, et seulement ensuite fermer.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (selectedId.value != null) selectedId.value = null
  else emit('close')
}

// Recadre / re-pose dès que les variantes arrivent (la modale s'ouvre pendant le
// chargement, la carte est déjà montée).
watch(() => props.alternatives, () => renderAlternatives(), { deep: false })

onMounted(() => {
  initMap()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  clearEndpoints()
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

        <!-- Sport + profil de routage du tronçon : changer l'un ou l'autre relance la
             recherche de variantes (l'itinéraire, lui, n'est pas modifié). -->
        <div class="raltd-routing">
          <div class="btn-group btn-group-sm" role="group" :aria-label="t('routes.wt_sport')">
            <button
              v-for="s in SPORTS"
              :key="s"
              type="button"
              class="btn"
              :class="sport === s ? 'btn-primary' : 'btn-outline-secondary'"
              :title="t(`routes.wt_sport_${s}`)"
              :aria-label="t(`routes.wt_sport_${s}`)"
              :disabled="loading"
              @click="emit('update:sport', s)"
            >
              <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
            </button>
          </div>
          <select
            class="form-select form-select-sm raltd-profile-select"
            :value="profile"
            :aria-label="t('routes.profile_label')"
            :title="t(`routes.brouter_profile.${profile}_desc`)"
            :disabled="loading"
            @change="emit('update:profile', ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="p in profilesForSport(sport)"
              :key="p"
              :value="p"
              :title="t(`routes.brouter_profile.${p}_desc`)"
            >
              {{ t(`routes.brouter_profile.${p}`) }}
            </option>
          </select>
        </div>

        <button type="button" class="raltd-close" :aria-label="t('routes.close')" @click="emit('close')">×</button>
      </div>

      <div class="raltd-body">
        <div class="raltd-map-wrap">
          <div ref="mapEl" class="raltd-map"></div>

          <div v-if="loading || (widening && !alternatives.length)" class="raltd-overlay">
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

        <!-- Toujours rendu hors chargement initial : le bouton « chercher plus large »
             doit rester atteignable même quand aucune variante n'a été trouvée, c'est
             justement là qu'il sert. -->
        <div v-if="!loading" class="raltd-legend">
          <div class="raltd-legend-main">
            <span v-if="alternatives.length" class="raltd-hint">{{ t('routes.alternatives_hint') }}</span>
            <!-- `div` et non `button` : la pastille sélectionnée contient elle-même le
                 bouton « Choisir », et un bouton dans un bouton est invalide. D'où le
                 rôle + la gestion clavier à la main (`.self` pour ne pas intercepter la
                 touche Entrée destinée au bouton interne). -->
            <div v-if="alternatives.length" class="raltd-chips">
              <div
                class="raltd-chip"
                role="button"
                tabindex="0"
                :aria-pressed="selectedId === CURRENT_ID"
                :class="{
                  'raltd-chip--active': highlightedId === CURRENT_ID,
                  'raltd-chip--selected': selectedId === CURRENT_ID,
                  'raltd-chip--dimmed': highlightedId !== null && highlightedId !== CURRENT_ID,
                }"
                @mouseenter="onChipEnter(CURRENT_ID)"
                @mouseleave="onChipLeave"
                @focus="onChipEnter(CURRENT_ID)"
                @blur="onChipLeave"
                @click="onChipClick(CURRENT_ID)"
                @keydown.enter.self.prevent="onChipClick(CURRENT_ID)"
                @keydown.space.self.prevent="onChipClick(CURRENT_ID)"
              >
                <span class="raltd-swatch raltd-swatch--dashed"></span>
                {{ t('routes.alternatives_current') }}
                <span class="raltd-chip-grade" :title="t('routes.alternatives_avg_grade')">
                  {{ avgGrade(currentStats.gainM, currentStats.distanceM).toFixed(1) }}%
                </span>
                <!-- Choisir le tracé actuel = ne rien changer : on referme, c'est tout. -->
                <button
                  v-if="selectedId === CURRENT_ID"
                  type="button"
                  class="raltd-choose"
                  @click.stop="chooseSelected"
                >
                  {{ t('routes.alternatives_keep_current') }}
                </button>
              </div>
              <div
                v-for="(alt, i) in alternatives"
                :key="i"
                class="raltd-chip"
                role="button"
                tabindex="0"
                :aria-pressed="selectedId === i"
                :class="{
                  'raltd-chip--active': highlightedId === i,
                  'raltd-chip--selected': selectedId === i,
                  'raltd-chip--dimmed': highlightedId !== null && highlightedId !== i,
                }"
                @mouseenter="onChipEnter(i)"
                @mouseleave="onChipLeave"
                @focus="onChipEnter(i)"
                @blur="onChipLeave"
                @click="onChipClick(i)"
                @keydown.enter.self.prevent="onChipClick(i)"
                @keydown.space.self.prevent="onChipClick(i)"
              >
                <span class="raltd-swatch" :style="{ background: alt.color }"></span>
                {{ t('routes.alternatives_variant', { n: i + 1 }) }}
                <span
                  class="raltd-chip-delta"
                  :class="alt.deltaDistanceM <= 0 ? 'raltd-pos' : 'raltd-neg'"
                  :title="`${t('routes.alternatives_delta_distance')} — ${formatDistancePrecise(alt.distanceM)}`"
                >
                  {{ fmtDelta(alt.deltaDistanceM, 'dist') }}
                </span>
                <span
                  class="raltd-chip-delta"
                  :class="alt.deltaGainM <= 0 ? 'raltd-pos' : 'raltd-neg'"
                  :title="`${t('routes.alternatives_delta_gain')} — +${Math.round(alt.gainM)} m`"
                >
                  {{ fmtDelta(alt.deltaGainM, 'elev') }}
                </span>
                <span class="raltd-chip-grade" :title="t('routes.alternatives_avg_grade')">
                  {{ avgGrade(alt.gainM, alt.distanceM).toFixed(1) }}%
                </span>
                <button
                  v-if="selectedId === i"
                  type="button"
                  class="raltd-choose"
                  @click.stop="chooseSelected"
                >
                  {{ t('routes.apply_alternative') }}
                </button>
              </div>
            </div>
          </div>

          <span v-if="widenNote" class="raltd-widen-note">{{ widenNote }}</span>
          <button
            v-if="canWiden"
            type="button"
            class="btn btn-sm btn-outline-secondary raltd-widen"
            :title="t('routes.alternatives_widen_title', { radius: formatDistancePrecise(widenRadiusM) })"
            :disabled="widening"
            @click="emit('widen')"
          >
            <span v-if="widening" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-arrows-left-right-to-line me-1" aria-hidden="true"></i>
            {{ t('routes.alternatives_widen') }}
            <span class="raltd-widen-radius">{{ formatDistancePrecise(widenRadiusM) }}</span>
            <span v-if="widenLevels > 1" class="raltd-widen-level">{{ widenStep + 1 }}/{{ widenLevels }}</span>
          </button>
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
/* Sélecteur sport + profil : collé à droite, juste avant la croix de fermeture. */
.raltd-routing {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
  margin-right: 0.5rem;
  min-width: 0;
}
.raltd-profile-select { width: auto; max-width: 14rem; }
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
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.7rem 1rem 0.9rem;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
}
.raltd-legend-main { flex: 1; min-width: 0; }
.raltd-widen { flex: none; white-space: nowrap; }
.raltd-widen-radius { font-weight: 600; margin-left: 0.35rem; }
.raltd-widen-level {
  margin-left: 0.4rem;
  font-size: 0.75rem;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.raltd-widen-note {
  flex: none;
  font-size: 0.8rem;
  color: #6b7280;
  padding-bottom: 0.35rem;
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
  transition: border-color 0.12s, box-shadow 0.12s, opacity 0.12s;
}
.raltd-chip:hover, .raltd-chip--active {
  border-color: #0096c7;
  box-shadow: 0 0 0 1px #0096c7;
}
.raltd-chip--selected {
  border-color: #0096c7;
  box-shadow: 0 0 0 2px #0096c7;
}
/* Même mise en retrait que les tracés correspondants sur la carte. */
.raltd-chip--dimmed { opacity: 0.3; }
.raltd-chip-delta { font-weight: 600; font-variant-numeric: tabular-nums; }
/* Pente moyenne : valeur absolue (pas un écart) — en retrait pour ne pas la confondre
   avec les deux écarts qui la précèdent. */
.raltd-chip-grade {
  color: #6b7280;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  padding-left: 0.35rem;
  border-left: 1px solid #e5e7eb;
}
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

/* Bouton d'action, à l'intérieur de la pastille sélectionnée : il déborde du padding de
   la pastille pour en occuper le bord droit sans la faire grossir en hauteur. */
.raltd-choose {
  margin: -0.3rem -0.6rem -0.3rem 0.1rem;
  border: none;
  border-radius: 999px;
  background: #0096c7;
  color: #fff;
  font-weight: 600;
  font-size: 0.82rem;
  padding: 0.3rem 0.8rem;
  cursor: pointer;
}
.raltd-choose:hover { background: #007ea7; }

/* Sur téléphone : plein écran pour laisser la carte respirer et faciliter le clic. */
@media (max-width: 640px) {
  .raltd-backdrop { padding: 0; }
  .raltd-dialog {
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
  /* Le sélecteur de routage passe sous le titre : la barre serait sinon illisible. */
  .raltd-header { flex-wrap: wrap; padding: 0.6rem 0.8rem; }
  .raltd-routing {
    order: 3;
    width: 100%;
    margin: 0.5rem 0 0;
  }
  .raltd-profile-select { flex: 1; max-width: none; }
  .raltd-legend { padding: 0.6rem 0.8rem 0.75rem; }
  .raltd-hint { margin-bottom: 0.4rem; }
}
</style>

<!-- Styles des marqueurs d'extrémité : non-scoped car leur DOM est créé dynamiquement et
     n'hérite donc pas de l'attribut de scope du composant. -->
<style>
.raltd-end-marker {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.72rem;
  cursor: default;
}
.raltd-end-marker--start { background: #16a34a; }
.raltd-end-marker--finish { background: #111827; }
</style>
