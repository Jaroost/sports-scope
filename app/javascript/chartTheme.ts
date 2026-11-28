// Couleurs de Chart.js (textes, axes, grilles) calées sur le thème clair / sombre.
// Chart.js est chargé à la demande par chaque composant : celui-ci appelle
// `themeChart(Chart)` juste après l'import. Les options non surchargées par un
// graphique se résolvent sur `Chart.defaults` à chaque `update()`, d'où la mise à
// jour de toutes les instances vivantes lors d'une bascule.
import type { Chart as ChartType } from 'chart.js'
import { currentTheme, onThemeChange, type Theme } from './theme'

let installed = false

function paint(Chart: typeof ChartType, theme: Theme): void {
  const dark = theme === 'dark'
  Chart.defaults.color = dark ? '#adb5bd' : '#666'
  Chart.defaults.borderColor = dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'
}

export function themeChart(Chart: typeof ChartType): void {
  if (installed) return
  installed = true
  paint(Chart, currentTheme())
  onThemeChange((theme) => {
    paint(Chart, theme)
    Object.values(Chart.instances).forEach((c) => c.update('none'))
  })
}
