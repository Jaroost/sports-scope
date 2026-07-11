<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { t } from '../i18n'
import {
  chartIcons,
  chartDefs,
  defByKey,
  STREAM_CHIP_ORDER,
  fmt,
  formatHMS,
  formatKm,
  downsample,
  computeElevGain,
} from '../activityHelpers'
import { buildTooltipHtml } from '../activityTooltip'

const props = defineProps({
  streams: { type: Object, default: null },
  activity: { type: Object, default: null },
  streamsLoading: { type: Boolean, default: false },
  streamsError: { type: String, default: null },
  // Cross-component selection (driven by parent — chart click, map drag,
  // climb-marker click, stats-row click). We watch it to repaint the band
  // overlay + flags, and emit `select-segment` / `clear-selection` when the
  // user drags on a chart.
  selection: { type: Object, default: null },
  // v-model:x-axis — propagated up so MapCard can pick the right unit in the
  // route-hover tooltip.
  xAxis: { type: String, default: 'distance' },
  // v-model:visible-streams — exposed up so MapCard's tooltip can list the
  // currently-rendered stream rows.
  visibleStreams: { type: Array, default: () => [] },
  // v-model:zoom-range — { xMin, xMax } | null. Alimenté par le bouton
  // « Zoomer sur la sélection » et le pincement tactile.
  zoomRange: { type: Object, default: null },
  // v-model:collapsed — persisted by the parent (localStorage).
  collapsed: { type: Boolean, default: false },
})

const emit = defineEmits([
  'select-segment',
  'clear-selection',
  'update:xAxis',
  'update:visibleStreams',
  'update:zoomRange',
  'update:collapsed',
])

// ─── Layout (chart groups, presets, drag/drop state) ─────────────────────
function defaultLayout() {
  return chartDefs.map((def) => ({ id: def.key, streams: [def.key], collapsed: false }))
}

const chartLayout = ref(defaultLayout())
const layoutSaving = ref(false)
const layoutDirty = ref(false)
const savedLayouts = ref([]) // [{ id, name, layout }]
const selectedLayoutId = ref(null)
const lastUsedId = ref(null) // persisted on the server
const dragSourceId = ref(null)
const dragOverGroupId = ref(null)
const dragOverSlotIndex = ref(null)
const isCopyMode = ref(false) // true while the pointer is on the "copy" half
const hiddenDatasets = ref(new Map()) // groupId → Set<datasetIdx>
// Sur mobile, les contrôles du header (zoom/sélection/preset/axe) sont repliés dans un
// menu déroulant ouvert par un bouton « réglages », pour ne pas manger la moitié de l'écran.
const mobileControlsOpen = ref(false)

const availableLayout = computed(() => (props.streams ? chartLayout.value : []))

// Deduplicated list of streams currently shown somewhere.
const visibleStreamsLocal = computed(() => {
  const seen = new Set()
  const result = []
  for (const group of availableLayout.value) {
    for (const s of group.streams) {
      if (!seen.has(s)) { seen.add(s); result.push(s) }
    }
  }
  return result
})
// Push the list up via v-model so MapCard's tooltip can mirror what charts show.
watch(visibleStreamsLocal, (v) => emit('update:visibleStreams', v), { immediate: true, deep: true })

// Stream chips shown in the sticky header — independent of chartDefs order.
const chipStreams = computed(() => {
  const present = new Set(visibleStreamsLocal.value)
  return STREAM_CHIP_ORDER.filter((k) => present.has(k))
})

// Drop streams that aren't present on this activity and append any missing
// ones at the end. Returns nothing — mutates chartLayout in place if changed.
function syncLayoutWithStreams() {
  if (!props.streams) return
  const present = new Set(
    chartDefs
      .filter((d) => Array.isArray(props.streams[d.key]?.data) && props.streams[d.key].data.length > 0)
      .map((d) => d.key),
  )
  const cleaned = chartLayout.value
    .map((g) => ({ id: g.id, streams: g.streams.filter((k) => present.has(k)), collapsed: !!g.collapsed }))
    .filter((g) => g.streams.length > 0)
  const referenced = new Set(cleaned.flatMap((g) => g.streams))
  const missing = [...present].filter((k) => !referenced.has(k))
  const final = [...cleaned, ...missing.map((k) => ({ id: k, streams: [k], collapsed: false }))]
  if (JSON.stringify(final) === JSON.stringify(chartLayout.value)) return
  chartLayout.value = final
}

// ─── X-axis unit helpers ─────────────────────────────────────────────────
function timeFactor() { return 60 } // seconds per X-axis unit (always minutes)

function chartXFromRaw(rawX) {
  if (props.xAxis === 'distance') return rawX / 1000
  return rawX / timeFactor()
}

function chartXToRaw(x) {
  if (props.xAxis === 'distance') return x * 1000
  return x * timeFactor()
}

function xAxisLabel() {
  if (props.xAxis === 'distance') return t('strava.distance_km')
  return t('strava.time_label_min')
}

// Binary search the x stream (raw units) for the closest index to `target`.
function xValueToIndex(target) {
  const stream = props.streams?.[props.xAxis]?.data
  if (!stream || stream.length === 0) return 0
  let lo = 0
  let hi = stream.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stream[mid] < target) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(stream[lo - 1] - target) < Math.abs(stream[lo] - target)) return lo - 1
  return lo
}

// ─── Selection range stats (debounced display) ───────────────────────────
const selectionDisplay = ref(null)
let displayDebounceTimer = null
const DISPLAY_DEBOUNCE_MS = 60
watch(() => props.selection, (val) => {
  if (displayDebounceTimer) clearTimeout(displayDebounceTimer)
  displayDebounceTimer = setTimeout(() => {
    displayDebounceTimer = null
    selectionDisplay.value = val ? { ...val } : null
  }, DISPLAY_DEBOUNCE_MS)
}, { immediate: true })

function rangeBounds() {
  const refStream = props.streams?.distance?.data || props.streams?.time?.data || props.streams?.latlng?.data
  if (!refStream || refStream.length === 0) return null
  const maxIdx = refStream.length - 1
  const s = Math.max(0, Math.min(selectionDisplay.value?.startIdx ?? 0, maxIdx))
  const e = Math.max(s, Math.min(selectionDisplay.value?.endIdx ?? maxIdx, maxIdx))
  return { startIdx: s, endIdx: e }
}

function rangeDuration() {
  const b = rangeBounds()
  const time = props.streams?.time?.data
  if (!b || !time || time.length === 0) return null
  const t0 = time[Math.min(b.startIdx, time.length - 1)]
  const t1 = time[Math.min(b.endIdx, time.length - 1)]
  return Math.max(0, t1 - t0)
}

function rangeDistance() {
  const b = rangeBounds()
  const dist = props.streams?.distance?.data
  if (!b || !dist || dist.length === 0) return null
  const d0 = dist[Math.min(b.startIdx, dist.length - 1)]
  const d1 = dist[Math.min(b.endIdx, dist.length - 1)]
  return Math.max(0, d1 - d0)
}

const rangeElevation = computed(() => {
  const b = rangeBounds()
  const alt = props.streams?.altitude?.data
  if (!b || !alt || alt.length < 2) return null
  const start = Math.max(b.startIdx, 0)
  const end = Math.min(b.endIdx, alt.length - 1)

  // Without a selection (full activity): use the provider's authoritative
  // total_elevation_gain (D+) and derive D- from the invariant D+ - D- = net
  // altitude change (alt_end - alt_start), which holds regardless of the
  // smoothing algorithm used to compute D+.
  if (!selectionDisplay.value && props.activity?.total_elevation_gain != null) {
    const up = props.activity.total_elevation_gain
    const netAlt = alt[end] - alt[start]
    const down = Math.max(0, up - netAlt)
    return { up, down }
  }

  // With a selection: compute both from the smoothed stream slice.
  const { gain: up, loss: down } = computeElevGain(alt.slice(start, end + 1))
  return { up, down }
})

// VAM over the selected range — net altitude / duration. Signed.
function rangeVam() {
  const b = rangeBounds()
  const dur = rangeDuration()
  const alt = props.streams?.altitude?.data
  if (!b || !dur || dur <= 0 || !Array.isArray(alt) || alt.length < 2) return null
  const a0 = alt[Math.min(b.startIdx, alt.length - 1)]
  const a1 = alt[Math.min(b.endIdx, alt.length - 1)]
  if (typeof a0 !== 'number' || typeof a1 !== 'number') return null
  return ((a1 - a0) / dur) * 3600
}

