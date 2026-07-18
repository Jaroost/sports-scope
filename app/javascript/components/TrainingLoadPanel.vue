<script setup lang="ts">
import { ref, onMounted, computed, watch, watchEffect, nextTick } from 'vue'
import { t } from '../i18n'
import {
  useTrainingPlan, zoneColor, formZone, acwrColor, fmtDuration, fmtSigned, eventDateFmt,
  athleteFromSummary, polarize,
  ACTION_STYLE, PHASE_COLOR, FEAS_COLOR, GOALS, WEEK_PACE_COLOR, WEEK_SEGMENT_COLOR,
  type Point, type LoadSummary, type DayActivity,
} from '../composables/useTrainingPlan'
import { usePlannedLoads } from '../composables/usePlannedRides'
import ZoneDistribution from './ZoneDistribution.vue'
import WeekPlanner from './WeekPlanner.vue'
import MetricChart from './MetricChart.vue'

const props = defineProps({
  admin: { type: Boolean, default: false },
  // Sous-onglet actif de « Forme & seuils » côté parent : 'load' (charge/forme) ou
  // 'zones' (répartition d'intensité). Une seule instance, un seul fetch — on ne fait
  // qu'afficher l'un ou l'autre. FTP est un panneau à part (FtpPanel).
  section: { type: String, default: 'load' },
})

// Résumé remonté au parent pour les badges de sous-onglets : la reco du jour (badge
// « Forme & fatigue ») et le verdict de polarisation des zones (badge « Zones »).
const emit = defineEmits<{ summary: [payload: { recoAction: string | null; zonesVerdict: string | null }] }>()

const loading = ref(true)
const error = ref<string | null>(null)
const saving = ref(false)
const data = ref<LoadSummary | null>(null)

// Fenêtre d'affichage (jours). Infinity = tout.
const rangeDays = ref<number>(180)
const RANGES: { key: string; days: number }[] = [
  { key: 'range_3m', days: 90 },
  { key: 'range_6m', days: 180 },
  { key: 'range_12m', days: 365 },
  { key: 'range_all', days: Number.POSITIVE_INFINITY },
]

// LTHR (édition manuelle)
const editingLthr = ref(false)
const lthrInput = ref<string | number>('')

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

function activityHref(a: { source: string; external_id: string }): string {
  const base = a.source === 'imported' ? '/imported_activities' : '/activities'
  return `${localePrefix}${base}/${a.external_id}`
}

