<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'

// ── Types du payload /api/performance/training_load ──────────────────────────
interface DayActivity { source: string; external_id: string; name: string; tss: number; source_tss: string }
interface Point { date: string; tss: number; ctl: number; atl: number; tsb: number; activities?: DayActivity[] }
interface Current extends Point { form_zone: string }
interface Coverage { power: number; hr: number; estimated: number; total: number }
interface Thresholds { ftp_current?: number | null; lthr?: number | null; lthr_source?: string | null; lthr_auto?: number | null; typical_speed_kmh?: number | null }
interface LoadSummary {
  current: Current | null
  series: Point[]
  coverage: Coverage
  thresholds: Thresholds
}

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

onMounted(fetchData)

// ── Zones de fraîcheur (TSB) ─────────────────────────────────────────────────
const ZONES: Record<string, { color: string }> = {
  very_fresh: { color: '#0d6efd' },
  fresh: { color: '#198754' },
  neutral: { color: '#6c757d' },
  productive: { color: '#fd7e14' },
  overreaching: { color: '#dc3545' },
}
const ZONE_ORDER = ['fresh', 'neutral', 'productive', 'overreaching', 'very_fresh']

function zoneColor(key: string): string {
  return ZONES[key]?.color ?? '#6c757d'
}

// Zone de fraîcheur d'un TSB (mêmes seuils que TrainingLoad#form_zone côté serveur) —
// sert au tooltip pour afficher l'état de n'importe quel jour, pas seulement aujourd'hui.
function formZone(tsb: number): string {
  if (tsb >= 20) return 'very_fresh'
  if (tsb >= 5) return 'fresh'
  if (tsb >= -10) return 'neutral'
  if (tsb >= -30) return 'productive'
  return 'overreaching'
}

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

const current = computed(() => data.value?.current ?? null)
const currentZone = computed(() => current.value?.form_zone ?? 'neutral')

// ── Recommandation du jour ───────────────────────────────────────────────────
// Objectif de l'utilisateur → « plancher de fatigue » (TSB) acceptable. Selon la marge
// entre le TSB du jour et ce plancher, on propose repos / sortie facile / grosse séance.
// Persisté en localStorage comme le sport sélectionné.
const GOAL_STORAGE_KEY = 'sportsScope.trainingGoal'
const GOALS = ['improve_fast', 'improve_slow', 'maintain', 'peak'] as const
type Goal = typeof GOALS[number]
const GOAL_FLOOR: Record<Goal, number> = { improve_fast: -30, improve_slow: -20, maintain: -8, peak: 5 }

const storedGoal = (typeof localStorage !== 'undefined' && localStorage.getItem(GOAL_STORAGE_KEY)) as Goal | null
const goal = ref<Goal>(storedGoal && GOALS.includes(storedGoal) ? storedGoal : 'improve_slow')
watch(goal, (g) => { try { localStorage.setItem(GOAL_STORAGE_KEY, g) } catch { /* ignore */ } })

const ACTION_STYLE: Record<string, { icon: string; color: string }> = {
  rest: { icon: 'fa-bed', color: '#6c757d' },
  easy: { icon: 'fa-person-biking', color: '#198754' },
  big: { icon: 'fa-fire', color: '#dc3545' },
}

// Convertit un TSS en durée approx. (min, arrondie au 1/4 h) pour une intensité donnée :
// TSS = heures × IF² × 100 ⟹ heures = TSS / (IF² × 100). Rend la reco parlante.
function tssToMinutes(tss: number, intensity: number): number {
  const minutes = (tss / (intensity * intensity * 100)) * 60
  return Math.max(15, Math.round(minutes / 15) * 15)
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return `${h}h${String(m).padStart(2, '0')}`
  if (h) return `${h}h`
  return `${m} min`
}

const recommendation = computed(() => {
  const c = current.value
  if (!c) return null
  const tsb = c.tsb
  const ctl = c.ctl
  const headroom = tsb - GOAL_FLOOR[goal.value]

  let action: 'rest' | 'easy' | 'big'
  let tss = 0
  let minutes = 0
  let effort = ''
  let reason: string
  if (tsb <= -30) {
    action = 'rest'; reason = 'reason_overreaching'
  } else if (headroom < 0) {
    action = 'rest'; reason = 'reason_rest'
  } else if (headroom < 12) {
    action = 'easy'; tss = Math.round(0.6 * ctl); minutes = tssToMinutes(tss, 0.65); effort = 'endurance'; reason = 'reason_easy'
  } else {
    action = 'big'; tss = Math.round(1.4 * ctl); minutes = tssToMinutes(tss, 0.80); effort = 'hard'; reason = 'reason_big'
  }
  // Distance approximative selon la vitesse habituelle (km/h) × durée.
  const speed = data.value?.thresholds?.typical_speed_kmh ?? null
  const distanceKm = speed && minutes ? Math.round((speed * minutes) / 60) : null
  return { action, tss, minutes, effort, reason, distanceKm, tsb: Math.round(tsb) }
})

