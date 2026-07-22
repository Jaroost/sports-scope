<script setup lang="ts">
// Progression sur UN segment : un point par passage, la date en x, le chrono en y.
// Les deux sens sont deux séries distinctes (couleur ET forme de point) : une montée
// et sa descente n'ont rien de comparable, les mélanger sur une même courbe donnerait
// une progression imaginaire. Le passage du jour est isolé en troisième série pour se
// repérer d'un coup d'œil.
//
// Même montage que les autres graphiques de l'app (MetricChart, FtpPanel) : Chart.js
// chargé à la demande, canvas redessiné à chaque changement de données.
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch, type PropType } from 'vue'
import { t } from '../i18n'
import { formatChrono } from '../activityHelpers'

interface Effort {
  started_at: string | null
  duration_s: number
  reverse: boolean
}

const props = defineProps({
  efforts: { type: Array as PropType<Effort[]>, default: () => [] },
  // Le passage de la sortie affichée : elle n'est pas dans `efforts`.
  currentDurationS: { type: Number, required: true },
  currentDate: { type: String, default: '' },
  // Sens de cette sortie par rapport au sens de référence du segment : son point
  // rejoint la série correspondante, pas systématiquement le sens direct.
  currentReverse: { type: Boolean, default: false },
})

// Palette : bleu / violet séparables en vision déficiente (ΔE deutan 10,1), doublés
// d'une forme de point différente — la couleur n'est jamais le seul indice.
const FORWARD_COLOR = '#0d6efd'
const REVERSE_COLOR = '#6f42c1'
const TODAY_COLOR = '#fd7e14'

const canvas = ref<HTMLCanvasElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chart: any = null

type Point = { x: number, y: number }

function toPoint(dateStr: string | null, duration: number): Point | null {
  if (!dateStr) return null
  const ts = new Date(dateStr).getTime()
  if (!Number.isFinite(ts) || !Number.isFinite(duration)) return null
  return { x: ts, y: duration }
}

const forwardPoints = computed(() => series(false))
const reversePoints = computed(() => series(true))
const currentPoint = computed(() => toPoint(props.currentDate, props.currentDurationS))

function series(reverse: boolean): Point[] {
  return props.efforts
    .filter((e) => e.reverse === reverse)
    .map((e) => toPoint(e.started_at, e.duration_s))
    .filter((p): p is Point => p !== null)
    .sort((a, b) => a.x - b.x)
}

// Sous deux points au total, un graphique de progression ne dit rien.
const hasEnoughData = computed(() =>
  forwardPoints.value.length + reversePoints.value.length + (currentPoint.value ? 1 : 0) >= 2,
)

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(document.documentElement.lang || undefined, {
    day: '2-digit', month: '2-digit', year: '2-digit',
  })
}

async function render() {
  if (chart) { chart.destroy(); chart = null }
  if (!canvas.value || !hasEnoughData.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  // Le passage de cette sortie est aussi tracé dans SA série (selon son sens) pour
  // que la ligne de progression aille jusqu'à lui ; le point orange se pose par-dessus.
  const withCurrent = (points: Point[], mine: boolean) => (currentPoint.value && mine
    ? [...points, currentPoint.value].sort((a, b) => a.x - b.x)
    : points)
  const forward = withCurrent(forwardPoints.value, !props.currentReverse)
  const reverse = withCurrent(reversePoints.value, props.currentReverse)

  // Le passage du jour est en TÊTE du tableau : Chart.js dessine les séries dans
  // l'ordre inverse des index, donc la série 0 passe au-dessus des autres — sinon le
  // losange orange disparaît sous la courbe (vérifié au rendu).
  const datasets = [
    ...(currentPoint.value
      ? [{
          label: t('strava.segments.this_activity'),
          data: [currentPoint.value],
          // Anneau blanc : le losange reste lisible quand il tombe sur la courbe.
          borderColor: '#fff',
          backgroundColor: TODAY_COLOR,
          pointStyle: 'rectRot',
          pointRadius: 5,
          pointHoverRadius: 8,
          borderWidth: 2,
          showLine: false,
          tension: 0,
        }]
      : []),
    {
      label: t('strava.segments.chart_forward'),
      data: forward,
      borderColor: FORWARD_COLOR,
      backgroundColor: FORWARD_COLOR,
      pointStyle: 'circle',
      pointRadius: 2.5,
      pointHoverRadius: 5,
      borderWidth: 1.5,
      showLine: true,
      tension: 0,
    },
    {
      label: t('strava.segments.chart_reverse'),
      data: reverse,
      borderColor: REVERSE_COLOR,
      backgroundColor: REVERSE_COLOR,
      pointStyle: 'triangle',
      pointRadius: 3,
      pointHoverRadius: 6,
      borderWidth: 1.5,
      borderDash: [5, 3],
      showLine: true,
      tension: 0,
    },
  ].filter((d) => d.data.length > 0)

  chart = new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'bottom' as const,
          labels: { usePointStyle: true, boxWidth: 8, padding: 12 },
        },
        tooltip: {
          callbacks: {
            title: (items: { parsed: Point }[]) => fmtDate(items[0].parsed.x),
            label: (item: { dataset: { label?: string }, parsed: Point }) =>
              `${item.dataset.label} — ${formatChrono(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear' as const,
          // Échelle temporelle réelle : deux passages à un an d'écart ne doivent pas
          // paraître aussi proches que deux passages de la même semaine.
          ticks: { maxTicksLimit: 6, callback: (v: number) => fmtDate(v) },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: t('strava.segments.chart_y') },
          ticks: { callback: (v: number) => formatChrono(v) },
          grid: { color: 'rgba(0,0,0,0.06)' },
        },
      },
    },
  })
}

onMounted(async () => { await nextTick(); render() })
onBeforeUnmount(() => { if (chart) { chart.destroy(); chart = null } })
watch(() => props.efforts, () => { render() })
</script>

<template>
  <div v-if="hasEnoughData" class="segment-chart">
    <div class="segment-chart-canvas">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<style scoped>
.segment-chart {
  padding: 0.5rem 0.75rem 0.25rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-body-bg);
}
.segment-chart-canvas {
  position: relative;
  height: 200px;
}
</style>
