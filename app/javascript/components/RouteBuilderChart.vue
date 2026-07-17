<script setup lang="ts">
import { ref, computed, watch, nextTick, useTemplateRef } from 'vue'
import { t } from '../i18n'
import { routeStore } from '../stores/routeStore'
import { selectionStore } from '../stores/selectionStore'
import { placesStore } from '../stores/placesStore'
import {
  haversine, colorForGrade, geomIdxForKm,
  computeSegmentGrades, formatDuration,
} from '../routeHelpers'
import type { Sport } from '../userPreferences'
import { useAthleteState } from '../composables/useAthleteState'
import { estimateRouteLoad } from '../routeLoad'
import { FEAS_COLOR } from '../composables/useTrainingPlan'

const props = defineProps<{ simplified?: boolean }>()

// TSS estimé de l'itinéraire ENTIER (comme le temps estimé voisin, et non la
// sélection) : la barre mobile remplace le panneau latéral. Null = non estimable
// (visiteur non connecté, compte sans activité) → pastille masquée.
const { athlete } = useAthleteState()
const routeLoad = computed(() => {
  if (!athlete.value) return null
  return estimateRouteLoad(
    {
      distanceM: routeStore.distanceM.value,
      elevGainM: routeStore.elevGainM.value,
      speedKmh: routeStore.avgSpeedKmh.value,
      sport: routeStore.sport.value,
    },
    athlete.value,
  )
})

// Catégories d'activité — enregistrées avec l'itinéraire, pilotent la vitesse
// moyenne. Réexposées ici car la barre de stats mobile remplace le panneau latéral.
const ACTIVITIES = ['cycling', 'mtb', 'hiking'] as const

function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

const chartEl = useTemplateRef('chartEl')
let chartInstance: any = null
let segmentColors: string[] = []
let segmentGrades: (number | null)[] = []
let chartDrag: { startPx: number; currentPx: number } | null = null
let chartHandleDrag: { fixedKm: number } | null = null
let chartSelectionWiredEl: Element | null = null
let wheelRafPending = false
let pendingWheel: { px: number; deltaY: number } | null = null
// Gestes tactiles (mobile)
let pinch: { idA: number; idB: number; vA: number; vB: number } | null = null
let touchSelect: { id: number; startPx: number; moved: boolean } | null = null
let touchHandle: { id: number; fixedKm: number } | null = null
const HANDLE_TOL_PX = 8
const TOUCH_HANDLE_TOL_PX = 14
const TOUCH_TAP_TOL_PX = 8

const emit = defineEmits<{
  'fly-to': [lng: number, lat: number]
  'zoom-to': [lng: number, lat: number]
  'hover-end': []
  'fit-to-selection': []
  'open-selection-in-komoot': []
  'propose-alternatives': []
  'collapse': []
}>()

// ─── Computed ─────────────────────────────────────────────────────────────────

const chartStats = computed(() => {
  const range = selectionStore.selectionRange.value
  if (range && selectionStore.cumDistKm.length && routeStore.geometry.value.length >= 2) {
    const i0 = geomIdxForKm(range.startKm, selectionStore.cumDistKm)
    const i1 = geomIdxForKm(range.endKm, selectionStore.cumDistKm)
    const lo = Math.min(i0, i1)
    const hi = Math.max(i0, i1)
    if (hi - lo >= 1) {
      let dist = 0
      for (let i = lo + 1; i <= hi; i++) {
        dist += haversine(routeStore.geometry.value[i - 1], routeStore.geometry.value[i])
      }
      let gain = 0, loss = 0
      for (let i = lo + 1; i <= hi; i++) {
        const a = routeStore.geometry.value[i - 1][2]
        const b = routeStore.geometry.value[i][2]
        if (a == null || b == null) continue
        const d = b - a
        if (d > 0) gain += d; else loss += -d
      }
      return { distance: dist, gain, loss, avgGrade: dist > 0 ? ((gain - loss) / dist) * 100 : 0, isSelection: true }
    }
  }
  return {
    distance: routeStore.distanceM.value,
    gain: routeStore.elevGainM.value,
    loss: routeStore.elevLossM.value,
    avgGrade: routeStore.distanceM.value > 0
      ? ((routeStore.elevGainM.value - routeStore.elevLossM.value) / routeStore.distanceM.value) * 100
      : 0,
    isSelection: false,
  }
})

// ─── Segment colours ──────────────────────────────────────────────────────────

function recomputeSegmentColors() {
  const grades = computeSegmentGrades(routeStore.geometry.value)
  segmentColors = grades.map((g) => (g == null ? '#9ca3af' : colorForGrade(g)))
  segmentGrades = grades
}

// ─── Chart plugins ────────────────────────────────────────────────────────────

