<script setup lang="ts">
// ActivityDetail is now a slim coordinator: it owns the data fetches and the
// cross-component state that bridges the three big children below. All UI
// lives in the sub-components.
//
//   ActivityMapCard ── owns the Maplibre instance, markers, route hover
//   ActivityCharts  ── owns chartLayout, Chart.js instances, drag/zoom
//   ActivityStats   ── owns the climb + peak-power tables (presentational)
//   PhotoGallery    ── owns the gallery grid + the Teleport'd lightbox
//
// The parent's job is to glue them together via the shared refs documented
// in the "Cross-component state" block below.

import { ref, onMounted, computed, watch } from 'vue'
import { t } from '../i18n'
import { PEAK_POWER_DURATIONS, detectPauses, totalPausedSeconds } from '../activityHelpers'
// Même détection de cols et même pente lissée (fenêtre du profil) que le créateur
// d'itinéraire, pour que carte, graphique et tableau de cols soient cohérents.
import { detectClimbs, gradeForIndex } from '../routeHelpers'
import PhotoGallery from './PhotoGallery.vue'
import ActivityStats from './ActivityStats.vue'
import ActivityMapCard from './ActivityMapCard.vue'
import ActivityCharts from './ActivityCharts.vue'
import ActivityConditions from './ActivityConditions.vue'

const props = defineProps({
  activityId: { type: [String, Number], required: true },
  source: { type: String, default: 'strava' }, // 'strava' or 'imported'
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

// ─── Endpoint URLs (Strava vs FIT-imported) ──────────────────────────────
const activityUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}`
  : `/strava/activities/${props.activityId}`)
const streamsUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}/streams`
  : `/strava/activities/${props.activityId}/streams`)
const photosUrl = computed(() => props.source === 'imported'
  ? null // imported (FIT) has no photos
  : `/strava/activities/${props.activityId}/photos`)
const peakPowerRanksUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}/peak_power_ranks`
  : `/strava/activities/${props.activityId}/peak_power_ranks`)

// ─── Data state ──────────────────────────────────────────────────────────
const loading = ref(true)
const error = ref(null)
const activity = ref(null)
const streams = ref(null)
const streamsLoading = ref(false)
const streamsError = ref(null)
const photos = ref([])
const peakPowerRanks = ref(null) // { current: {dur: w}, bests: {dur: {avg_watts, …}} } | null
// Conditions météo du jour (matériel Strava + vent) — reconstituées via /api/weather
// à partir de la position de départ et de l'heure de l'activité.
const weather = ref(null)
const weatherLoading = ref(false)

// ─── Cross-component state ───────────────────────────────────────────────
// `selection` is the rendezvous between map (segment highlight + A/B handles),
// charts (range band + flags), and stats (active row).
const selection = ref(null) // { startIdx, endIdx } | null
// `hoveredClimbStartIdx` syncs map climb markers ↔ stats table rows.
const hoveredClimbStartIdx = ref(null)
// `lightboxIndex` syncs map photo markers ↔ gallery → lightbox.
const lightboxIndex = ref(null)
// Charts owns the chart-related UI state but lifts these to the parent so
// MapCard can build the same hover tooltip and the parent can persist the
// "collapsed" toggle to localStorage.
const xAxis = ref('distance')
const zoomRange = ref(null) // { xMin, xMax } | null
const visibleStreams = ref([])
// « Couleur des tracés » — possédée par ActivityMapCard (bouton palette de la carte),
// remontée ici pour que ActivityCharts colore aussi le profil d'altitude par pente.
const showGrade = ref(true)
// `*Collapsed` are persisted across reloads — the children mutate them via
// v-model, we mirror to localStorage in the watchers below.
const galleryCollapsed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.galleryCollapsed') === '1',
)
const statsCollapsed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.statsCollapsed') === '1',
)
const chartsCollapsed = ref(
  typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.chartsCollapsed') === '1',
)
// `hoveredPeakDuration` was previously also lifted; the peak-power table is
// the only consumer, so it lives entirely inside ActivityStats. We keep a
// local ref here to bind v-model since the prop API expects it.
const hoveredPeakDuration = ref(null)

// ─── Onglets d'analyse ────────────────────────────────────────────────────
// La carte reste toujours affichée au-dessus ; photos / puissance & cols /
// graphiques basculent dans des onglets pour libérer de la place verticale.
// L'onglet actif est persisté comme les toggles « collapsed » ci-dessus.
const TABS = ['photos', 'power', 'analysis']
const savedTab = (typeof localStorage !== 'undefined' && localStorage.getItem('sportsScope.activityTab')) || ''
const activeTab = ref(TABS.includes(savedTab) ? savedTab : 'analysis')
const hasPhotos = computed(() => photos.value.length > 0)
// L'onglet photos n'existe que s'il y a des photos : si l'onglet demandé est
// « photos » alors qu'il n'y en a pas, on affiche les graphiques à la place.
const effectiveTab = computed(() =>
  activeTab.value === 'photos' && !hasPhotos.value ? 'analysis' : activeTab.value,
)
watch(activeTab, (v) => {
  try { localStorage.setItem('sportsScope.activityTab', v) } catch { /* ignore */ }
})

// ─── Computed stats fed into ActivityStats ───────────────────────────────
// elapsed - moving = stopped time (red lights, refueling, etc.).
const movingStats = computed(() => {
  const elapsed = activity.value?.elapsed_time
  const moving = activity.value?.moving_time
  if (!Number.isFinite(elapsed) || !Number.isFinite(moving)) return null
  let stopped = Math.max(0, elapsed - moving)
  // Quand le capteur coupe l'enregistrement au lieu de marquer `moving: false`, le
  // résumé Strava renvoie moving_time == elapsed_time et `stopped` vaut 0 à tort. Les
  // streams sont alors la seule mesure des arrêts (cf. detectPauses). On recale `moving`
  // sur ce qui reste, pour que moving + stopped == elapsed reste vrai.
  if (stopped <= 0) {
    const detected = totalPausedSeconds(
      detectPauses(streams.value?.time?.data, streams.value?.moving?.data),
    )
    if (detected > 0) stopped = Math.min(detected, elapsed)
  }
  const stopPct = elapsed > 0 ? (stopped / elapsed) * 100 : 0
  return { elapsed, moving: Math.max(0, elapsed - stopped), stopped, stopPct }
})

// Une activité sans GPS (squash, tapis, muscu…) n'a pas de déplacement à mesurer :
// son éventuel stream `altitude` n'est que la dérive du baromètre. La VAM globale
// n'a alors aucun sens — même garde que les pastilles D+/D-/VAM d'ActivityCharts.
const hasGps = computed(() => {
  const ll = streams.value?.latlng?.data
  if (Array.isArray(ll) && ll.length > 0) return true
  const dist = streams.value?.distance?.data
  return Array.isArray(dist) && dist.length > 0 && dist[dist.length - 1] > 0
})

// Global VAM (m/h). Falls back to elapsed_time when moving_time is missing.
const globalVam = computed(() => {
  const gain = activity.value?.total_elevation_gain
  const denomS = movingStats.value?.moving ?? activity.value?.elapsed_time
  if (!hasGps.value) return null
  if (!Number.isFinite(gain) || gain <= 0 || !Number.isFinite(denomS) || denomS <= 0) return null
  return (gain / denomS) * 3600
})

// Best average power per standard duration (peak-power curve). Uses a
// cumulative-energy integral so non-uniform sampling and stoppages don't
// distort the result: avg = (E[j] - E[i]) / (time[j] - time[i]).
const peakPowers = computed(() => {
  const times = streams.value?.time?.data
  const watts = streams.value?.watts?.data
  if (!Array.isArray(times) || !Array.isArray(watts) || times.length < 2) return []
  const n = Math.min(times.length, watts.length)
  if (n < 2) return []
  const E = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1]
    const w = watts[i - 1]
    const wv = (typeof w === 'number' && Number.isFinite(w)) ? w : 0
    E[i] = E[i - 1] + wv * Math.max(0, dt)
  }
  const totalSpan = times[n - 1] - times[0]
  const out = []
  for (const D of PEAK_POWER_DURATIONS) {
    if (D > totalSpan) break
    let best = null
    let bestStart = null
    let bestEnd = null
    let j = 0
    for (let i = 0; i < n; i++) {
      while (j < n && times[j] - times[i] < D) j++
      if (j >= n) break
      const dt = times[j] - times[i]
      if (dt <= 0) continue
      const avg = (E[j] - E[i]) / dt
      if (best == null || avg > best) {
        best = avg
        bestStart = i
        bestEnd = j
      }
    }
    if (best != null && Number.isFinite(best) && best > 0) {
      out.push({ duration: D, avgPower: best, startIdx: bestStart, endIdx: bestEnd })
    }
  }
  return out
})

// Per-climb stats enriched with duration + VAM. detectClimbs already gives
// gain/lengthM/avgGrade/category; we add the per-climb time and VAM.
const climbsWithVam = computed(() => {
  if (!streams.value) return []
  const alt = streams.value.altitude?.data
  const dist = streams.value.distance?.data
  const time = streams.value.time?.data
  if (!Array.isArray(alt) || !Array.isArray(dist) || alt.length === 0) return []
  const climbs = detectClimbs(alt, dist)
  return climbs.map((c) => {
    const t0 = Array.isArray(time) ? time[c.startIdx] : null
    const t1 = Array.isArray(time) ? time[c.endIdx] : null
    const duration = (t0 != null && t1 != null) ? Math.max(0, t1 - t0) : null
    const vam = (duration && c.gain > 0) ? (c.gain / duration) * 3600 : null
    return { ...c, duration, vam }
  })
})

// ─── Selection helpers ───────────────────────────────────────────────────
function setSelection(startIdx, endIdx) {
  if (startIdx == null || endIdx == null) {
    selection.value = null
    return
  }
  let s = Math.max(0, Math.min(startIdx, endIdx))
  let e = Math.max(startIdx, endIdx)
  // We don't track which axis is active here (lives in ActivityCharts); fall
  // back to time/distance/latlng for bounds — they share lengths.
  const refLen = streams.value?.time?.data?.length
    || streams.value?.distance?.data?.length
    || streams.value?.latlng?.data?.length
    || 1
  e = Math.min(refLen - 1, e)
  selection.value = { startIdx: s, endIdx: e }
}

function clearSelection() {
  // The map's A/B handles snap back to the route ends via ActivityMapCard's
  // own watcher; the chart's overlay clears via ActivityCharts'.
  selection.value = null
}

// ─── Fetches ─────────────────────────────────────────────────────────────
async function fetchActivity() {
  try {
    const res = await fetch(activityUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (res.status === 404) {
      error.value = t('strava.activity_not_found')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    activity.value = payload.activity
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Remplace le stream `grade_smooth` brut de Strava par une pente recalculée depuis
// l'altitude avec la fenêtre de lissage du profil (gradeForIndex). Le graphique, le
// tooltip et les stats de pente reflètent ainsi la même pente que la carte et le
// créateur d'itinéraire. Sans altitude/distance, on laisse les streams intacts.
function withSmoothedGrade(s) {
  const alt = s?.altitude?.data
  const dist = s?.distance?.data
  if (!Array.isArray(alt) || !Array.isArray(dist) || alt.length < 2) return s
  const n = Math.min(alt.length, dist.length)
  const grade = new Array(n)
  for (let i = 0; i < n; i++) grade[i] = gradeForIndex(Math.min(i, n - 2), alt, dist)
  return { ...s, grade_smooth: { ...(s.grade_smooth || {}), data: grade } }
}

async function fetchStreams() {
  streamsLoading.value = true
  streamsError.value = null
  try {
    const res = await fetch(streamsUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    streams.value = withSmoothedGrade(payload.streams || {})
    // Une activité sans GPS (squash, tapis, muscu…) n'a pas de flux `distance` :
    // l'axe des abscisses par défaut n'a alors rien à mesurer, on bascule sur le temps.
    if (!streams.value.distance?.data?.length) xAxis.value = 'time'
  } catch (e) {
    streamsError.value = e.message
  } finally {
    streamsLoading.value = false
  }
}

async function fetchPhotos() {
  if (!photosUrl.value) { photos.value = []; return }
  try {
    const res = await fetch(photosUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    photos.value = Array.isArray(payload.photos) ? payload.photos : []
  } catch {
    photos.value = []
  }
}

// Conditions météo du jour de l'activité. Best-effort : on lit la position de
// départ (start_latlng) et l'heure UTC (start_date) puis on interroge notre proxy
// Open-Meteo. Sans coordonnées ou sans date, on n'affiche rien.
async function fetchWeather() {
  weather.value = null
  const ll = activity.value?.start_latlng
  const at = activity.value?.start_date || activity.value?.start_date_local
  if (!Array.isArray(ll) || ll.length !== 2 || !at) return
  const [lat, lng] = ll
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return

  weatherLoading.value = true
  try {
    const url = `/api/weather?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&at=${encodeURIComponent(at)}`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (res.status === 204 || !res.ok) return
    const payload = await res.json()
    weather.value = payload.weather || null
  } catch {
    // Best-effort — le bandeau conditions s'affiche sans la météo (matériel seul).
  } finally {
    weatherLoading.value = false
  }
}

// All-time peak-power ranks — works for both Strava (cached server-side) and
// imported (persisted alongside the FIT data).
async function fetchPeakPowerRanks() {
  peakPowerRanks.value = null
  try {
    const res = await fetch(peakPowerRanksUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    peakPowerRanks.value = await res.json()
  } catch {
    // Best-effort — the table still renders without rank badges.
  }
}

// ─── Persistence watchers (children mutate via v-model) ──────────────────
watch(galleryCollapsed, (v) => {
  try { localStorage.setItem('sportsScope.galleryCollapsed', v ? '1' : '0') } catch { /* ignore */ }
})
watch(statsCollapsed, (v) => {
  try { localStorage.setItem('sportsScope.statsCollapsed', v ? '1' : '0') } catch { /* ignore */ }
})
watch(chartsCollapsed, (v) => {
  try { localStorage.setItem('sportsScope.chartsCollapsed', v ? '1' : '0') } catch { /* ignore */ }
})

onMounted(async () => {
  fetchPhotos()
  await fetchActivity()
  if (!activity.value) return
  // Fire-and-forget — le bandeau conditions se remplit dès que la météo arrive.
  fetchWeather()
  await fetchStreams()
  // Fire-and-forget — the table renders fine without ranks.
  fetchPeakPowerRanks()
})
</script>

<template>
  <div>
    <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>Loading…</span>
    </div>
    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>
    <div v-else-if="activity">
      <ActivityMapCard
        :activity="activity"
        :streams="streams"
        :photos="photos"
        :selection="selection"
        :visible-streams="visibleStreams"
        :x-axis="xAxis"
        v-model:hovered-climb-start-idx="hoveredClimbStartIdx"
        v-model:lightbox-index="lightboxIndex"
        :locale-prefix="localePrefix"
        @update:show-grade="showGrade = $event"
        @select-segment="(s, e) => setSelection(s, e)"
        @clear-selection="clearSelection"
      />

      <!-- Matériel Strava + météo du jour (best-effort). -->
      <ActivityConditions
        :activity="activity"
        :weather="weather"
        :weather-loading="weatherLoading"
      />

      <!-- Onglets d'analyse — la carte ci-dessus reste toujours visible. -->
      <div class="btn-group btn-group-sm activity-tabs mt-3" role="group" :aria-label="t('strava.tabs.analysis')">
        <button
          v-if="hasPhotos"
          type="button"
          class="btn d-flex align-items-center gap-2"
          :class="effectiveTab === 'photos' ? 'btn-warning' : 'btn-outline-secondary'"
          :aria-pressed="effectiveTab === 'photos'"
          @click="activeTab = 'photos'"
        >
          <i class="fa-solid fa-images" aria-hidden="true"></i>
          <span>{{ t('strava.tabs.photos') }} ({{ photos.length }})</span>
        </button>
        <button
          type="button"
          class="btn d-flex align-items-center gap-2"
          :class="effectiveTab === 'power' ? 'btn-warning' : 'btn-outline-secondary'"
          :aria-pressed="effectiveTab === 'power'"
          @click="activeTab = 'power'"
        >
          <i class="fa-solid fa-bolt" aria-hidden="true"></i>
          <span>{{ t('strava.tabs.stats') }}</span>
        </button>
        <button
          type="button"
          class="btn d-flex align-items-center gap-2"
          :class="effectiveTab === 'analysis' ? 'btn-warning' : 'btn-outline-secondary'"
          :aria-pressed="effectiveTab === 'analysis'"
          @click="activeTab = 'analysis'"
        >
          <i class="fa-solid fa-chart-line" aria-hidden="true"></i>
          <span>{{ t('strava.tabs.analysis') }}</span>
        </button>
      </div>

      <!-- PhotoGallery reste toujours monté (même hors onglet) pour que la
           lightbox déclenchée par les marqueurs photo de la carte fonctionne
           quel que soit l'onglet actif ; seule sa grille suit l'onglet. -->
      <PhotoGallery
        :photos="photos"
        :active="effectiveTab === 'photos'"
        v-model:lightbox-index="lightboxIndex"
        v-model:collapsed="galleryCollapsed"
      />

      <ActivityStats
        v-if="effectiveTab === 'power'"
        class="mb-3"
        :moving-stats="movingStats"
        :global-vam="globalVam"
        :climbs-with-vam="climbsWithVam"
        :peak-powers="peakPowers"
        :peak-power-ranks="peakPowerRanks"
        :selection="selection"
        v-model:hovered-climb-start-idx="hoveredClimbStartIdx"
        v-model:hovered-peak-duration="hoveredPeakDuration"
        v-model:collapsed="statsCollapsed"
        @select-segment="(s, e) => setSelection(s, e)"
      />

      <ActivityCharts
        v-if="effectiveTab === 'analysis'"
        class="mb-3"
        :streams="streams"
        :activity="activity"
        :streams-loading="streamsLoading"
        :streams-error="streamsError"
        :selection="selection"
        :show-grade="showGrade"
        v-model:x-axis="xAxis"
        v-model:visible-streams="visibleStreams"
        v-model:zoom-range="zoomRange"
        v-model:collapsed="chartsCollapsed"
        @select-segment="(s, e) => setSelection(s, e)"
        @clear-selection="clearSelection"
      />
    </div>
  </div>
</template>
