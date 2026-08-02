<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { t } from '../i18n'
import { formatPowerDuration, type CurvePoint, type CurveSeries } from '../activityHelpers'

// ─── Courbe de puissance (puissance moyenne max / durée) ─────────────────────
// Un seul graphique, plusieurs séries superposées sur le même axe : la courbe de
// la sortie et la courbe record « tous les temps » se lisent l'une contre l'autre
// (l'écart entre les deux, c'est ce qui reste à aller chercher). Les durées sont
// espacées log et posées sur un axe de catégories : chaque décade occupe donc la
// même largeur, comme il se doit pour une courbe de puissance. Les séries n'ont
// pas forcément les mêmes durées — on trace l'union et on comble les trous
// (`spanGaps`), la courbe record n'ayant que les 11 durées de référence.

const props = defineProps<{
  series: CurveSeries[]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chart: any = null

function usable(points: CurvePoint[]): CurvePoint[] {
  return points.filter((p) => Number.isFinite(p.duration) && Number.isFinite(p.watts) && p.watts > 0)
}

const drawn = computed(() => props.series
  .map((s) => ({ ...s, points: usable(s.points) }))
  .filter((s) => s.points.length >= 2))

// Axe commun : toutes les durées vues par au moins une série, du plus court au plus long.
const durations = computed(() => {
  const all = new Set<number>()
  drawn.value.forEach((s) => s.points.forEach((p) => all.add(p.duration)))
  return [...all].sort((a, b) => a - b)
})

const hasData = computed(() => drawn.value.length > 0)
const clickable = computed(() => drawn.value.some((s) => s.points.some((p) => !!p.href)))

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

// Teinte de remplissage dérivée de la couleur de la série (hex → rgba).
function fillFor(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(252, 76, 2, ${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

async function render() {
  if (chart) { chart.destroy(); chart = null }
  if (!hasData.value || !canvas.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  const xs = durations.value
  // Une ligne de points par série, alignée sur l'axe commun : trous à null.
  const rows = drawn.value.map((s) => {
    const byDuration = new Map(s.points.map((p) => [p.duration, p]))
    return { series: s, cells: xs.map((d) => byDuration.get(d) ?? null) }
  })

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: xs.map((d) => formatPowerDuration(d)),
      datasets: rows.map(({ series, cells }) => ({
        label: series.label,
        data: cells.map((c) => (c ? Math.round(c.watts) : null)),
        borderColor: series.color,
        backgroundColor: series.fill ? fillFor(series.color, 0.12) : fillFor(series.color, 0.85),
        pointBackgroundColor: series.color,
        borderWidth: 2,
        borderDash: series.dashed ? [5, 3] : [],
        fill: !!series.fill,
        tension: 0.25,
        pointRadius: series.showPoints ? 3 : 0,
        pointHoverRadius: 5,
        // La courbe record n'a que 11 durées : sans ça elle serait hachée.
        spanGaps: true,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Le point le plus proche en X répond au survol, sans avoir à le toucher.
      interaction: { mode: 'index' as const, intersect: false },
      // Clic sur un point → ouvre l'activité qui détient ce record (si connue).
      onClick: (_evt: unknown, els: { datasetIndex: number; index: number }[]) => {
        for (const el of els || []) {
          const href = rows[el.datasetIndex]?.cells[el.index]?.href
          if (href) { window.location.href = href; return }
        }
      },
      onHover: (evt: { native?: Event }, els: { datasetIndex: number; index: number }[]) => {
        const target = evt.native?.target as HTMLElement | undefined
        if (!target) return
        const over = (els || []).some((el) => !!rows[el.datasetIndex]?.cells[el.index]?.href)
        target.style.cursor = over ? 'pointer' : 'default'
      },
      plugins: {
        // Une seule série ⇒ le titre la nomme déjà, pas de légende.
        legend: {
          display: rows.length > 1,
          position: 'bottom' as const,
          labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'line' },
        },
        tooltip: {
          callbacks: {
            title: (items: { dataIndex: number }[]) => {
              const d = xs[items?.[0]?.dataIndex ?? -1]
              return d != null ? formatPowerDuration(d) : ''
            },
            label: (item: { datasetIndex: number; dataIndex: number; parsed: { y: number } }) => {
              const cell = rows[item.datasetIndex]?.cells[item.dataIndex]
              const name = rows[item.datasetIndex]?.series.label ?? ''
              let suffix = ''
              // Sur la courbe « tous les temps » : quand le record vient de la sortie
              // affichée on le dit, sinon on donne la date de celle qui le détient.
              if (cell?.isCurrent) suffix = ` · ${t('strava.stats.power_curve_this_activity')}`
              else if (cell?.startedAt) suffix = ` · ${formatDate(cell.startedAt)}`
              return `${name} : ${item.parsed.y} W${suffix}`
            },
            footer: () => (clickable.value ? t('strava.stats.power_curve_click_hint') : ''),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: t('strava.stats.power_curve_axis') },
        },
        x: {
          title: { display: true, text: t('strava.stats.col_duration') },
          ticks: { maxTicksLimit: 10, autoSkip: true, maxRotation: 0 },
        },
      },
    },
  })
}

onMounted(async () => { await nextTick(); render() })
onBeforeUnmount(() => { if (chart) { chart.destroy(); chart = null } })
watch(() => props.series, async () => { await nextTick(); render() }, { deep: true })
</script>

<template>
  <div v-if="hasData" class="power-curve">
    <div class="power-curve-canvas">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<style scoped>
.power-curve {
  padding: 0.5rem 0.75rem 0.25rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-body-bg);
}
.power-curve-canvas {
  position: relative;
  height: 240px;
}
</style>
