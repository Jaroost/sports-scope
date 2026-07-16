<script setup lang="ts">
import { computed } from 'vue'
import { type PropType } from 'vue'
import { t } from '../i18n'
import { formatHMS, formatKm, formatPowerDuration, type ClimbSegment } from '../activityHelpers'

interface ClimbWithVam extends ClimbSegment {
  duration: number | null
  vam: number | null
}

interface PeakPower {
  duration: number
  avgPower: number
  startIdx: number
  endIdx: number
}

const props = defineProps({
  movingStats: { type: Object as PropType<{ moving: number; elapsed: number; stopped: number; stopPct: number } | null>, default: null },
  globalVam: { type: Number, default: null },
  climbsWithVam: { type: Array as PropType<ClimbWithVam[]>, default: () => [] },
  peakPowers: { type: Array as PropType<PeakPower[]>, default: () => [] },
  // { current: {dur: w}, bests: {dur: { avg_watts, source, external_id, started_at }} } | null
  peakPowerRanks: { type: Object as PropType<Record<string, any> | null>, default: null },
  // The whole-activity selection (drives row highlight on map AND in here).
  selection: { type: Object, default: null },
  // v-model:hovered-climb-start-idx — synced with the map markers in the parent.
  hoveredClimbStartIdx: { type: Number, default: null },
  // v-model:hovered-peak-duration — local to this component but lifted for consistency.
  hoveredPeakDuration: { type: Number, default: null },
  // v-model:collapsed — persisted by the parent (localStorage).
  collapsed: { type: Boolean, default: false },
})

const emit = defineEmits([
  'select-segment',
  'update:hoveredClimbStartIdx',
  'update:hoveredPeakDuration',
  'update:collapsed',
])

const hasContent = computed(() =>
  props.movingStats || props.globalVam != null
  || props.climbsWithVam.length > 0
  || props.peakPowers.length > 0,
)

function isClimbSelected(c) {
  const s = props.selection
  return !!s && s.startIdx === c.startIdx && s.endIdx === c.endIdx
}

function isPeakPowerSelected(pp) {
  const s = props.selection
  return !!s && s.startIdx === pp.startIdx && s.endIdx === pp.endIdx
}

// For a row in the peak-power table, label its rank vs. the user's history.
// Same semantics as before extraction: 'pr' = strictly better than the best
// known prior effort, 'tied' = within ±0.5 W, otherwise null (we surface the
// historical best instead).
function peakPowerRankLabel(pp) {
  const bests = props.peakPowerRanks?.bests
  if (!bests) return null
  const best = bests[String(pp.duration)]
  if (!best || !Number.isFinite(best.avg_watts)) return 'pr'
  const delta = pp.avgPower - best.avg_watts
  if (delta > 0.5) return 'pr'
  if (Math.abs(delta) <= 0.5) return 'tied'
  return null
}

function peakPowerBestFor(pp) {
  return props.peakPowerRanks?.bests?.[String(pp.duration)] || null
}

function selectClimb(c) { emit('select-segment', c.startIdx, c.endIdx) }
function selectPeak(pp) { emit('select-segment', pp.startIdx, pp.endIdx) }

function setHoveredClimb(idx) { emit('update:hoveredClimbStartIdx', idx) }
function setHoveredPeak(dur)  { emit('update:hoveredPeakDuration', dur) }

function toggleCollapsed() { emit('update:collapsed', !props.collapsed) }
</script>