function rangeGrade() {
  // Net rise / horizontal distance — matches the col markers on the map.
  // The sample-mean of grade_smooth is intentionally NOT used here.
  const b = rangeBounds()
  if (!b) return null
  const alt = props.streams?.altitude?.data
  const dist = props.streams?.distance?.data
  if (!alt || !dist || alt.length === 0 || dist.length === 0) return null
  const d0 = dist[Math.min(b.startIdx, dist.length - 1)]
  const d1 = dist[Math.min(b.endIdx, dist.length - 1)]
  if (d1 - d0 <= 0) return null
  const a0 = alt[Math.min(b.startIdx, alt.length - 1)]
  const a1 = alt[Math.min(b.endIdx, alt.length - 1)]
  return ((a1 - a0) / (d1 - d0)) * 100
}

function chartStats(def) {
  const data = props.streams?.[def.key]?.data
  if (!data || data.length === 0) return null
  const s = selectionDisplay.value?.startIdx ?? 0
  const e = selectionDisplay.value?.endIdx ?? data.length - 1
  let count = 0
  let sum = 0
  let mn = Infinity
  let mx = -Infinity
  for (let i = s; i <= e && i < data.length; i++) {
    const v = def.transform(data[i])
    if (v == null || Number.isNaN(v)) continue
    count++
    sum += v
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  if (count === 0) return null
  let mean = sum / count
  // For grade_smooth, the per-sample mean disagrees with the col-marker
  // grade for the same segment — override with the net rise / horizontal.
  if (def.key === 'grade_smooth') {
    const rg = rangeGrade()
    if (rg != null) mean = rg
  }
  return { count, mean, min: mn, max: mx }
}

// ─── Chart.js plugin: drag-to-select + flag handles + selection highlight
const HANDLE_TOL = 8
// Tolérances tactiles (px) : zone d'accroche d'une poignée et seuil sous lequel un
// geste reste un « tap » (mobile, doigts plus gros que le curseur souris).
const TOUCH_HANDLE_TOL_PX = 16
const TOUCH_TAP_TOL_PX = 8

function drawChartFlag(ctx, area, x, kind) {
  const fw = 12
  const fh = 9
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

function detectChartHandle(chart, px) {
  const sel = chart.$selectionRange
  if (!sel || sel.start == null || sel.end == null) return null
  const area = chart.chartArea
  const px1 = Math.max(area.left, Math.min(area.right, chart.scales.x.getPixelForValue(sel.start)))
  const px2 = Math.max(area.left, Math.min(area.right, chart.scales.x.getPixelForValue(sel.end)))
  const startVal = sel.start
  const endVal = sel.end
  const dStart = Math.abs(px - px1)
  const dEnd = Math.abs(px - px2)
  if (dStart <= HANDLE_TOL && dStart <= dEnd) return { fixedValue: endVal }
  if (dEnd <= HANDLE_TOL) return { fixedValue: startVal }
  return null
}

const dragSelectPlugin = {
  id: 'dragSelect',
  beforeEvent(chart, args) {
    const e = args.event
    const native = e.native
    if (!native) return
    const st = chart.$drag || (chart.$drag = { mode: null, x0: null, x1: null, fixedValue: null })

    const isStart = (native.type === 'mousedown' && native.button === 0) || native.type === 'touchstart'
    const isMove = native.type === 'mousemove' || native.type === 'touchmove'
    const isEnd = native.type === 'mouseup' || native.type === 'mouseout' || native.type === 'touchend' || native.type === 'touchcancel'

    if (isStart) {
      const area = chart.chartArea
      if (e.x < area.left - HANDLE_TOL || e.x > area.right + HANDLE_TOL) return
      if (e.y < area.top || e.y > area.bottom) return
      const handle = detectChartHandle(chart, e.x)
      if (handle) {
        st.mode = 'handle'
        st.fixedValue = handle.fixedValue
        chart.canvas.style.cursor = 'ew-resize'
      } else {
        st.mode = 'select'
        st.x0 = e.x
        st.x1 = e.x
        chart.canvas.style.cursor = 'crosshair'
      }
      if (native.type === 'touchstart' && native.cancelable) native.preventDefault()
      chart.draw()
    } else if (isMove && st.mode === 'handle') {
      const v = chart.scales.x.getValueForPixel(e.x)
      if (v != null && !Number.isNaN(v)) {
        chart.$onSelect?.(st.fixedValue, v)
      }
      if (native.type === 'touchmove' && native.cancelable) native.preventDefault()
    } else if (isMove && st.mode === 'select') {
      st.x1 = e.x
      if (native.type === 'touchmove' && native.cancelable) native.preventDefault()
      chart.draw()
    } else if (isMove && !st.mode) {
      const handle = detectChartHandle(chart, e.x)
      chart.canvas.style.cursor = handle ? 'ew-resize' : 'crosshair'
    } else if (isEnd && st.mode) {
      if (st.mode === 'select') {
        const area = chart.chartArea
        const x0 = Math.max(area.left, Math.min(area.right, st.x0))
        const x1 = Math.max(area.left, Math.min(area.right, st.x1))
        if (Math.abs(x1 - x0) >= 4) {
          const v0 = chart.scales.x.getValueForPixel(x0)
          const v1 = chart.scales.x.getValueForPixel(x1)
          chart.$onSelect?.(v0, v1)
        }
      }
      st.mode = null
      st.x0 = null
      st.x1 = null
      st.fixedValue = null
      chart.canvas.style.cursor = 'crosshair'
      chart.draw()
    }
  },
  afterDraw(chart) {
    const { ctx, chartArea } = chart
    const st = chart.$drag
    const sel = chart.$selectionRange
    if (sel && sel.start != null && sel.end != null) {
      const px1 = chart.scales.x.getPixelForValue(sel.start)
      const px2 = chart.scales.x.getPixelForValue(sel.end)
      const lo = Math.min(px1, px2)
      const hi = Math.max(px1, px2)
      if (!chart.$noSelection) {
        const clipLo = Math.max(chartArea.left, lo)
        const clipHi = Math.min(chartArea.right, hi)
        if (clipHi > clipLo) {
          ctx.save()
          ctx.fillStyle = 'rgba(13, 110, 253, 0.15)'
          ctx.fillRect(clipLo, chartArea.top, clipHi - clipLo, chartArea.bottom - chartArea.top)
          ctx.restore()
        }
      }
      const drawLo = Math.max(chartArea.left, Math.min(chartArea.right, lo))
      const drawHi = Math.max(chartArea.left, Math.min(chartArea.right, hi))
      drawChartFlag(ctx, chartArea, drawLo, 'start')
      drawChartFlag(ctx, chartArea, drawHi, 'end')
    }
    if (st && st.mode === 'select' && st.x0 != null && st.x1 != null) {
      ctx.save()
      ctx.fillStyle = 'rgba(13, 110, 253, 0.25)'
      ctx.fillRect(Math.min(st.x0, st.x1), chartArea.top, Math.abs(st.x1 - st.x0), chartArea.bottom - chartArea.top)
      ctx.restore()
    }
  },
}

// ─── Chart instances + rendering ─────────────────────────────────────────
const chartInstances = new Map()
const touchCleanups = new Map() // groupId → () => void : retire les listeners tactiles
// Geste tactile en cours (un seul à la fois). Chaque objet mémorise le chart concerné.
let touchPinch: any = null  // { idA, idB, vA, vB, chart } — pincement + pan (2 doigts)
let touchSelect: any = null // { id, startPx, startY, moved, chart } — sélection (1 doigt)
let touchHandle: any = null // { id, fixedValue, chart } — déplacement d'une borne min/max
let xMinAll = 0
let xMaxAll = 0

async function renderCharts() {
  const groups = availableLayout.value
  if (groups.length === 0) return

  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables, dragSelectPlugin)

  destroyCharts()

  const xStream = props.streams[props.xAxis]?.data || props.streams.time?.data || []
  const maxPoints = 600
  const xRaw = xStream
  xMinAll = xRaw.length > 0 ? chartXFromRaw(xRaw[0]) : 0
  xMaxAll = xRaw.length > 0 ? chartXFromRaw(xRaw[xRaw.length - 1]) : 0

  groups.forEach((group) => {
    if (group.collapsed) return
    const canvas = document.getElementById(`chart-${group.id}`) as HTMLCanvasElement | null
    if (!canvas) return

    const occurrences = new Map()
    const datasets = group.streams.map((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return null
      const count = (occurrences.get(streamKey) || 0) + 1
      occurrences.set(streamKey, count)
      const totalForKey = group.streams.filter((s) => s === streamKey).length
      const label = totalForKey > 1
        ? `${t('strava.stream.' + def.key)} #${count} (${def.unit})`
        : `${t('strava.stream.' + def.key)} (${def.unit})`
      const yRaw = props.streams[streamKey].data
      const len = Math.min(xRaw.length, yRaw.length)
      const pairs = []
      for (let i = 0; i < len; i++) {
        pairs.push({ x: chartXFromRaw(xRaw[i]), y: def.transform(yRaw[i]) })
      }
      const data = downsample(pairs, maxPoints)
      return {
        label,
        data,
        borderColor: def.color,
        backgroundColor: def.color + '33',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: true,
        yAxisID: `y-${idx}`,
        $streamKey: streamKey,
      }
    }).filter(Boolean)

    const yScales = {}
    group.streams.forEach((streamKey, idx) => {
      const def = defByKey(streamKey)
      if (!def) return
      yScales[`y-${idx}`] = {
        type: 'linear',
        position: idx % 2 === 0 ? 'left' : 'right',
        // Titre d'axe retiré pour gagner de la place — l'unité est rappelée dans la
        // légende du panneau. Les graduations restent colorées pour repérer l'axe.
        title: { display: false },
        ticks: { maxTicksLimit: 6, color: def.color },
        grid: { drawOnChartArea: idx === 0 },
      }
    })

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { intersect: false, mode: 'index', axis: 'x' },
        // Tactile géré par nos propres listeners (attachTouchInteraction) : on ne
        // laisse à Chart.js que la souris pour éviter un double traitement des gestes.
        events: ['mousedown', 'mousemove', 'mouseup', 'mouseout', 'click'],
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            mode: 'index',
            intersect: false,
            external: externalTooltipHandler,
          },
        },
        scales: {
          x: {
            type: 'linear',
            // Titre d'axe retiré (rappelé dans la légende du panneau, cf. axis-x-hint).
            title: { display: false },
            ticks: props.xAxis === 'time'
              ? {
                  stepSize: 10,
                  maxTicksLimit: 30,
                  callback: ((tf) => (val: number) => formatHMS(val * tf))(timeFactor()),
                }
              : { maxTicksLimit: 8 },
            // Épingle l'axe sur l'étendue exacte des données (hors zoom) pour que la
            // courbe touche les deux bords. Sans min/max, Chart.js arrondit au tick
            // supérieur et laisse un vide à droite (la courbe n'atteint pas 100 %).
            min: props.zoomRange?.xMin ?? xMinAll,
            max: props.zoomRange?.xMax ?? xMaxAll,
          },
          ...yScales,
        },
      },
    })

    ;(chart as any).$onSelect = (v0: number, v1: number) => {
      const r0 = chartXToRaw(Math.min(v0, v1))
      const r1 = chartXToRaw(Math.max(v0, v1))
      const sIdx = xValueToIndex(r0)
      const eIdx = xValueToIndex(r1)
      const xs = props.streams?.[props.xAxis]?.data || props.streams?.time?.data
      const maxIdx = (xs?.length || 1) - 1
      if (sIdx <= 0 && eIdx >= maxIdx) emit('clear-selection')
      else emit('select-segment', sIdx, eIdx)
    }

    touchCleanups.set(group.id, attachTouchInteraction(canvas, chart))

    chartInstances.set(group.id, chart)
  })

  applySelectionToCharts()
}

