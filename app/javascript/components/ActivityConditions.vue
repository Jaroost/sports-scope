<script setup lang="ts">
// Bandeau « conditions » sous la carte d'une activité : matériel Strava utilisé
// (nom + km au compteur), appareil d'enregistrement et météo du jour (température,
// ciel, vent + rafales). Le matériel ne vient que du détail Strava (`activity.gear`) ;
// la météo est récupérée par le parent via /api/weather (cf. ActivityDetail).
import { computed, type PropType } from 'vue'
import { t } from '../i18n'
import { weatherBucket, weatherLabel, windCardinal, windArrowDeg, type Weather } from '../weatherHelpers'
import { zoneColor } from '../composables/useTrainingPlan'

const props = defineProps({
  activity: { type: Object as PropType<Record<string, any>>, required: true },
  weather: { type: Object as PropType<Weather | null>, default: null },
  weatherLoading: { type: Boolean, default: false },
})

// Forme (fraîcheur) à l'entrée de la séance : { ctl, atl, tsb, form_zone } servi par
// le back (TrainingLoad.form_on) sur l'activité. Le TSB dit si on abordait la sortie
// reposé (positif) ou fatigué (négatif) ; la zone donne couleur + libellé partagés
// avec la page performance.
const form = computed(() => {
  const f = props.activity?.form
  return f && Number.isFinite(f.tsb) ? f : null
})
const formZoneKey = computed(() => form.value?.form_zone || 'neutral')
const formColor = computed(() => zoneColor(formZoneKey.value))
const formTsb = computed(() => {
  const v = Math.round(form.value?.tsb ?? 0)
  return v > 0 ? `+${v}` : `${v}`
})
const formLabel = computed(() => t(`performance.load.zone_${formZoneKey.value}`))
const formHint = computed(() => t(`performance.load.zone_${formZoneKey.value}_hint`))

// Le matériel Strava (vélo ou chaussures) n'est présent que dans le détail Strava.
const gear = computed(() => {
  const g = props.activity?.gear
  return g && (g.name || g.nickname) ? g : null
})
const gearName = computed(() => gear.value?.nickname || gear.value?.name || null)
// Icône selon le type de gear : les chaussures ont un gear_id préfixé « g ».
const gearIcon = computed(() => {
  const id = String(gear.value?.id || props.activity?.gear_id || '')
  return id.startsWith('g') ? 'fa-shoe-prints' : 'fa-bicycle'
})
const gearDistanceKm = computed(() => {
  const d = gear.value?.distance
  return Number.isFinite(d) && d > 0 ? Math.round(d / 1000).toLocaleString() : null
})

// L'appareil d'enregistrement (montre, compteur, appli) est distinct du « gear » Strava,
// qui ne couvre que les vélos et les chaussures : une séance de squash n'a pas de gear
// mais a bien un `device_name`.
const deviceName = computed(() => {
  const d = props.activity?.device_name
  return typeof d === 'string' && d.trim() ? d.trim() : null
})

const w = computed(() => props.weather)
const bucketIcon = computed(() => weatherBucket(w.value?.weather_code).icon)
const label = computed(() => (w.value ? weatherLabel(w.value.weather_code) : ''))
const cardinal = computed(() => windCardinal(w.value?.wind_direction))
const arrowDeg = computed(() => windArrowDeg(w.value?.wind_direction))

const hasWeather = computed(() =>
  !!w.value && (w.value.temperature != null || w.value.wind_speed != null || w.value.weather_code != null),
)
const hasContent = computed(
  () => !!form.value || !!gearName.value || !!deviceName.value || hasWeather.value || props.weatherLoading,
)

function fmt1(v: number | null | undefined): string {
  return v == null ? '–' : (Math.round(v * 10) / 10).toString()
}
</script>

