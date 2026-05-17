import { t } from './i18n'

// Whole-day difference between today and the given ISO date, using local
// midnight as the reference (so an activity from "yesterday at 11 PM" reads
// as "1 day ago", not "9 hours ago"). Returns null for invalid/missing input.
export function daysSince(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  return Math.round((a - b) / MS_PER_DAY)
}

// Human-readable "X days ago" badge label. Uses i18n keys under `common.*`.
// Negative days (date in the future) fall back to the plain count to avoid
// nonsensical strings — shouldn't happen in practice for activity lists.
export function formatDaysAgo(iso) {
  const n = daysSince(iso)
  if (n == null) return ''
  if (n === 0) return t('common.days_ago_today')
  if (n === 1) return t('common.days_ago_yesterday')
  if (n < 0) return t('common.days_in_future', { count: -n })
  return t('common.days_ago_other', { count: n })
}
