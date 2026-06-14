<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'
import { routeStore } from '../stores/routeStore'
import { placesStore } from '../stores/placesStore'
import { formatKm, formatDistanceShort, formatDuration } from '../routeHelpers'
import type { Climb } from '../routeHelpers'
import type { Place } from '../stores/placesStore'

const props = defineProps<{
  sidebarWidth: number
}>()

const emit = defineEmits<{
  'select-climb': [climb: Climb]
  'hover-climb': [climb: Climb | null]
  'select-place': [place: Place]
  'hover-place': [place: Place | null]
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
            @change="routeStore.persistSpeed()"
          />
          <small>km/h</small>
        </span>
      </span>

      <!-- Lieux -->
      <template v-if="placesStore.importantPlaces.value.length || placesStore.isFetchingPlaces.value">
        <button type="button" class="places-section-toggle" @click="placesStore.placesExpanded.value = !placesStore.placesExpanded.value">
          <span class="places-section-label">
            <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
            {{ placesStore.placesExpanded.value
              ? t('routes.places_title')
              : `${placesStore.importantPlaces.value.length} ${t('routes.places_count')}` }}
          </span>
          <span v-if="placesStore.isFetchingPlaces.value" class="spinner-border spinner-border-sm text-secondary" aria-hidden="true"></span>
          <i v-else :class="placesStore.placesExpanded.value ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down'" aria-hidden="true"></i>
        </button>
        <template v-if="placesStore.placesExpanded.value">
          <div v-if="placesStore.isFetchingPlaces.value && !placesStore.importantPlaces.value.length" class="places-loading">
            <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <span>{{ t('routes.places_loading') }}</span>
          </div>
          <div v-if="placesStore.hasCemeteryPlaces.value || placesStore.hasLocalityPlaces.value" class="places-filter-bar">
            <button
              v-if="placesStore.hasLocalityPlaces.value"
              type="button"
              class="places-filter-btn"
              :class="{ active: placesStore.placeShowLocalities.value }"
              @click="placesStore.placeShowLocalities.value = !placesStore.placeShowLocalities.value"
            >
              <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
            </button>
            <button
              v-if="placesStore.hasCemeteryPlaces.value"
              type="button"
              class="places-filter-btn"
              :class="{ active: placesStore.placeShowCemeteries.value }"
              @click="placesStore.placeShowCemeteries.value = !placesStore.placeShowCemeteries.value"
            >
              <i class="fa-solid fa-cross" aria-hidden="true"></i>
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
            <i v-if="place.type === 'cemetery'" class="fa-solid fa-cross place-pill-icon" aria-hidden="true"></i>
            <span class="place-pill-name">{{ place.name }}</span>
            <span v-if="place.type === 'cemetery' && place.distFromRouteM > 0" class="place-pill-route-dist">
              {{ formatDistanceShort(place.distFromRouteM) }}
            </span>
          </div>
        </template>
      </template>

    </div>
  </div>
</template>
