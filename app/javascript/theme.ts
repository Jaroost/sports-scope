// Mode clair / sombre — s'appuie sur le mode de couleurs natif de Bootstrap 5.3
// (`data-bs-theme` sur <html>). Le choix (clair | sombre | auto) est un réglage
// d'appareil, gardé dans le cookie `theme` pour que Rails le rende directement dans
// la page (pas de flash). « auto » suit `prefers-color-scheme`, tranché une première
// fois par le script en tête de layout, puis ici à chaque changement côté système.
//
// Les pages plein écran de navigation portent `data-theme-locked` : elles restent
// claires quel que soit le choix (panneaux sur la carte, lisibles en plein soleil).

export type ThemePref = 'light' | 'dark' | 'auto'
export type Theme = 'light' | 'dark'

export const THEME_EVENT = 'sports-scope:themechange'

const root = document.documentElement
const media = window.matchMedia?.('(prefers-color-scheme: dark)')

export function themePreference(): ThemePref {
  const v = root.dataset.themePref
  return v === 'light' || v === 'dark' ? v : 'auto'
}

export function currentTheme(): Theme {
  return root.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light'
}

export function isDarkTheme(): boolean {
  return currentTheme() === 'dark'
}

function resolve(pref: ThemePref): Theme {
  if (pref !== 'auto') return pref
  return media?.matches ? 'dark' : 'light'
}

function apply(): void {
  if (root.hasAttribute('data-theme-locked')) return
  const next = resolve(themePreference())
  if (next === currentTheme() && root.hasAttribute('data-bs-theme')) return
  root.setAttribute('data-bs-theme', next)
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: next }))
}

function markChoices(): void {
  const pref = themePreference()
  document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach((el) => {
    const active = el.dataset.themeChoice === pref
    el.classList.toggle('active', active)
    el.setAttribute('aria-pressed', String(active))
  })
}

export function setThemePreference(pref: ThemePref): void {
  root.dataset.themePref = pref
  document.cookie = `theme=${pref}; path=/; max-age=${60 * 60 * 24 * 365 * 2}; SameSite=Lax`
  markChoices()
  apply()
}

/** Appelle `fn` à chaque bascule de thème ; renvoie de quoi se désabonner. */
export function onThemeChange(fn: (theme: Theme) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<Theme>).detail)
  window.addEventListener(THEME_EVENT, handler)
  return () => window.removeEventListener(THEME_EVENT, handler)
}

export function installThemeSwitcher(): void {
  markChoices()
  media?.addEventListener?.('change', () => {
    if (themePreference() === 'auto') apply()
  })
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null
    const choice = target?.closest<HTMLElement>('[data-theme-choice]')
    if (choice) {
      // Garde le menu ouvert : on voit la page changer sous ses yeux.
      e.preventDefault()
      e.stopPropagation()
      setThemePreference(choice.dataset.themeChoice as ThemePref)
      return
    }
    if (target?.closest('[data-theme-cycle]')) {
      // Visiteur déconnecté : un seul bouton, clair ↔ sombre.
      setThemePreference(currentTheme() === 'dark' ? 'light' : 'dark')
    }
  })
}