const gradeFillPlugin = {
  id: 'routeGradeFill',
  beforeDatasetsDraw(chart: any) {
    if (!segmentColors.length) return
    const ds = chart.data.datasets[0]?.data
    if (!ds || ds.length < 2) return
    const { ctx, chartArea } = chart
    const xScale = chart.scales.x
    const yScale = chart.scales.y
    const baseY = chartArea.bottom
    ctx.save()
    ctx.beginPath()
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
    ctx.clip()
    for (let i = 1; i < ds.length; i++) {
      const c = segmentColors[i - 1]
      if (!c) continue
      const x0 = xScale.getPixelForValue(ds[i - 1].x)
      const x1 = xScale.getPixelForValue(ds[i].x)
      if (x1 < chartArea.left || x0 > chartArea.right) continue
      const y0 = yScale.getPixelForValue(ds[i - 1].y)
      const y1 = yScale.getPixelForValue(ds[i].y)
      ctx.fillStyle = c + '66'
      ctx.beginPath()
      ctx.moveTo(x0, baseY)
      ctx.lineTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.lineTo(x1, baseY)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  },
}

const hoverSyncPlugin = {
  id: 'hoverSync',
  afterDatasetsDraw(chart: any) {
    const idx = selectionStore.hoverIdx.value
    if (idx == null || !selectionStore.cumDistKm.length || idx >= selectionStore.cumDistKm.length) return
    const ele = routeStore.geometry.value[idx]?.[2]
    if (ele == null) return
    const km = selectionStore.cumDistKm[idx]
    const { ctx, chartArea } = chart
    const px = chart.scales.x.getPixelForValue(km)
    const py = chart.scales.y.getPixelForValue(ele)
    if (px < chartArea.left || px > chartArea.right) return
    ctx.save()
    ctx.strokeStyle = 'rgba(252, 76, 2, 0.65)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(px, chartArea.top)
    ctx.lineTo(px, chartArea.bottom)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(px, py, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#fc4c02'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.restore()
  },
}

const placeIndicatorPlugin = {
  id: 'placeIndicator',
  afterDatasetsDraw(chart: any) {
    const km = placesStore.placeHoverKm ?? placesStore.placeSelectedKm
    if (km == null) return
    const { ctx, chartArea, scales } = chart
    const x = scales.x.getPixelForValue(km)
    if (x < chartArea.left || x > chartArea.right) return
    const idx = geomIdxForKm(km, selectionStore.cumDistKm)
    const alt = routeStore.geometry.value[idx]?.[2]
    ctx.save()
    ctx.strokeStyle = '#0d6efd'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(x, chartArea.top)
    ctx.lineTo(x, chartArea.bottom)
    ctx.stroke()
    if (alt != null) {
      const y = scales.y.getPixelForValue(alt)
      ctx.setLineDash([])
      ctx.fillStyle = '#0d6efd'
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.restore()
  },
}

function drawChartFlag(ctx: CanvasRenderingContext2D, area: any, x: number, kind: 'start' | 'end') {
  const fw = 12, fh = 9
  const headTop = Math.max(0, area.top - fh)
  ctx.save()
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x, area.top)
  ctx.lineTo(x, area.bottom)
  ctx.stroke()
  if (kind === 'start') {
    ctx.fillStyle = '#22c55e'
    ctx.fillRect(x, headTop, fw, fh)
    ctx.strokeStyle = '#15803d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  } else {
    const cell = 3
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ef4444' : '#ffffff'
        ctx.fillRect(x + c * cell, headTop + r * cell, cell, cell)
      }
    }
    ctx.strokeStyle = '#7f1d1d'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, headTop + 0.5, fw, fh)
  }
  ctx.fillStyle = '#1f2937'
  ctx.beginPath()
  ctx.arc(x, area.top, 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

const selectionRectPlugin = {
  id: 'routeSelectionRect',
  beforeDatasetsDraw(chart: any) {
    const { ctx, chartArea } = chart
    let x1: number, x2: number
    if (chartDrag) {
      x1 = chartDrag.startPx; x2 = chartDrag.currentPx
    } else if (selectionStore.selectionRange.value) {
      x1 = chart.scales.x.getPixelForValue(selectionStore.selectionRange.value.startKm)
      x2 = chart.scales.x.getPixelForValue(selectionStore.selectionRange.value.endKm)
    } else { return }
    const xMin = Math.max(chartArea.left, Math.min(x1, x2))
    const xMax = Math.min(chartArea.right, Math.max(x1, x2))
    if (xMax <= xMin) return
    ctx.save()
    ctx.fillStyle = 'rgba(0, 180, 216, 0.22)'
    ctx.fillRect(xMin, chartArea.top, xMax - xMin, chartArea.bottom - chartArea.top)
    ctx.strokeStyle = '#00b4d8'
    ctx.lineWidth = 1
    ctx.strokeRect(xMin + 0.5, chartArea.top + 0.5, xMax - xMin - 1, chartArea.bottom - chartArea.top - 1)
    ctx.restore()
  },
  afterDatasetsDraw(chart: any) {
    if (!selectionStore.selectionRange.value) return
    const { ctx, chartArea } = chart
    const lo = Math.min(selectionStore.selectionRange.value.startKm, selectionStore.selectionRange.value.endKm)
    const hi = Math.max(selectionStore.selectionRange.value.startKm, selectionStore.selectionRange.value.endKm)
    const pxLo = Math.max(chartArea.left, Math.min(chartArea.right, chart.scales.x.getPixelForValue(lo)))
    const pxHi = Math.max(chartArea.left, Math.min(chartArea.right, chart.scales.x.getPixelForValue(hi)))
    drawChartFlag(ctx, chartArea, pxLo, 'start')
    drawChartFlag(ctx, chartArea, pxHi, 'end')
  },
}

// ─── Chart render ─────────────────────────────────────────────────────────────

async function render() {
  if (!routeStore.hasGeometry.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)
  if (!chartEl.value) await nextTick()
  if (!chartEl.value) return
  destroy()
  recomputeSegmentColors()
  let cumDist = 0
  const points = [{ x: 0, y: routeStore.geometry.value[0][2] ?? 0 }]
  const cumDistKm = [0]
  for (let i = 1; i < routeStore.geometry.value.length; i++) {
    cumDist += haversine(routeStore.geometry.value[i - 1], routeStore.geometry.value[i])
    const km = cumDist / 1000
    cumDistKm.push(km)
    points.push({ x: km, y: routeStore.geometry.value[i][2] ?? points[points.length - 1].y })
  }
  selectionStore.cumDistKm = cumDistKm

  chartInstance = new Chart(chartEl.value.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        label: t('routes.altitude'),
        data: points,
        borderColor: '#198754',
        segment: { borderColor: (ctx: any) => segmentColors[ctx.p0DataIndex] || '#198754' },
        fill: false,
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 1.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { intersect: false, mode: 'index', axis: 'x' },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: cumDistKm[cumDistKm.length - 1],
          title: { display: false },
          ticks: { maxTicksLimit: 8, font: { size: 10 } },
        },
        y: {
          title: { display: true, text: t('routes.y_m'), font: { size: 10 } },
          ticks: {
            stepSize: (() => {
              const alts = points.map((p) => p.y).filter((v) => v != null)
              const range = Math.max(...alts) - Math.min(...alts)
              return range >= 150 ? 100 : undefined
            })(),
            maxTicksLimit: 20,
            font: { size: 10 },
          },
          grid: { color: 'rgba(0,0,0,0.07)', lineWidth: 1 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items: any[]) => items.length ? `${items[0].parsed.x.toFixed(2)} km` : '',
            label: (item: any) => {
              const alt = Math.round(item.parsed.y)
              const i = item.dataIndex
              const grade = segmentGrades[i] != null ? segmentGrades[i] : segmentGrades[Math.max(0, i - 1)]
              const out = [`${t('routes.altitude')}: ${alt} m`]
              if (grade != null) {
                const sign = grade > 0 ? '+' : ''
                out.push(`${t('routes.grade')}: ${sign}${(grade as number).toFixed(1)}%`)
              }
              return out
            },
          },
        },
      },
    },
    plugins: [gradeFillPlugin, selectionRectPlugin, hoverSyncPlugin, placeIndicatorPlugin],
  })
  attachInteractionOnce(chartEl.value)
}

