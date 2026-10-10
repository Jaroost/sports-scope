import { t } from './i18n'

// Durées d'un programme d'entraînement : "m:ss" à l'écran, secondes dans les données.
// Partagé par l'éditeur et par la carte d'un bloc. `formatTime`/`parseTime` sont
// génériques (minutes:secondes) et servent aussi à l'allure d'un programme de course.

// "m:ss" sous l'heure, "h:mm:ss" au-delà : ce que `parseTime` relit à l'identique.
export function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// Accepte "m:ss", "h:mm:ss" ou un nombre brut de secondes. `null` = saisie inexploitable
// (le champ est alors laissé tel quel, sans modifier la valeur).
export function parseTime(text: string): number | null {
  const trimmed = text.trim()
  const withHours = trimmed.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/)
  if (withHours) return Number(withHours[1]) * 3600 + Number(withHours[2]) * 60 + Number(withHours[3])
  const withColon = trimmed.match(/^(\d+):([0-5]?\d)$/)
  if (withColon) return Number(withColon[1]) * 60 + Number(withColon[2])
  const bare = trimmed.match(/^\d+$/)
  return bare ? Number(bare[0]) : null
}

// Durée « en clair » pour l'affichage (total, par tour) : « 30 secondes », « 2 minutes »,
// « 1 min 30 s », « 1h30 ». La saisie, elle, reste en mm:ss / hh:mm:ss.
export function formatHuman(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const secShort = t('training_programs.human_sec_short')
  if (h > 0) {
    const base = m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`
    return s > 0 ? `${base} ${s} ${secShort}` : base
  }
  if (m > 0) {
    return s > 0
      ? `${m} ${t('training_programs.human_min_short')} ${s} ${secShort}`
      : `${m} ${t(`training_programs.human_minute_${m === 1 ? 'one' : 'other'}`)}`
  }
  return `${s} ${t(`training_programs.human_second_${s === 1 ? 'one' : 'other'}`)}`
}