function applySelectionToCharts() {
  const xs = props.streams?.[props.xAxis]?.data
  if (!xs || xs.length === 0) return
  const fullStart = chartXFromRaw(xs[0])
  const fullEnd = chartXFromRaw(xs[xs.length - 1])
  chartInstances.forEach((chart) => {
    if (!props.selection) {
      chart.$selectionRange = { start: fullStart, end: fullEnd }
      chart.$noSelection = true
    } else {
      const x0 = chartXFromRaw(xs[props.selection.startIdx])
      const x1 = chartXFromRaw(xs[props.selection.endIdx])
      chart.$selectionRange = { start: x0, end: x1 }
      chart.$noSelection = false
    }
    chart.draw()
  })
}

function destroyCharts() {
  touchCleanups.forEach((detach) => detach())
  touchCleanups.clear()
  touchPinch = touchSelect = touchHandle = null
  // Remove any external tooltip DOM nodes before destroying their charts.
  chartInstances.forEach((c) => {
    c.canvas.parentNode?.querySelector('.chart-tooltip')?.remove()
  })
  chartInstances.forEach((c) => c.destroy())
  chartInstances.clear()
  hiddenDatasets.value = new Map()
}

function externalTooltipHandler(context) {
  const { chart, tooltip } = context
  const canvasId = chart.canvas.id || ''
  const groupId = canvasId.startsWith('chart-') ? canvasId.slice(6) : null
  if (!groupId) return
  const slot = document.querySelector(`.chart-tooltip-slot[data-group-id="${CSS.escape(groupId)}"]`)
  if (!slot) return
  let el = slot.querySelector('.chart-tooltip')
  if (!el) {
    el = document.createElement('div')
    el.className = 'chart-tooltip chart-tooltip-inline'
    slot.appendChild(el)
  }
  if (tooltip.opacity === 0 || chart.$drag?.mode) {
    el.classList.add('chart-tooltip-hidden')
    return
  }
  const xv = tooltip.dataPoints?.[0]?.parsed?.x
  if (xv == null || Number.isNaN(xv)) {
    el.classList.add('chart-tooltip-hidden')
    return
  }
  const idx = xValueToIndex(chartXToRaw(xv))
  const hoveredGroup = chartLayout.value.find((g) => g.id === groupId)
  const priority = hoveredGroup?.streams || []
  el.innerHTML = buildTooltipHtml({
    streams: props.streams,
    activity: props.activity,
    xAxis: props.xAxis,
    idx,
    visibleStreams: visibleStreamsLocal.value,
    priorityStreams: priority,
  })
  el.classList.remove('chart-tooltip-hidden')
  const area = chart.chartArea
  const cursorX = tooltip.caretX
  if (area && cursorX != null) {
    const mid = (area.left + area.right) / 2
    slot.classList.toggle('chart-tooltip-slot-left', cursorX > mid)
  }
}

function isDatasetHidden(groupId, idx) {
  return hiddenDatasets.value.get(groupId)?.has(idx) || false
}

function toggleDataset(groupId, idx) {
  const chart = chartInstances.get(groupId)
  if (!chart) return
  const prev = hiddenDatasets.value.get(groupId) || new Set()
  const next = new Set(prev)
  if (next.has(idx)) { next.delete(idx); chart.show(idx) }
  else { next.add(idx); chart.hide(idx) }
  const newMap = new Map(hiddenDatasets.value)
  newMap.set(groupId, next)
  hiddenDatasets.value = newMap
}

// ─── Layout mutations (merge / copy / split / collapse / move / reset) ───
function mergeGroups(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const merged = {
    id: target.id,
    streams: [...target.streams, ...source.streams.filter((s) => !target.streams.includes(s))],
    collapsed: !!target.collapsed,
  }
  chartLayout.value = chartLayout.value
    .filter((g) => g.id !== sourceId)
    .map((g) => (g.id === targetId ? merged : g))
  layoutDirty.value = true
}

// Copy: append source's streams to target without removing source — lets the
// user overlay the same curve multiple times in a single group.
function copyToGroup(sourceId, targetId) {
  if (sourceId === targetId) return
  const source = chartLayout.value.find((g) => g.id === sourceId)
  const target = chartLayout.value.find((g) => g.id === targetId)
  if (!source || !target) return
  const updated = {
    id: target.id,
    streams: [...target.streams, ...source.streams],
    collapsed: !!target.collapsed,
  }
  chartLayout.value = chartLayout.value.map((g) => (g.id === targetId ? updated : g))
  layoutDirty.value = true
}

function toggleCollapsed(group) {
  const next = chartLayout.value.map((g) =>
    g.id === group.id ? { ...g, collapsed: !g.collapsed } : g,
  )
  chartLayout.value = next
  layoutDirty.value = true
}

