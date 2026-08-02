import { describe, expect, it } from 'vitest'
import { computeElevGain, elevGainOptions } from './activityHelpers'

// `computeElevGain` sert deux origines d'altitude aux défauts opposés : le flux d'un
// compteur (déjà purgé de ses pauses, sans discontinuité) et le `.fit` brut d'un
// téléphone (baromètre non calibré, points de pause conservés). Les cas ci-dessous
// reproduisent les deux artefacts mesurés sur une sortie enregistrée en parallèle par
// les deux — voir le commentaire de la fonction.
//
// Les seuils sont des encadrements et non des égalités : la moyenne glissante rogne
// les extrémités: une rampe de n mètres en ressort à n-2·pente, parce que les
// premiers et derniers points sont moyennés avec un voisinage tronqué. C'est le prix
// du lissage, et il est le même avec ou sans les options ajoutées ici.

// Une trace à 1 Hz : altitudes fournies, distance qui avance de `speed` m/s.
function ride(alts: (number | null)[], speed = 8) {
  return {
    time: { data: alts.map((_, i) => i) },
    distance: { data: alts.map((_, i) => i * speed) },
  }
}

// Rampe de 1 m/s : `n` points de `from` à `from + n - 1`.
function climb(from = 0, n = 100) {
  return Array.from({ length: n }, (_, i) => from + i)
}

describe('computeElevGain — comportement de base', () => {
  it('accumule les montées et les descentes séparément', () => {
    const alts = [...climb(0, 51), ...climb(0, 51).reverse()]
    const { gain, loss } = computeElevGain(alts)
    expect(gain).toBeGreaterThan(47)
    expect(gain).toBeLessThanOrEqual(50)
    expect(loss).toBeCloseTo(gain, 1)
  })

  it('divise le bruit de quantification au lieu de le compter', () => {
    // Plat parfait bruité de ±0,5 m une seconde sur deux : rien n'a été gravi.
    const alts = Array.from({ length: 200 }, (_, i) => 500 + (i % 2 ? 0.5 : -0.5))
    const brut = alts.reduce((s, v, i) => (i && v > alts[i - 1] ? s + v - alts[i - 1] : s), 0)
    expect(brut).toBeCloseTo(100, 0)
    // La fenêtre de 5 points (halfWin=2) ramène le bruit d'un facteur 5 — elle ne
    // l'annule pas, d'où les options ci-dessous pour les artefacts qui en réchappent.
    expect(computeElevGain(alts).gain).toBeLessThan(brut / 4)
  })

  it('reste inerte sans les flux voisins', () => {
    const alts = climb(0, 101)
    expect(computeElevGain(alts, elevGainOptions(null)).gain).toBeCloseTo(computeElevGain(alts).gain, 5)
  })
})

describe('computeElevGain — marche de calibration (maxVerticalSpeed)', () => {
  // Les premières secondes en altitude GPS, puis le baromètre prend le relais : sur
  // la sortie de référence, 923,8 m → 1039,2 m en une seconde, soit 115 m de D+ fictif.
  const withStep = [...Array(20).fill(920), ...climb(1035, 100)]

  it('compte la marche sans l’option', () => {
    expect(computeElevGain(withStep).gain).toBeGreaterThan(200)
  })

  it('la gomme sans toucher au relief qui l’entoure', () => {
    // Reste la rampe de 99 m, aux extrémités rognées près.
    const { gain } = computeElevGain(withStep, elevGainOptions(ride(withStep)))
    expect(gain).toBeGreaterThan(95)
    expect(gain).toBeLessThanOrEqual(99)
  })

  it('laisse passer une vraie descente rapide', () => {
    // -3 m/s : une descente de col à 60 km/h dans du -18 %, sous le plafond de 5 m/s.
    // Rien ne doit être écrêté : les 297 m sont perdus pour de vrai.
    const dive = Array.from({ length: 100 }, (_, i) => 1500 - i * 3)
    const { loss } = computeElevGain(dive, elevGainOptions(ride(dive, 17)))
    expect(loss).toBeGreaterThan(285)
    expect(loss).toBeLessThanOrEqual(297)
  })

  it('mesure l’écart sur des échantillons espacés, pas sur des indices', () => {
    // Enregistrement coupé 10 min : +200 m par-dessus ce trou est du relief, pas une
    // marche. Le seuil étant une vitesse, il s'élargit avec la durée du trou.
    const alts = [...climb(500, 30), ...climb(700, 30)]
    const time = { data: [...Array.from({ length: 30 }, (_, i) => i), ...Array.from({ length: 30 }, (_, i) => 630 + i)] }
    const distance = { data: alts.map((_, i) => i * 8) }
    expect(computeElevGain(alts, elevGainOptions({ time, distance })).gain).toBeGreaterThan(190)
  })
})

describe('computeElevGain — dérive à l’arrêt (skipStationary)', () => {
  // 754 arrêts et 58 min immobiles sur la sortie de référence : le baromètre respire
  // (vent, soleil sur l’appareil) et chaque oscillation vers le haut était comptée.
  const drift = Array.from({ length: 600 }, (_, i) => 500 + Math.sin(i / 3) * 2)

  it('compte la dérive sans l’option', () => {
    expect(computeElevGain(drift).gain).toBeGreaterThan(100)
  })

  it('ne l’accumule pas quand la distance n’avance pas', () => {
    const stopped = { time: { data: drift.map((_, i) => i) }, distance: { data: drift.map(() => 4200) } }
    expect(computeElevGain(drift, elevGainOptions(stopped)).gain).toBe(0)
  })

  it('ne reporte pas la dérive d’un bloc à la reprise', () => {
    // Arrêt de 30 s pendant lequel l’altimètre dérive de +30 m, puis on repart et on
    // grimpe 50 m pour de vrai. Seuls ces 50 m doivent compter.
    const alts = [...Array(20).fill(500), ...climb(500, 31), ...climb(530, 51)]
    const distance = [
      ...Array.from({ length: 20 }, (_, i) => i * 8),
      ...Array(31).fill(152),
      ...Array.from({ length: 51 }, (_, i) => 152 + i * 8),
    ]
    const time = alts.map((_, i) => i)
    const { gain } = computeElevGain(alts, elevGainOptions({ time: { data: time }, distance: { data: distance } }))
    expect(gain).toBeGreaterThan(45)
    expect(gain).toBeLessThan(55)
  })

  it('ne prend pas un compteur qui recule pour un arrêt', () => {
    const alts = climb(500, 60)
    const distance = alts.map((_, i) => (i === 30 ? 0 : i * 8))
    const { gain } = computeElevGain(alts, elevGainOptions({ time: { data: alts.map((_, i) => i) }, distance: { data: distance } }))
    expect(gain).toBeGreaterThan(55)
  })
})

describe('elevGainOptions — tranches', () => {
  it('découpe les flux voisins comme l’appelant découpe les altitudes', () => {
    // Sans découpe alignée, la distance lue en face de chaque altitude serait décalée
    // de 50 échantillons et la sélection passerait pour immobile.
    const alts = [...Array(50).fill(500), ...climb(500, 50)]
    const streams = ride(alts)
    const full = computeElevGain(alts, elevGainOptions(streams))
    const half = computeElevGain(alts.slice(50), elevGainOptions(streams, 50))
    expect(half.gain).toBeGreaterThan(full.gain - 2)
    expect(half.gain).toBeLessThanOrEqual(full.gain)
  })
})
