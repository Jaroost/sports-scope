<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'
import {
  useTrainingPlan, zoneColor, formZone, acwrColor, fmtDuration, fmtSigned, eventDateFmt,
  ACTION_STYLE, PHASE_COLOR, FEAS_COLOR, GOALS, WEEK_PACE_COLOR,
  type Point, type LoadSummary, type DayActivity,
} from '../composables/useTrainingPlan'
import ZoneDistribution from './ZoneDistribution.vue'

const props = defineProps({
  admin: { type: Boolean, default: false },
})

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
  await nextTick()
  renderChart()
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

// Remplissages translucides des bandes de zones (mêmes couleurs que la légende).
const ZONE_FILL: Record<string, string> = {
  very_fresh: 'rgba(13,110,253,0.20)',
  fresh: 'rgba(25,135,84,0.20)',
  neutral: 'rgba(108,117,125,0.14)',
  productive: 'rgba(253,126,20,0.22)',
  overreaching: 'rgba(220,53,69,0.24)',
}

// Plugin Chart.js : peint en fond les bandes de zones TSB, calées sur l'axe droit
// (`tsb`), derrière les courbes. Bornes = seuils de formZone.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tsbZonesPlugin: any = {
  id: 'tsbZones',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  beforeDatasetsDraw(c: any) {
    const scale = c.scales?.tsb
    const area = c.chartArea
    if (!scale || !area) return
    const bands = [
      { from: 20, to: Infinity, fill: ZONE_FILL.very_fresh },
      { from: 5, to: 20, fill: ZONE_FILL.fresh },
      { from: -10, to: 5, fill: ZONE_FILL.neutral },
      { from: -30, to: -10, fill: ZONE_FILL.productive },
      { from: -Infinity, to: -30, fill: ZONE_FILL.overreaching },
    ]
    const { ctx } = c
    ctx.save()
    for (const b of bands) {
      let yTop = b.to === Infinity ? area.top : scale.getPixelForValue(b.to)
      let yBot = b.from === -Infinity ? area.bottom : scale.getPixelForValue(b.from)
      yTop = Math.max(area.top, Math.min(area.bottom, yTop))
      yBot = Math.max(area.top, Math.min(area.bottom, yBot))
      if (yBot - yTop <= 0.5) continue
      ctx.fillStyle = b.fill
      ctx.fillRect(area.left, yTop, area.right - area.left, yBot - yTop)
    }
    ctx.restore()
  },
}

// ── Plan d'entraînement (objectif + reco du jour), partagé avec le widget d'accueil ─
const {
  current, goal, targetEvent, eventInfo, feasibility, projection,
  editingEvent, evDate, evDistance, evIntensity, todayISO,
  openEventEditor, saveEvent, removeEvent, recommendation, weekPlan,
} = useTrainingPlan(data)
const currentZone = computed(() => current.value?.form_zone ?? 'neutral')

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

// ── Graphique PMC (Chart.js) ─────────────────────────────────────────────────
// Deux graphiques empilés : « charge » (CTL+ATL) en haut, « fraîcheur » (TSB + zones)
// en bas. Ainsi chaque bande de couleur ne va qu'avec la seule courbe sous elle.
const loadCanvas = ref<HTMLCanvasElement | null>(null)
const tsbCanvas = ref<HTMLCanvasElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadChart: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tsbChart: any = null

const hasData = computed(() => (data.value?.series?.length ?? 0) >= 2)

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

// ── Panneau de détail (sous les graphes) ─────────────────────────────────────
// Un tooltip flottant recouvrait presque tout le tracé (les graphes ne font que
// ~200 px de haut, et la liste des séances allonge la bulle) : le détail vit donc
// dans un bloc dédié sous les courbes. Le survol/tap ne fait que déplacer l'index.
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

// Repère vertical sur les DEUX graphes au jour lu, puisque le détail n'est plus
// ancré au curseur : sans lui, on ne saurait pas quel point le bloc décrit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hoverLinePlugin: any = {
  id: 'hoverLine',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  afterDatasetsDraw(c: any) {
    if (hoverIndex.value == null) return
    const pt = c.getDatasetMeta(0)?.data?.[hoverIndex.value]
    const area = c.chartArea
    if (!pt || !area) return
    const { ctx } = c
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(pt.x, area.top)
    ctx.lineTo(pt.x, area.bottom)
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = 'rgba(33,37,41,0.5)'
    ctx.stroke()
    ctx.restore()
  },
}

