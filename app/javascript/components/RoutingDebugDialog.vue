<script setup lang="ts">
// Débogage d'un profil de routage, sur une carte dédiée (cf. routingDebug.ts pour le
// principe). Trois outils dans une seule boîte :
//   - le tracé est coloré par coût au km (vert = voie idéale … violet = quasi interdite) ;
//   - un clic sur la carte décrit la voie à cet endroit et, s'il est hors tracé, force le
//     passage par ce point pour chiffrer ce que ça coûte ;
//   - les réglages sont ensuite relâchés un par un : ceux qui feraient passer par le point
//     sont listés, avec « Voir » (tracé obtenu) et « Appliquer » (change le profil).
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { mapStyleFor } from '../mapStyles'
import { formatDistancePrecise } from '../routeHelpers'
import type { Coord, LngLat } from '../routeHelpers'
import type { LegWaypoint } from '../brouterLegs'
import type { Sport } from '../userPreferences'
import { profileLabel } from '../routingProfiles'
import {
  COST_COLOR_STOPS,
  costColor,
  distanceToPolyline,
  explainErrorKey,
  fetchCostProfile,
  nearestLeg,
  paramValueLabel,
  probePoint,
  sortedTags,
  tryRelaxations,
} from '../routingDebug'
import type { CostLeg, ProbeResult, RelaxationResult, WayRun } from '../routingDebug'

const props = defineProps<{
  waypoints: LegWaypoint[]
  spec: string
  sport: Sport
  mapStyleId: string
}>()
const emit = defineEmits<{
  close: []
  apply: [spec: string]
}>()

const mapEl = ref<HTMLElement | null>(null)
let mapInstance: any = null
let _maplibregl: any = null
let mapReady = false
let pointMarker: any = null

const legs = shallowRef<CostLeg[]>([])
const loading = ref(true)
const colorByCost = ref(true)

const probe = shallowRef<ProbeResult | null>(null)
const probing = ref(false)
const variants = shallowRef<RelaxationResult[]>([])
const variantsRunning = ref(false)
const variantsDone = ref(false)
const progress = ref({ done: 0, total: 0 })
const previewKey = ref<string | null>(null)

let loadAbort: AbortController | null = null
let probeAbort: AbortController | null = null
let fitted = false

const failedLegs = computed(() =>
  legs.value
    .map((l, i) => ({ i, error: l.outcome && l.outcome.ok === false ? l.outcome.error : null }))
    .filter((l) => l.error),
)

// ─── Carte ───────────────────────────────────────────────────────────────────

const EMPTY = { type: 'FeatureCollection', features: [] } as any

const COST_EXPR = ['interpolate', ['linear'], ['get', 'factor'], ...COST_COLOR_STOPS.flat()] as any

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
    mapInstance.resize()
    renderRoute()
  })
  mapInstance.on('click', (e: any) => onMapClick([e.lngLat.lng, e.lngLat.lat]))
}

