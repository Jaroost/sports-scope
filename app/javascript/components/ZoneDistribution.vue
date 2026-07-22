<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { intensityZoneColor, fmtSeconds, polarize, ZONE_VERDICT_COLOR, type ZoneChannel, type ZoneSummary } from '../composables/useTrainingPlan'

const props = defineProps<{
  zones: ZoneSummary | null
  lthr: number | null
  ftp: number | null
}>()

// Libellé d'une zone (partagé FC/puissance : la FC n'utilise que z1..z5).
function zoneLabel(zone: string): string {
  return t(`performance.zones.label_${zone}`)
}

const hasAny = computed(() => !!(props.zones?.hr || props.zones?.power))

// Les deux canaux rendus par la même boucle, avec leur libellé de référence (seuil).
const channels = computed(() => {
  const z = props.zones
  return [
    {
      key: 'hr', icon: 'fa-heart-pulse', iconClass: 'text-danger',
      title: t('performance.zones.hr_title'),
      ref: props.lthr ? t('performance.zones.hr_ref', { bpm: props.lthr }) : '',
      channel: z?.hr ?? null,
      polar: z?.hr ? polarize(z.hr) : null,
      desc: t('performance.zones.hr_desc'),
      empty: props.lthr ? t('performance.zones.no_hr') : t('performance.zones.set_lthr_hint'),
    },
    {
      key: 'power', icon: 'fa-bolt', iconClass: 'text-warning',
      title: t('performance.zones.power_title'),
      ref: props.ftp ? t('performance.zones.power_ref', { watts: props.ftp }) : '',
      channel: z?.power ?? null,
      polar: z?.power ? polarize(z.power) : null,
      desc: '',
      empty: t('performance.zones.no_power'),
    },
  ]
})

// Segments d'une barre empilée : on n'y garde que les zones réellement présentes
// (pct > 0) ; la légende, elle, liste toutes les zones.
function segments(channel: ZoneChannel | null) {
  return channel ? channel.zones.filter((z) => z.pct > 0) : []
}

// Réel vs idéal : ~80 / ~5 / ~15 (beaucoup de facile, peu de zone grise, un peu
// d'intensité). Le calcul de polarisation + verdict est partagé (cf. useTrainingPlan).
const GROUP_COLOR = { easy: '#198754', moderate: '#ffc107', hard: '#dc3545' }
const IDEAL = { easy: 80, moderate: 5, hard: 15 }
function verdictColor(v: string): string {
  return ZONE_VERDICT_COLOR[v as keyof typeof ZONE_VERDICT_COLOR] ?? '#6c757d'
}
</script>