function destroy() {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null }
}

function update() {
  if (chartInstance) chartInstance.update('none')
}

function resize(w?: number, h?: number) {
  if (!chartInstance) return
  if (w != null && h != null) chartInstance.resize(w, h)
  else chartInstance.resize()
}

function getChartInstance() { return chartInstance }
function getChartEl() { return chartEl.value }

// ─── Zoom ─────────────────────────────────────────────────────────────────────

function applyZoom() {
  if (!chartInstance) return
  const naturalMax = selectionStore.cumDistKm.length ? selectionStore.cumDistKm[selectionStore.cumDistKm.length - 1] : null
  chartInstance.options.scales.x.min = selectionStore.zoomMin ?? 0
  chartInstance.options.scales.x.max = selectionStore.zoomMax ?? naturalMax
  chartInstance.update('none')
  selectionStore.isZoomed.value = selectionStore.zoomMin != null || selectionStore.zoomMax != null
}

function resetZoom() {
  selectionStore.zoomMin = null
  selectionStore.zoomMax = null
  applyZoom()
}

function zoomToSelection() {
  if (!selectionStore.selectionRange.value) return
  const { startKm, endKm } = selectionStore.selectionRange.value
  selectionStore.zoomMin = Math.min(startKm, endKm)
  selectionStore.zoomMax = Math.max(startKm, endKm)
  applyZoom()
}

