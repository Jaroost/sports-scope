<script setup lang="ts">
// Bandeau discret « qualité des données » sous la carte d'une activité : liste les
// anomalies d'enregistrement (trous de capteur, pics de puissance aberrants, pertes
// du cardio) qui peuvent fausser l'analyse (charge, NP, moyennes, courbe de
// puissance). Purement informatif — il n'altère aucun calcul, il prévient juste de
// ne pas surinterpréter des chiffres pollués. Les infobulles sont natives (`title`)
// pour rester léger, sans machinerie Bootstrap.
import { type PropType } from 'vue'
import { t } from '../i18n'
import { formatDuration, type QualityFlag } from '../activityHelpers'

const props = defineProps({
  flags: { type: Array as PropType<QualityFlag[]>, default: () => [] },
})

function flagMessage(f: QualityFlag): string {
  const duration = f.seconds != null ? formatDuration(f.seconds) : ''
  return t(`strava.quality.${f.key}`, { count: f.count, duration })
}
</script>

<template>
  <div v-if="props.flags.length" class="activity-quality mb-3" role="note">
    <div class="d-flex align-items-start gap-2">
      <i class="fa-solid fa-triangle-exclamation quality-icon mt-1" aria-hidden="true"></i>
      <div class="flex-grow-1">
        <div class="quality-title d-flex align-items-center gap-2">
          <strong>{{ t('strava.quality.title') }}</strong>
          <i
            class="fa-regular fa-circle-question text-muted"
            :title="t('strava.quality.hint')"
            aria-hidden="true"
          ></i>
        </div>
        <ul class="quality-list mb-0">
          <li
            v-for="f in props.flags"
            :key="f.key"
            :class="{ 'quality-warning': f.severity === 'warning' }"
            :title="t(`strava.quality.${f.key}_hint`)"
          >
            {{ flagMessage(f) }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity-quality {
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  background: rgba(253, 126, 20, 0.08);
  border: 1px solid rgba(253, 126, 20, 0.25);
  font-size: 0.85rem;
}
.quality-icon { color: #fd7e14; }
.quality-title strong { font-size: 0.88rem; }
.quality-list {
  padding-left: 1.1rem;
  margin-top: 0.15rem;
}
.quality-list li { cursor: help; }
.quality-list li.quality-warning { color: #b45309; font-weight: 600; }

@media (prefers-color-scheme: dark) {
  .activity-quality { background: rgba(253, 126, 20, 0.12); }
  .quality-list li.quality-warning { color: #f0a35e; }
}
</style>
