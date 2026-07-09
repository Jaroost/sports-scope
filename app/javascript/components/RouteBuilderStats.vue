<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import { routeStore } from '../stores/routeStore'
import { placesStore } from '../stores/placesStore'
import { formatKm, formatDistanceShort, formatDuration } from '../routeHelpers'
import type { Climb } from '../routeHelpers'
import type { Place } from '../stores/placesStore'
import { categoryForType } from '../poiCategories'
import type { Sport } from '../userPreferences'
import { profilesForSport } from '../brouter'

// Catégories d'activité — pilotent la vitesse moyenne (via le profil) et sont
// enregistrées avec l'itinéraire.
const ACTIVITIES = ['cycling', 'mtb', 'hiking'] as const

function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

const props = defineProps<{
  sidebarWidth: number
}>()

const emit = defineEmits<{
  'select-climb': [climb: Climb]
  'hover-climb': [climb: Climb | null]
  'select-place': [place: Place]
  'hover-place': [place: Place | null]
  'retry-places': []
  'change-sport': [sport: Sport]
  'change-profile': [profile: string]
}>()

const climbsExpanded = ref(true)
</script>

<template>
  <div
    class="card shadow-sm border-0 route-stats-sidebar"
    :style="{ width: sidebarWidth + 'px', minWidth: sidebarWidth + 'px' }"
  >
    <div class="card-body d-flex flex-column gap-2 p-3">

      <!-- Distance -->
      <span class="stat-pill stat-pill-distance">
        <i class="fa-solid fa-route" aria-hidden="true"></i>
        <strong>{{ formatKm(routeStore.distanceM.value) }}</strong>
      </span>

      <!-- D+ -->
      <span class="stat-pill stat-pill-up">
        <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
        <strong>+{{ Math.round(routeStore.elevGainM.value) }} m</strong>
      </span>

      <!-- Cols -->
      <template v-if="routeStore.detectedClimbs.value.length">
        <button type="button" class="climbs-section-toggle" @click="climbsExpanded = !climbsExpanded">
          <span class="climbs-section-label">
            <i class="fa-solid fa-mountain" aria-hidden="true"></i>
            {{ climbsExpanded
              ? 'Cols'
              : `${routeStore.detectedClimbs.value.length} col${routeStore.detectedClimbs.value.length > 1 ? 's' : ''}` }}
          </span>
          <i :class="climbsExpanded ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down'" aria-hidden="true"></i>
        </button>
        <template v-if="climbsExpanded">
          <button
            v-for="(climb, idx) in routeStore.detectedClimbs.value"
            :key="idx"
            type="button"
            class="climb-pill"
            @click="emit('select-climb', climb)"
            @mouseenter="emit('hover-climb', climb)"
            @mouseleave="emit('hover-climb', null)"
          >
            <span class="climb-pill-cat" :class="climb.category ? `climb-cat-${climb.category}` : 'climb-cat-uncat'">
              {{ climb.category || 'HC' }}
            </span>
            <span class="climb-pill-stats">
              <span>{{ climb.lengthM >= 1000 ? (climb.lengthM / 1000).toFixed(1) + ' km' : Math.round(climb.lengthM) + ' m' }} · +{{ Math.round(climb.gain) }} m</span>
              <span class="climb-pill-grade">{{ climb.avgGrade.toFixed(1) }}%</span>
            </span>
          </button>
        </template>
      </template>

      <!-- Type d'activité — enregistré avec l'itinéraire, pilote la vitesse moyenne -->
      <div class="activity-toggle btn-group btn-group-sm w-100" role="group" :aria-label="t('routes.wt_sport')">
        <button
          v-for="s in ACTIVITIES"
          :key="s"
          type="button"
          class="btn"
          :class="routeStore.sport.value === s ? 'btn-primary' : 'btn-outline-secondary'"
          :title="t(`routes.wt_sport_${s}`)"
          :aria-label="t(`routes.wt_sport_${s}`)"
          :disabled="routeStore.readOnly.value"
          @click="emit('change-sport', s)"
        >
          <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
          <span class="ms-1 d-none d-sm-inline">{{ t(`routes.wt_sport_${s}`) }}</span>
        </button>
      </div>

      <!-- Profil de routage BRouter — filtré par sport, relance le calcul du tracé -->
      <div class="profile-select">
        <label class="form-label small text-muted mb-1" for="route-profile-select">
          {{ t('routes.profile_label') }}
        </label>
        <select
          id="route-profile-select"
          class="form-select form-select-sm"
          :value="routeStore.profile.value"
          :disabled="routeStore.readOnly.value"
          :title="t(`routes.brouter_profile.${routeStore.profile.value}_desc`)"
          @change="emit('change-profile', ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="p in profilesForSport(routeStore.sport.value)"
            :key="p"
            :value="p"
            :title="t(`routes.brouter_profile.${p}_desc`)"
          >
            {{ t(`routes.brouter_profile.${p}`) }}
          </option>
        </select>
        <p class="profile-desc small text-muted mb-0 mt-1">
          {{ t(`routes.brouter_profile.${routeStore.profile.value}_desc`) }}
        </p>
      </div>

      <!-- Temps estimé -->
      <span class="stat-pill stat-pill-time" :title="t('routes.estimated_time_hint')">
        <span class="d-flex align-items-center gap-2">
          <i class="fa-solid fa-clock" aria-hidden="true"></i>
          <strong>{{ formatDuration(routeStore.estimatedSeconds.value) }}</strong>
        </span>
        <span class="speed-input-wrap">
          <input
            v-model.number="routeStore.avgSpeedKmh.value"
            type="number"
            min="3"
            max="80"
            step="1"
            class="speed-input"
            :title="t('routes.avg_speed_hint')"
            :aria-label="t('routes.avg_speed_hint')"
          />
          <small>km/h</small>
        </span>
      </span>

      <!-- Lieux -->
      <template v-if="placesStore.importantPlaces.value.length || placesStore.isFetchingPlaces.value || placesStore.placesFetchFailed.value">
        <button
          type="button"
          class="places-section-toggle"
          :title="placesStore.placesFetchFailed.value ? t('routes.places_retry') : undefined"
          @click="placesStore.placesFetchFailed.value
            ? emit('retry-places')
            : (placesStore.placesExpanded.value = !placesStore.placesExpanded.value)"
        >
          <span class="places-section-label">
            <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
            {{ placesStore.placesFetchFailed.value || placesStore.placesExpanded.value
              ? t('routes.places_title')
              : `${placesStore.importantPlaces.value.length} ${t('routes.places_count')}` }}
          </span>
          <span v-if="placesStore.isFetchingPlaces.value" class="spinner-border spinner-border-sm text-secondary" aria-hidden="true"></span>
          <i v-else-if="placesStore.placesFetchFailed.value" class="fa-solid fa-rotate-right" aria-hidden="true"></i>
          <i v-else :class="placesStore.placesExpanded.value ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down'" aria-hidden="true"></i>
        </button>
        <div v-if="placesStore.placesFetchFailed.value" class="places-error">
          {{ t('routes.places_error') }}
        </div>
        <template v-if="!placesStore.placesFetchFailed.value && placesStore.placesExpanded.value">
          <div v-if="placesStore.isFetchingPlaces.value && !placesStore.importantPlaces.value.length" class="places-loading">
            <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <span>{{ t('routes.places_loading') }}</span>
          </div>
          <div class="places-filter-bar">
            <button
              v-for="cat in placesStore.presentCategories.value"
              :key="cat.key"
              type="button"
              class="places-filter-btn"
              :class="{ active: placesStore.show[cat.key] }"
              :style="placesStore.show[cat.key] ? { color: cat.color } : undefined"
              :title="t(`profile.poi.${cat.labelKey}`)"
              @click="placesStore.show[cat.key] = !placesStore.show[cat.key]"
            >
              <i class="fa-solid" :class="cat.icon" aria-hidden="true"></i>
            </button>
          </div>
          <div
            v-for="(place, idx) in placesStore.filteredPlaces.value"
            :key="idx"
            class="place-pill"
            :title="place.name"
            style="cursor: pointer"
            @mouseenter="emit('hover-place', place)"
            @mouseleave="emit('hover-place', null)"
            @click="emit('select-place', place)"
          >
            <span class="place-pill-dist">{{ formatDistanceShort(place.distanceM) }}</span>
            <i
              v-if="categoryForType(place.type)"
              class="fa-solid place-pill-icon"
              :class="categoryForType(place.type)!.icon"
              :style="{ color: categoryForType(place.type)!.color }"
              aria-hidden="true"
            ></i>
            <span class="place-pill-name">{{ place.name }}</span>
            <span v-if="categoryForType(place.type)?.point && place.distFromRouteM > 0" class="place-pill-route-dist">
              {{ formatDistanceShort(place.distFromRouteM) }}
            </span>
          </div>
        </template>
      </template>

    </div>
  </div>