async function fetchData() {
  loading.value = true
  try {
    const res = await fetch('/api/performance/training_load', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as LoadSummary
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

// Ancre : arrivée depuis le widget d'accueil via /performance#training-load. Le
// panneau se monte de façon asynchrone (après le chargement de PerformanceAnalysis),
// donc le défilement natif du navigateur ne trouve pas encore l'élément ; on le fait
// nous-mêmes une fois le panneau monté.
const rootEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  await fetchData()
  if (window.location.hash === '#training-load') {
    await nextTick()
    rootEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})

// ── Zones de fraîcheur (TSB) ─────────────────────────────────────────────────
// `zoneColor` / `formZone` viennent du composable (partagés avec le widget d'accueil).
const ZONE_ORDER = ['fresh', 'neutral', 'productive', 'overreaching', 'very_fresh']

// ── Plan d'entraînement (objectif + reco du jour), partagé avec le widget d'accueil ─
// Les seuils athlète sont dérivés de la charge déjà chargée (pas de seconde requête),
// et servent à estimer le TSS des itinéraires prévus → segment orange de la barre.
const athlete = computed(() => athleteFromSummary(data.value))
const { plannedLoads } = usePlannedLoads(athlete)

// Bilan des sorties RÉELLES par jour (ISO → { tss, count, at }), pour le planificateur :
//   • tss   : charge encaissée ce jour-là (RÉEL de la série, pas l'estimé) ;
//   • count : nombre de sorties → combien d'itinéraires planifiés marquer « réalisés » ;
//   • at    : heure de la sortie la plus tardive → un plan n'est fait que si une sortie
//             a eu lieu APRÈS sa pose (sinon un plan ajouté après coup passerait pour fait).
// On se fie aux activités attachées à la série (cf. attach_activities côté serveur), pas
// au tracé prévu — rouler « en gros » le tour planifié suffit à le compter.
type DayDone = { tss: number; count: number; at: string | null; activities: DayActivity[] }
const doneByDay = computed<Record<string, DayDone>>(() => {
  const out: Record<string, DayDone> = {}
  for (const p of data.value?.series ?? []) {
    const acts = p.activities ?? []
    if (!acts.length) continue
    let at: string | null = null
    for (const a of acts) {
      if (a.started_at && (!at || new Date(a.started_at).getTime() > new Date(at).getTime())) at = a.started_at
    }
    out[p.date] = { tss: Math.round(p.tss), count: acts.length, at, activities: acts }
  }
  return out
})

const {
  current, goal, targetEvent, eventInfo, feasibility, projection,
  editingEvent, evDate, evDistance, evIntensity, todayISO,
  openEventEditor, saveEvent, removeEvent, recommendation, weekPlan,
} = useTrainingPlan(data, plannedLoads)
const currentZone = computed(() => current.value?.form_zone ?? 'neutral')

// Remonte le résumé au parent dès que la reco ou les zones changent. Verdict des zones :
// on privilégie la puissance (vélo), à défaut la FC — un seul canal pour un badge.
watchEffect(() => {
  const zoneChannel = data.value?.zones?.power ?? data.value?.zones?.hr ?? null
  emit('summary', {
    recoAction: recommendation.value?.action ?? null,
    zonesVerdict: zoneChannel ? polarize(zoneChannel).verdict : null,
  })
})

// ── Série affichée selon la fenêtre choisie ──────────────────────────────────
const displayed = computed<Point[]>(() => {
  const s = data.value?.series ?? []
  if (!s.length || !Number.isFinite(rangeDays.value)) return s
  return s.slice(-rangeDays.value)
})

// ── Tendance sur 7 jours (flèche par tuile) ──────────────────────────────────
// Compare la valeur du jour à celle d'il y a `TREND_WINDOW` jours dans la série
// (points quotidiens, jours de repos inclus). `goodDir` = sens « favorable » de la
// métrique → colore la flèche (vert = va dans le bon sens, orange = à surveiller).
// Le seuil `flat` (adapté à l'échelle) évite d'afficher une tendance sur du bruit.
const TREND_WINDOW = 7
type Trend = { dir: 'up' | 'down' | 'flat'; tone: 'good' | 'warn' | 'flat'; icon: string; delta: string }
function computeTrend(key: 'ctl' | 'atl' | 'tsb', flat: number, goodDir: 'up' | 'down'): Trend | null {
  const s = data.value?.series ?? []
  if (s.length < TREND_WINDOW + 1) return null
  const d = s[s.length - 1][key] - s[s.length - 1 - TREND_WINDOW][key]
  const dir = Math.abs(d) < flat ? 'flat' : d > 0 ? 'up' : 'down'
  const tone = dir === 'flat' ? 'flat' : dir === goodDir ? 'good' : 'warn'
  const icon = dir === 'flat' ? 'fa-arrow-right-long' : dir === 'up' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'
  return { dir, tone, icon: `fa-solid ${icon}`, delta: fmtSigned(d) }
}
const ctlTrend = computed(() => computeTrend('ctl', 1, 'up'))   // forme de fond : monter = bien
const atlTrend = computed(() => computeTrend('atl', 1, 'down')) // fatigue : baisser = bien
const tsbTrend = computed(() => computeTrend('tsb', 2, 'up'))   // fraîcheur : monter = plus frais

// ── LTHR ─────────────────────────────────────────────────────────────────────
const lthr = computed(() => data.value?.thresholds?.lthr ?? null)
const lthrSource = computed(() => data.value?.thresholds?.lthr_source ?? null)

function startEditLthr() {
  lthrInput.value = data.value?.thresholds?.lthr_source === 'manual' && lthr.value != null ? lthr.value : ''
  editingLthr.value = true
}

async function saveLthr() {
  saving.value = true
  try {
    const res = await fetch('/api/athlete', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ athlete: { lthr_manual: String(lthrInput.value ?? '').trim() } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    editingLthr.value = false
    await fetchData()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function resetLthr() {
  lthrInput.value = ''
  await saveLthr()
}

// ── Maintenance admin : backfill unifié des métriques dérivées ───────────────
// Recalcule TOUTES les dérivées manquantes/obsolètes (NP, courbe de puissance,
// histogrammes FC/puissance…) depuis les streams déjà stockés (aucun appel Strava),
// puis recharge la couverture et les courbes. Réservé aux administrateurs.
const backfilling = ref(false)
const backfillResult = ref<{ updated: number; unchanged: number; scanned: number } | null>(null)

async function runBackfill() {
  backfilling.value = true
  backfillResult.value = null
  try {
    const res = await fetch('/admin/maintenance/backfill_derivations', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    backfillResult.value = await res.json()
    await fetchData()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    backfilling.value = false
  }
}

// ── Courbes par métrique, rangées « derrière » leur case ─────────────────────
// Chaque case (forme de fond, fatigue, fraîcheur, ratio) ouvre/ferme sa propre courbe
// (MetricChart) sous les cases. Les échelles diffèrent (charge / fraîcheur signée /
// ratio) → un graphe autonome par case plutôt qu'un axe partagé. Rien n'est affiché
// par défaut : les cases restent le résumé, la courbe est le détail à la demande.
type Metric = 'ctl' | 'atl' | 'tsb' | 'acwr'
const METRIC_ORDER: Metric[] = ['ctl', 'atl', 'tsb', 'acwr']
const openMetrics = ref<Set<Metric>>(new Set())

function toggleMetric(m: Metric) {
  const s = new Set(openMetrics.value)
  if (s.has(m)) s.delete(m)
  else s.add(m)
  openMetrics.value = s
}
function isMetricOpen(m: Metric): boolean {
  return openMetrics.value.has(m)
}
const openMetricsOrdered = computed<Metric[]>(() => METRIC_ORDER.filter((m) => openMetrics.value.has(m)))

// ── Panneau de détail (sous les courbes) ─────────────────────────────────────
// Le survol d'une courbe déplace `hoverIndex` (remonté par MetricChart) ; le bloc de
// détail commun décrit alors le jour lu, quel que soit le graphe survolé.
const hoverIndex = ref<number | null>(null)

function dateLong(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
}

// Hors survol, on montre le dernier jour de la fenêtre : le bloc garde sa hauteur
// (pas de saut de mise en page) et affiche l'info la plus utile par défaut.
const detail = computed<Point | null>(() => {
  const pts = displayed.value
  if (!pts.length) return null
  return pts[hoverIndex.value ?? pts.length - 1] ?? null
})
const detailZone = computed(() => (detail.value ? formZone(detail.value.tsb) : 'neutral'))
const detailActivities = computed<DayActivity[]>(() => detail.value?.activities ?? [])

// Fenêtre changée : l'index survolé désigne une position dans la série affichée, il ne
// veut plus rien dire une fois la fenêtre changée.
watch(rangeDays, () => { hoverIndex.value = null })
</script>

<template>
  <div id="training-load" ref="rootEl" class="mb-4">
    <!-- Sous-onglet « Forme & fatigue » : titre, tuiles, reco, planificateur, courbes PMC. -->
    <div v-show="section === 'load'">
    <h2 class="h5 d-flex align-items-center gap-2 mb-1">
      <i class="fa-solid fa-heart-pulse text-warning" aria-hidden="true"></i>
      <span>{{ t('performance.load.title') }}</span>
    </h2>
    <p class="text-muted small mb-3">{{ t('performance.load.intro') }}</p>

    <div class="card shadow-sm border-0">
      <div class="card-body">
        <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
          <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
          <span>{{ t('performance.loading') }}</span>
        </div>

        <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span>{{ error }}</span>
        </div>

        <div v-else-if="!current" class="text-muted mb-0">{{ t('performance.load.no_data') }}</div>

        <template v-else>
          <!-- Valeurs du jour -->
          <div class="row g-3 mb-3">
            <div class="col-6 col-lg-3">
              <div
                class="load-tile load-tile-toggle"
                :class="{ 'is-open': isMetricOpen('ctl') }"
                role="button"
                tabindex="0"
                :aria-expanded="isMetricOpen('ctl')"
                :title="t('performance.load.toggle_curve')"
                @click="toggleMetric('ctl')"
                @keydown.enter.prevent="toggleMetric('ctl')"
                @keydown.space.prevent="toggleMetric('ctl')"
              >
                <div class="small text-muted">{{ t('performance.load.ctl_label') }} <span class="text-body-tertiary">· {{ t('performance.load.ctl_sub') }}</span></div>
                <div class="d-flex align-items-baseline gap-2">
                  <span class="fs-3 fw-bold" style="color:#0d6efd">{{ Math.round(current.ctl) }}</span>
                  <span v-if="ctlTrend" class="load-trend" :class="`trend-${ctlTrend.tone}`" :title="t('performance.load.trend_tooltip')">
                    <i :class="ctlTrend.icon" aria-hidden="true"></i>
                    <span v-if="ctlTrend.dir !== 'flat'" class="ms-1">{{ ctlTrend.delta }}</span>
                  </span>
                </div>
                <div class="load-help">{{ t('performance.load.ctl_help') }}</div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div
                class="load-tile load-tile-toggle"
                :class="{ 'is-open': isMetricOpen('atl') }"
                role="button"
                tabindex="0"
                :aria-expanded="isMetricOpen('atl')"
                :title="t('performance.load.toggle_curve')"
                @click="toggleMetric('atl')"
                @keydown.enter.prevent="toggleMetric('atl')"
                @keydown.space.prevent="toggleMetric('atl')"
              >
                <div class="small text-muted">{{ t('performance.load.atl_label') }} <span class="text-body-tertiary">· {{ t('performance.load.atl_sub') }}</span></div>
                <div class="d-flex align-items-baseline gap-2">
                  <span class="fs-3 fw-bold" style="color:#fd7e14">{{ Math.round(current.atl) }}</span>
                  <span v-if="atlTrend" class="load-trend" :class="`trend-${atlTrend.tone}`" :title="t('performance.load.trend_tooltip')">
                    <i :class="atlTrend.icon" aria-hidden="true"></i>
                    <span v-if="atlTrend.dir !== 'flat'" class="ms-1">{{ atlTrend.delta }}</span>
                  </span>
                </div>
                <div class="load-help">{{ t('performance.load.atl_help') }}</div>
              </div>
            </div>
            <div class="col-6 col-lg-3">
              <div
                class="load-tile load-tile-toggle"
                :class="{ 'is-open': isMetricOpen('tsb') }"
                role="button"
                tabindex="0"
                :aria-expanded="isMetricOpen('tsb')"
                :title="t('performance.load.toggle_curve')"
                @click="toggleMetric('tsb')"
                @keydown.enter.prevent="toggleMetric('tsb')"
                @keydown.space.prevent="toggleMetric('tsb')"
              >
                <div class="small text-muted">{{ t('performance.load.tsb_label') }} <span class="text-body-tertiary">· {{ t('performance.load.tsb_sub') }}</span></div>
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="fs-3 fw-bold" :style="{ color: zoneColor(currentZone) }">{{ fmtSigned(current.tsb) }}</span>
                  <span v-if="tsbTrend" class="load-trend" :class="`trend-${tsbTrend.tone}`" :title="t('performance.load.trend_tooltip')">
                    <i :class="tsbTrend.icon" aria-hidden="true"></i>
                    <span v-if="tsbTrend.dir !== 'flat'" class="ms-1">{{ tsbTrend.delta }}</span>
                  </span>
                  <span class="badge" :style="{ backgroundColor: zoneColor(currentZone) }">{{ t(`performance.load.zone_${currentZone}`) }}</span>
                </div>
                <div class="load-help">{{ t(`performance.load.zone_${currentZone}_hint`) }}</div>
              </div>
            </div>
            <!-- ACWR : ratio charge aiguë/chronique (risque de blessure) -->
            <div class="col-6 col-lg-3">
              <div
                class="load-tile load-tile-toggle"
                :class="{ 'is-open': isMetricOpen('acwr') }"
                role="button"
                tabindex="0"
                :aria-expanded="isMetricOpen('acwr')"
                :title="t('performance.load.toggle_curve')"
                @click="toggleMetric('acwr')"
                @keydown.enter.prevent="toggleMetric('acwr')"
                @keydown.space.prevent="toggleMetric('acwr')"
              >
                <div class="small text-muted">{{ t('performance.load.acwr_label') }} <span class="text-body-tertiary">· {{ t('performance.load.acwr_sub') }}</span></div>
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="fs-3 fw-bold" :style="{ color: acwrColor(current.acwr_zone) }">
                    {{ current.acwr != null ? current.acwr.toFixed(2) : '—' }}
                  </span>
                  <span v-if="current.acwr_zone" class="badge" :style="{ backgroundColor: acwrColor(current.acwr_zone) }">{{ t(`performance.load.acwr_${current.acwr_zone}`) }}</span>
                </div>
                <div class="load-help">{{ current.acwr_zone ? t(`performance.load.acwr_${current.acwr_zone}_hint`) : t('performance.load.acwr_pending') }}</div>
              </div>
            </div>
          </div>

          <!-- Courbes « derrière » les cases : chaque case ci-dessus ouvre/ferme la
               sienne. Rien tant qu'aucune n'est ouverte — les cases restent le résumé. -->
          <div v-if="openMetricsOrdered.length" class="metric-curves mb-3">
            <!-- Fenêtre temporelle commune à toutes les courbes ouvertes. -->
            <div class="btn-group btn-group-sm mb-2" role="group">
              <button
                v-for="r in RANGES" :key="r.key" type="button"
                class="btn" :class="rangeDays === r.days ? 'btn-primary' : 'btn-outline-secondary'"
                @click="rangeDays = r.days"
              >{{ t(`performance.load.${r.key}`) }}</button>
            </div>

            <div @mouseleave="hoverIndex = null">
              <MetricChart
                v-for="m in openMetricsOrdered" :key="m"
                :metric="m" :points="displayed" :hover-index="hoverIndex"
                @hover="hoverIndex = $event"
              />
            </div>

            <!-- Détail du jour lu, commun à toutes les courbes ouvertes. -->
            <div v-if="detail" class="load-detail mt-2">
              <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                <span class="fw-semibold text-capitalize">{{ dateLong(detail.date) }}</span>
                <span class="badge" :style="{ backgroundColor: zoneColor(detailZone) }">{{ t(`performance.load.zone_${detailZone}`) }}</span>
                <span v-if="hoverIndex === null" class="small text-body-tertiary ms-auto">{{ t('performance.load.detail_hint') }}</span>
              </div>
              <div class="d-flex flex-wrap gap-3 small">
                <span><span class="load-dot" style="background:#0d6efd"></span>{{ t('performance.load.ctl_label') }} : <b>{{ Math.round(detail.ctl) }}</b></span>
                <span><span class="load-dot" style="background:#fd7e14"></span>{{ t('performance.load.atl_label') }} : <b>{{ Math.round(detail.atl) }}</b></span>
                <span><span class="load-dot" style="background:#343a40"></span>{{ t('performance.load.tsb_label') }} : <b>{{ fmtSigned(detail.tsb) }}</b></span>
              </div>
              <div v-if="detailActivities.length" class="mt-2 pt-2 border-top">
                <a
                  v-for="a in detailActivities" :key="`${a.source}-${a.external_id}`"
                  :href="activityHref(a)" class="load-detail-act small"
                >
                  <i class="fa-solid fa-arrow-right-long me-1 text-muted" aria-hidden="true"></i>{{ a.name }}
                  <span class="text-body-tertiary">({{ Math.round(a.tss) }} TSS)</span>
                </a>
              </div>
              <div v-else class="small text-body-tertiary mt-2">{{ t('performance.load.detail_rest') }}</div>
            </div>

            <!-- Légende des zones : sous le point sélectionné, pour lire les bandes de
                 couleur des courbes Fraîcheur / Ratio. -->
            <div class="mt-3">
              <div class="small text-muted mb-1">{{ t('performance.load.zones_title') }}</div>
              <div class="d-flex flex-wrap gap-2">
                <span
                  v-for="z in ZONE_ORDER" :key="z"
                  class="badge rounded-pill zone-chip" :style="{ backgroundColor: zoneColor(z) }"
                  :title="t(`performance.load.zone_${z}_hint`)"
                >{{ t(`performance.load.zone_${z}`) }}</span>
              </div>
            </div>

            <!-- Aide « comment lire ces courbes ». -->
            <details class="mt-3 load-how">
              <summary class="small fw-semibold text-primary">
                <i class="fa-solid fa-circle-question me-1" aria-hidden="true"></i>{{ t('performance.load.how_title') }}
              </summary>
              <p class="small text-muted mt-2 mb-0">{{ t('performance.load.how_body') }}</p>
            </details>
          </div>

          <!-- Sortie objectif datée -->
          <div class="mb-3">
            <!-- Éditeur -->
            <div v-if="editingEvent" class="event-editor">
              <div class="d-flex flex-wrap align-items-end gap-3">
                <div>
                  <label class="small text-muted d-block mb-1">{{ t('performance.load.event.date_label') }}</label>
                  <input v-model="evDate" type="date" :min="todayISO" class="form-control form-control-sm" />
                </div>
                <div>
                  <label class="small text-muted d-block mb-1">{{ t('performance.load.event.distance_label') }}</label>
                  <div class="input-group input-group-sm" style="width:8rem">
                    <input v-model="evDistance" type="number" min="1" max="1000" class="form-control" />
                    <span class="input-group-text">km</span>
                  </div>
                </div>
                <div>
                  <label class="small text-muted d-block mb-1">{{ t('performance.load.event.intensity_label') }}</label>
                  <select v-model="evIntensity" class="form-select form-select-sm" style="width:auto">
                    <option value="easy">{{ t('performance.load.event.intensity_easy') }}</option>
                    <option value="tempo">{{ t('performance.load.event.intensity_tempo') }}</option>
                    <option value="race">{{ t('performance.load.event.intensity_race') }}</option>
                  </select>
                </div>
                <div class="d-flex gap-2">
                  <button type="button" class="btn btn-sm btn-primary" :disabled="!evDate || !evDistance" @click="saveEvent">{{ t('performance.load.event.save') }}</button>
                  <button v-if="targetEvent" type="button" class="btn btn-sm btn-outline-danger" @click="removeEvent">{{ t('performance.load.event.remove') }}</button>
                  <button type="button" class="btn btn-sm btn-link text-muted" @click="editingEvent = false">{{ t('performance.load.event.cancel') }}</button>
                </div>
              </div>
            </div>

            <!-- Résumé de l'événement -->
            <div v-else-if="eventInfo && eventInfo.phase !== 'past'" class="event-card" :style="{ borderColor: PHASE_COLOR[eventInfo.phase] }">
              <div class="d-flex flex-wrap align-items-center gap-3">
                <span class="event-countdown" :style="{ backgroundColor: PHASE_COLOR[eventInfo.phase] }">
                  <span class="event-countdown-num">{{ eventInfo.days === 0 ? '🎉' : `J-${eventInfo.days}` }}</span>
                </span>
                <div class="flex-grow-1">
                  <div class="fw-bold">
                    {{ t('performance.load.event.summary', { distance: eventInfo.distanceKm, date: eventDateFmt(eventInfo.date) }) }}
                    <span class="badge ms-1" :style="{ backgroundColor: PHASE_COLOR[eventInfo.phase] }">{{ t(`performance.load.event.phase_${eventInfo.phase}`) }}</span>
                  </div>
                  <div class="small text-muted">
                    {{ t('performance.load.event.cost', { duration: fmtDuration(eventInfo.durationMin), tss: eventInfo.tss }) }}
                  </div>
                  <div v-if="feasibility" class="small mt-1" :style="{ color: FEAS_COLOR[feasibility.level] }">
                    <i class="fa-solid fa-gauge-high me-1" aria-hidden="true"></i>{{ t(`performance.load.event.feasibility_${feasibility.level}`) }}
                  </div>
                  <div v-if="projection" class="small mt-1" :style="{ color: zoneColor(formZone(projection.tsb)) }">
                    <i class="fa-solid fa-wand-magic-sparkles me-1" aria-hidden="true"></i>{{ t(`performance.load.event.projection_${projection.verdict}`, { tsb: fmtSigned(projection.tsb) }) }}
                  </div>
                </div>
                <div class="d-flex gap-2">
                  <button type="button" class="btn btn-sm btn-outline-secondary" @click="openEventEditor">{{ t('performance.load.event.edit') }}</button>
                  <button type="button" class="btn btn-sm btn-link text-danger p-0" @click="removeEvent">{{ t('performance.load.event.remove') }}</button>
                </div>
              </div>
            </div>

            <!-- Bouton d'ajout -->
            <button v-else type="button" class="btn btn-sm btn-outline-primary" @click="openEventEditor">
              <i class="fa-solid fa-calendar-check me-1" aria-hidden="true"></i>{{ t('performance.load.event.set') }}
            </button>
          </div>

          <!-- Recommandation du jour -->
          <div v-if="recommendation" class="reco-card mb-3" :style="{ borderColor: ACTION_STYLE[recommendation.action].color }">
            <div class="d-flex flex-wrap align-items-center gap-3">
              <span class="reco-icon" :style="{ backgroundColor: ACTION_STYLE[recommendation.action].color }">
                <i :class="`fa-solid ${ACTION_STYLE[recommendation.action].icon}`" aria-hidden="true"></i>
              </span>
              <div class="flex-grow-1">
                <div class="small text-muted">{{ t('performance.load.reco.title') }}</div>
                <div class="fs-5 fw-bold" :style="{ color: ACTION_STYLE[recommendation.action].color }">
                  {{ t(`performance.load.reco.action_${recommendation.action}`) }}
                  <span v-if="recommendation.minutes" class="text-body fw-normal fs-6">·
                    ≈ {{ fmtDuration(recommendation.minutes) }}<template v-if="recommendation.distanceKm"> (<span
                      class="reco-distance"
                      :title="t('performance.load.reco.distance_cycling_hint', { speed: data?.thresholds?.typical_speed_kmh })"
                    >{{ t('performance.load.reco.distance_cycling', { km: recommendation.distanceKm }) }}</span>)</template>
                    {{ t(`performance.load.reco.effort_${recommendation.effort}`) }}
                  </span>
                </div>
                <div class="small text-muted">
                  {{ t(`performance.load.reco.${recommendation.reason}`, { tsb: recommendation.tsb, days: recommendation.days ?? 0 }) }}
                  <span
                    v-if="recommendation.tss"
                    class="reco-tss"
                    :title="t('performance.load.reco.tss_explain')"
                  >(~{{ recommendation.tss }} TSS <i class="fa-solid fa-circle-info" aria-hidden="true"></i>)</span>
                </div>
              </div>
              <div v-if="!eventInfo || eventInfo.phase === 'past'">
                <label class="small text-muted d-block mb-1">{{ t('performance.load.reco.goal_label') }}</label>
                <select v-model="goal" class="form-select form-select-sm reco-goal">
                  <option v-for="g in GOALS" :key="g" :value="g">{{ t(`performance.load.reco.goal_${g}`) }}</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Cible de volume de la semaine -->
          <div v-if="weekPlan" class="week-card mb-3">
            <div class="d-flex flex-wrap align-items-baseline gap-2 mb-2">
              <span class="fw-bold">{{ t('performance.load.week.title') }}</span>
              <span class="text-body-secondary">
                {{ t('performance.load.week.target', { tss: weekPlan.target }) }}
                <span class="text-body-tertiary">·
                  <template v-if="weekPlan.ramp === null">{{ t('performance.load.week.ramp_event') }}</template>
                  <template v-else-if="weekPlan.ramp > 0">{{ t('performance.load.week.ramp_up', { tss: weekPlan.rampTss, ctl: weekPlan.ramp }) }}</template>
                  <template v-else-if="weekPlan.ramp === 0">{{ t('performance.load.week.ramp_flat') }}</template>
                  <template v-else>{{ t('performance.load.week.ramp_down', { tss: Math.abs(weekPlan.rampTss ?? 0) }) }}</template>
                </span>
              </span>
              <span class="badge ms-auto" :style="{ backgroundColor: WEEK_PACE_COLOR[weekPlan.pace] }">
                {{ t(`performance.load.week.pace_${weekPlan.pace}`) }}
              </span>
            </div>

            <!-- Vert = fait, orange = prévu (itinéraires planifiés), gris = à placer.
                 Si fait + prévu dépasse la cible, la barre se cale sur le total et un
                 repère marque la position de la cible. -->
            <div class="week-progress-wrap">
              <div class="progress week-progress" role="progressbar" :aria-valuenow="weekPlan.donePct" aria-valuemin="0" aria-valuemax="100">
                <div class="progress-bar" :style="{ width: `${weekPlan.donePct}%`, backgroundColor: WEEK_SEGMENT_COLOR.done }"></div>
                <div class="progress-bar progress-bar-striped" :style="{ width: `${weekPlan.plannedPct}%`, backgroundColor: WEEK_SEGMENT_COLOR.planned }"></div>
              </div>
              <div
                v-if="weekPlan.overPlanned"
                class="week-target-marker"
                :style="{ left: `${weekPlan.targetPct}%` }"
                :title="t('performance.load.week.target', { tss: weekPlan.target })"
              ></div>
            </div>

            <div class="d-flex flex-wrap gap-2 justify-content-between small mt-2">
              <span class="fw-semibold">
                <i class="fa-solid fa-square me-1" :style="{ color: WEEK_SEGMENT_COLOR.done }" aria-hidden="true"></i>
                {{ t('performance.load.week.progress', { done: weekPlan.done, target: weekPlan.target }) }}
                <span v-if="weekPlan.planned > 0" class="fw-normal ms-2">
                  <i class="fa-solid fa-square me-1" :style="{ color: WEEK_SEGMENT_COLOR.planned }" aria-hidden="true"></i>
                  {{ t('performance.load.week.planned', { tss: weekPlan.planned }) }}
                </span>
              </span>
              <span v-if="weekPlan.remaining > 0" class="text-muted">
                {{ t('performance.load.week.remaining_to_plan', { tss: weekPlan.remaining, days: weekPlan.daysLeft, duration: fmtDuration(weekPlan.minutesLeft) }) }}
              </span>
              <span v-else class="text-success">
                <i class="fa-solid fa-circle-check me-1" aria-hidden="true"></i>{{ t('performance.load.week.done_label') }}
              </span>
            </div>

            <WeekPlanner :athlete="athlete" :done-by-day="doneByDay" fluid class="mt-3" />

            <div class="small text-body-tertiary mt-2">
              <i class="fa-solid fa-circle-info me-1" aria-hidden="true"></i>{{ t(weekPlan.ramp === null ? 'performance.load.week.explain_event' : 'performance.load.week.explain') }}
            </div>
          </div>


          <hr class="my-3" />

          <!-- Couverture + seuil FC -->
          <div class="row g-3 align-items-center small">
            <div class="col-12 col-md-7 text-muted">
              <i class="fa-solid fa-circle-info me-1" :title="t('performance.load.coverage_hint')" aria-hidden="true"></i>
              {{ t('performance.load.coverage', { total: data.coverage.total, power: data.coverage.power, hr: data.coverage.hr, estimated: data.coverage.estimated }) }}
            </div>
            <div class="col-12 col-md-5 text-md-end">
              <template v-if="!editingLthr">
                <span class="text-muted me-2">{{ t('performance.load.lthr_title') }} :</span>
                <strong v-if="lthr">{{ t('performance.load.lthr_value', { bpm: lthr }) }}</strong>
                <span v-else class="text-muted">—</span>
                <span v-if="lthr && lthrSource" class="badge ms-1" :class="lthrSource === 'manual' ? 'text-bg-primary' : 'text-bg-secondary'">
                  {{ lthrSource === 'manual' ? t('performance.ftp.source_manual') : t('performance.ftp.source_auto') }}
                </span>
                <button type="button" class="btn btn-sm btn-link p-0 ms-2" @click="startEditLthr">
                  <i class="fa-solid fa-pen" aria-hidden="true"></i>
                </button>
              </template>
              <div v-else class="d-inline-flex align-items-center gap-2">
                <div class="input-group input-group-sm" style="width:9rem">
                  <input v-model="lthrInput" type="number" min="100" max="220" class="form-control" :placeholder="t('performance.ftp.auto_placeholder')" />
                  <span class="input-group-text">bpm</span>
                </div>
                <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="saveLthr">{{ t('performance.ftp.save') }}</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="saving" @click="resetLthr">{{ t('performance.ftp.use_auto') }}</button>
                <button type="button" class="btn btn-sm btn-link text-muted" :disabled="saving" @click="editingLthr = false">{{ t('performance.ftp.cancel') }}</button>
              </div>
            </div>
          </div>

          <!-- Méthode de calcul du TSS et du seuil FC -->
          <details class="load-how mt-2">
            <summary class="small fw-semibold text-primary">
              <i class="fa-solid fa-calculator me-1" aria-hidden="true"></i>{{ t('performance.load.methods_title') }}
            </summary>
            <div class="methods-body small text-muted mt-2">
              <div class="fw-semibold text-body">{{ t('performance.load.tss_method_title') }}</div>
              <p class="mb-1">{{ t('performance.load.tss_method_formula') }}</p>
              <p class="mb-1">{{ t('performance.load.tss_method_intro') }}</p>
              <ol class="mb-1 ps-3">
                <li>{{ t('performance.load.tss_method_power') }}</li>
                <li>{{ t('performance.load.tss_method_hr') }}</li>
                <li>{{ t('performance.load.tss_method_estimated') }}</li>
              </ol>
              <p class="mb-3">{{ t('performance.load.tss_method_cap') }}</p>

              <div class="fw-semibold text-body">{{ t('performance.load.lthr_method_title') }}</div>
              <p class="mb-1 text-body">{{ t('performance.load.lthr_method_what') }}</p>
              <p class="mb-1">{{ t('performance.load.lthr_method_manual') }}</p>
              <p class="mb-1">{{ t('performance.load.lthr_method_auto') }}</p>
              <p class="mb-0 text-body-tertiary">
                <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ t('performance.load.lthr_method_auto_warning') }}
              </p>
            </div>
          </details>

          <p class="small text-body-tertiary mt-2 mb-0">
            <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ t('performance.load.seed_hint') }}
          </p>

          <!-- Maintenance (administrateurs seulement) -->
          <div v-if="props.admin" class="admin-maint mt-3">
            <div class="d-flex flex-wrap align-items-center gap-2">
              <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="backfilling" @click="runBackfill">
                <span v-if="backfilling" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                <i v-else class="fa-solid fa-wrench me-1" aria-hidden="true"></i>
                {{ backfilling ? t('performance.load.admin.backfill_running') : t('performance.load.admin.backfill') }}
              </button>
              <span
                v-if="backfillResult"
                class="small text-muted"
              >{{ t('performance.load.admin.backfill_result', { updated: backfillResult.updated, unchanged: backfillResult.unchanged, scanned: backfillResult.scanned }) }}</span>
            </div>
            <div class="small text-body-tertiary mt-1">
              <i class="fa-solid fa-lock me-1" aria-hidden="true"></i>{{ t('performance.load.admin.backfill_hint') }}
            </div>
          </div>
        </template>
      </div>
    </div>
    </div><!-- /section forme -->

    <!-- Sous-onglet « Zones d'intensité » : même donnée (fetch partagé), vue à part. -->
    <div v-show="section === 'zones'">
      <div v-if="loading" class="text-muted d-flex align-items-center gap-2 py-3">
        <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
        <span>{{ t('performance.loading') }}</span>
      </div>
      <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>{{ error }}</span>
      </div>
      <ZoneDistribution
        v-else-if="current"
        :zones="data?.zones ?? null"
        :lthr="lthr"
        :ftp="data?.thresholds?.ftp_current ?? null"
      />
      <div v-else class="text-muted mb-0">{{ t('performance.load.no_data') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Décale l'ancre sous la navbar fixe (fixed-top) pour ne pas masquer le titre.
   `--navbar-h` = hauteur réelle (mesurée par trackNavbar) : la navbar wrappe
   sur deux lignes avec beaucoup de menus. Marge de 1.5rem sous la barre. */
#training-load {
  scroll-margin-top: calc(var(--navbar-h, 3.5rem) + 1.5rem);
}
.load-tile {
  height: 100%;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
}
/* Case cliquable : ouvre/ferme sa courbe. Chevron CSS (pas de dépendance police) qui
   pivote quand la courbe est ouverte ; la bordure passe à l'accent. */
.load-tile-toggle {
  position: relative;
  cursor: pointer;
  padding-right: 1.75rem;
  transition: border-color 0.15s, background 0.15s;
}
.load-tile-toggle:hover {
  background: var(--bs-tertiary-bg);
}
.load-tile-toggle::after {
  content: '';
  position: absolute;
  top: 0.85rem;
  right: 0.85rem;
  width: 0.45rem;
  height: 0.45rem;
  border-right: 2px solid var(--bs-secondary-color);
  border-bottom: 2px solid var(--bs-secondary-color);
  transform: rotate(45deg);
  transition: transform 0.15s;
  opacity: 0.55;
}
.load-tile-toggle.is-open {
  border-color: var(--bs-primary);
}
.load-tile-toggle.is-open::after {
  transform: rotate(-135deg);
  opacity: 0.9;
}
.reco-card {
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-left-width: 4px;
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}
.reco-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  flex: 0 0 auto;
  border-radius: 50%;
  color: #fff;
  font-size: 1.2rem;
}
.reco-goal {
  width: auto;
  min-width: 11rem;
}
.reco-tss,
.reco-distance {
  cursor: help;
  white-space: nowrap;
}
.week-card {
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
}
.week-progress {
  height: 0.75rem;
}
/* Repère « objectif » : trait vertical qui déborde légèrement la barre, coiffé d'un
   petit fanion, posé à la position de la cible quand on planifie au-delà. */
.week-progress-wrap {
  position: relative;
}
.week-target-marker {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  background: var(--bs-body-color, #212529);
  border-radius: 1px;
  pointer-events: none;
}
.week-target-marker::before {
  content: "";
  position: absolute;
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--bs-body-color, #212529);
}
.event-card {
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-left-width: 4px;
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}
.event-editor {
  padding: 0.75rem 1rem;
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.5rem;
}
.event-countdown {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3.25rem;
  height: 3.25rem;
  flex: 0 0 auto;
  border-radius: 0.5rem;
  color: #fff;
}
.event-countdown-num {
  font-weight: 700;
  font-size: 1rem;
}
.load-help {
  font-size: 0.78rem;
  color: var(--bs-secondary-color);
  margin-top: 0.25rem;
}
.load-trend {
  display: inline-flex;
  align-items: center;
  font-size: 0.85rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: help;
}
.trend-good {
  color: #198754;
}
.trend-warn {
  color: #fd7e14;
}
.trend-flat {
  color: var(--bs-secondary-color);
}
.load-detail {
  margin-top: 0.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}
.load-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  vertical-align: middle;
}
.load-detail-act {
  display: block;
  padding: 2px 0;
  color: var(--bs-body-color);
  text-decoration: none;
}
.load-detail-act:hover {
  color: var(--bs-primary);
  text-decoration: underline;
}
.zone-chip {
  cursor: help;
}
.load-how summary {
  cursor: pointer;
  list-style: revert;
}
/* Texte explicatif : borné en largeur, une ligne trop longue devient illisible. */
.methods-body {
  max-width: 68ch;
}
.methods-body li {
  margin-bottom: 0.35rem;
}
</style>
