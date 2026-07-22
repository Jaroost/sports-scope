<script setup lang="ts">
// Répartition par zone d'intensité d'UNE sortie (onglet « Zones » du détail).
// La logique de zonage (bornes, histogramme, seuils courants) vit côté serveur
// (TrainingLoad.zones_for_activity) : ce composant ne fait que le rendu — même barre
// empilée et mêmes couleurs que la page performance (ZoneDistribution.vue), plus un
// petit conseil déduit du profil d'intensité de la séance.
import { ref, computed, watch } from 'vue'
import { t } from '../i18n'
import { intensityZoneColor, fmtSeconds, type ZoneChannel } from '../composables/useTrainingPlan'

const props = defineProps({
  activityId: { type: [String, Number], required: true },
  source: { type: String, default: 'strava' }, // 'strava' | 'imported'
  // L'onglet ne charge qu'à l'affichage : inutile de calculer les zones tant que
  // l'utilisateur ne les regarde pas.
  active: { type: Boolean, default: false },
})

interface ZonesPayload {
  hr: ZoneChannel | null
  power: ZoneChannel | null
  lthr: number | null
  ftp: number | null
}

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<ZonesPayload | null>(null)
const fetched = ref(false)

const zonesUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}/zones`
  : `/strava/activities/${props.activityId}/zones`)

async function fetchZones() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(zonesUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as ZonesPayload
    fetched.value = true
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

// Chargement paresseux : au premier affichage de l'onglet seulement.
watch(() => props.active, (isActive) => {
  if (isActive && !fetched.value && !loading.value) fetchZones()
}, { immediate: true })

function zoneLabel(zone: string): string {
  return t(`performance.zones.label_${zone}`)
}

const hasAny = computed(() => !!(data.value?.hr || data.value?.power))

// Les deux canaux rendus par la même boucle, avec leur seuil de référence.
const channels = computed(() => {
  const d = data.value
  return [
    {
      key: 'hr', icon: 'fa-heart-pulse', iconClass: 'text-danger',
      title: t('strava.zones.hr_title'),
      ref: d?.lthr ? t('strava.zones.hr_ref', { bpm: d.lthr }) : '',
      channel: d?.hr ?? null,
      empty: d?.lthr ? t('strava.zones.no_hr') : t('strava.zones.set_lthr_hint'),
    },
    {
      key: 'power', icon: 'fa-bolt', iconClass: 'text-warning',
      title: t('strava.zones.power_title'),
      ref: d?.ftp ? t('strava.zones.power_ref', { watts: d.ftp }) : '',
      channel: d?.power ?? null,
      empty: t('strava.zones.no_power'),
    },
  ].filter((c) => c.channel || c.key === 'hr' || (c.key === 'power' && data.value?.ftp))
})

// Segments réellement présents (pct > 0) ; la légende, elle, liste toutes les zones.
function segments(channel: ZoneChannel | null) {
  return channel ? channel.zones.filter((z) => z.pct > 0) : []
}

// ── Conseil de séance ────────────────────────────────────────────────────────
// Contrairement à la polarisation de la page performance (idéal 80/5/15 SUR PLUSIEURS
// sorties), on qualifie ICI une seule séance : où le temps a-t-il été passé ? On
// regroupe facile (z1+z2) / modéré (z3, « zone grise ») / intense (z4+) et on en
// déduit le type de séance et le conseil associé.
const ADVICE_COLOR: Record<string, string> = {
  recovery: '#0d6efd', endurance: '#198754', tempo: '#fd7e14',
  threshold: '#dc3545', mixed: '#6c757d',
}
function sessionVerdict(channel: ZoneChannel): string {
  let easy = 0
  let moderate = 0
  let hard = 0
  for (const z of channel.zones) {
    if (z.zone === 'z1' || z.zone === 'z2') easy += z.pct
    else if (z.zone === 'z3') moderate += z.pct
    else hard += z.pct
  }
  if (hard >= 20) return 'threshold'
  if (moderate >= 40) return 'tempo'
  if (easy >= 85) return 'recovery'
  if (easy >= 60) return 'endurance'
  return 'mixed'
}

// On base le conseil sur la puissance quand elle est là (plus fiable), sinon la FC.
const advice = computed(() => {
  const channel = data.value?.power ?? data.value?.hr ?? null
  if (!channel) return null
  const verdict = sessionVerdict(channel)
  return {
    verdict,
    color: ADVICE_COLOR[verdict] ?? '#6c757d',
    // Ce que la séance ÉTAIT, puis ce qu'il faut travailler pour progresser.
    text: t(`strava.zones.advice_${verdict}`),
    improve: t(`strava.zones.improve_${verdict}`),
  }
})
</script>

<template>
  <div class="mt-3 mb-3">
    <h2 class="h5 d-flex align-items-center gap-2 mb-1">
      <i class="fa-solid fa-layer-group text-warning" aria-hidden="true"></i>
      <span>{{ t('strava.zones.title') }}</span>
    </h2>
    <p class="text-muted small mb-3">{{ t('strava.zones.intro') }}</p>

    <div v-if="loading" class="text-muted d-flex align-items-center gap-2 py-3">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('strava.zones.loading') }}</span>
    </div>

    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>

    <div v-else-if="data" class="card shadow-sm border-0">
      <div class="card-body">
        <p v-if="!hasAny" class="text-muted mb-0">{{ t('strava.zones.no_data') }}</p>

        <template v-else>
          <!-- Conseil de séance : encart mis en avant, comme les recos de la page performance. -->
          <div v-if="advice" class="zone-advice mb-3" :style="{ borderColor: advice.color }">
            <div class="d-flex flex-wrap align-items-center gap-2">
              <span class="zone-advice-badge" :style="{ backgroundColor: advice.color }">
                <i class="fa-solid fa-lightbulb me-1" aria-hidden="true"></i>{{ t('strava.zones.advice_label') }}
              </span>
              <span class="small">{{ advice.text }}</span>
            </div>
            <div class="zone-advice-improve small d-flex align-items-baseline gap-2">
              <i class="fa-solid fa-arrow-trend-up" :style="{ color: advice.color }" aria-hidden="true"></i>
              <span><span class="fw-semibold">{{ t('strava.zones.improve_label') }} :</span> {{ advice.improve }}</span>
            </div>
          </div>

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

            <template v-if="c.channel">
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
            </template>
            <p v-else class="text-muted small mb-0">{{ c.empty }}</p>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Barre + légende : reprises à l'identique de ZoneDistribution.vue pour l'homogénéité. */
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
/* Encart conseil : bord coloré à gauche, badge + texte, dans l'esprit des recos.
   Deux lignes empilées : ce que la séance était, puis « Pour progresser ». */
.zone-advice {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid;
  border-left-width: 4px;
  border-radius: 0.375rem;
  background: var(--bs-tertiary-bg);
}
/* Séparateur discret entre le constat et le levier de progression. */
.zone-advice-improve {
  padding-top: 0.4rem;
  border-top: 1px solid var(--bs-border-color);
}
.zone-advice-badge {
  display: inline-flex;
  align-items: center;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 0.25rem;
  white-space: nowrap;
}
</style>