<template>
  <div v-if="hasContent" class="card shadow-sm border-0 mt-3">
    <div class="card-header activity-card-header d-flex align-items-center gap-2">
      <i class="fa-solid fa-chart-simple text-warning" aria-hidden="true"></i>
      <h3 class="h6 mb-0">{{ t('strava.stats.title') }}</h3>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary ms-auto"
        :title="collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
        :aria-pressed="collapsed"
        @click="toggleCollapsed"
      >
        <i :class="collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
      </button>
    </div>
    <div v-if="!collapsed" class="card-body">
      <!-- Top-line stats: temps actif / arrêts / VAM globale -->
      <div v-if="movingStats || globalVam != null" class="row g-3 mb-3 stats-pills-row">
        <div v-if="movingStats" class="col-6 col-md-3">
          <div class="stat-card">
            <span class="stat-icon"><i class="fa-solid fa-person-biking text-success" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.moving') }}</div>
              <strong>{{ formatHMS(movingStats.moving) }}</strong>
            </div>
          </div>
        </div>
        <div v-if="movingStats" class="col-6 col-md-3">
          <div class="stat-card">
            <span class="stat-icon"><i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.elapsed') }}</div>
              <strong>{{ formatHMS(movingStats.elapsed) }}</strong>
            </div>
          </div>
        </div>
        <div v-if="movingStats" class="col-6 col-md-3">
          <div class="stat-card">
            <span class="stat-icon"><i class="fa-solid fa-pause text-secondary" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">
                {{ t('strava.stats.stopped') }}
                <span v-if="movingStats.elapsed > 0" class="text-muted">· {{ movingStats.stopPct.toFixed(0) }} %</span>
              </div>
              <strong>{{ formatHMS(movingStats.stopped) }}</strong>
            </div>
          </div>
        </div>
        <div v-if="globalVam != null" class="col-6 col-md-3">
          <div class="stat-card" :title="t('strava.stats.vam_hint')">
            <span class="stat-icon"><i class="fa-solid fa-mountain text-success" aria-hidden="true"></i></span>
            <div>
              <div class="text-muted small">{{ t('strava.stats.vam_global') }}</div>
              <strong>{{ Math.round(globalVam) }} m/h</strong>
            </div>
          </div>
        </div>
      </div>

      <!-- Climbs (per-climb VAM) -->
      <div v-if="climbsWithVam.length > 0" class="stats-section">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.climbs_title') }}</span>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th>#</th>
                <th :title="t('strava.stats.col_length')">
                  <i class="fa-solid fa-route text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_length') }}</span>
                </th>
                <th :title="t('strava.stats.col_gain')">
                  <i class="fa-solid fa-arrow-trend-up text-success" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_gain') }}</span>
                </th>
                <th :title="t('strava.stats.col_grade')">
                  <i class="fa-solid fa-slash text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_grade') }}</span>
                </th>
                <th :title="t('strava.stats.col_time')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_time') }}</span>
                </th>
                <th :title="t('strava.stats.col_vam')">
                  <i class="fa-solid fa-mountain text-success" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_vam') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(c, i) in climbsWithVam"
                :key="`climb-${i}`"
                class="climb-row"
                :class="{
                  'climb-row-active': isClimbSelected(c),
                  'climb-row-hover': hoveredClimbStartIdx === c.startIdx,
                }"
                role="button"
                tabindex="0"
                :title="t('strava.click_to_select_climb')"
                :aria-pressed="isClimbSelected(c)"
                @click="selectClimb(c)"
                @keydown.enter.prevent="selectClimb(c)"
                @keydown.space.prevent="selectClimb(c)"
                @mouseenter="setHoveredClimb(c.startIdx)"
                @mouseleave="setHoveredClimb(null)"
                @focus="setHoveredClimb(c.startIdx)"
                @blur="setHoveredClimb(null)"
              >
                <td>
                  <span class="climb-cat-badge" :class="`climb-cat-${c.category || 'HC'}`">
                    <span>{{ c.category ? `Cat ${c.category}` : 'HC' }}</span>
                  </span>
                </td>
                <td>{{ formatKm(c.lengthM) }}</td>
                <td>+{{ Math.round(c.gain) }} m</td>
                <td>{{ c.avgGrade.toFixed(1) }} %</td>
                <td>{{ c.duration != null ? formatHMS(c.duration) : '–' }}</td>
                <td>{{ c.vam != null ? `${Math.round(c.vam)} m/h` : '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Peak average power per duration (shortest → longest). -->
      <div v-if="peakPowers.length > 0" class="stats-section mt-3">
        <h4 class="h6 mb-2 d-flex align-items-center gap-2">
          <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.stats.peak_power_title') }}</span>
        </h4>
        <div class="table-responsive stats-table-scroll">
          <table class="table table-sm stats-table align-middle mb-0">
            <thead>
              <tr>
                <th :title="t('strava.stats.col_duration')">
                  <i class="fa-regular fa-clock text-secondary" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_duration') }}</span>
                </th>
                <th :title="t('strava.stats.col_power')">
                  <i class="fa-solid fa-bolt text-warning" aria-hidden="true"></i>
                  <span class="visually-hidden">{{ t('strava.stats.col_power') }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="pp in peakPowers"
                :key="`peak-${pp.duration}`"
                class="climb-row"
                :class="{
                  'climb-row-active': isPeakPowerSelected(pp),
                  'climb-row-hover': hoveredPeakDuration === pp.duration,
                }"
                role="button"
                tabindex="0"
                :title="t('strava.click_to_select_peak_power')"
                :aria-pressed="isPeakPowerSelected(pp)"
                @click="selectPeak(pp)"
                @keydown.enter.prevent="selectPeak(pp)"
                @keydown.space.prevent="selectPeak(pp)"
                @mouseenter="setHoveredPeak(pp.duration)"
                @mouseleave="setHoveredPeak(null)"
                @focus="setHoveredPeak(pp.duration)"
                @blur="setHoveredPeak(null)"
              >
                <td>{{ formatPowerDuration(pp.duration) }}</td>
                <td class="d-flex align-items-center gap-2 flex-wrap">
                  <span>{{ Math.round(pp.avgPower) }} W</span>
                  <span
                    v-if="peakPowerRankLabel(pp) === 'pr'"
                    class="peak-power-badge peak-power-badge-pr"
                    :title="t('strava.stats.peak_power_pr_hint')"
                  >
                    <i class="fa-solid fa-trophy" aria-hidden="true"></i>
                    <span>{{ t('strava.stats.peak_power_pr') }}</span>
                  </span>
                  <span
                    v-else-if="peakPowerRankLabel(pp) === 'tied'"
                    class="peak-power-badge peak-power-badge-tied"
                    :title="t('strava.stats.peak_power_tied_hint')"
                  >
                    <i class="fa-solid fa-equals" aria-hidden="true"></i>
                    <span>{{ t('strava.stats.peak_power_tied') }}</span>
                  </span>
                  <span
                    v-else-if="peakPowerBestFor(pp)"
                    class="peak-power-best text-muted small"
                    :title="t('strava.stats.peak_power_best_hint')"
                  >
                    <i class="fa-regular fa-star" aria-hidden="true"></i>
                    {{ Math.round(peakPowerBestFor(pp).avg_watts) }} W
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }

/* Inline category badge — paints its background from `currentColor` (set by
   the .climb-cat-* class) so each category gets its bucket colour. */
.climb-cat-badge {
  display: inline-flex;
  align-items: center;
  background: currentColor;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.4;
}
.climb-cat-badge > span { color: #fff; }

.stats-section + .stats-section { border-top: 1px dashed rgba(0, 0, 0, 0.08); padding-top: 0.75rem; }
.stats-table th {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6c757d;
  font-weight: 600;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.stats-table td {
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
}
.stats-table-scroll {
  max-height: 360px;
  overflow-y: auto;
}
.stats-table-scroll thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fff;
}

/* Clickable rows mirror selection state on the map + chart. The hover/active
   colouring is applied on the <td> because Bootstrap paints --bs-table-bg on
   cells, which masks any background set on the <tr>. */
.climb-row { cursor: pointer; }
.climb-row > td { transition: background-color 0.12s, box-shadow 0.12s; }
.climb-row:hover > td,
.climb-row-hover > td {
  background-color: rgba(252, 76, 2, 0.12);
}
.climb-row:focus-visible { outline: none; }
.climb-row:focus-visible > td {
  box-shadow: inset 0 2px 0 rgba(252, 76, 2, 0.55),
              inset 0 -2px 0 rgba(252, 76, 2, 0.55);
}
.climb-row:focus-visible > td:first-child { box-shadow: inset 2px 0 0 rgba(252, 76, 2, 0.55), inset 0 2px 0 rgba(252, 76, 2, 0.55), inset 0 -2px 0 rgba(252, 76, 2, 0.55); }
.climb-row:focus-visible > td:last-child  { box-shadow: inset -2px 0 0 rgba(252, 76, 2, 0.55), inset 0 2px 0 rgba(252, 76, 2, 0.55), inset 0 -2px 0 rgba(252, 76, 2, 0.55); }
.climb-row-active > td,
.climb-row-active:hover > td,
.climb-row-active.climb-row-hover > td {
  background-color: rgba(252, 76, 2, 0.22);
  font-weight: 600;
}

/* Personal-best badges on the peak-power table. `-pr` is the highlight, `-tied`
   is a soft variant when values match within rounding tolerance. */
.peak-power-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.peak-power-badge-pr {
  background: rgba(255, 193, 7, 0.18);
  color: #b45309;
  border: 1px solid rgba(180, 83, 9, 0.35);
}
.peak-power-badge-tied {
  background: rgba(108, 117, 125, 0.14);
  color: #495057;
  border: 1px solid rgba(108, 117, 125, 0.3);
}
.peak-power-best {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-variant-numeric: tabular-nums;
}
</style>