function fmtSigned(v: number): string {
  return v > 0 ? `+${Math.round(v)}` : String(Math.round(v))
}

// ── Série affichée selon la fenêtre choisie ──────────────────────────────────
const displayed = computed<Point[]>(() => {
  const s = data.value?.series ?? []
  if (!s.length || !Number.isFinite(rangeDays.value)) return s
  return s.slice(-rangeDays.value)
})

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

// ── Tooltip HTML externe (permet un badge coloré pour l'état du jour) ────────
let tooltipEl: HTMLElement | null = null

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
function dot(color: string): string {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>`
}
function dateLong(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTooltipEl(chart: any): HTMLElement {
  const parent = chart.canvas.parentNode as HTMLElement
  if (!tooltipEl) {
    tooltipEl = document.createElement('div')
    Object.assign(tooltipEl.style, {
      position: 'absolute', pointerEvents: 'none', opacity: '0',
      transform: 'translate(-50%, -100%)', transition: 'opacity .1s ease',
      background: 'rgba(17,24,39,0.92)', color: '#fff', padding: '8px 10px',
      borderRadius: '6px', fontSize: '12px', lineHeight: '1.4', width: '240px',
      boxSizing: 'border-box', zIndex: '20', boxShadow: '0 4px 12px rgba(0,0,0,0.25)', whiteSpace: 'normal',
    } as Partial<CSSStyleDeclaration>)
    parent.appendChild(tooltipEl)
  } else if (tooltipEl.parentNode !== parent) {
    parent.appendChild(tooltipEl)
  }
  return tooltipEl
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function externalTooltip(context: { chart: any; tooltip: any }) {
  const { chart, tooltip } = context
  const el = getTooltipEl(chart)
  if (!tooltip.opacity) { el.style.opacity = '0'; return }

  const p = displayed.value[tooltip.dataPoints?.[0]?.dataIndex]
  if (!p) { el.style.opacity = '0'; return }

  const zone = formZone(p.tsb)
  const acts = p.activities ?? []
  const actHtml = acts.length
    ? '<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,.15);padding-top:5px">' +
      acts.slice(0, 4).map((a) => `<div style="opacity:.9">• ${escapeHtml(a.name)} <span style="opacity:.6">(${Math.round(a.tss)})</span></div>`).join('') +
      (acts.length > 4 ? `<div style="opacity:.6">+${acts.length - 4}…</div>` : '') +
      `<div style="opacity:.7;margin-top:3px"><i>${escapeHtml(t('performance.load.click_activity'))}</i></div>` +
      '</div>'
    : ''

  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:5px;text-transform:capitalize">${escapeHtml(dateLong(p.date))}</div>` +
    `<div>${dot('#0d6efd')}${escapeHtml(t('performance.load.ctl_label'))} : <b>${Math.round(p.ctl)}</b></div>` +
    `<div>${dot('#fd7e14')}${escapeHtml(t('performance.load.atl_label'))} : <b>${Math.round(p.atl)}</b></div>` +
    `<div style="margin-bottom:6px">${dot('#adb5bd')}${escapeHtml(t('performance.load.tsb_label'))} : <b>${p.tsb > 0 ? '+' : ''}${Math.round(p.tsb)}</b></div>` +
    `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${zoneColor(zone)};color:#fff;font-weight:600;font-size:11px">${escapeHtml(t(`performance.load.zone_${zone}`))}</span>` +
    actHtml

  // Positionne le tooltip du côté OPPOSÉ au survol (coin haut), pour qu'il ne soit
  // jamais masqué par le curseur : souris à gauche → tooltip à droite, et inversement.
  const area = chart.chartArea
  const left = chart.canvas.offsetLeft
  const top = chart.canvas.offsetTop
  const onLeftHalf = tooltip.caretX <= (area.left + area.right) / 2

  el.style.opacity = '1'
  el.style.top = `${top + area.top + 6}px`
  if (onLeftHalf) {
    el.style.left = `${left + area.right - 6}px`
    el.style.transform = 'translate(-100%, 0)'
  } else {
    el.style.left = `${left + area.left + 6}px`
    el.style.transform = 'translate(0, 0)'
  }
}

// Aligne l'aire de tracé des deux graphes : même largeur d'axe Y à gauche.
const Y_AXIS_WIDTH = 46

