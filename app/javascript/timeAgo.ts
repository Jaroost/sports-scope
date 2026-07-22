import { t } from './i18n'

// Whole-day difference between today and the given ISO date, using local
// midnight as the reference (so an activity from "yesterday at 11 PM" reads
// as "1 day ago", not "9 hours ago"). Returns null for invalid/missing input.
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY)
}

// Human-readable "X days ago" badge label. Uses i18n keys under `common.*`.
// Shows the largest relevant unit: days under a month, then months, then
// years (≈30 days/month, ≈365 days/year — good enough for a badge).
// Negative days (date in the future) fall back to the plain count to avoid
// nonsensical strings — shouldn't happen in practice for activity lists.
export function formatDaysAgo(iso: string | null | undefined): string {
  const n = daysSince(iso)
  if (n == null) return ''
  if (n === 0) return t('common.days_ago_today')
  if (n === 1) return t('common.days_ago_yesterday')
  if (n < 0) return t('common.days_in_future', { count: -n })
  if (n < 30) return t('common.days_ago_other', { count: n })
  const months = Math.round(n / 30)
  if (months < 12) return t('common.months_ago', { count: months })
  const years = Math.round(n / 365)
  return t(years === 1 ? 'common.years_ago_one' : 'common.years_ago_other', { count: years })
}