// Chart.js n'expose pas d'événement « index survolé » : on détourne le hook du
// tooltip (désactivé visuellement) qui, lui, connaît le point actif.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syncDetail(context: { tooltip: any }) {
  const idx = context.tooltip?.dataPoints?.[0]?.dataIndex
  // `opacity: 0` = sortie de survol : on garde le dernier index tant que le curseur
  // reste sur le graphe (le repli sur le dernier jour se fait au mouseleave).
  if (idx != null) hoverIndex.value = idx
}

// Le graphe non survolé doit redessiner son repère : Chart.js ne le sait pas.
watch(hoverIndex, () => {
  loadChart?.render()
  tsbChart?.render()
})

// Aligne l'aire de tracé des deux graphes : même largeur d'axe Y à gauche.
const Y_AXIS_WIDTH = 46

// Interactions communes aux deux graphes : les deux alimentent le même panneau.
function sharedOptions(extra: Record<string, unknown> = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'top' as const, labels: { usePointStyle: true, boxWidth: 8 } },
      tooltip: { enabled: false, external: syncDetail },
    },
    ...extra,
  }
}

async function renderChart() {
  if (loadChart) { loadChart.destroy(); loadChart = null }
  if (tsbChart) { tsbChart.destroy(); tsbChart = null }
  if (!hasData.value || !loadCanvas.value || !tsbCanvas.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  const pts = displayed.value
  const labels = pts.map((p) => fmtDate(p.date))

  // ── Graphe du haut : charge (forme de fond + fatigue) ──────────────────────
  const loadCtx = loadCanvas.value.getContext('2d')
  if (loadCtx) {
    loadChart = new Chart(loadCtx, {
      type: 'line',
      plugins: [hoverLinePlugin],
      data: {
        labels,
        datasets: [
          {
            label: t('performance.load.ctl_label'), data: pts.map((p) => p.ctl),
            borderColor: '#0d6efd', pointRadius: 0, borderWidth: 2, tension: 0.3,
          },
          {
            label: t('performance.load.atl_label'), data: pts.map((p) => p.atl),
            borderColor: '#fd7e14', pointRadius: 0, borderWidth: 1.5, tension: 0.3, borderDash: [5, 3],
          },
        ],
      },
      options: sharedOptions({
        scales: {
          y: { beginAtZero: true, position: 'left', afterFit: (s: { width: number }) => { s.width = Y_AXIS_WIDTH }, title: { display: true, text: t('performance.load.axis_load') } },
          x: { ticks: { display: false }, grid: { display: false } },
        },
      }),
    })
  }

  // ── Graphe du bas : fraîcheur (TSB) seule, avec les bandes de zones ─────────
  const tsbCtx = tsbCanvas.value.getContext('2d')
  if (tsbCtx) {
    tsbChart = new Chart(tsbCtx, {
      type: 'line',
      plugins: [tsbZonesPlugin, hoverLinePlugin],
      data: {
        labels,
        datasets: [
          {
            label: t('performance.load.tsb_label'), data: pts.map((p) => p.tsb), yAxisID: 'tsb',
            borderColor: '#343a40', pointRadius: 0, borderWidth: 2, tension: 0.3,
          },
        ],
      },
      options: sharedOptions({
        scales: {
          tsb: { type: 'linear', position: 'left', afterFit: (s: { width: number }) => { s.width = Y_AXIS_WIDTH }, title: { display: true, text: t('performance.load.axis_tsb') } },
          x: { ticks: { maxTicksLimit: 12, autoSkip: true } },
        },
      }),
    })
  }
}

// Re-render quand la fenêtre change. L'index survolé désigne une position dans la
// série affichée : il ne veut plus rien dire une fois la fenêtre changée.
watch(rangeDays, async () => { hoverIndex.value = null; await nextTick(); renderChart() })

onBeforeUnmount(() => {
  if (loadChart) { loadChart.destroy(); loadChart = null }
  if (tsbChart) { tsbChart.destroy(); tsbChart = null }
})
</script>

<template>
  <div id="training-load" ref="rootEl" class="mb-4">
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
              <div class="load-tile" :title="t('performance.load.ctl_help')">
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
              <div class="load-tile" :title="t('performance.load.atl_help')">
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
              <div class="load-tile" :title="t('performance.load.tsb_help')">
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
              <div class="load-tile" :title="t('performance.load.acwr_help')">
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
                  <template v-else-if="weekPlan.ramp > 0">{{ t('performance.load.week.ramp_up', { ctl: weekPlan.ramp }) }}</template>
                  <template v-else-if="weekPlan.ramp === 0">{{ t('performance.load.week.ramp_flat') }}</template>
                  <template v-else>{{ t('performance.load.week.ramp_down') }}</template>
                </span>
              </span>
              <span class="badge ms-auto" :style="{ backgroundColor: WEEK_PACE_COLOR[weekPlan.pace] }">
                {{ t(`performance.load.week.pace_${weekPlan.pace}`) }}
              </span>
            </div>

            <div class="progress week-progress" role="progressbar" :aria-valuenow="weekPlan.pct" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar" :style="{ width: `${weekPlan.pct}%`, backgroundColor: WEEK_PACE_COLOR[weekPlan.pace] }"></div>
            </div>

            <div class="d-flex flex-wrap gap-2 justify-content-between small mt-2">
              <span class="fw-semibold">{{ t('performance.load.week.progress', { done: weekPlan.done, target: weekPlan.target }) }}</span>
              <span v-if="weekPlan.remaining > 0" class="text-muted">
                {{ t('performance.load.week.remaining', { tss: weekPlan.remaining, days: weekPlan.daysLeft, duration: fmtDuration(weekPlan.minutesLeft) }) }}
              </span>
              <span v-else class="text-success">
                <i class="fa-solid fa-circle-check me-1" aria-hidden="true"></i>{{ t('performance.load.week.done_label') }}
              </span>
            </div>

            <div class="small text-body-tertiary mt-2">
              <i class="fa-solid fa-circle-info me-1" aria-hidden="true"></i>{{ t(weekPlan.ramp === null ? 'performance.load.week.explain_event' : 'performance.load.week.explain') }}
            </div>
          </div>

          <!-- Aide « comment lire » -->
          <details class="mb-3 load-how">
            <summary class="small fw-semibold text-primary">
              <i class="fa-solid fa-circle-question me-1" aria-hidden="true"></i>{{ t('performance.load.how_title') }}
            </summary>
            <p class="small text-muted mt-2 mb-0">{{ t('performance.load.how_body') }}</p>
          </details>

          <!-- Sélecteur de période -->
          <div class="btn-group btn-group-sm mb-2" role="group">
            <button
              v-for="r in RANGES" :key="r.key" type="button"
              class="btn" :class="rangeDays === r.days ? 'btn-primary' : 'btn-outline-secondary'"
              @click="rangeDays = r.days"
            >{{ t(`performance.load.${r.key}`) }}</button>
          </div>

          <!-- Graphiques : charge en haut, fraîcheur (+ zones) en bas -->
          <div @mouseleave="hoverIndex = null">
            <div class="load-chart-wrap load-chart-top">
              <canvas ref="loadCanvas"></canvas>
            </div>
            <div class="load-chart-wrap load-chart-bottom">
              <canvas ref="tsbCanvas"></canvas>
            </div>
          </div>

          <!-- Détail du jour lu : sous les graphes plutôt qu'en bulle par-dessus -->
          <div v-if="detail" class="load-detail">
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

          <!-- Légende des zones -->
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

    <!-- Répartition du temps par zone d'intensité (FC & puissance) -->
    <ZoneDistribution
      v-if="current"
      class="mt-4"
      :zones="data?.zones ?? null"
      :lthr="lthr"
      :ftp="data?.thresholds?.ftp_current ?? null"
    />
  </div>
</template>

<style scoped>
/* Décale l'ancre sous la navbar fixe (fixed-top) pour ne pas masquer le titre. */
#training-load {
  scroll-margin-top: 5rem;
}
.load-tile {
  height: 100%;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
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
.load-chart-wrap {
  position: relative;
}
.load-chart-top {
  height: 210px;
}
.load-chart-bottom {
  height: 180px;
  margin-top: 0.25rem;
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