function installLayers() {
  const round = { 'line-join': 'round', 'line-cap': 'round' } as any
  mapInstance.addSource('dbg-route', { type: 'geojson', data: EMPTY })
  mapInstance.addLayer({
    id: 'dbg-route-border', type: 'line', source: 'dbg-route', layout: round,
    paint: { 'line-color': 'rgba(0,0,0,0.5)', 'line-width': 8 },
  })
  mapInstance.addLayer({
    id: 'dbg-route-line', type: 'line', source: 'dbg-route', layout: round,
    paint: { 'line-color': COST_EXPR, 'line-width': 5 },
  })
  mapInstance.addSource('dbg-straight', { type: 'geojson', data: EMPTY })
  mapInstance.addLayer({
    id: 'dbg-straight-line', type: 'line', source: 'dbg-straight',
    paint: { 'line-color': '#64748b', 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
  })
  // Tracé forcé par le point cliqué, puis tracé d'une variante : par-dessus le tracé.
  mapInstance.addSource('dbg-forced', { type: 'geojson', data: EMPTY })
  mapInstance.addLayer({
    id: 'dbg-forced-line', type: 'line', source: 'dbg-forced', layout: round,
    paint: { 'line-color': '#2563eb', 'line-width': 4, 'line-dasharray': [1.2, 1.2] },
  })
  mapInstance.addSource('dbg-variant', { type: 'geojson', data: EMPTY })
  mapInstance.addLayer({
    id: 'dbg-variant-line', type: 'line', source: 'dbg-variant', layout: round,
    paint: { 'line-color': '#c026d3', 'line-width': 5 },
  })
}

const line = (coords: Array<Coord | LngLat>, properties: any = {}) => ({
  type: 'Feature', properties,
  geometry: { type: 'LineString', coordinates: coords.map((c) => [c[0], c[1]]) },
})
const collection = (features: any[]) => ({ type: 'FeatureCollection', features }) as any

function renderRoute() {
  if (!mapReady || !mapInstance) return
  const features: any[] = []
  const straight: any[] = []
  const all: LngLat[] = []
  legs.value.forEach((l, i) => {
    if (l.straight || !l.outcome?.ok) {
      const a = props.waypoints[i], b = props.waypoints[i + 1]
      if (a && b) straight.push(line([[a.lng, a.lat], [b.lng, b.lat]]))
      return
    }
    for (const run of l.outcome.leg.runs) {
      features.push(line(run.coords, { factor: Math.min(run.factor, 10), tags: run.tagsText }))
    }
    // Les sections reconstituées couvrent le tracé ; à défaut (messages absents), le tracé
    // entier en neutre plutôt que rien.
    if (!l.outcome.leg.runs.length) features.push(line(l.outcome.leg.coords, { factor: 1 }))
    for (const c of l.outcome.leg.coords) all.push([c[0], c[1]])
  })
  mapInstance.getSource('dbg-route')?.setData(collection(features))
  mapInstance.getSource('dbg-straight')?.setData(collection(straight))
  applyColorMode()
  if (!fitted && all.length > 1) {
    fitted = true
    const b = new _maplibregl.LngLatBounds(all[0], all[0])
    for (const c of all) b.extend(c)
    mapInstance.fitBounds(b, { padding: 60, duration: 0 })
  }
}

function applyColorMode() {
  if (!mapReady) return
  mapInstance.setPaintProperty('dbg-route-line', 'line-color', colorByCost.value ? COST_EXPR : '#2563eb')
}
watch(colorByCost, applyColorMode)

function setLayer(source: string, coords: Array<Coord | LngLat> | null) {
  if (!mapReady) return
  mapInstance.getSource(source)?.setData(coords ? collection([line(coords)]) : EMPTY)
}

function setPointMarker(p: LngLat | null) {
  pointMarker?.remove()
  pointMarker = null
  if (!p || !mapInstance || !_maplibregl) return
  const el = document.createElement('div')
  el.className = 'rdbg-point'
  pointMarker = new _maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(p).addTo(mapInstance)
}

// ─── Chargement du tracé ─────────────────────────────────────────────────────

async function loadProfile() {
  loadAbort?.abort()
  const ac = new AbortController()
  loadAbort = ac
  loading.value = true
  try {
    const res = await fetchCostProfile(props.waypoints, props.spec, ac.signal)
    if (ac.signal.aborted) return
    legs.value = res
    renderRoute()
  } catch (e: any) {
    if (e?.name !== 'AbortError') throw e
  } finally {
    if (loadAbort === ac) loading.value = false
  }
}

// Le profil change (« Appliquer » sur un réglage) : l'itinéraire se recalcule côté parent,
// on recolore le nôtre sur le nouveau spec et on oublie le point.
watch(() => props.spec, () => {
  clearProbe()
  loadProfile()
})

// ─── Clic : description + forçage ────────────────────────────────────────────

function clearProbe() {
  probeAbort?.abort()
  probe.value = null
  probing.value = false
  variants.value = []
  variantsRunning.value = false
  variantsDone.value = false
  previewKey.value = null
  setLayer('dbg-forced', null)
  setLayer('dbg-variant', null)
  setPointMarker(null)
}

async function onMapClick(point: LngLat) {
  if (loading.value) return
  const near = nearestLeg(point, legs.value)
  if (!near) return
  clearProbe()
  setPointMarker(point)
  const ac = new AbortController()
  probeAbort = ac
  probing.value = true
  const leg = (legs.value[near.index].outcome as { ok: true; leg: any }).leg
  try {
    const res = await probePoint(point, near.index, props.waypoints, leg, props.spec, ac.signal)
    if (ac.signal.aborted) return
    probe.value = res
    setLayer('dbg-forced', res.forcedCoords)
    probing.value = false
    if (!res.onRoute && !isEquivalent(res)) await runRelaxations(res, ac)
  } catch (e: any) {
    if (e?.name !== 'AbortError') throw e
  } finally {
    if (probeAbort === ac) probing.value = false
  }
}

// Coût du tracé forcé à moins de 0,5 % de l'actuel : BRouter a départagé deux voies
// équivalentes, aucun réglage n'est « responsable ».
function isEquivalent(r: ProbeResult): boolean {
  return !r.error && !r.onRoute && r.currentCost > 0 && (r.forcedCost - r.currentCost) / r.currentCost < 0.005
}

async function runRelaxations(res: ProbeResult, ac: AbortController) {
  variantsRunning.value = true
  variantsDone.value = false
  progress.value = { done: 0, total: 0 }
  const a = props.waypoints[res.legIndex], b = props.waypoints[res.legIndex + 1]
  try {
    const found = await tryRelaxations(
      res.error ? 'reach' : 'through',
      [a.lng, a.lat], [b.lng, b.lat], res.point, props.spec, ac.signal,
      (done, total) => { progress.value = { done, total } },
    )
    if (ac.signal.aborted) return
    variants.value = found.sort((x, y) => x.lengthM - y.lengthM)
    variantsDone.value = true
  } finally {
    if (probeAbort === ac) variantsRunning.value = false
  }
}

// ─── Lecture du résultat ─────────────────────────────────────────────────────

// Voie la plus proche du point cliqué : c'est elle que la fiche décrit.
const here = computed<WayRun | null>(() => {
  const p = probe.value
  if (!p?.nearby.length) return null
  return p.nearby.reduce((best, r) =>
    distanceToPolyline(p.point, r.coords) < distanceToPolyline(p.point, best.coords) ? r : best,
  )
})

// Altitude du sommet du tracé le plus proche du point.
const hereEle = computed<number | null>(() => {
  const p = probe.value
  const coords = p?.forcedCoords ?? (p ? currentCoords(p) : null)
  if (!p || !coords?.length) return null
  let best: Coord | null = null
  let bd = Infinity
  for (const c of coords) {
    const d = (c[0] - p.point[0]) ** 2 + (c[1] - p.point[1]) ** 2
    if (d < bd) { bd = d; best = c }
  }
  return best?.[2] ?? null
})

function currentCoords(p: ProbeResult): Coord[] | null {
  const l = legs.value[p.legIndex]
  return l?.outcome?.ok ? l.outcome.leg.coords : null
}

const worstNearby = computed<WayRun | null>(() => {
  const list = probe.value?.nearby ?? []
  if (list.length < 2) return null
  const worst = list.reduce((b, r) => (r.factor > b.factor ? r : b))
  return worst.factor > 1.2 ? worst : null
})

const delta = computed(() => {
  const p = probe.value
  if (!p || p.onRoute || p.error || p.currentCost <= 0) return null
  const pct = ((p.forcedCost - p.currentCost) / p.currentCost) * 100
  return { pct, lengthM: p.forcedLengthM - p.currentLengthM }
})

function fmtPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '−'
  const abs = Math.abs(pct)
  return `${sign}${abs < 10 ? abs.toFixed(1) : Math.round(abs)} %`
}
function fmtLen(m: number): string {
  return `${m >= 0 ? '+' : '−'}${formatDistancePrecise(Math.abs(m))}`
}
function fmtFactor(f: number): string {
  return `×${f < 10 ? f.toFixed(2) : Math.round(f)}`
}