function splitGroup(group) {
  if (!group || group.streams.length <= 1) return
  const idx = chartLayout.value.findIndex((g) => g.id === group.id)
  if (idx < 0) return
  const otherGroups = chartLayout.value.filter((g) => g.id !== group.id)
  const used = new Set(otherGroups.map((g) => g.id))
  const replacements = []
  for (const s of group.streams) {
    if (otherGroups.some((g) => g.streams.length === 1 && g.streams[0] === s)) continue
    if (replacements.some((r) => r.streams[0] === s)) continue
    let candidate = s
    let suffix = 1
    while (used.has(candidate)) {
      suffix++
      candidate = `${s}-${suffix}`
    }
    used.add(candidate)
    replacements.push({ id: candidate, streams: [s], collapsed: false })
  }
  const newLayout = [...chartLayout.value]
  newLayout.splice(idx, 1, ...replacements)
  chartLayout.value = newLayout
  layoutDirty.value = true
}

function moveGroupToIndex(groupId, targetIndex) {
  const idx = chartLayout.value.findIndex((g) => g.id === groupId)
  if (idx < 0) return
  const arr = [...chartLayout.value]
  const [moved] = arr.splice(idx, 1)
  const clamped = Math.max(0, Math.min(targetIndex > idx ? targetIndex - 1 : targetIndex, arr.length))
  arr.splice(clamped, 0, moved)
  if (arr.every((g, i) => g.id === chartLayout.value[i]?.id)) return
  chartLayout.value = arr
  layoutDirty.value = true
}

function resetLayout() {
  chartLayout.value = defaultLayout()
  selectedLayoutId.value = null
  layoutDirty.value = true
  syncLayoutWithStreams()
  setLastUsed(null)
}

