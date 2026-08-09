// Couleurs récemment utilisées dans l'éditeur du tableau de bord companion
// (CompanionBlockPicker). Confort d'édition seulement — mémorisées en
// localStorage, jamais envoyées dans companion_settings : ça n'a aucun
// contrat avec l'appli Dart, contrairement à `color`/`text_color` d'un bloc.
const STORAGE_KEY = 'sportsScope.companionRecentColors'
const MAX_COLORS = 16

export function recentColors(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string') : []
  } catch {
    return []
  }
}

export function rememberColor(hex: string): void {
  try {
    const colors = recentColors().filter((c) => c !== hex)
    colors.unshift(hex)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors.slice(0, MAX_COLORS)))
  } catch { /* ignore — localStorage indisponible */ }
}