const errorText = computed(() => {
  const e = probe.value?.error
  if (!e) return ''
  const key = explainErrorKey(e)
  return key ? `${t(key)} (${e})` : e
})

function tagChips(run: WayRun): Array<[string, string]> {
  return sortedTags(run.tags).slice(0, 6)
}
function extraTags(run: WayRun): number {
  return Math.max(0, Object.keys(run.tags).length - 6)
}

function previewVariant(v: RelaxationResult) {
  const key = `${v.key}=${v.value}`
  if (previewKey.value === key) {
    previewKey.value = null
    setLayer('dbg-variant', null)
  } else {
    previewKey.value = key
    setLayer('dbg-variant', v.coords)
  }
}

function applyVariant(v: RelaxationResult) {
  emit('apply', v.spec)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (probe.value || probing.value) clearProbe()
  else emit('close')
}

onMounted(() => {
  initMap()
  loadProfile()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  loadAbort?.abort()
  probeAbort?.abort()
  pointMarker?.remove()
  if (mapInstance) { mapInstance.remove(); mapInstance = null }
})
</script>

<template>
  <div class="rdbg-backdrop" @click.self="emit('close')">
    <div class="rdbg-dialog shadow-lg">
      <div class="rdbg-header">
        <span class="rdbg-title">
          <i class="fa-solid fa-bug me-1" aria-hidden="true"></i>
          {{ t('routes.routing_debug.title') }}
        </span>
        <span class="rdbg-profile text-muted small" :title="spec">{{ profileLabel(spec, sport) }}</span>
        <button type="button" class="rdbg-close" :aria-label="t('routes.close')" @click="emit('close')">×</button>
      </div>

      <div class="rdbg-body">
        <div class="rdbg-map-wrap">
          <div ref="mapEl" class="rdbg-map"></div>
          <div v-if="loading" class="rdbg-overlay">
            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
            {{ t('routes.routing_debug.loading') }}
          </div>

          <!-- Légende de la rampe de couleur, et bascule coloré / neutre. -->
          <div class="rdbg-legend">
            <label class="form-check form-switch mb-1 small">
              <input v-model="colorByCost" class="form-check-input" type="checkbox" role="switch" />
              <span class="form-check-label">{{ t('routes.routing_debug.layer_cost') }}</span>
            </label>
            <template v-if="colorByCost">
              <div
                class="rdbg-ramp"
                :style="{ background: `linear-gradient(90deg, ${COST_COLOR_STOPS.map((s) => s[1]).join(', ')})` }"
              ></div>
              <div class="rdbg-ramp-labels">
                <span>{{ t('routes.routing_debug.legend_ideal') }}</span>
                <span>{{ t('routes.routing_debug.legend_avoided') }}</span>
                <span>{{ t('routes.routing_debug.legend_forbidden') }}</span>
              </div>
            </template>
          </div>
        </div>

        <aside class="rdbg-panel">
          <p v-if="failedLegs.length" class="small text-danger mb-2">
            <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>
            {{ t('routes.routing_debug.failed_legs', { legs: failedLegs.map((l) => l.i + 1).join(', ') }) }}
            <span class="text-muted">({{ failedLegs[0].error }})</span>
          </p>

          <p v-if="!probe && !probing" class="rdbg-hint">
            <i class="fa-solid fa-hand-pointer me-1" aria-hidden="true"></i>
            {{ t('routes.routing_debug.hint') }}
          </p>

          <div v-if="probing" class="small mb-2">
            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
            {{ t('routes.routing_debug.probing') }}
          </div>

          <template v-if="probe">
            <!-- Verdict. -->
            <div v-if="probe.error" class="rdbg-verdict rdbg-verdict--bad">
              <strong>{{ t('routes.routing_debug.unreachable') }}</strong>
              <div class="small">{{ errorText }}</div>
            </div>
            <div v-else-if="probe.onRoute" class="rdbg-verdict rdbg-verdict--ok">
              {{ t('routes.routing_debug.on_route', { leg: probe.legIndex + 1 }) }}
            </div>
            <div v-else-if="delta && isEquivalent(probe)" class="rdbg-verdict rdbg-verdict--ok">
              {{ t('routes.routing_debug.equivalent', { pct: fmtPct(delta.pct) }) }}
            </div>
            <div v-else-if="delta" class="rdbg-verdict rdbg-verdict--warn">
              {{ t('routes.routing_debug.costs_more', { pct: fmtPct(delta.pct), dist: fmtLen(delta.lengthM) }) }}
            </div>
            <div v-if="probe.snapM != null && !probe.onRoute && probe.snapM > 25" class="rdbg-verdict rdbg-verdict--warn">
              {{ t('routes.routing_debug.snap_far', { dist: formatDistancePrecise(probe.snapM) }) }}
            </div>

            <!-- Fiche de la voie sous le point : ce qu'est la voie, et ce qu'en pense le profil. -->
            <section v-if="here" class="rdbg-section">
              <h4 class="rdbg-h">{{ t('routes.routing_debug.here') }}</h4>
              <div class="rdbg-card">
                <div class="rdbg-chips">
                  <span v-for="[k, v] in tagChips(here)" :key="k" class="rdbg-chip">
                    <b>{{ k }}</b><template v-if="v">={{ v }}</template>
                  </span>
                  <span v-if="extraTags(here)" class="rdbg-chip rdbg-chip--more" :title="here.tagsText">
                    +{{ extraTags(here) }}
                  </span>
                </div>
                <dl class="rdbg-facts">
                  <dt>{{ t('routes.routing_debug.fact_cost') }}</dt>
                  <dd>
                    <span class="rdbg-swatch" :style="{ background: costColor(here.factor) }"></span>
                    {{ fmtFactor(here.factor) }}
                  </dd>
                  <dt>{{ t('routes.routing_debug.fact_length') }}</dt>
                  <dd>{{ formatDistancePrecise(here.distanceM) }}</dd>
                  <template v-if="hereEle != null">
                    <dt>{{ t('routes.routing_debug.fact_ele') }}</dt>
                    <dd>{{ Math.round(hereEle) }} m</dd>
                  </template>
                  <template v-if="here.elevCost">
                    <dt>{{ t('routes.routing_debug.fact_elev_cost') }}</dt>
                    <dd>{{ Math.round(here.elevCost) }}</dd>
                  </template>
                  <template v-if="here.turnCost">
                    <dt>{{ t('routes.routing_debug.fact_turn_cost') }}</dt>
                    <dd>{{ Math.round(here.turnCost) }}</dd>
                  </template>
                </dl>
              </div>
            </section>

            <!-- Voies du voisinage, dans l'ordre du parcours. -->
            <section v-if="probe.nearby.length > 1" class="rdbg-section">
              <h4 class="rdbg-h">{{ t('routes.routing_debug.around') }}</h4>
              <ul class="rdbg-ways">
                <li v-for="(r, i) in probe.nearby" :key="i" :class="{ 'rdbg-way--worst': r === worstNearby }">
                  <span class="rdbg-swatch" :style="{ background: costColor(r.factor) }"></span>
                  <span class="rdbg-way-tags" :title="r.tagsText">
                    {{ sortedTags(r.tags).slice(0, 3).map(([k, v]) => (v ? `${k}=${v}` : k)).join(' · ') }}
                  </span>
                  <span class="rdbg-way-len">{{ formatDistancePrecise(r.distanceM) }}</span>
                  <span class="rdbg-way-cost">{{ fmtFactor(r.factor) }}</span>
                </li>
              </ul>
              <p v-if="worstNearby" class="small text-muted mb-0">
                {{ t('routes.routing_debug.worst') }}
              </p>
            </section>

            <!-- Réglages responsables. -->
            <section v-if="variantsRunning || variantsDone" class="rdbg-section">
              <h4 class="rdbg-h">{{ t('routes.routing_debug.variants_title') }}</h4>
              <div v-if="variantsRunning" class="small text-muted">
                <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
                {{ t('routes.routing_debug.variants_running', { done: progress.done, total: progress.total }) }}
              </div>
              <p v-else-if="!variants.length" class="small text-muted mb-0">
                {{ t('routes.routing_debug.variants_none') }}
              </p>
              <ul v-if="variants.length" class="rdbg-variants">
                <li
                  v-for="v in variants"
                  :key="`${v.key}=${v.value}`"
                  :class="{ 'rdbg-variant--active': previewKey === `${v.key}=${v.value}` }"
                >
                  <div class="rdbg-variant-main">
                    <div class="rdbg-variant-name">{{ t(`routes.routing_profile.param.${v.key}`) }}</div>
                    <div class="small text-muted">
                      {{ paramValueLabel(v.key, v.from) }} → <b>{{ paramValueLabel(v.key, v.value) }}</b>
                      <template v-if="probe && !probe.error">
                        · {{ fmtLen(v.lengthM - probe.currentLengthM) }}
                      </template>
                    </div>
                  </div>
                  <button type="button" class="btn btn-sm btn-outline-secondary" @click="previewVariant(v)">
                    {{ t('routes.routing_debug.see') }}
                  </button>
                  <button type="button" class="btn btn-sm btn-primary" @click="applyVariant(v)">
                    {{ t('routes.routing_debug.apply') }}
                  </button>
                </li>
              </ul>
            </section>

            <button type="button" class="btn btn-sm btn-link px-0 mt-2" @click="clearProbe">
              {{ t('routes.routing_debug.clear') }}
            </button>
          </template>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rdbg-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.rdbg-dialog {
  background: #fff;
  border-radius: 0.75rem;
  width: min(1320px, 96vw);
  height: min(860px, 92vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rdbg-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid #e5e7eb;
  flex: none;
}
.rdbg-title { font-weight: 600; }
.rdbg-profile { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rdbg-close {
  border: none;
  background: transparent;
  font-size: 1.5rem;
  line-height: 1;
  color: #6b7280;
  cursor: pointer;
  padding: 0 0.25rem;
}
.rdbg-close:hover { color: #111827; }
.rdbg-body { display: flex; flex: 1; min-height: 0; }
.rdbg-map-wrap { position: relative; flex: 1; min-width: 0; }
.rdbg-map { position: absolute; inset: 0; cursor: crosshair; }
.rdbg-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.82);
  z-index: 1;
  color: #374151;
}
.rdbg-legend {
  position: absolute;
  left: 0.75rem;
  bottom: 1.6rem;
  z-index: 1;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 0.5rem;
  padding: 0.45rem 0.7rem;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  width: 13rem;
}
.rdbg-ramp { height: 8px; border-radius: 4px; }
.rdbg-ramp-labels { display: flex; justify-content: space-between; font-size: 0.7rem; color: #6b7280; margin-top: 2px; }
.rdbg-panel {
  flex: none;
  width: 380px;
  border-left: 1px solid #e5e7eb;
  background: #f9fafb;
  padding: 0.9rem 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.rdbg-hint { font-size: 0.88rem; color: #4b5563; }
.rdbg-verdict {
  border-radius: 0.5rem;
  padding: 0.55rem 0.7rem;
  font-size: 0.88rem;
  margin-bottom: 0.6rem;
  border: 1px solid transparent;
}
.rdbg-verdict--ok { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
.rdbg-verdict--warn { background: #fffbeb; border-color: #fde68a; color: #92400e; }
.rdbg-verdict--bad { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.rdbg-section { margin-top: 0.8rem; }
.rdbg-h { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin: 0 0 0.35rem; }
.rdbg-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 0.6rem 0.7rem; }
.rdbg-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.5rem; }
.rdbg-chip {
  font-size: 0.74rem;
  background: #f3f4f6;
  border-radius: 0.3rem;
  padding: 0.1rem 0.4rem;
  word-break: break-all;
}
.rdbg-chip--more { color: #6b7280; }
.rdbg-facts { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.8rem; margin: 0; font-size: 0.84rem; }
.rdbg-facts dt { color: #6b7280; font-weight: 400; }
.rdbg-facts dd { margin: 0; font-variant-numeric: tabular-nums; }
.rdbg-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 0.3rem; flex: none; }
.rdbg-ways, .rdbg-variants { list-style: none; margin: 0; padding: 0; }
.rdbg-ways li {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  padding: 0.25rem 0.4rem;
  border-radius: 0.3rem;
}
.rdbg-way--worst { background: #fef3c7; }
.rdbg-way-tags { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rdbg-way-len, .rdbg-way-cost { font-variant-numeric: tabular-nums; color: #4b5563; }
.rdbg-way-cost { min-width: 3.2rem; text-align: right; font-weight: 600; }
.rdbg-variants li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.5rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  margin-bottom: 0.4rem;
}
.rdbg-variant--active { border-color: #c026d3 !important; box-shadow: 0 0 0 1px #c026d3; }
.rdbg-variant-main { flex: 1; min-width: 0; }
.rdbg-variant-name { font-size: 0.85rem; font-weight: 600; }

@media (max-width: 800px) {
  .rdbg-backdrop { padding: 0; }
  .rdbg-dialog { width: 100%; height: 100%; max-height: 100%; border-radius: 0; }
  .rdbg-body { flex-direction: column; }
  .rdbg-map-wrap { flex: 1 1 45%; min-height: 220px; }
  .rdbg-panel { width: auto; flex: 1 1 55%; border-left: none; border-top: 1px solid #e5e7eb; }
}
</style>

<!-- Marqueur du point cliqué : non-scoped, son DOM est créé par MapLibre. -->
<style>
.rdbg-point {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #2563eb;
  border: 3px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
</style>