// Interactions communes aux deux graphes (clic → séance, curseur, tooltip externe).
function sharedOptions(pts: Point[], extra: Record<string, unknown> = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    onClick: (_evt: unknown, els: { index: number }[]) => {
      const act = pts[els?.[0]?.index]?.activities?.[0]
      if (act) window.location.href = activityHref(act)
    },
    onHover: (evt: { native?: Event }, els: { index: number }[]) => {
      const target = evt.native?.target as HTMLElement | undefined
      if (!target) return
      target.style.cursor = pts[els?.[0]?.index]?.activities?.length ? 'pointer' : 'default'
    },
    plugins: {
      legend: { position: 'top' as const, labels: { usePointStyle: true, boxWidth: 8 } },
      tooltip: { enabled: false, external: externalTooltip },
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
      options: sharedOptions(pts, {
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
      plugins: [tsbZonesPlugin],
      data: {
        labels,
        datasets: [
          {
            label: t('performance.load.tsb_label'), data: pts.map((p) => p.tsb), yAxisID: 'tsb',
            borderColor: '#343a40', pointRadius: 0, borderWidth: 2, tension: 0.3,
          },
        ],
      },
      options: sharedOptions(pts, {
        scales: {
          tsb: { type: 'linear', position: 'left', afterFit: (s: { width: number }) => { s.width = Y_AXIS_WIDTH }, title: { display: true, text: t('performance.load.axis_tsb') } },
          x: { ticks: { maxTicksLimit: 12, autoSkip: true } },
        },
      }),
    })
  }
}

// Re-render quand la fenêtre change.
watch(rangeDays, async () => { await nextTick(); renderChart() })

onBeforeUnmount(() => {
  if (loadChart) { loadChart.destroy(); loadChart = null }
  if (tsbChart) { tsbChart.destroy(); tsbChart = null }
  if (tooltipEl) { tooltipEl.remove(); tooltipEl = null }
})
</script>

<template>
  <div class="mb-4">
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
            <div class="col-12 col-md-4">
              <div class="load-tile" :title="t('performance.load.ctl_help')">
                <div class="small text-muted">{{ t('performance.load.ctl_label') }} <span class="text-body-tertiary">· {{ t('performance.load.ctl_sub') }}</span></div>
                <div class="fs-3 fw-bold" style="color:#0d6efd">{{ Math.round(current.ctl) }}</div>
                <div class="load-help">{{ t('performance.load.ctl_help') }}</div>
              </div>
            </div>
            <div class="col-12 col-md-4">
              <div class="load-tile" :title="t('performance.load.atl_help')">
                <div class="small text-muted">{{ t('performance.load.atl_label') }} <span class="text-body-tertiary">· {{ t('performance.load.atl_sub') }}</span></div>
                <div class="fs-3 fw-bold" style="color:#fd7e14">{{ Math.round(current.atl) }}</div>
                <div class="load-help">{{ t('performance.load.atl_help') }}</div>
              </div>
            </div>
            <div class="col-12 col-md-4">
              <div class="load-tile" :title="t('performance.load.tsb_help')">
                <div class="small text-muted">{{ t('performance.load.tsb_label') }} <span class="text-body-tertiary">· {{ t('performance.load.tsb_sub') }}</span></div>
                <div class="d-flex align-items-center gap-2">
                  <span class="fs-3 fw-bold" :style="{ color: zoneColor(currentZone) }">{{ fmtSigned(current.tsb) }}</span>
                  <span class="badge" :style="{ backgroundColor: zoneColor(currentZone) }">{{ t(`performance.load.zone_${currentZone}`) }}</span>
                </div>
                <div class="load-help">{{ t(`performance.load.zone_${currentZone}_hint`) }}</div>
              </div>
            </div>
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
                    ≈ {{ fmtDuration(recommendation.minutes) }}<template v-if="recommendation.distanceKm"> (~{{ recommendation.distanceKm }} km)</template>
                    {{ t(`performance.load.reco.effort_${recommendation.effort}`) }}
                  </span>
                </div>
                <div class="small text-muted">
                  {{ t(`performance.load.reco.${recommendation.reason}`, { tsb: recommendation.tsb }) }}
                  <span
                    v-if="recommendation.tss"
                    class="reco-tss"
                    :title="t('performance.load.reco.tss_explain')"
                  >(~{{ recommendation.tss }} TSS <i class="fa-solid fa-circle-info" aria-hidden="true"></i>)</span>
                </div>
              </div>
              <div>
                <label class="small text-muted d-block mb-1">{{ t('performance.load.reco.goal_label') }}</label>
                <select v-model="goal" class="form-select form-select-sm reco-goal">
                  <option v-for="g in GOALS" :key="g" :value="g">{{ t(`performance.load.reco.goal_${g}`) }}</option>
                </select>
              </div>
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
          <div class="load-chart-wrap load-chart-top">
            <canvas ref="loadCanvas"></canvas>
          </div>
          <div class="load-chart-wrap load-chart-bottom">
            <canvas ref="tsbCanvas"></canvas>
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

          <p class="small text-body-tertiary mt-2 mb-0">
            <i class="fa-solid fa-triangle-exclamation me-1" aria-hidden="true"></i>{{ t('performance.load.seed_hint') }}
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.reco-tss {
  cursor: help;
  white-space: nowrap;
}
.load-help {
  font-size: 0.78rem;
  color: var(--bs-secondary-color);
  margin-top: 0.25rem;
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
.zone-chip {
  cursor: help;
}
.load-how summary {
  cursor: pointer;
  list-style: revert;
}
</style>