</template>

<style scoped>
.route-stats-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.route-stats-sidebar .card-body {
  overflow-y: auto;
  min-height: 0;
}
.stat-pill {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.75rem;
  border-radius: 0.6rem;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}
.stat-pill-distance { background: rgba(252, 76, 2, 0.12); color: #fc4c02; }
.stat-pill-up       { background: rgba(25, 135, 84, 0.12); color: #15803d; }
.stat-pill-time     { background: rgba(13, 110, 253, 0.10); color: #0d6efd; flex-direction: column; align-items: flex-start; gap: 0.3rem; }
.stat-pill-time .speed-input-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 0.15rem;
}
.stat-pill-time .speed-input-wrap small { font-size: 0.7rem; opacity: 0.75; }
.stat-pill-time .speed-input {
  width: 2.6rem;
  border: 1px solid rgba(13, 110, 253, 0.25);
  background: rgba(255, 255, 255, 0.6);
  color: inherit;
  border-radius: 4px;
  padding: 0 0.25rem;
  font-size: 0.78rem;
  font-weight: 600;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}
.stat-pill-time .speed-input::-webkit-inner-spin-button,
.stat-pill-time .speed-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.stat-pill-time .speed-input:focus { outline: none; border-color: #0d6efd; }

.climbs-section-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.35rem 0.75rem;
  border: none;
  border-radius: 0.6rem;
  background: rgba(25, 135, 84, 0.12);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  color: #15803d;
}
.climbs-section-toggle:hover { background: rgba(25, 135, 84, 0.20); }
.climbs-section-label { display: flex; align-items: center; gap: 0.4rem; }

.climb-pill {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 0.5rem;
  background: #f9fafb;
  cursor: pointer;
  text-align: left;
  font-size: 0.8rem;
  transition: background 0.1s, border-color 0.1s;
}
.climb-pill:hover { background: #f0fdf4; border-color: #16a34a; }
.climb-pill-cat { font-weight: 700; font-size: 0.72rem; min-width: 1.5rem; text-align: center; flex-shrink: 0; }
.climb-pill-stats { display: flex; flex-direction: column; line-height: 1.25; color: #374151; }
.climb-pill-grade { color: #6b7280; font-size: 0.73rem; }

.climb-cat-HC    { color: #111827; }
.climb-cat-1     { color: #b91c1c; }
.climb-cat-2     { color: #ea580c; }
.climb-cat-3     { color: #ca8a04; }
.climb-cat-4     { color: #16a34a; }
.climb-cat-uncat { color: #6c757d; }

.places-section-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.35rem 0.75rem;
  border: none;
  border-radius: 0.6rem;
  background: rgba(13, 110, 253, 0.10);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1d4ed8;
}
.places-section-toggle:hover { background: rgba(13, 110, 253, 0.18); }
.places-section-label { display: flex; align-items: center; gap: 0.4rem; }

.place-pill {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 0.5rem;
  background: #f9fafb;
  font-size: 0.8rem;
}
.place-pill:hover { background: #eff6ff; border-color: rgba(13,110,253,0.25); }
.place-pill-dist { flex-shrink: 0; font-weight: 600; font-variant-numeric: tabular-nums; color: #6b7280; min-width: 2.5rem; text-align: right; }
.place-pill-name { color: #1f2937; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.place-pill-icon { font-size: 0.65rem; color: #6b7280; flex-shrink: 0; }
.place-pill-route-dist { flex-shrink: 0; font-size: 0.72rem; color: #9ca3af; font-variant-numeric: tabular-nums; white-space: nowrap; }

.places-filter-bar { display: flex; align-items: center; gap: 0.3rem; padding: 0.1rem 0.6rem 0.35rem; }
.places-filter-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.18rem 0.5rem;
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 999px;
  background: #f3f4f6;
  color: #9ca3af;
  font-size: 0.68rem;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.places-filter-btn.active { background: rgba(13, 110, 253, 0.1); border-color: rgba(13, 110, 253, 0.35); color: #0d6efd; }
.places-loading { font-size: 0.78rem; color: #9ca3af; display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.4rem; }
.places-error { font-size: 0.75rem; color: #dc3545; padding: 0.1rem 0.6rem 0.3rem; }
</style>