// Applique une fenêtre de zoom [newMin, newMax] avec recadrage sur les bornes
// naturelles. Si la fenêtre couvre (ou dépasse) tout le tracé → reset complet.
function applyZoomRange(newMin: number, newMax: number) {
  if (!selectionStore.cumDistKm.length) return
  const naturalMin = selectionStore.cumDistKm[0]
  const naturalMax = selectionStore.cumDistKm[selectionStore.cumDistKm.length - 1]
  const naturalRange = naturalMax - naturalMin
  if (newMax - newMin >= naturalRange) { resetZoom(); return }
  if (newMin < naturalMin) { newMax += naturalMin - newMin; newMin = naturalMin }
  if (newMax > naturalMax) { newMin -= newMax - naturalMax; newMax = naturalMax }
  selectionStore.zoomMin = newMin
  selectionStore.zoomMax = newMax
  applyZoom()
}

// ─── Selection ────────────────────────────────────────────────────────────────

function clearSelection() {
  selectionStore.selectionRange.value = null
  selectionStore.selectionPinned.value = false
  if (chartInstance) chartInstance.update('none')
}

// ─── Chart handle detection ───────────────────────────────────────────────────

function detectHandle(px: number, tol = HANDLE_TOL_PX): 'start' | 'end' | null {
  if (!chartInstance || !selectionStore.selectionRange.value) return null
  const area = chartInstance.chartArea
  const xScale = chartInstance.scales.x
  const lo = Math.min(selectionStore.selectionRange.value.startKm, selectionStore.selectionRange.value.endKm)
  const hi = Math.max(selectionStore.selectionRange.value.startKm, selectionStore.selectionRange.value.endKm)
  const pxStart = Math.max(area.left, Math.min(area.right, xScale.getPixelForValue(lo)))
  const pxEnd = Math.max(area.left, Math.min(area.right, xScale.getPixelForValue(hi)))
  const dStart = Math.abs(px - pxStart)
  const dEnd = Math.abs(px - pxEnd)
  if (dStart <= tol && dStart <= dEnd) return 'start'
  if (dEnd <= tol) return 'end'
  return null
}

// ─── Wheel zoom ───────────────────────────────────────────────────────────────

function onChartWheel(e: WheelEvent) {
  if (!chartInstance || !selectionStore.cumDistKm.length) return
  e.preventDefault()
  const rect = (chartEl.value as HTMLCanvasElement).getBoundingClientRect()
  pendingWheel = { px: e.clientX - rect.left, deltaY: e.deltaY }
  if (wheelRafPending) return
  wheelRafPending = true
  requestAnimationFrame(() => {
    wheelRafPending = false
    if (!pendingWheel || !chartInstance) return
    const { px, deltaY } = pendingWheel
    pendingWheel = null
    const xScale = chartInstance.scales.x
    const cursorVal = xScale.getValueForPixel(px)
    const naturalMin = selectionStore.cumDistKm[0]
    const naturalMax = selectionStore.cumDistKm[selectionStore.cumDistKm.length - 1]
    if (cursorVal == null || Number.isNaN(cursorVal)) return
    const curMin = selectionStore.zoomMin ?? naturalMin
    const curMax = selectionStore.zoomMax ?? naturalMax
    const range = curMax - curMin
    if (range <= 0) return
    const factor = deltaY > 0 ? 1.25 : 0.8
    const newRange = range * factor
    const leftFrac = (cursorVal - curMin) / range
    applyZoomRange(cursorVal - leftFrac * newRange, cursorVal - leftFrac * newRange + newRange)
  })
}

// ─── Mouse interactions ───────────────────────────────────────────────────────

