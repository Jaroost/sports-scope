<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { t } from '../i18n'
import type { Point } from '../composables/useTrainingPlan'

// ─── Courbe d'une seule métrique (CTL / ATL / TSB / ACWR) ─────────────────────
// Rangée « derrière » sa case dans TrainingLoadPanel : on l'ouvre au clic. Chaque
// métrique a son échelle propre (charge, fraîcheur signée, ratio), d'où un graphe
// autonome par case plutôt qu'un axe partagé. Le survol est mutualisé via `hoverIndex`
// (remonté au parent, qui alimente le panneau de détail commun sous les courbes).

type Metric = 'ctl' | 'atl' | 'tsb' | 'acwr'

const props = defineProps<{
  metric: Metric
  points: Point[]
  hoverIndex: number | null
}>()

const emit = defineEmits<{ hover: [index: number | null] }>()

const META: Record<Metric, { color: string; dash: boolean; labelKey: string; zeroBased: boolean }> = {
  ctl: { color: '#0d6efd', dash: false, labelKey: 'performance.load.ctl_label', zeroBased: true },
  atl: { color: '#fd7e14', dash: true, labelKey: 'performance.load.atl_label', zeroBased: true },
  tsb: { color: '#343a40', dash: false, labelKey: 'performance.load.tsb_label', zeroBased: false },
  acwr: { color: '#20c997', dash: false, labelKey: 'performance.load.acwr_label', zeroBased: false },
}

// Bandes de zones peintes en fond (mêmes seuils/teintes que les badges du panneau).
const TSB_BANDS = [
  { from: 20, to: Infinity, fill: 'rgba(13,110,253,0.20)' },
  { from: 5, to: 20, fill: 'rgba(25,135,84,0.20)' },
  { from: -10, to: 5, fill: 'rgba(108,117,125,0.14)' },
  { from: -30, to: -10, fill: 'rgba(253,126,20,0.22)' },
  { from: -Infinity, to: -30, fill: 'rgba(220,53,69,0.24)' },
]
const ACWR_BANDS = [
  { from: 1.5, to: Infinity, fill: 'rgba(220,53,69,0.20)' },
  { from: 1.3, to: 1.5, fill: 'rgba(253,126,20,0.20)' },
  { from: 0.8, to: 1.3, fill: 'rgba(25,135,84,0.18)' },
  { from: -Infinity, to: 0.8, fill: 'rgba(13,110,253,0.16)' },
]
function bandsFor(metric: Metric) {
  return metric === 'tsb' ? TSB_BANDS : metric === 'acwr' ? ACWR_BANDS : null
}

const canvas = ref<HTMLCanvasElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chart: any = null

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

// Bandes de zones en fond (métriques à zones seulement).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bandsPlugin: any = {
  id: 'metricBands',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  beforeDatasetsDraw(c: any) {
    const bands = bandsFor(props.metric)
    const scale = c.scales?.y
    const area = c.chartArea
    if (!bands || !scale || !area) return
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

// Repère vertical au jour survolé (piloté par `hoverIndex` partagé).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hoverLinePlugin: any = {
  id: 'metricHoverLine',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  afterDatasetsDraw(c: any) {
    if (props.hoverIndex == null) return
    const pt = c.getDatasetMeta(0)?.data?.[props.hoverIndex]
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

// Chart.js n'expose pas « index survolé » : on détourne le hook du tooltip (masqué).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syncHover(context: { tooltip: any }) {
  const idx = context.tooltip?.dataPoints?.[0]?.dataIndex
  if (idx != null) emit('hover', idx)
}

async function render() {
  if (chart) { chart.destroy(); chart = null }
  if (!canvas.value || props.points.length < 2) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  const meta = META[props.metric]
  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  chart = new Chart(ctx, {
    type: 'line',
    plugins: [bandsPlugin, hoverLinePlugin],
    data: {
      labels: props.points.map((p) => fmtDate(p.date)),
      datasets: [
        {
          label: t(meta.labelKey),
          data: props.points.map((p) => p[props.metric] as number | null),
          borderColor: meta.color,
          borderDash: meta.dash ? [5, 3] : [],
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.3,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: syncHover },
      },
      scales: {
        y: { beginAtZero: meta.zeroBased, position: 'left' as const },
        x: { ticks: { maxTicksLimit: 12, autoSkip: true } },
      },
    },
  })
}

onMounted(async () => { await nextTick(); render() })
onBeforeUnmount(() => { if (chart) { chart.destroy(); chart = null } })

// Re-tracé complet quand la donnée ou la fenêtre change (nouveau tableau de points).
watch(() => props.points, () => { render() })
// Simple redraw du repère quand le jour survolé change (pas de reconstruction).
watch(() => props.hoverIndex, () => { chart?.render() })
</script>

<template>
  <div class="metric-chart">
    <div class="metric-chart-head">
      <span class="metric-dot" :style="{ background: META[metric].color }" aria-hidden="true"></span>
      <span class="fw-semibold small">{{ t(META[metric].labelKey) }}</span>
    </div>
    <div class="metric-chart-canvas">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<style scoped>
.metric-chart {
  padding: 0.5rem 0.75rem 0.25rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-body-bg);
}
.metric-chart + .metric-chart {
  margin-top: 0.5rem;
}
.metric-chart-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.25rem;
}
.metric-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.metric-chart-canvas {
  position: relative;
  height: 160px;
}
</style>