<template>
  <div v-if="hasContent" class="card shadow-sm border-0 mb-3 activity-conditions">
    <div class="card-body py-2 d-flex flex-wrap align-items-center gap-2">
      <!-- Forme (fraîcheur) à l'entrée de la séance : TSB + zone colorée. -->
      <span v-if="form" class="cond-pill cond-form" :title="`${t('strava.conditions.form')} — ${formHint}`">
        <i class="fa-solid fa-heart-pulse" :style="{ color: formColor }" aria-hidden="true"></i>
        <span class="cond-val" :style="{ color: formColor }">{{ formTsb }}</span>
        <span class="cond-sub">{{ formLabel }}</span>
      </span>

      <span
        v-if="form && (gearName || deviceName || hasWeather || weatherLoading)"
        class="cond-sep"
        aria-hidden="true"
      ></span>

      <!-- Matériel Strava -->
      <span v-if="gearName" class="cond-pill cond-gear" :title="t('strava.conditions.gear')">
        <i class="fa-solid" :class="gearIcon" aria-hidden="true"></i>
        <span class="cond-val">{{ gearName }}</span>
        <span v-if="gearDistanceKm" class="cond-sub">{{ gearDistanceKm }} km</span>
      </span>

      <!-- Appareil d'enregistrement -->
      <span v-if="deviceName" class="cond-pill cond-device" :title="t('strava.conditions.device')">
        <i class="fa-solid fa-microchip" aria-hidden="true"></i>
        <span class="cond-val">{{ deviceName }}</span>
      </span>

      <span
        v-if="(gearName || deviceName) && (hasWeather || weatherLoading)"
        class="cond-sep"
        aria-hidden="true"
      ></span>

      <!-- Météo -->
      <span
        v-if="weatherLoading && !hasWeather"
        class="cond-pill text-muted"
      >
        <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
        <span class="cond-val">{{ t('strava.conditions.weather_loading') }}</span>
      </span>

      <template v-else-if="hasWeather">
        <span class="cond-pill" :title="label">
          <i class="fa-solid" :class="bucketIcon" aria-hidden="true"></i>
          <span v-if="w.temperature != null" class="cond-val">{{ fmt1(w.temperature) }} °C</span>
          <span class="cond-sub">{{ label }}</span>
        </span>

        <span v-if="w.wind_speed != null" class="cond-pill" :title="t('strava.conditions.wind')">
          <i
            class="fa-solid fa-arrow-up cond-wind-arrow"
            :style="{ transform: `rotate(${arrowDeg}deg)` }"
            aria-hidden="true"
          ></i>
          <span class="cond-val">{{ Math.round(w.wind_speed) }} km/h</span>
          <span v-if="cardinal" class="cond-sub">{{ cardinal }}</span>
          <span v-if="w.wind_gusts != null" class="cond-sub">
            {{ t('strava.conditions.gusts') }} {{ Math.round(w.wind_gusts) }}
          </span>
        </span>

        <span v-if="w.humidity != null" class="cond-pill" :title="t('strava.conditions.humidity')">
          <i class="fa-solid fa-droplet text-info" aria-hidden="true"></i>
          <span class="cond-val">{{ Math.round(w.humidity) }} %</span>
        </span>

        <span
          v-if="w.precipitation != null && w.precipitation > 0"
          class="cond-pill"
          :title="t('strava.conditions.precipitation')"
        >
          <i class="fa-solid fa-umbrella text-primary" aria-hidden="true"></i>
          <span class="cond-val">{{ fmt1(w.precipitation) }} mm</span>
        </span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cond-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.04);
  font-size: 0.85rem;
  line-height: 1.3;
}
.cond-pill > i { color: #fc4c02; }
.cond-gear > i { color: #6c757d; }
.cond-device > i { color: #6c757d; }
.cond-val { font-weight: 600; font-variant-numeric: tabular-nums; }
.cond-sub { color: #6c757d; font-size: 0.78rem; }
.cond-sep {
  width: 1px;
  align-self: stretch;
  min-height: 1.4rem;
  background: rgba(0, 0, 0, 0.12);
}
/* La flèche vent tourne autour de son centre pour pointer le sens du vent. */
.cond-wind-arrow { transition: transform 0.2s ease; color: #0d6efd; }

@media (prefers-color-scheme: dark) {
  .cond-pill { background: rgba(255, 255, 255, 0.08); }
  .cond-sub { color: #adb5bd; }
  .cond-sep { background: rgba(255, 255, 255, 0.18); }
}
</style>
