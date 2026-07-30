import { describe, expect, it } from 'vitest'
import { peakPowerCurve, PEAK_POWER_DURATIONS, POWER_CURVE_DURATIONS } from './activityHelpers'

// `peakPowerCurve` alimente à la fois le tableau des meilleures puissances moyennes
// (durées standard) et les deux courbes de puissance de l'analyse d'activité (grille
// dense). Elle intègre l'énergie plutôt que de moyenner les échantillons : c'est ce
// qui la rend juste quand la cadence d'échantillonnage n'est pas régulière.

function streamsOf(times: number[], watts: (number | null)[]) {
  return { time: { data: times }, watts: { data: watts } }
}

// Une minute à 100 W, puis une minute à 300 W (échantillonnage 1 Hz).
function twoBlocks() {
  const times: number[] = []
  const watts: number[] = []
  for (let s = 0; s <= 120; s++) {
    times.push(s)
    watts.push(s < 60 ? 100 : 300)
  }
  return streamsOf(times, watts)
}

describe('peakPowerCurve', () => {
  it('prend la meilleure fenêtre glissante, pas la première', () => {
    const curve = peakPowerCurve(twoBlocks(), [60])
    expect(curve).toHaveLength(1)
    expect(Math.round(curve[0].avgPower)).toBe(300)
    // La fenêtre retenue est bien le second bloc.
    expect(curve[0].startIdx).toBe(60)
    expect(curve[0].endIdx).toBe(120)
  })

  it('moyenne sur la fenêtre demandée (120 s = les deux blocs)', () => {
    const curve = peakPowerCurve(twoBlocks(), [120])
    expect(Math.round(curve[0].avgPower)).toBe(200)
  })

  it('s’arrête aux durées plus longues que l’activité', () => {
    const curve = peakPowerCurve(twoBlocks(), [60, 120, 300, 600])
    expect(curve.map((p) => p.duration)).toEqual([60, 120])
  })

  it('intègre le temps réel : un trou d’échantillonnage ne gonfle pas la moyenne', () => {
    // 0→30 s à 100 W puis un saut de 30 s (un seul échantillon à 400 W couvrant
    // la trouée) : la moyenne 60 s doit rester pondérée par le temps.
    const streams = streamsOf([0, 30, 60], [100, 400, 400])
    const curve = peakPowerCurve(streams, [60])
    // E = 100*30 + 400*30 = 15 000 J sur 60 s → 250 W.
    expect(Math.round(curve[0].avgPower)).toBe(250)
  })

  it('traite les trous de puissance comme des zéros', () => {
    const times = Array.from({ length: 61 }, (_, i) => i)
    const watts = times.map((_, i) => (i < 30 ? 200 : null))
    const curve = peakPowerCurve(streamsOf(times, watts), [60])
    expect(Math.round(curve[0].avgPower)).toBe(100)
  })

  it('rend un tableau vide sans flux de puissance exploitable', () => {
    expect(peakPowerCurve(null)).toEqual([])
    expect(peakPowerCurve(streamsOf([0, 1, 2], []))).toEqual([])
    expect(peakPowerCurve(streamsOf([0], [250]))).toEqual([])
    // Que des zéros : aucune durée n'a de puissance positive à montrer.
    expect(peakPowerCurve(streamsOf([0, 30, 60], [0, 0, 0]), [60])).toEqual([])
  })

  it('rend une courbe décroissante sur la grille dense', () => {
    // Sortie synthétique : sprint de 10 s à 800 W au milieu d'un fond à 200 W.
    const times = Array.from({ length: 601 }, (_, i) => i)
    const watts = times.map((_, i) => (i >= 300 && i < 310 ? 800 : 200))
    const curve = peakPowerCurve(streamsOf(times, watts), POWER_CURVE_DURATIONS)
    expect(curve.length).toBeGreaterThan(10)
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].avgPower).toBeLessThanOrEqual(curve[i - 1].avgPower + 1e-9)
    }
    expect(Math.round(curve[0].avgPower)).toBe(800)
  })

  // La courbe tracée couvre la même fenêtre que le tableau : 5 s → 1 h 30.
  it('borne la grille dense aux durées du tableau', () => {
    expect(POWER_CURVE_DURATIONS[0]).toBe(PEAK_POWER_DURATIONS[0])
    expect(POWER_CURVE_DURATIONS[POWER_CURVE_DURATIONS.length - 1])
      .toBe(PEAK_POWER_DURATIONS[PEAK_POWER_DURATIONS.length - 1])
    // Toutes les durées de référence sont sur la grille : les deux courbes du
    // graphique se posent sur les mêmes graduations, sans trou artificiel.
    PEAK_POWER_DURATIONS.forEach((d) => expect(POWER_CURVE_DURATIONS).toContain(d))
  })

  it('utilise les durées standard par défaut', () => {
    const times = Array.from({ length: 121 }, (_, i) => i)
    const curve = peakPowerCurve(streamsOf(times, times.map(() => 250)))
    expect(curve.map((p) => p.duration))
      .toEqual(PEAK_POWER_DURATIONS.filter((d) => d <= 120))
  })
})
