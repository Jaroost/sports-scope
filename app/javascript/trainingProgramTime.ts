// Durées d'un programme d'entraînement : "m:ss" à l'écran, secondes dans les données.
// Partagé par l'éditeur et par la carte d'un bloc. `formatTime`/`parseTime` sont
// génériques (minutes:secondes) et servent aussi à l'allure d'un programme de course.

export function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Accepte "m:ss" ou un nombre brut de secondes. `null` = saisie inexploitable
// (le champ est alors laissé tel quel, sans modifier la valeur).
export function parseTime(text: string): number | null {
  const trimmed = text.trim()
  const withColon = trimmed.match(/^(\d+):([0-5]?\d)$/)
  if (withColon) return Number(withColon[1]) * 60 + Number(withColon[2])
  const bare = trimmed.match(/^\d+$/)
  return bare ? Number(bare[0]) : null
}
