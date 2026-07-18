// Hover-tooltip rendering — shared between ActivityMapCard (map cursor) and
// ActivityCharts (Chart.js external tooltip). All inputs are passed in as
// plain arguments so the file stays free of Vue / DOM closures.

import { t } from './i18n'
import { defByKey, formatHMS, escapeHtml } from './activityHelpers'

export type StreamEntry = { data: unknown[] }
export type StreamsMap = Record<string, StreamEntry | undefined> | null | undefined

export interface TooltipTitleParams {
  streams: StreamsMap
  idx: number
  xAxis: string
  activityStartIso?: string | null
}

export interface TooltipHtmlParams {
  streams: StreamsMap
  activity: Record<string, unknown> | null | undefined
  xAxis: string
  idx: number
  visibleStreams: string[]
  priorityStreams?: string[]
}

// Vertical ascent speed (m/h) measured over a ±15 s window around `idx`.
// Lives next to the tooltip builders because it's only consumed there.
export function instantVam(streams: StreamsMap, idx: number): number | null {
  const times = streams?.time?.data as number[] | undefined
  const alt = streams?.altitude?.data as number[] | undefined
  if (!Array.isArray(times) || !Array.isArray(alt)) return null
  const n = Math.min(times.length, alt.length)
  if (n < 2 || idx < 0 || idx >= n) return null
  const targetT = times[idx]
  const HALF = 15
  let i0 = idx
  let i1 = idx
  while (i0 > 0 && targetT - times[i0 - 1] < HALF) i0--
  while (i1 < n - 1 && times[i1 + 1] - targetT < HALF) i1++
  if (i1 <= i0) return null
  const dt = times[i1] - times[i0]
  if (dt <= 0) return null
  return ((alt[i1] - alt[i0]) / dt) * 3600
}

// Builds the small "title" block at the top of the tooltip (distance + time +
// absolute wall-clock). `xAxis` is 'distance' | 'time' and picks which line
// is the main one. `activityStartIso` is `activity.start_date_local`.
export function buildTooltipTitleLines({ streams, idx, xAxis, activityStartIso }: TooltipTitleParams): { main: boolean; text: string }[] {
  const lines: { main: boolean; text: string }[] = []
  const distStream = streams?.distance?.data as number[] | undefined
  const timeStream = streams?.time?.data as number[] | undefined
  const dm = distStream?.[idx]
  const tSec = timeStream?.[idx]
  if (xAxis === 'distance') {
    if (dm != null) lines.push({ main: true, text: `${(dm / 1000).toFixed(2)} km` })
    if (tSec != null) lines.push({ main: false, text: formatHMS(tSec) })
  } else {
    if (tSec != null) lines.push({ main: true, text: formatHMS(tSec) })
    if (dm != null) lines.push({ main: false, text: `${(dm / 1000).toFixed(2)} km` })
  }
  // Absolute datetime = activity start (wall-clock, "Z" stripped) + elapsed
  // seconds. Strava ships start_date_local with a misleading "Z" suffix.
  if (activityStartIso && tSec != null) {
    const localBase = new Date(activityStartIso.replace(/Z$/, '')).getTime()
    const dt = new Date(localBase + tSec * 1000)
    lines.push({
      main: false,
      text: dt.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    })
  }
  return lines
}

// Builds the full tooltip HTML. `priorityStreams` is rendered at the top
// (the hovered chart's own streams); `visibleStreams` populates the
// secondary section below. The chart's "Vit. ascensionnelle" derived row is
// always rendered when altitude data exists.
export function buildTooltipHtml({ streams, activity, xAxis, idx, visibleStreams, priorityStreams = [] }: TooltipHtmlParams): string {
  if (idx == null) return ''
  const titleLines = buildTooltipTitleLines({
    streams,
    idx,
    xAxis,
    activityStartIso: activity?.start_date_local as string | undefined,
  })
  let html = '<div class="chart-tooltip-title">'
  for (const line of titleLines) {
    const cls = line.main ? 'chart-tooltip-title-main' : 'chart-tooltip-title-sub'
    html += `<div class="${cls}">${escapeHtml(line.text)}</div>`
  }
  html += '</div>'

  const rendered = new Set<string>()
  const renderRow = (streamKey: string): string => {
    if (rendered.has(streamKey)) return ''
    const def = defByKey(streamKey, activity)
    if (!def) return ''
    const rawArr = streams?.[streamKey]?.data as unknown[] | undefined
    const raw = rawArr?.[idx]
    if (raw == null) return ''
    const y = def.transform(raw as number)
    const digits = def.digits ?? 1
    const value = Number.isNaN(y) ? '–' : (def.format ? def.format(y) : y.toFixed(digits))
    rendered.add(streamKey)
    return `<div class="chart-tooltip-row">
      <span class="chart-tooltip-swatch" style="background:${def.color}"></span>
      <span class="chart-tooltip-name">${escapeHtml(t('strava.stream.' + (def.labelKey || streamKey)))}</span>
      <span class="chart-tooltip-value">${escapeHtml(value)} ${escapeHtml(def.unit || '')}</span>
    </div>`
  }

  let primary = ''
  for (const k of priorityStreams) primary += renderRow(k)
  let secondary = ''
  for (const k of visibleStreams) secondary += renderRow(k)

  const vam = instantVam(streams, idx)
  let vamRow = ''
  if (vam != null && Number.isFinite(vam)) {
    vamRow = `<div class="chart-tooltip-row">
      <span class="chart-tooltip-swatch" style="background:#198754"></span>
      <span class="chart-tooltip-name">${escapeHtml(t('strava.stats.col_vam'))}</span>
      <span class="chart-tooltip-value">${escapeHtml(Math.round(vam).toString())} m/h</span>
    </div>`
  }

  if (primary) html += `<div class="chart-tooltip-section">${primary}</div>`
  if (primary && secondary) html += '<div class="chart-tooltip-divider"></div>'
  if (secondary) html += `<div class="chart-tooltip-section chart-tooltip-section-secondary">${secondary}</div>`
  if (vamRow) {
    if (primary || secondary) html += '<div class="chart-tooltip-divider"></div>'
    html += `<div class="chart-tooltip-section chart-tooltip-section-secondary">${vamRow}</div>`
  }
  return html
}

// Positions a free-floating tooltip element next to a `(x, y)` anchor inside
// a container of the given size. Picks the side (right/left) that leaves the
// tooltip fully inside the container.
export function positionTooltipBeside(
  el: HTMLElement,
  anchorX: number,
  anchorY: number,
  containerWidth: number,
  containerHeight: number,
): void {
  const tipRect = el.getBoundingClientRect()
  const OFFSET = 16
  const placeOnRight = anchorX + OFFSET + tipRect.width < containerWidth - 4
  if (placeOnRight) {
    el.style.left = `${anchorX + OFFSET}px`
    el.style.transform = 'translate(0, -50%)'
  } else {
    el.style.left = `${anchorX - OFFSET}px`
    el.style.transform = 'translate(-100%, -50%)'
  }
  let topPos = anchorY
  const halfH = tipRect.height / 2
  if (topPos - halfH < 4) topPos = halfH + 4
  if (topPos + halfH > containerHeight - 4) topPos = containerHeight - halfH - 4
  el.style.top = `${topPos}px`
}