<template>
  <div class="mb-4">
    <h2 class="h5 d-flex align-items-center gap-2 mb-1">
      <i class="fa-solid fa-layer-group text-warning" aria-hidden="true"></i>
      <span>{{ t('performance.zones.title') }}</span>
    </h2>
    <p class="text-muted small mb-3">
      {{ t('performance.zones.intro', { days: zones?.window_days ?? 42 }) }}
    </p>

    <div class="card shadow-sm border-0">
      <div class="card-body">
        <p v-if="!hasAny" class="text-muted mb-0">{{ t('performance.zones.no_data') }}</p>

        <template v-else>
          <div v-for="(c, i) in channels" :key="c.key" class="zone-channel" :class="{ 'mt-3 pt-3 border-top': i > 0 }">
            <div class="d-flex align-items-baseline justify-content-between mb-2">
              <div class="fw-semibold">
                <i :class="`fa-solid ${c.icon} me-1 ${c.iconClass}`" aria-hidden="true"></i>{{ c.title }}
              </div>
              <div class="small text-muted">
                <span v-if="c.ref">{{ c.ref }}</span>
                <span v-if="c.channel"> · {{ fmtSeconds(c.channel.total_seconds) }}</span>
              </div>
            </div>

            <p v-if="c.desc" class="text-body-tertiary small mb-2">{{ c.desc }}</p>

            <template v-if="c.channel">
              <!-- Barre détaillée par zone -->
              <div class="zone-bar" role="img" :aria-label="c.title">
                <div
                  v-for="s in segments(c.channel)" :key="s.zone"
                  class="zone-seg"
                  :style="{ width: `${s.pct}%`, backgroundColor: intensityZoneColor(s.zone) }"
                  :title="`${zoneLabel(s.zone)} — ${s.pct}% · ${fmtSeconds(s.seconds)}`"
                >
                  <span v-if="s.pct >= 8" class="zone-seg-label">{{ Math.round(s.pct) }}%</span>
                </div>
              </div>
              <div class="d-flex flex-wrap gap-2 mt-2">
                <span
                  v-for="z in c.channel.zones" :key="z.zone"
                  class="zone-legend" :class="{ 'zone-legend-muted': z.pct === 0 }"
                >
                  <span class="zone-dot" :style="{ backgroundColor: intensityZoneColor(z.zone) }"></span>
                  <span class="fw-semibold">{{ zoneLabel(z.zone) }}</span>
                  <span class="text-muted">{{ t('performance.zones.legend_value', { pct: z.pct, time: fmtSeconds(z.seconds) }) }}</span>
                </span>
              </div>

              <!-- Polarisation : réel vs idéal + verdict -->
              <div v-if="c.polar" class="polar mt-3">
                <div class="d-flex align-items-center flex-wrap gap-2 mb-1">
                  <span class="small fw-semibold">{{ t('performance.zones.polar_title') }}</span>
                  <span class="badge" :style="{ backgroundColor: verdictColor(c.polar.verdict) }">
                    {{ t(`performance.zones.verdict_${c.polar.verdict}`) }}
                  </span>
                  <i class="fa-solid fa-circle-info text-muted small polar-info" :title="t('performance.zones.polar_hint')" aria-hidden="true"></i>
                </div>

                <div class="polar-row">
                  <span class="polar-tag text-muted">{{ t('performance.zones.polar_actual') }}</span>
                  <div class="zone-bar polar-bar">
                    <div class="zone-seg" :style="{ width: `${c.polar.easy}%`, backgroundColor: GROUP_COLOR.easy }" :title="`${t('performance.zones.polar_easy')} — ${c.polar.easy}%`">
                      <span v-if="c.polar.easy >= 10" class="zone-seg-label">{{ c.polar.easy }}%</span>
                    </div>
                    <div class="zone-seg" :style="{ width: `${c.polar.moderate}%`, backgroundColor: GROUP_COLOR.moderate }" :title="`${t('performance.zones.polar_moderate')} — ${c.polar.moderate}%`">
                      <span v-if="c.polar.moderate >= 10" class="zone-seg-label">{{ c.polar.moderate }}%</span>
                    </div>
                    <div class="zone-seg" :style="{ width: `${c.polar.hard}%`, backgroundColor: GROUP_COLOR.hard }" :title="`${t('performance.zones.polar_hard')} — ${c.polar.hard}%`">
                      <span v-if="c.polar.hard >= 10" class="zone-seg-label">{{ c.polar.hard }}%</span>
                    </div>
                  </div>
                </div>

                <div class="polar-row">
                  <span class="polar-tag text-muted">{{ t('performance.zones.polar_ideal') }}</span>
                  <div class="zone-bar polar-bar polar-ideal" :title="t('performance.zones.polar_hint')">
                    <div class="zone-seg" :style="{ width: `${IDEAL.easy}%`, backgroundColor: GROUP_COLOR.easy }"><span class="zone-seg-label">{{ IDEAL.easy }}%</span></div>
                    <div class="zone-seg" :style="{ width: `${IDEAL.moderate}%`, backgroundColor: GROUP_COLOR.moderate }"></div>
                    <div class="zone-seg" :style="{ width: `${IDEAL.hard}%`, backgroundColor: GROUP_COLOR.hard }"><span class="zone-seg-label">{{ IDEAL.hard }}%</span></div>
                  </div>
                </div>

                <div class="d-flex flex-wrap gap-3 small text-muted mt-1">
                  <span><span class="zone-dot" :style="{ backgroundColor: GROUP_COLOR.easy }"></span>{{ t('performance.zones.polar_easy') }}</span>
                  <span><span class="zone-dot" :style="{ backgroundColor: GROUP_COLOR.moderate }"></span>{{ t('performance.zones.polar_moderate') }}</span>
                  <span><span class="zone-dot" :style="{ backgroundColor: GROUP_COLOR.hard }"></span>{{ t('performance.zones.polar_hard') }}</span>
                </div>
              </div>
            </template>
            <p v-else class="text-muted small mb-0">{{ c.empty }}</p>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.zone-bar {
  display: flex;
  width: 100%;
  height: 1.75rem;
  border-radius: 0.375rem;
  overflow: hidden;
  background: var(--bs-tertiary-bg);
}
.zone-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 2px;
  transition: filter 0.12s ease;
}
.zone-seg:hover {
  filter: brightness(1.08);
}
.zone-seg-label {
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
  white-space: nowrap;
}
.zone-legend {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
}
.zone-legend-muted {
  opacity: 0.45;
}
.zone-dot {
  display: inline-block;
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  flex: 0 0 auto;
}
.polar-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}
.polar-tag {
  flex: 0 0 auto;
  width: 3.5rem;
  font-size: 0.78rem;
}
.polar-bar {
  height: 1.25rem;
}
/* La barre « idéal » est une simple référence : rayée et atténuée pour ne pas la
   confondre avec la répartition réelle. */
.polar-ideal {
  opacity: 0.7;
  background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.18) 0, rgba(255, 255, 255, 0.18) 3px, transparent 3px, transparent 6px);
}
.polar-info {
  cursor: help;
}
</style>