function attachInteractionOnce(canvas: HTMLCanvasElement) {
  if (chartSelectionWiredEl === canvas || !canvas) return
  chartSelectionWiredEl = canvas
  canvas.addEventListener('wheel', onChartWheel as EventListener, { passive: false })
  attachTouchInteraction(canvas)

  canvas.addEventListener('mousemove', (ev) => {
    if (chartHandleDrag || chartDrag || !chartInstance) return
    const r = canvas.getBoundingClientRect()
    const x = ev.clientX - r.left
    const area = chartInstance.chartArea
    if (x < area.left - HANDLE_TOL_PX || x > area.right + HANDLE_TOL_PX) {
      canvas.style.cursor = ''
      return
    }
    canvas.style.cursor = detectHandle(x) ? 'ew-resize' : 'crosshair'
    if (x >= area.left && x <= area.right && selectionStore.cumDistKm.length) {
      const km = chartInstance.scales.x.getValueForPixel(x)
      if (km != null && !Number.isNaN(km)) {
        const pt = routeStore.geometry.value[geomIdxForKm(km, selectionStore.cumDistKm)]
        if (pt) emit('fly-to', pt[0], pt[1])
      }
    }
  })
  canvas.addEventListener('mouseleave', () => { emit('hover-end') })

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || !chartInstance) return
    const rect = canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const area = chartInstance.chartArea
    if (x < area.left - HANDLE_TOL_PX || x > area.right + HANDLE_TOL_PX) return
    ev.preventDefault()

    const handle = detectHandle(x)
    if (handle) {
      const fixedKm = handle === 'start'
        ? selectionStore.selectionRange.value!.endKm
        : selectionStore.selectionRange.value!.startKm
      chartHandleDrag = { fixedKm }
      canvas.style.cursor = 'ew-resize'
      const onMove = (e: MouseEvent) => {
        if (!chartInstance || !chartHandleDrag) return
        const r2 = canvas.getBoundingClientRect()
        const xx = Math.max(chartInstance.chartArea.left, Math.min(chartInstance.chartArea.right, e.clientX - r2.left))
        const km = chartInstance.scales.x.getValueForPixel(xx)
        if (km == null || Number.isNaN(km)) return
        const lo = Math.min(chartHandleDrag.fixedKm, km)
        const hi = Math.max(chartHandleDrag.fixedKm, km)
        selectionStore.selectionRange.value = { startKm: lo, endKm: hi }
        selectionStore.selectionPinned.value = true
        chartInstance.update('none')
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        chartHandleDrag = null
        canvas.style.cursor = ''
        emit('fit-to-selection')
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }

    if (x < area.left || x > area.right) return
    const startPx = x
    chartDrag = { startPx, currentPx: x }
    chartInstance.update('none')

    const onMove = (e: MouseEvent) => {
      if (!chartInstance) return
      const r = canvas.getBoundingClientRect()
      chartDrag!.currentPx = Math.max(chartInstance.chartArea.left, Math.min(chartInstance.chartArea.right, e.clientX - r.left))
      chartInstance.update('none')
    }
    const onUp = (e: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!chartDrag || !chartInstance) { chartDrag = null; return }
      const r = canvas.getBoundingClientRect()
      const finalX = Math.max(chartInstance.chartArea.left, Math.min(chartInstance.chartArea.right, e.clientX - r.left))
      const dragged = Math.abs(finalX - startPx) > 4
      const xScale = chartInstance.scales.x
      const km1 = xScale.getValueForPixel(Math.min(startPx, finalX))
      const km2 = xScale.getValueForPixel(Math.max(startPx, finalX))
      chartDrag = null
      if (dragged) {
        selectionStore.selectionRange.value = { startKm: km1, endKm: km2 }
        selectionStore.selectionPinned.value = true
        chartInstance.update('none')
        emit('fit-to-selection')
      } else {
        const col = routeStore.detectedClimbs.value.find((c) => km1 >= c.startKm && km1 <= c.endKm)
        if (col) {
          selectionStore.selectionRange.value = { startKm: col.startKm, endKm: col.endKm }
          selectionStore.selectionPinned.value = true
          chartInstance.update('none')
          emit('fit-to-selection')
        } else {
          selectionStore.selectionRange.value = null
          selectionStore.selectionPinned.value = false
          chartInstance.update('none')
          const pt = routeStore.geometry.value[geomIdxForKm(km1, selectionStore.cumDistKm)]
          if (pt) emit('zoom-to', pt[0], pt[1])
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

// ─── Touch interactions (mobile) ───────────────────────────────────────────────
// 1 doigt : glisser pour sélectionner une plage, taper pour zoomer/sélectionner un col.
// 2 doigts : pincer pour zoomer + déplacer la fenêtre (pan) quand on est zoomé.

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
  return null
}

// Position horizontale (px) du doigt relative au canvas.
function touchPx(canvas: HTMLCanvasElement, clientX: number): number {
  return clientX - canvas.getBoundingClientRect().left
}

// Fraction [0..1] de la zone de tracé sous le doigt (sert au calcul de pincement).
function touchFraction(canvas: HTMLCanvasElement, clientX: number): number {
  if (!chartInstance) return 0
  const area = chartInstance.chartArea
  return (touchPx(canvas, clientX) - area.left) / (area.right - area.left)
}

function resetTouchGestures() {
  pinch = null
  touchSelect = null
  touchHandle = null
  if (chartDrag) { chartDrag = null; if (chartInstance) chartInstance.update('none') }
}

function attachTouchInteraction(canvas: HTMLCanvasElement) {
  canvas.addEventListener('touchstart', (ev: TouchEvent) => {
    if (!chartInstance || !selectionStore.cumDistKm.length) return

    // Deux doigts → pincement/déplacement ; on annule tout geste à un doigt en cours.
    if (ev.touches.length >= 2) {
      ev.preventDefault()
      touchSelect = null
      touchHandle = null
      if (chartDrag) { chartDrag = null; chartInstance.update('none') }
      const a = ev.touches[0], b = ev.touches[1]
      const naturalMin = selectionStore.cumDistKm[0]
      const naturalMax = selectionStore.cumDistKm[selectionStore.cumDistKm.length - 1]
      const curMin = selectionStore.zoomMin ?? naturalMin
      const curMax = selectionStore.zoomMax ?? naturalMax
      const fA = touchFraction(canvas, a.clientX)
      const fB = touchFraction(canvas, b.clientX)
      pinch = {
        idA: a.identifier, idB: b.identifier,
        vA: curMin + fA * (curMax - curMin),
        vB: curMin + fB * (curMax - curMin),
      }
      return
    }

    const touch = ev.touches[0]
    const x = touchPx(canvas, touch.clientX)
    const area = chartInstance.chartArea
    if (x < area.left - TOUCH_HANDLE_TOL_PX || x > area.right + TOUCH_HANDLE_TOL_PX) return
    ev.preventDefault()

    // Poignée d'une sélection existante → redimensionnement.
    const handle = detectHandle(x, TOUCH_HANDLE_TOL_PX)
    if (handle) {
      touchHandle = {
        id: touch.identifier,
        fixedKm: handle === 'start'
          ? selectionStore.selectionRange.value!.endKm
          : selectionStore.selectionRange.value!.startKm,
      }
      return
    }

    if (x < area.left || x > area.right) return
    touchSelect = { id: touch.identifier, startPx: x, moved: false }
    chartDrag = { startPx: x, currentPx: x }
    chartInstance.update('none')
  }, { passive: false })

  canvas.addEventListener('touchmove', (ev: TouchEvent) => {
    if (!chartInstance) return

    if (pinch) {
      const a = findTouch(ev.touches, pinch.idA)
      const b = findTouch(ev.touches, pinch.idB)
      if (!a || !b) return
      ev.preventDefault()
      const fA = touchFraction(canvas, a.clientX)
      const fB = touchFraction(canvas, b.clientX)
      if (Math.abs(fA - fB) < 1e-4) return
      const newRange = (pinch.vA - pinch.vB) / (fA - fB)
      const newMin = pinch.vA - fA * newRange
      applyZoomRange(newMin, newMin + newRange)
      return
    }

    if (touchHandle) {
      const t = findTouch(ev.touches, touchHandle.id)
      if (!t) return
      ev.preventDefault()
      const area = chartInstance.chartArea
      const xx = Math.max(area.left, Math.min(area.right, touchPx(canvas, t.clientX)))
      const km = chartInstance.scales.x.getValueForPixel(xx)
      if (km == null || Number.isNaN(km)) return
      selectionStore.selectionRange.value = { startKm: Math.min(touchHandle.fixedKm, km), endKm: Math.max(touchHandle.fixedKm, km) }
      selectionStore.selectionPinned.value = true
      chartInstance.update('none')
      return
    }

    if (touchSelect && chartDrag) {
      const t = findTouch(ev.touches, touchSelect.id)
      if (!t) return
      ev.preventDefault()
      const area = chartInstance.chartArea
      const x = Math.max(area.left, Math.min(area.right, touchPx(canvas, t.clientX)))
      if (Math.abs(x - touchSelect.startPx) > TOUCH_TAP_TOL_PX) touchSelect.moved = true
      chartDrag.currentPx = x
      const km = chartInstance.scales.x.getValueForPixel(x)
      if (km != null && !Number.isNaN(km)) {
        const pt = routeStore.geometry.value[geomIdxForKm(km, selectionStore.cumDistKm)]
        if (pt) emit('fly-to', pt[0], pt[1])
      }
      chartInstance.update('none')
    }
  }, { passive: false })

  const onTouchEnd = (ev: TouchEvent) => {
    if (!chartInstance) return

    if (pinch) {
      if (ev.touches.length < 2) pinch = null
      return
    }

    if (touchHandle) {
      if (findTouch(ev.touches, touchHandle.id)) return
      touchHandle = null
      emit('fit-to-selection')
      return
    }

    if (touchSelect) {
      if (findTouch(ev.touches, touchSelect.id)) return
      const startPx = touchSelect.startPx
      const moved = touchSelect.moved
      const finalX = chartDrag ? chartDrag.currentPx : startPx
      touchSelect = null
      chartDrag = null
      const xScale = chartInstance.scales.x
      if (moved) {
        const km1 = xScale.getValueForPixel(Math.min(startPx, finalX))
        const km2 = xScale.getValueForPixel(Math.max(startPx, finalX))
        selectionStore.selectionRange.value = { startKm: km1 as number, endKm: km2 as number }
        selectionStore.selectionPinned.value = true
        chartInstance.update('none')
        emit('fit-to-selection')
      } else {
        const km1 = xScale.getValueForPixel(startPx)
        const col = km1 != null ? routeStore.detectedClimbs.value.find((c) => km1 >= c.startKm && km1 <= c.endKm) : undefined
        if (col) {
          selectionStore.selectionRange.value = { startKm: col.startKm, endKm: col.endKm }
          selectionStore.selectionPinned.value = true
          chartInstance.update('none')
          emit('fit-to-selection')
        } else {
          selectionStore.selectionRange.value = null
          selectionStore.selectionPinned.value = false
          chartInstance.update('none')
          if (km1 != null) {
            const pt = routeStore.geometry.value[geomIdxForKm(km1, selectionStore.cumDistKm)]
            if (pt) emit('zoom-to', pt[0], pt[1])
          }
        }
      }
      emit('hover-end')
    }
  }
  canvas.addEventListener('touchend', onTouchEnd, { passive: false })
  canvas.addEventListener('touchcancel', () => { resetTouchGestures(); emit('hover-end') }, { passive: false })
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

watch(selectionStore.hoverIdx, () => update())
watch(selectionStore.selectionRange, () => update())

// ─── Expose ───────────────────────────────────────────────────────────────────

defineExpose({ render, destroy, update, resize, resetZoom, clearSelection, zoomToSelection, getChartInstance, getChartEl })
</script>

<template>
  <div class="card shadow-sm border-0 route-builder-chart-card">

    <!-- ── Mode simplifié (mobile) ── -->
    <template v-if="props.simplified">
      <!-- Type d'activité — seul accès sur mobile (le panneau latéral est masqué) -->
      <div class="activity-toggle btn-group btn-group-sm w-100 mb-2" role="group" :aria-label="t('routes.wt_sport')">
        <button
          v-for="s in ACTIVITIES"
          :key="s"
          type="button"
          class="btn"
          :class="routeStore.sport.value === s ? 'btn-primary' : 'btn-outline-secondary'"
          :aria-label="t(`routes.wt_sport_${s}`)"
          @click="routeStore.setSport(s)"
        >
          <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
          <span class="ms-1">{{ t(`routes.wt_sport_${s}`) }}</span>
        </button>
      </div>
      <div v-if="routeStore.hasGeometry.value" class="mobile-chart-stats">
        <span class="stat-pill stat-pill-distance">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
          <strong>{{ chartStats.distance >= 1000 ? (chartStats.distance / 1000).toFixed(2) + ' km' : Math.round(chartStats.distance) + ' m' }}</strong>
        </span>
        <span class="stat-pill stat-pill-up">
          <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
          <strong>+{{ Math.round(chartStats.gain) }} m</strong>
        </span>
        <span class="stat-pill stat-pill-time">
          <i class="fa-solid fa-clock" aria-hidden="true"></i>
          <strong>{{ formatDuration(routeStore.estimatedSeconds.value) }}</strong>
          <span class="speed-input-wrap">
            <input
              v-model.number="routeStore.avgSpeedKmh.value"
              type="number" min="3" max="80" step="1"
              class="speed-input"
              :aria-label="t('routes.avg_speed_hint')"
            />
            <small>km/h</small>
          </span>
        </span>
        <span
          v-if="routeLoad"
          class="stat-pill stat-pill-tss"
          :title="t('routes.tss.hint_short')"
        >
          <i class="fa-solid fa-bolt" aria-hidden="true"></i>
          <strong>{{ t('routes.tss.label') }} ≈ {{ routeLoad.tss }}</strong>
          <small v-if="routeLoad.level" :style="{ color: FEAS_COLOR[routeLoad.level] }">
            {{ t(`routes.tss.level_${routeLoad.level}`) }}
          </small>
        </span>
      </div>
      <div class="card-body route-builder-chart-card-body">
        <div v-if="routeStore.isFetchingElevation.value" class="mobile-chart-loading">
          <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
          <span>{{ t('routes.computing_elevation') }}</span>
        </div>
        <div v-else-if="!routeStore.hasGeometry.value" class="text-muted small text-center py-3">
          <i class="fa-solid fa-hand-pointer me-1" aria-hidden="true"></i>
          {{ t('routes.click_hint') }}
        </div>
        <div v-else class="elevation-canvas-wrap">
          <canvas ref="chartEl"></canvas>
        </div>
      </div>
    </template>

    <!-- ── Mode complet (desktop) ── -->
    <template v-else>
      <div class="card-header activity-card-header d-flex align-items-center gap-2 flex-wrap">
        <i class="fa-solid fa-mountain text-warning" aria-hidden="true"></i>
        <h3 class="h6 mb-0">{{ t('routes.elevation_profile') }}</h3>
        <button
          v-if="selectionStore.selectionRange.value"
          type="button"
          class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
          :title="t('routes.zoom_to_selection')"
          @click="zoomToSelection"
        >
          <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
          <span>{{ t('routes.zoom_to_selection') }}</span>
        </button>
        <button
          v-if="selectionStore.selectionRange.value"
          type="button"
          class="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
          :title="t('routes.clear_selection')"
          @click="clearSelection"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          <span>{{ t('routes.clear_selection') }}</span>
        </button>
        <button
          v-if="selectionStore.selectionRange.value && !routeStore.readOnly.value"
          type="button"
          class="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1"
          :title="t('routes.propose_alternatives')"
          @click="$emit('propose-alternatives')"
        >
          <i class="fa-solid fa-code-branch" aria-hidden="true"></i>
          <span>{{ t('routes.alternatives_short') }}</span>
        </button>
        <button
          v-if="selectionStore.selectionRange.value"
          type="button"
          class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
          :title="t('routes.open_selection_in_komoot')"
          @click="$emit('open-selection-in-komoot')"
        >
          <i class="fa-solid fa-person-biking" aria-hidden="true"></i>
          <span>Komoot</span>
        </button>
        <button
          v-if="selectionStore.isZoomed.value"
          type="button"
          class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
          :title="t('routes.reset_zoom')"
          @click="resetZoom"
        >
          <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
          <span>{{ t('routes.reset_zoom') }}</span>
        </button>
        <div class="ms-auto d-flex align-items-center gap-2 flex-wrap">
          <template v-if="routeStore.hasGeometry.value">
            <span class="stat-pill stat-pill-distance">
              <i class="fa-solid fa-route me-1" aria-hidden="true"></i>
              <strong>{{ chartStats.distance >= 1000 ? (chartStats.distance / 1000).toFixed(2) + ' km' : Math.round(chartStats.distance) + ' m' }}</strong>
            </span>
            <span class="stat-pill stat-pill-up">
              <i class="fa-solid fa-arrow-trend-up me-1" aria-hidden="true"></i>
              <strong>+{{ Math.round(chartStats.gain) }} m</strong>
            </span>
            <span class="stat-pill stat-pill-down">
              <i class="fa-solid fa-arrow-trend-down me-1" aria-hidden="true"></i>
              <strong>−{{ Math.round(chartStats.loss) }} m</strong>
            </span>
            <span class="stat-pill stat-pill-grade">
              <span class="grade-icon me-1" aria-hidden="true">\</span>
              <strong>{{ chartStats.avgGrade.toFixed(1) }} %</strong>
            </span>
          </template>
          <button
            type="button"
            class="btn btn-sm btn-light chart-collapse-btn"
            @click="$emit('collapse')"
            :title="t('routes.hide_elevation_chart')"
            aria-label="Réduire"
          >
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="card-body route-builder-chart-card-body">
        <div v-if="!routeStore.hasGeometry.value" class="text-muted small d-flex align-items-center gap-2">
          <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
          <span>{{ t('routes.no_elevation_yet') }}</span>
        </div>
        <template v-else>
          <div class="elevation-canvas-wrap">
            <canvas ref="chartEl"></canvas>
          </div>
        </template>
      </div>
    </template>

  </div>
</template>

<style scoped>
.route-builder-chart-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  flex: 1;
}
.route-builder-chart-card :deep(.card-header) {
  padding: 0.15rem 0.35rem;
}
.route-builder-chart-card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0.4rem 0.75rem;
}
.elevation-canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.elevation-canvas-wrap canvas { cursor: crosshair; width: 100% !important; touch-action: none; }
.chart-collapse-btn {
  flex-shrink: 0;
  padding: 0.15rem 0.4rem;
  line-height: 1;
}
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
.stat-pill-distance { background: rgba(252, 76, 2, 0.12); color: #fc4c02; }
.stat-pill-up       { background: rgba(25, 135, 84, 0.12); color: #15803d; }
.stat-pill-down     { background: rgba(220, 53, 69, 0.12); color: #b02a37; }
.stat-pill-grade    { background: rgba(108, 117, 125, 0.12); color: #495057; }
.stat-pill-tss      { background: rgba(111, 66, 193, 0.12); color: #6f42c1; gap: 0.4rem; }
.stat-pill-tss small { font-weight: 600; font-size: 0.72rem; }
.grade-icon {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700;
  font-size: 0.95em;
  line-height: 1;
  display: inline-block;
}
/* ── Mobile simplified header ── */
.mobile-chart-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem 0.25rem;
  overflow-x: auto;
}
.mobile-chart-stats .stat-pill {
  flex-shrink: 0;
}
.mobile-chart-stats .stat-pill-time {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
  background: rgba(13, 110, 253, 0.10);
  color: #0d6efd;
  border-radius: 999px;
}
.speed-input-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 0.15rem;
}
.speed-input-wrap small { font-size: 0.7rem; opacity: 0.75; }
.speed-input {
  width: 2.6rem;
  border: 1px solid rgba(13, 110, 253, 0.25);
  background: rgba(255, 255, 255, 0.6);
  color: inherit;
  border-radius: 4px;
  padding: 0 0.25rem;
  font-size: 0.78rem;
  font-weight: 600;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}
.speed-input::-webkit-inner-spin-button,
.speed-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.speed-input:focus { outline: none; border-color: #0d6efd; }
.mobile-chart-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: #6b7280;
  padding: 1rem;
}
</style>