// ─── Preset (server-persisted layout) management ─────────────────────────
async function fetchSavedLayouts() {
  try {
    const res = await fetch('/preferences/chart_layouts', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const payload = await res.json()
    if (Array.isArray(payload.chart_layouts)) savedLayouts.value = payload.chart_layouts
    lastUsedId.value = payload.last_used_id ?? null
  } catch { /* ignore */ }
}

// Apply a preset locally without persisting it as the new "last used" — used
// on mount when we restore the previously selected preset from the server.
function applyPresetById(id) {
  if (id == null) return false
  const preset = savedLayouts.value.find((p) => p.id === id)
  if (!preset) return false
  selectedLayoutId.value = id
  chartLayout.value = (preset.layout || []).map((g) => ({
    id: String(g.id),
    streams: Array.isArray(g.streams) ? g.streams.map(String) : [],
    collapsed: !!g.collapsed,
  }))
  layoutDirty.value = false
  return true
}

function loadPreset(rawId) {
  const id = typeof rawId === 'number' ? rawId : parseInt(rawId, 10)
  if (Number.isNaN(id)) {
    selectedLayoutId.value = null
    setLastUsed(null)
    return
  }
  if (!applyPresetById(id)) return
  syncLayoutWithStreams()
  setLastUsed(id)
}

async function setLastUsed(id) {
  try {
    await fetch('/preferences/chart_layouts/last_used', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id == null ? null : id }),
    })
    lastUsedId.value = id
  } catch { /* fire-and-forget */ }
}

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function savePresetAs() {
  const current = selectedLayoutId.value
    ? savedLayouts.value.find((p) => p.id === selectedLayoutId.value)
    : null
  const proposed = current?.name || ''
  const name = window.prompt(t('strava.layout.save_as_prompt'), proposed)
  if (name == null) return
  const trimmed = name.trim()
  if (!trimmed) return
  layoutSaving.value = true
  try {
    const res = await fetch('/preferences/chart_layouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name: trimmed, layout: chartLayout.value }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    const saved = payload.chart_layout
    if (saved) {
      const existing = savedLayouts.value.findIndex((p) => p.id === saved.id)
      if (existing >= 0) savedLayouts.value.splice(existing, 1, saved)
      else savedLayouts.value.push(saved)
      savedLayouts.value = [...savedLayouts.value].sort((a, b) => a.name.localeCompare(b.name))
      selectedLayoutId.value = saved.id
      layoutDirty.value = false
      setLastUsed(saved.id)
    }
  } catch {
    // best-effort UI feedback would go here; for now we just stop the spinner
  } finally {
    layoutSaving.value = false
  }
}

async function deletePreset() {
  const id = selectedLayoutId.value
  if (!id) return
  const preset = savedLayouts.value.find((p) => p.id === id)
  if (!preset) return
  const confirmed = window.confirm(`${t('strava.layout.delete_confirm')} « ${preset.name} » ?`)
  if (!confirmed) return
  try {
    const res = await fetch(`/preferences/chart_layouts/${id}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    savedLayouts.value = savedLayouts.value.filter((p) => p.id !== id)
    resetLayout()
  } catch { /* ignore */ }
}

function onPresetChange(ev) {
  const v = ev.target.value
  if (v === '') resetLayout()
  else loadPreset(v)
}

// ─── Drag-reorder via pointer events ─────────────────────────────────────
// Pointer-events instead of HTML5 drag — gives full control and avoids
// browser quirks around draggable attributes + document-level listeners.
const DRAG_THRESHOLD_PX = 6
let pdStartX = 0
let pdStartY = 0
let pdInitialized = false
let pdMoveListener = null
let pdUpListener = null

function onChartPointerDown(group, e) {
  // Pointer Events : couvre souris ET tactile (le drag-reorder marche donc sur mobile).
  if (e.button !== undefined && e.button > 0) return
  if (e.target.closest && e.target.closest('button')) return
  pdStartX = e.clientX
  pdStartY = e.clientY
  pdInitialized = false
  dragSourceId.value = group.id
  // Capture le pointeur sur le header : au doigt, les pointermove/up continuent d'arriver
  // ici même si le doigt survole d'autres éléments, et la page ne défile pas pendant le drag.
  if (e.pointerId != null) (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId)
  pdMoveListener = (ev) => onPointerMove(ev)
  pdUpListener = () => onPointerUp()
  window.addEventListener('pointermove', pdMoveListener)
  window.addEventListener('pointerup', pdUpListener)
  window.addEventListener('pointercancel', pdUpListener)
}

function onPointerMove(e) {
  if (!pdInitialized) {
    const dx = e.clientX - pdStartX
    const dy = e.clientY - pdStartY
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    pdInitialized = true
  }
  pointerHitTest(e.clientX, e.clientY)
  document.body.style.cursor = dragOverGroupId.value
    ? (isCopyMode.value ? 'copy' : 'alias')
    : 'grabbing'
}

function pointerHitTest(clientX, clientY) {
  const elem = document.elementFromPoint(clientX, clientY)
  if (!elem) {
    dragOverGroupId.value = null
    dragOverSlotIndex.value = null
    isCopyMode.value = false
    return
  }
  let node = elem
  while (node && node !== document.body) {
    if (node.classList?.contains('chart-drop-slot')) {
      const idx = parseInt((node as HTMLElement).dataset?.slotIdx ?? '', 10)
      if (!Number.isNaN(idx)) {
        dragOverSlotIndex.value = idx
        dragOverGroupId.value = null
        isCopyMode.value = false
      }
      return
    }
    if (node.classList?.contains('chart-group')) {
      const id = (node as HTMLElement).dataset?.groupId
      if (id && id !== dragSourceId.value) {
        const rect = node.getBoundingClientRect()
        const midX = rect.left + rect.width / 2
        isCopyMode.value = clientX > midX
        dragOverGroupId.value = id
        dragOverSlotIndex.value = null
      } else {
        dragOverGroupId.value = null
        dragOverSlotIndex.value = null
        isCopyMode.value = false
      }
      return
    }
    node = node.parentElement
  }
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
  isCopyMode.value = false
}

function onPointerUp() {
  if (pdMoveListener) {
    window.removeEventListener('pointermove', pdMoveListener)
    pdMoveListener = null
  }
  if (pdUpListener) {
    window.removeEventListener('pointerup', pdUpListener)
    window.removeEventListener('pointercancel', pdUpListener)
    pdUpListener = null
  }
  document.body.style.cursor = ''

  if (pdInitialized && dragSourceId.value) {
    if (dragOverGroupId.value && dragOverGroupId.value !== dragSourceId.value) {
      if (isCopyMode.value) copyToGroup(dragSourceId.value, dragOverGroupId.value)
      else mergeGroups(dragSourceId.value, dragOverGroupId.value)
    } else if (dragOverSlotIndex.value != null) {
      moveGroupToIndex(dragSourceId.value, dragOverSlotIndex.value)
    }
  }

  dragSourceId.value = null
  dragOverGroupId.value = null
  dragOverSlotIndex.value = null
  isCopyMode.value = false
  pdInitialized = false
}

// ─── Zoom (drag-selection on a chart) ────────────────────────────
function setZoom(min, max) {
  const natural = xMaxAll - xMinAll
  if (natural <= 0) return
  const minSpan = natural * 0.005
  let lo = Math.max(min, xMinAll)
  let hi = Math.min(max, xMaxAll)
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2
    lo = Math.max(xMinAll, mid - minSpan / 2)
    hi = Math.min(xMaxAll, mid + minSpan / 2)
  }
  if (lo <= xMinAll && hi >= xMaxAll) emit('update:zoomRange', null)
  else emit('update:zoomRange', { xMin: lo, xMax: hi })
}

function resetZoom() { emit('update:zoomRange', null) }

function zoomToSelection() {
  if (!props.selection) return
  const xs = props.streams?.[props.xAxis]?.data || props.streams?.time?.data
  if (!xs || xs.length === 0) return
  const a = xs[props.selection.startIdx]
  const b = xs[props.selection.endIdx]
  if (a == null || b == null) return
  const x0 = chartXFromRaw(a)
  const x1 = chartXFromRaw(b)
  if (Number.isNaN(x0) || Number.isNaN(x1) || x0 === x1) return
  setZoom(Math.min(x0, x1), Math.max(x0, x1))
}

function applyZoomToCharts() {
  chartInstances.forEach((chart) => {
    chart.options.scales.x.min = props.zoomRange?.xMin
    chart.options.scales.x.max = props.zoomRange?.xMax
    chart.update('none')
  })
}

// ─── Touch interactions (mobile) ──────────────────────────────────────────
// 1 doigt : glisser horizontalement = sélectionner une plage ; saisir un drapeau de
//   bord = déplacer la limite min/max (les drapeaux affichés aux bords sont les bornes).
//   Un glissement majoritairement vertical rend la main au scroll de la page.
// 2 doigts : pincer pour zoomer + déplacer la fenêtre (pan) quand on est zoomé.
function findTouchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
  return null
}
function touchPxIn(canvas: HTMLCanvasElement, clientX: number): number {
  return clientX - canvas.getBoundingClientRect().left
}
function touchFractionIn(chart: any, canvas: HTMLCanvasElement, clientX: number): number {
  const area = chart.chartArea
  return (touchPxIn(canvas, clientX) - area.left) / (area.right - area.left)
}
// Valeur d'axe (chart-x) → index d'échantillon dans les streams.
function chartValueToIndex(chartXVal: number): number {
  return xValueToIndex(chartXToRaw(chartXVal))
}

function attachTouchInteraction(canvas: HTMLCanvasElement, chart: any) {
  const onStart = (ev: TouchEvent) => {
    // 2 doigts → pincement/pan : on annule tout geste à un doigt en cours.
    if (ev.touches.length >= 2) {
      ev.preventDefault()
      touchSelect = null
      touchHandle = null
      if (chart.$drag) { chart.$drag = null; chart.update('none') }
      const a = ev.touches[0], b = ev.touches[1]
      const curMin = props.zoomRange?.xMin ?? xMinAll
      const curMax = props.zoomRange?.xMax ?? xMaxAll
      const fA = touchFractionIn(chart, canvas, a.clientX)
      const fB = touchFractionIn(chart, canvas, b.clientX)
      touchPinch = {
        idA: a.identifier, idB: b.identifier, chart,
        vA: curMin + fA * (curMax - curMin),
        vB: curMin + fB * (curMax - curMin),
      }
      return
    }
    const touch = ev.touches[0]
    const x = touchPxIn(canvas, touch.clientX)
    const area = chart.chartArea
    if (x < area.left - TOUCH_HANDLE_TOL_PX || x > area.right + TOUCH_HANDLE_TOL_PX) return
    // Drapeau de bord (limite min/max) sous le doigt → redimensionnement : on capture.
    const handle = detectChartHandle(chart, x)
    if (handle) {
      ev.preventDefault()
      touchHandle = { id: touch.identifier, fixedValue: handle.fixedValue, chart }
      return
    }
    if (x < area.left || x > area.right) return
    // Sélection : on ne capture pas encore (pas de preventDefault) — le scroll vertical
    // de la page reste possible tant que le doigt n'a pas tranché en faveur de l'horizontale.
    touchSelect = { id: touch.identifier, startPx: x, startY: touch.clientY, moved: false, chart }
  }

  const onMove = (ev: TouchEvent) => {
    if (touchPinch && touchPinch.chart === chart) {
      const a = findTouchById(ev.touches, touchPinch.idA)
      const b = findTouchById(ev.touches, touchPinch.idB)
      if (!a || !b) return
      ev.preventDefault()
      const fA = touchFractionIn(chart, canvas, a.clientX)
      const fB = touchFractionIn(chart, canvas, b.clientX)
      if (Math.abs(fA - fB) < 1e-4) return
      const newRange = (touchPinch.vA - touchPinch.vB) / (fA - fB)
      const newMin = touchPinch.vA - fA * newRange
      setZoom(newMin, newMin + newRange)
      return
    }

    if (touchHandle && touchHandle.chart === chart) {
      const tt = findTouchById(ev.touches, touchHandle.id)
      if (!tt) return
      ev.preventDefault()
      const area = chart.chartArea
      const xx = Math.max(area.left, Math.min(area.right, touchPxIn(canvas, tt.clientX)))
      const val = chart.scales.x.getValueForPixel(xx)
      if (val == null || Number.isNaN(val)) return
      const lo = Math.min(chartValueToIndex(val), chartValueToIndex(touchHandle.fixedValue))
      const hi = Math.max(chartValueToIndex(val), chartValueToIndex(touchHandle.fixedValue))
      if (hi > lo) emit('select-segment', lo, hi)
      return
    }

    if (touchSelect && touchSelect.chart === chart) {
      const tt = findTouchById(ev.touches, touchSelect.id)
      if (!tt) return
      const area = chart.chartArea
      const x = Math.max(area.left, Math.min(area.right, touchPxIn(canvas, tt.clientX)))
      if (!touchSelect.moved) {
        const dx = Math.abs(x - touchSelect.startPx)
        const dy = Math.abs(tt.clientY - touchSelect.startY)
        // On ne démarre une sélection que si le geste est franchement horizontal.
        // Tant que ce n'est pas le cas (vertical ou diagonal), on ne fait pas de
        // preventDefault : le scroll vertical de la page reste possible. Dès que le
        // geste penche vers la verticale, on abandonne définitivement la sélection.
        if (dx <= TOUCH_TAP_TOL_PX || dx <= dy) {
          if (dy > TOUCH_TAP_TOL_PX && dy >= dx) touchSelect = null
          return
        }
        touchSelect.moved = true
        chart.$drag = { mode: 'select', x0: touchSelect.startPx, x1: x }
      }
      ev.preventDefault()
      chart.$drag.x1 = x
      chart.update('none')
    }
  }

  const onEnd = (ev: TouchEvent) => {
    if (touchPinch && touchPinch.chart === chart) {
      if (ev.touches.length < 2) touchPinch = null
      return
    }
    if (touchHandle && touchHandle.chart === chart) {
      if (findTouchById(ev.touches, touchHandle.id)) return
      touchHandle = null
      return
    }
    if (touchSelect && touchSelect.chart === chart) {
      if (findTouchById(ev.touches, touchSelect.id)) return
      const moved = touchSelect.moved
      const drag = chart.$drag
      touchSelect = null
      chart.$drag = null
      if (moved && drag) {
        const xScale = chart.scales.x
        const v0 = xScale.getValueForPixel(Math.min(drag.x0, drag.x1))
        const v1 = xScale.getValueForPixel(Math.max(drag.x0, drag.x1))
        if (v0 != null && v1 != null) {
          const sIdx = chartValueToIndex(v0)
          const eIdx = chartValueToIndex(v1)
          const xs = props.streams?.[props.xAxis]?.data || props.streams?.time?.data
          const maxIdx = (xs?.length || 1) - 1
          if (sIdx <= 0 && eIdx >= maxIdx) emit('clear-selection')
          else if (eIdx > sIdx) emit('select-segment', sIdx, eIdx)
        }
      }
      chart.update('none')
    }
  }

  const onCancel = () => {
    touchPinch = touchSelect = touchHandle = null
    if (chart.$drag) { chart.$drag = null; chart.update('none') }
  }

  canvas.addEventListener('touchstart', onStart, { passive: false })
  canvas.addEventListener('touchmove', onMove, { passive: false })
  canvas.addEventListener('touchend', onEnd, { passive: false })
  canvas.addEventListener('touchcancel', onCancel, { passive: false })
  return () => {
    canvas.removeEventListener('touchstart', onStart)
    canvas.removeEventListener('touchmove', onMove)
    canvas.removeEventListener('touchend', onEnd)
    canvas.removeEventListener('touchcancel', onCancel)
  }
}

// ─── Toggle wrappers (v-model) ───────────────────────────────────────────
function setXAxis(v) { emit('update:xAxis', v) }
function toggleCardCollapsed() { emit('update:collapsed', !props.collapsed) }
function clearSelection() { emit('clear-selection') }

// ─── Watchers ────────────────────────────────────────────────────────────
watch(() => props.xAxis, () => {
  emit('update:zoomRange', null)
  if (props.streams) renderCharts()
})

watch(chartLayout, async () => {
  if (!props.streams) return
  await nextTick()
  renderCharts()
}, { deep: true })

// When the user re-shows the charts after collapsing, the canvases were torn
// down by v-if, so we re-render once Vue mounts the new canvases.
watch(() => props.collapsed, async (collapsed) => {
  if (collapsed) return
  if (!props.streams) return
  await nextTick()
  renderCharts()
})

watch(() => props.zoomRange, applyZoomToCharts)

watch(() => props.selection, applySelectionToCharts)

// First mount: pull the saved presets, restore the user's last-used one,
// reconcile the layout against the streams actually available, and render.
onMounted(async () => {
  await fetchSavedLayouts()
  if (lastUsedId.value != null) applyPresetById(lastUsedId.value)
  syncLayoutWithStreams()
  if (props.streams && availableLayout.value.length > 0) {
    await new Promise((r) => requestAnimationFrame(r))
    await renderCharts()
  }
})

// When the parent fetches `streams` asynchronously, we may mount with
// `streams=null`. Watch for the first non-null assignment and render.
watch(() => props.streams, async (val, old) => {
  if (val && !old) {
    syncLayoutWithStreams()
    await nextTick()
    await renderCharts()
  }
})

onBeforeUnmount(() => {
  destroyCharts()
})
</script>

<template>
  <div class="card shadow-sm border-0 mt-3">
    <div class="card-header activity-card-header charts-sticky-header">
      <div class="d-flex flex-wrap gap-2 justify-content-between align-items-center">
        <h3 class="h6 mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-chart-line text-warning" aria-hidden="true"></i>
          <span>{{ t('strava.charts') }}</span>
        </h3>
        <div class="d-flex flex-wrap gap-3 align-items-center chart-controls-wrap">
          <!-- Bouton « réglages » : visible uniquement sur mobile, ouvre/ferme le menu
               déroulant des contrôles ci-dessous. -->
          <button
            v-if="!collapsed"
            type="button"
            class="btn btn-sm btn-outline-secondary chart-controls-toggle"
            :aria-pressed="mobileControlsOpen"
            :title="t('strava.charts')"
            @click="mobileControlsOpen = !mobileControlsOpen"
          >
            <i class="fa-solid fa-sliders" aria-hidden="true"></i>
          </button>
          <!-- Controls only render when the charts card is expanded. The
               toggle button stays visible in both states. -->
          <div
            v-if="!collapsed"
            class="chart-controls"
            :class="{ 'chart-controls-open': mobileControlsOpen }"
          >
            <!-- GROUPE 1 : Actions ponctuelles (visibles si applicables) -->
            <div class="control-group" v-if="selection || zoomRange">
              <button
                v-if="selection"
                type="button"
                class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                :title="t('strava.zoom_to_selection')"
                @click="zoomToSelection(); mobileControlsOpen = false"
              >
                <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
                <span>{{ t('strava.zoom_to_selection') }}</span>
              </button>
              <button
                v-if="selection"
                type="button"
                class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
                :title="t('strava.clear_selection')"
                @click="clearSelection(); mobileControlsOpen = false"
              >
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                <span>{{ t('strava.clear_selection') }}</span>
              </button>
              <button
                v-if="zoomRange"
                type="button"
                class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                :title="t('strava.reset_zoom')"
                @click="resetZoom(); mobileControlsOpen = false"
              >
                <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
                <span>{{ t('strava.reset_zoom') }}</span>
              </button>
            </div>

            <!-- GROUPE 2 : Préférence (preset nommé) -->
            <div class="control-group" :title="t('strava.layout.title')">
              <span class="control-group-label">{{ t('strava.layout.preset_label') }}</span>
              <select
                class="form-select form-select-sm preset-select"
                :value="selectedLayoutId ?? ''"
                :title="t('strava.layout.select_preset')"
                @change="onPresetChange"
              >
                <option value="">— {{ t('strava.layout.no_preset') }} —</option>
                <option v-for="p in savedLayouts" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <div class="btn-group btn-group-sm">
                <button
                  type="button"
                  class="btn btn-outline-primary"
                  :disabled="layoutSaving"
                  :title="t('strava.layout.save_as')"
                  @click="savePresetAs"
                >
                  <span v-if="layoutSaving" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                  <i v-else class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="btn btn-outline-danger"
                  :disabled="!selectedLayoutId || layoutSaving"
                  :title="t('strava.layout.delete')"
                  @click="deletePreset"
                >
                  <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="btn btn-outline-secondary"
                  :title="t('strava.layout.reset')"
                  @click="resetLayout"
                >
                  <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
                </button>
              </div>
            </div>

            <!-- GROUPE 3 : Axe X -->
            <div class="control-group" v-if="availableLayout.length > 0">
              <span class="control-group-label">{{ t('strava.x_axis_label') }}</span>
              <div class="btn-group btn-group-sm" role="group">
                <input type="radio" class="btn-check" name="xAxis" id="xAxis-distance" autocomplete="off" value="distance" :checked="xAxis === 'distance'" :disabled="!streams || !streams.distance" @change="setXAxis('distance')" />
                <label class="btn btn-outline-secondary" for="xAxis-distance">{{ t('strava.x_distance') }}</label>
                <input type="radio" class="btn-check" name="xAxis" id="xAxis-time" autocomplete="off" value="time" :checked="xAxis === 'time'" :disabled="!streams || !streams.time" @change="setXAxis('time')" />
                <label class="btn btn-outline-secondary" for="xAxis-time">{{ t('strava.x_time') }}</label>
              </div>
            </div>
          </div>

          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            :title="collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
            :aria-pressed="collapsed"
            @click="toggleCardCollapsed"
          >
            <i :class="collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div v-if="availableLayout.length > 0" class="range-chips d-flex flex-wrap gap-2 align-items-center mt-2">
        <span v-if="rangeDuration() != null" class="range-chip">
          <i class="fa-regular fa-clock" aria-hidden="true"></i>
          <strong>{{ formatHMS(rangeDuration()) }}</strong>
        </span>
        <span v-if="rangeDistance() != null" class="range-chip">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
          <strong>{{ formatKm(rangeDistance()) }}</strong>
        </span>
        <span v-if="rangeElevation" class="range-chip range-chip-success">
          <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
          <strong>{{ Math.round(rangeElevation.up) }} m</strong>
        </span>
        <span v-if="rangeElevation" class="range-chip range-chip-danger">
          <i class="fa-solid fa-arrow-trend-down" aria-hidden="true"></i>
          <strong>{{ Math.round(rangeElevation.down) }} m</strong>
        </span>
        <span v-if="rangeGrade() != null && !visibleStreamsLocal.includes('grade_smooth')" class="range-chip">
          <i class="fa-solid fa-percent" aria-hidden="true"></i>
          <strong>{{ rangeGrade().toFixed(1) }} %</strong>
        </span>
        <div
          v-if="rangeVam() != null || chipStreams.length > 0"
          class="control-group range-chip-group"
        >
          <span
            v-if="rangeVam() != null"
            class="range-chip"
            :class="rangeVam() >= 0 ? 'range-chip-success' : 'range-chip-danger'"
            :title="t('strava.stats.vam_hint')"
          >
            <i class="fa-solid fa-mountain" aria-hidden="true"></i>
            <strong>{{ Math.round(rangeVam()) }} m/h</strong>
            <i class="fa-solid fa-circle-info chip-info-hint" aria-hidden="true"></i>
          </span>
          <span
            v-for="streamKey in chipStreams"
            :key="`mean-${streamKey}`"
            class="range-chip range-chip-stream"
            :style="{ background: defByKey(streamKey)?.color + '1f', color: defByKey(streamKey)?.color }"
          >
            <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
            <strong v-if="chartStats(defByKey(streamKey))">{{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</strong>
            <strong v-else>–</strong>
            <i v-if="chartStats(defByKey(streamKey))" class="fa-solid fa-circle-info chip-info-hint" aria-hidden="true"></i>
            <span v-if="chartStats(defByKey(streamKey))" class="chip-popover">
              <div class="chart-tooltip-title">
                <div class="chart-tooltip-title-main">
                  <i :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'}`" aria-hidden="true"></i>
                  {{ t('strava.stream.' + streamKey) }}
                </div>
              </div>
              <div class="chart-tooltip-section">
                <div class="chart-tooltip-row">
                  <i class="fa-solid fa-arrow-down-short-wide chart-tooltip-icon" aria-hidden="true"></i>
                  <span class="chart-tooltip-name">{{ t('strava.range_stats.min') }}</span>
                  <span class="chart-tooltip-value">{{ fmt(chartStats(defByKey(streamKey)).min, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</span>
                </div>
                <div class="chart-tooltip-row">
                  <i class="fa-solid fa-equals chart-tooltip-icon" aria-hidden="true"></i>
                  <span class="chart-tooltip-name">{{ t('strava.range_stats.mean') }}</span>
                  <span class="chart-tooltip-value">{{ fmt(chartStats(defByKey(streamKey)).mean, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</span>
                </div>
                <div class="chart-tooltip-row">
                  <i class="fa-solid fa-arrow-up-wide-short chart-tooltip-icon" aria-hidden="true"></i>
                  <span class="chart-tooltip-name">{{ t('strava.range_stats.max') }}</span>
                  <span class="chart-tooltip-value">{{ fmt(chartStats(defByKey(streamKey)).max, defByKey(streamKey).digits) }} {{ defByKey(streamKey).unit }}</span>
                </div>
              </div>
            </span>
          </span>
        </div>
      </div>
    </div>
    <div v-if="!collapsed" class="card-body">
      <div v-if="streamsLoading" class="text-muted d-flex align-items-center gap-2">
        <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
        <span>{{ t('strava.loading_streams') }}</span>
      </div>
      <div v-else-if="streamsError" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>{{ streamsError }}</span>
      </div>
      <div v-else-if="availableLayout.length === 0" class="text-muted d-flex align-items-center gap-2">
        <i class="fa-regular fa-folder-open" aria-hidden="true"></i>
        <span>{{ t('strava.no_stream_data') }}</span>
      </div>
      <div v-else class="chart-layout">
        <template v-for="(group, gIdx) in availableLayout" :key="group.id">
          <div
            class="chart-drop-slot"
            :class="{ active: dragOverSlotIndex === gIdx, hinting: dragSourceId }"
            :data-slot-idx="gIdx"
          ></div>
          <div
            class="chart-group"
            :class="{
              'merge-target': dragOverGroupId === group.id && dragSourceId !== group.id,
              dragging: dragSourceId === group.id,
            }"
            :data-group-id="group.id"
          >
            <div
              v-if="dragOverGroupId === group.id && dragSourceId !== group.id"
              class="chart-group-zones"
            >
              <div class="chart-zone chart-zone-merge" :class="{ active: !isCopyMode }">
                <span>{{ t('strava.layout.merge_here') }}</span>
              </div>
              <div class="chart-zone chart-zone-copy" :class="{ active: isCopyMode }">
                <span>{{ t('strava.layout.copy_here') }}</span>
              </div>
            </div>
            <div
              class="chart-group-header"
              :title="t('strava.layout.drag_hint')"
              @pointerdown="onChartPointerDown(group, $event)"
            >
              <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="drag-handle">
                    <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                  </span>
                  <template v-if="!group.collapsed">
                    <button
                      v-for="(streamKey, sIdx) in group.streams"
                      :key="`legend-${group.id}-${sIdx}`"
                      type="button"
                      class="legend-pill"
                      :class="{ hidden: isDatasetHidden(group.id, sIdx) }"
                      :title="isDatasetHidden(group.id, sIdx) ? t('strava.layout.show_curve') : t('strava.layout.hide_curve')"
                      @click="toggleDataset(group.id, sIdx)"
                      @pointerdown.stop
                    >
                      <i
                        :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'} legend-icon`"
                        :style="{ color: defByKey(streamKey)?.color }"
                        aria-hidden="true"
                      ></i>
                      <span>{{ t('strava.stream.' + streamKey) }} <span class="legend-unit">[{{ defByKey(streamKey)?.unit }}]</span></span>
                    </button>
                  </template>
                  <template v-else>
                    <span
                      v-for="streamKey in group.streams"
                      :key="streamKey"
                      class="legend-pill legend-pill-static"
                    >
                      <i
                        :class="`fa-solid ${chartIcons[streamKey] || 'fa-chart-line'} legend-icon`"
                        :style="{ color: defByKey(streamKey)?.color }"
                        aria-hidden="true"
                      ></i>
                      <span>{{ t('strava.stream.' + streamKey) }} <span class="legend-unit">[{{ defByKey(streamKey)?.unit }}]</span></span>
                    </span>
                  </template>
                  <!-- Axe X (commun au panneau) rappelé ici, les titres d'axes ayant été
                       retirés du graphique pour gagner de la place. -->
                  <span class="axis-x-hint" :title="t('strava.x_axis_label')">
                    <i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i>
                    <span>{{ xAxisLabel() }}</span>
                  </span>
                </div>
                <div class="d-flex gap-1">
                  <button
                    v-if="group.streams.length > 1 && !group.collapsed"
                    type="button"
                    class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                    :title="t('strava.layout.split')"
                    @click="splitGroup(group)"
                    @pointerdown.stop
                  >
                    <i class="fa-solid fa-object-ungroup" aria-hidden="true"></i>
                    <span>{{ t('strava.layout.split') }}</span>
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                    :title="group.collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
                    @click="toggleCollapsed(group)"
                    @pointerdown.stop
                  >
                    <i :class="group.collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>
            <div v-if="!group.collapsed">
              <div class="chart-canvas-wrap">
                <canvas :id="`chart-${group.id}`"></canvas>
                <div class="chart-tooltip-slot" :data-group-id="group.id"></div>
              </div>
            </div>
          </div>
        </template>
        <div
          class="chart-drop-slot"
          :class="{ active: dragOverSlotIndex === availableLayout.length, hinting: dragSourceId }"
          :data-slot-idx="availableLayout.length"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.charts-sticky-header {
  position: sticky;
  top: 4rem;
  z-index: 5;
  background: #ffffff;
  backdrop-filter: saturate(140%);
  border-bottom: 1px solid rgba(252, 76, 2, 0.22);
  box-shadow: 0 6px 14px -10px rgba(0, 0, 0, 0.18);
}

/* ── Contrôles du header : responsive ──────────────────────────────────────
   Desktop : les groupes de contrôles s'insèrent inline dans la barre (display:
   contents → ils héritent du flex/gap du parent), le bouton « réglages » est masqué.
   Mobile  : la barre ne garde que titre + réglages + cacher ; les contrôles passent
   dans un menu déroulant flottant (overlay) ouvert par le bouton réglages, pour ne
   plus occuper la moitié de l'écran. */
.chart-controls-wrap { position: relative; }
.chart-controls { display: contents; }
.chart-controls-toggle { display: none; }

@media (max-width: 767px) {
  /* Le header (donc les statistiques) reste sticky pendant le défilement des
     graphiques ; les contrôles étant repliés dans le menu, sa hauteur reste contenue. */
  .chart-controls-toggle { display: inline-flex; }
  .chart-controls { display: none; }
  /* Graphiques plus courts sur téléphone pour en voir davantage à l'écran. */
  .chart-canvas-wrap { height: 170px; }
  .chart-controls.chart-controls-open {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.6rem;
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 30;
    width: min(20rem, 88vw);
    max-height: 70vh;
    overflow-y: auto;
    padding: 0.75rem;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 0.6rem;
    box-shadow: 0 12px 30px -10px rgba(0, 0, 0, 0.4);
  }
  /* Dans le menu, chaque groupe occupe toute la largeur et reste lisible. */
  .chart-controls.chart-controls-open .control-group {
    width: 100%;
    flex-wrap: wrap;
  }
  .chart-controls.chart-controls-open .preset-select { max-width: none; flex: 1; }
}

.range-chips { font-size: 0.85rem; }
.range-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  background: rgba(108, 117, 125, 0.1);
  color: #495057;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.range-chip strong {
  font-weight: 600;
  color: #212529;
}
.range-chip-success {
  background: rgba(25, 135, 84, 0.12);
  color: #198754;
}
.range-chip-success strong { color: #146c43; }
.range-chip-danger {
  background: rgba(220, 53, 69, 0.12);
  color: #b02a37;
}
.range-chip-danger strong { color: #842029; }

.preset-select {
  width: auto;
  max-width: 220px;
  min-width: 140px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.55rem 0.25rem 0.6rem;
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 0.5rem;
  position: relative;
}
.range-chip-group {
  flex-wrap: wrap;
  padding: 0.2rem 0.35rem;
}
.control-group-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6c757d;
  user-select: none;
  padding-right: 0.15rem;
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  margin-right: 0.25rem;
  line-height: 1.6;
}

.range-chip-stream {
  position: relative;
  font-weight: 500;
  cursor: help;
}
.range-chip-stream strong { color: inherit; }
.chip-info-hint {
  font-size: 0.65em;
  opacity: 0.55;
  margin-left: 0.1rem;
  transition: opacity 0.15s ease;
}
.range-chip-stream:hover .chip-info-hint,
.range-chip-stream:focus-within .chip-info-hint {
  opacity: 1;
}

/* Hover popover anchored under each stream-mean chip. Reuses chart-tooltip's
   children (title/row/name/value) so the look matches the chart hover panel. */
.chip-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  display: none;
  background: rgba(33, 37, 41, 0.94);
  color: #fff;
  padding: 0.5rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.range-chip-stream:hover .chip-popover,
.range-chip-stream:focus-within .chip-popover {
  display: block;
}
.chart-tooltip-icon {
  width: 14px;
  text-align: center;
  flex-shrink: 0;
  opacity: 0.85;
}

/* Legend pills above each chart group. */
.legend-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: #495057;
  font-size: 0.72rem;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s, color 0.12s;
  user-select: none;
  line-height: 1.5;
}
.legend-pill:hover { background: rgba(0, 0, 0, 0.07); }
.legend-pill.hidden {
  opacity: 0.45;
  text-decoration: line-through;
}
.legend-icon {
  font-size: 0.85rem;
  line-height: 1;
  flex-shrink: 0;
}
.legend-pill.hidden .legend-icon { color: #adb5bd !important; }
.legend-pill-static {
  cursor: default;
  background: rgba(0, 0, 0, 0.02);
  border-style: dashed;
}
.legend-pill-static:hover { background: rgba(0, 0, 0, 0.02); }
/* Unité rappelée dans la pastille de légende, à la place du titre d'axe Y. */
.legend-unit {
  font-weight: 400;
  opacity: 0.6;
}
/* Rappel de l'axe X (à la place du titre d'axe X), discret et non interactif. */
.axis-x-hint {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  color: #6c757d;
  user-select: none;
  padding-left: 0.15rem;
}

/* Layout / drag-reorder. */
.chart-layout { position: relative; }
.chart-group {
  border-radius: 0.5rem;
  padding: 0.5rem;
  border: 1px solid transparent;
  position: relative;
  transition: outline 0.12s, background-color 0.12s, opacity 0.12s, box-shadow 0.12s;
}
.chart-group.dragging { opacity: 0.45; }
.chart-group.merge-target {
  outline: 3px solid rgba(13, 110, 253, 0.45);
  outline-offset: -3px;
  box-shadow: 0 0 0 4px rgba(13, 110, 253, 0.08);
}
.chart-group-zones {
  position: absolute;
  inset: 0;
  display: flex;
  pointer-events: none;
  z-index: 4;
  border-radius: 0.5rem;
  overflow: hidden;
}
.chart-zone {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: 0.02em;
  transition: background 0.12s, color 0.12s;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
}
.chart-zone-merge {
  background: linear-gradient(to right, rgba(13, 110, 253, 0.22), rgba(13, 110, 253, 0.06));
  color: #0a58ca;
  border-right: 2px dashed rgba(0, 0, 0, 0.15);
}
.chart-zone-copy {
  background: linear-gradient(to left, rgba(25, 135, 84, 0.22), rgba(25, 135, 84, 0.06));
  color: #146c43;
}
.chart-zone.active {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
.chart-zone-merge.active {
  background: linear-gradient(to right, rgba(13, 110, 253, 0.65), rgba(13, 110, 253, 0.35));
}
.chart-zone-copy.active {
  background: linear-gradient(to left, rgba(25, 135, 84, 0.65), rgba(25, 135, 84, 0.35));
}
.chart-zone span {
  background: rgba(255, 255, 255, 0.85);
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  box-shadow: 0 4px 12px -4px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
}
.chart-zone.active span {
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
}
.chart-group-header {
  cursor: grab;
  padding: 0.35rem 0.5rem;
  margin-bottom: 0.4rem;
  border-radius: 0.4rem;
  background: rgba(108, 117, 125, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.05);
  transition: background-color 0.12s, border-color 0.12s;
  user-select: none;
  /* Le header est une poignée de drag (réordonnancement) : on neutralise le
     défilement/zoom tactile dessus pour que le drag fonctionne au doigt. */
  touch-action: none;
}
.chart-group-header:hover {
  background: rgba(252, 76, 2, 0.06);
  border-color: rgba(252, 76, 2, 0.25);
}
.chart-group.dragging .chart-group-header { cursor: grabbing; }
.drag-handle {
  color: #adb5bd;
  font-size: 0.95rem;
  pointer-events: none;
}
.chart-group-header:hover .drag-handle { color: #fc4c02; }
.chart-drop-slot {
  height: 6px;
  margin: 0;
  border-radius: 4px;
  background: transparent;
  transition: background-color 0.12s, height 0.12s, margin 0.12s, box-shadow 0.12s;
  position: relative;
}
.chart-drop-slot.hinting {
  height: 24px;
  margin: 6px 0;
  background: repeating-linear-gradient(
    45deg,
    rgba(108, 117, 125, 0.14),
    rgba(108, 117, 125, 0.14) 6px,
    rgba(108, 117, 125, 0.05) 6px,
    rgba(108, 117, 125, 0.05) 12px
  );
  border: 1px dashed rgba(108, 117, 125, 0.4);
}
.chart-drop-slot.hinting::before {
  content: "↕";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(108, 117, 125, 0.6);
  font-size: 0.95rem;
  pointer-events: none;
}
.chart-drop-slot.active {
  background: rgba(13, 110, 253, 0.35);
  border-color: #0d6efd;
  box-shadow: 0 0 0 2px rgba(13, 110, 253, 0.25);
  height: 28px;
  margin: 6px 0;
}
.chart-drop-slot.active::before {
  color: #0d6efd;
  font-weight: bold;
}

.chart-canvas-wrap {
  position: relative;
  height: 240px;
  width: 100%;
}
.chart-canvas-wrap canvas {
  cursor: crosshair;
  touch-action: pan-y;
}
</style>

<style>
/* The Chart.js external-tooltip DOM is created via document.createElement
   (and Map's hover tooltip too), so these classes must be global. */
.chart-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(33, 37, 41, 0.94);
  color: #fff;
  padding: 0.5rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  z-index: 30;
  white-space: nowrap;
  transition: opacity 0.1s ease;
  opacity: 0;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.45);
  max-width: 360px;
  left: 0;
  top: 0;
}
.chart-tooltip-title {
  margin-bottom: 0.35rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.18);
}
.chart-tooltip-title-main {
  font-weight: 600;
  font-size: 0.85rem;
}
.chart-tooltip-title-sub {
  font-weight: 400;
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 0.1rem;
}
.chart-tooltip-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  line-height: 1.65;
}
.chart-tooltip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
.chart-tooltip-name {
  color: rgba(255, 255, 255, 0.78);
  margin-right: 0.4rem;
}
.chart-tooltip-value {
  margin-left: auto;
  font-weight: 600;
  padding-left: 0.55rem;
}
.chart-tooltip-divider {
  margin: 0.35rem 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.22);
}
.chart-tooltip-section-secondary {
  opacity: 0.78;
  font-size: 0.95em;
}

/* Inline variant: anchored as an overlay in the top-right corner of the
   canvas wrap. Sits above the chart without stealing pointer events. */
.chart-tooltip-slot {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 5;
  pointer-events: none;
  max-width: 60%;
}
.chart-tooltip-slot.chart-tooltip-slot-left {
  right: auto;
  left: 6px;
}
.chart-tooltip-inline {
  position: static;
  transform: none;
  opacity: 1;
  white-space: normal;
  font-size: 0.72rem;
}
.chart-tooltip-hidden {
  display: none;
}
</style>
