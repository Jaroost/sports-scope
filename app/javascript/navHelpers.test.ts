import { describe, expect, it } from 'vitest'
import {
  textColorOn, turnIcon, buildTurnChain, turnEta, remainingSeconds, formatDuration,
  arrivalClock, moveLngLat, buildClimbProfile, profileYAt, buildDebugClimb,
  smoothEtaSpeed, arrivalStep, INITIAL_ARRIVAL_STATE,
} from './navHelpers'
import type { ArrivalState } from './navHelpers'
import type { TurnPoint, Climb } from './routeHelpers'
import { ARRIVAL_M, ARRIVAL_APPROACH_M } from './navConstants'

// Helpers purs de la navigation : couleurs, icônes, ETA, géométrie et profil de col.
// Tout est sans état ni dépendance à MapLibre — testable directement.

function turn(distM: number, over: Partial<TurnPoint> = {}): TurnPoint {
  return { idx: 0, distM, angle: 60, direction: 'right', kind: 'turn', ...over }
}

describe('textColorOn', () => {
  it('écrit en sombre sur un fond clair et en blanc sur un fond sombre', () => {
    expect(textColorOn('#ffffff')).toBe('#111827')
    expect(textColorOn('#000000')).toBe('#ffffff')
  })

  it('suit la luminance perçue, pas la somme des canaux', () => {
    // Mêmes canaux (255 + 51), mais dominés par le vert (coef. 0,587) d'un côté et par
    // le bleu (0,114) de l'autre : seul le vert dépasse le seuil.
    expect(textColorOn('#00ff33')).toBe('#111827')
    expect(textColorOn('#3300ff')).toBe('#ffffff')
    // Le vert pur reste juste sous le seuil (0,587 × 255 = 149,7 ≤ 150).
    expect(textColorOn('#00ff00')).toBe('#ffffff')
  })

  it('accepte une couleur sans dièse', () => {
    expect(textColorOn('ffffff')).toBe('#111827')
  })
})

describe('turnIcon', () => {
  it('distingue ronds-points et demi-tours des virages simples', () => {
    expect(turnIcon({ direction: 'left', kind: 'roundabout', angle: 90 })).toBe('fa-rotate-left')
    expect(turnIcon({ direction: 'right', kind: 'roundabout', angle: 90 })).toBe('fa-rotate-right')
    expect(turnIcon({ direction: 'left', kind: 'uturn', angle: 180 })).toBe('fa-arrow-down')
  })

  it('affiche « tout droit » quand la déviation est négligeable', () => {
    expect(turnIcon({ direction: 'right', kind: 'turn', angle: 19 })).toBe('fa-arrow-up')
    expect(turnIcon({ direction: 'right', kind: 'turn', angle: -19 })).toBe('fa-arrow-up')
    expect(turnIcon({ direction: 'right', kind: 'turn', angle: 20 })).toBe('fa-arrow-right')
    expect(turnIcon({ direction: 'left', kind: 'turn', angle: -45 })).toBe('fa-arrow-left')
  })
})

describe('buildTurnChain', () => {
  it('enchaîne les virages suivants tant qu’ils sont rapprochés', () => {
    const turns = [turn(100), turn(160), turn(200), turn(600)]
    const chain = buildTurnChain(turns, 0, 50, 100, 4)

    // Le virage pointé (100 m) n’est pas inclus ; les distances sont relatives à `here`.
    expect(chain.map((h) => h.distM)).toEqual([110, 150])
    expect(chain.every((h) => h.state === 'near')).toBe(true)
  })

  it('s’arrête au premier écart supérieur à gapM', () => {
    const turns = [turn(100), turn(400), turn(450)]
    expect(buildTurnChain(turns, 0, 0, 100, 4)).toEqual([])
  })

  it('plafonne le total à max virages (donc max − 1 suivants)', () => {
    const turns = [turn(100), turn(150), turn(200), turn(250), turn(300)]
    expect(buildTurnChain(turns, 0, 0, 100, 3)).toHaveLength(2)
  })

  it('renvoie une liste vide pour un pointeur hors bornes', () => {
    const turns = [turn(100)]
    expect(buildTurnChain(turns, -1, 0, 100, 4)).toEqual([])
    expect(buildTurnChain(turns, 1, 0, 100, 4)).toEqual([])
  })

  it('recopie le numéro de sortie des ronds-points', () => {
    const turns = [turn(100), turn(150, { kind: 'roundabout', exitNumber: 3 })]
    expect(buildTurnChain(turns, 0, 0, 100, 4)[0].exitNumber).toBe(3)
  })
})

describe('turnEta / remainingSeconds', () => {
  it('renvoie null à l’arrêt (sous 1 km/h)', () => {
    expect(turnEta(500, 0)).toBeNull()
    expect(turnEta(500, 0.9)).toBeNull()
    expect(remainingSeconds(500, 0)).toBeNull()
  })

  it('affiche les secondes en deçà d’une minute', () => {
    expect(turnEta(100, 36)).toBe('10 s')   // 36 km/h = 10 m/s
  })

  it('passe au format m:ss au-delà d’une minute', () => {
    expect(turnEta(1000, 36)).toBe('1:40')
    expect(turnEta(650, 36)).toBe('1:05')   // secondes sur deux chiffres
  })

  it('remainingSeconds convertit distance et vitesse sans arrondi', () => {
    expect(remainingSeconds(1000, 36)).toBeCloseTo(100, 6)
  })
})

describe('formatDuration', () => {
  it('reste en minutes en deçà d’une heure', () => {
    expect(formatDuration(0)).toBe('0 min')
    expect(formatDuration(720)).toBe('12 min')
    expect(formatDuration(-60)).toBe('0 min')   // jamais de durée négative
  })

  it('passe en heures + minutes sur deux chiffres au-delà', () => {
    expect(formatDuration(3600)).toBe('1 h 00')
    expect(formatDuration(3900)).toBe('1 h 05')
    expect(formatDuration(7200)).toBe('2 h 00')
  })
})

describe('arrivalClock', () => {
  it('ajoute la durée à l’heure courante, minutes sur deux chiffres', () => {
    const now = new Date(2026, 6, 25, 14, 0, 0)
    expect(arrivalClock(1920, now)).toBe('14:32')
    expect(arrivalClock(300, now)).toBe('14:05')
  })

  it('passe correctement à l’heure suivante', () => {
    expect(arrivalClock(3600, new Date(2026, 6, 25, 23, 30, 0))).toBe('0:30')
  })
})

describe('moveLngLat', () => {
  it('avance vers le nord sans changer la longitude', () => {
    const [lng, lat] = moveLngLat([6.5, 46.5], 0, 1000)
    expect(lng).toBeCloseTo(6.5, 9)
    expect(lat).toBeCloseTo(46.5 + 0.008993, 5)   // 1 km ≈ 0,009° de latitude
  })

  it('avance vers l’est sans changer la latitude', () => {
    const [lng, lat] = moveLngLat([6.5, 0], 90, 1000)
    expect(lat).toBeCloseTo(0, 9)
    expect(lng).toBeCloseTo(6.5 + 0.008993, 5)    // à l’équateur, même écart qu’en latitude
  })

  it('élargit le pas en longitude avec la latitude (convergence des méridiens)', () => {
    const near = moveLngLat([6.5, 0], 90, 1000)[0] - 6.5
    const far = moveLngLat([6.5, 60], 90, 1000)[0] - 6.5
    expect(far).toBeCloseTo(near * 2, 4)          // cos(60°) = 0,5
  })

  it('un aller-retour revient au point de départ', () => {
    const there = moveLngLat([6.5, 46.5], 45, 500)
    const back = moveLngLat(there, 225, 500)
    expect(back[0]).toBeCloseTo(6.5, 6)
    expect(back[1]).toBeCloseTo(46.5, 6)
  })
})

describe('profileYAt', () => {
  const pts = [{ x: 0, y: 100 }, { x: 50, y: 50 }, { x: 100, y: 20 }]

  it('interpole entre deux points', () => {
    expect(profileYAt(pts, 25)).toBeCloseTo(75, 6)
    expect(profileYAt(pts, 75)).toBeCloseTo(35, 6)
  })

  it('rend la valeur exacte sur un point', () => {
    expect(profileYAt(pts, 0)).toBe(100)
    expect(profileYAt(pts, 50)).toBe(50)
  })

  it('sature au dernier point au-delà de la plage', () => {
    expect(profileYAt(pts, 200)).toBe(20)
  })

  it('renvoie le bas du cadre sans aucun point', () => {
    expect(profileYAt([], 50)).toBe(100)
  })
})

describe('buildClimbProfile', () => {
  const climb: Climb = {
    startIdx: 0, endIdx: 4, gain: 100, lengthM: 4000,
    avgGrade: 2.5, category: '4', startKm: 0, endKm: 4,
  }
  const alts = [500, 525, 550, 575, 600]
  const cum = [0, 1000, 2000, 3000, 4000]

  it('normalise la distance sur toute la largeur du viewBox', () => {
    const { pts } = buildClimbProfile(climb, alts, cum)
    expect(pts).toHaveLength(5)
    expect(pts[0].x).toBe(0)
    expect(pts[4].x).toBe(100)
  })

  it('met le sommet en haut et le départ en bas (y inversé)', () => {
    const { pts, topY } = buildClimbProfile(climb, alts, cum)
    expect(pts[0].y).toBe(96)          // altitude minimale → bas du cadre
    expect(pts[4].y).toBe(8)           // altitude maximale → 96 − 88
    expect(topY).toBe(8)
    expect(pts.map((p) => p.y)).toEqual([...pts.map((p) => p.y)].sort((a, b) => b - a))
  })

  it('produit un segment par intervalle et une aire fermée', () => {
    const { segments, areaD } = buildClimbProfile(climb, alts, cum)
    expect(segments).toHaveLength(4)
    expect(segments.every((s) => s.color.startsWith('#'))).toBe(true)
    expect(areaD.startsWith('M0,100')).toBe(true)
    expect(areaD.endsWith('L100,100 Z')).toBe(true)
  })

  it('ne divise pas par zéro sur un col plat ou de longueur nulle', () => {
    const flat = buildClimbProfile(climb, [500, 500, 500, 500, 500], cum)
    expect(flat.pts.every((p) => Number.isFinite(p.y))).toBe(true)

    const zeroLen = buildClimbProfile(climb, alts, [0, 0, 0, 0, 0])
    expect(zeroLen.pts.every((p) => Number.isFinite(p.x))).toBe(true)
  })

  it('traite une altitude manquante comme zéro', () => {
    const { pts } = buildClimbProfile(climb, [500, null, 550, 575, 600], cum)
    expect(pts.every((p) => Number.isFinite(p.y))).toBe(true)
  })
})

describe('buildDebugClimb', () => {
  it('produit un profil factice complet et cohérent', () => {
    const info = buildDebugClimb()

    expect(info.segments).toHaveLength(28)
    expect(info.posX).toBeCloseTo(42, 6)
    expect(info.topY).toBe(6)                                  // 96 − 90 au sommet
    expect(info.remainingGainM).toBeCloseTo(info.climb.gain * 0.58, 6)
    // Le curseur est posé sur la ligne d'altitude : entre le sommet et le bas du cadre,
    // et plus haut que le départ puisqu'on est à 42 % de la montée.
    expect(info.posY).toBeGreaterThan(info.topY)
    expect(info.posY).toBeLessThan(96)
    expect(['#111827', '#ffffff']).toContain(info.gradeText)
  })
})

describe('smoothEtaSpeed', () => {
  it('s’amorce sur la première vitesse exploitable (sans rampe depuis zéro)', () => {
    expect(smoothEtaSpeed(0, 28)).toBe(28)
  })

  it('ignore les arrêts et les allures de marche à pied', () => {
    // Feu rouge : la moyenne de l'ETA ne s'effondre pas.
    expect(smoothEtaSpeed(28, 0)).toBe(28)
    expect(smoothEtaSpeed(28, 3)).toBe(28)
  })

  it('converge lentement vers la vitesse courante', () => {
    const once = smoothEtaSpeed(20, 30)
    expect(once).toBeCloseTo(20.5, 6)          // 5 % de l'écart

    // Une accélération durable finit par être prise en compte, sans à-coup.
    let avg = 20
    for (let i = 0; i < 100; i++) avg = smoothEtaSpeed(avg, 30)
    expect(avg).toBeGreaterThan(29)
    expect(avg).toBeLessThan(30)
  })
})

describe('arrivalStep', () => {
  // Suite de fixes : chaque distance restante est passée à la machine, qui porte son état.
  // `onRoute` par défaut, car hors-tracé la progression n'est pas fiable.
  function run(remainings: number[], opts: { onRoute?: (i: number) => boolean } = {}) {
    let state: ArrivalState = INITIAL_ARRIVAL_STATE
    let arrived = false
    const arrivedAt: number[] = []
    remainings.forEach((remainingM, i) => {
      const step = arrivalStep(state, {
        remainingM,
        hasRoute: true,
        onRoute: opts.onRoute ? opts.onRoute(i) : true,
        arrived,
      })
      state = { seenEnRoute: step.seenEnRoute, lastRemainingM: step.lastRemainingM }
      if (step.justArrived) { arrived = true; arrivedAt.push(i) }
    })
    return { state, arrived, arrivedAt }
  }

  it('annonce l’arrivée après une approche progressive', () => {
    const { arrived, arrivedAt } = run([5000, 2000, 400, 200, 60, 10])
    expect(arrived).toBe(true)
    expect(arrivedAt).toEqual([5])            // au fix qui passe sous le seuil
  })

  it('n’annonce qu’une fois', () => {
    const { arrivedAt } = run([5000, 200, 10, 8, 5])
    expect(arrivedAt).toEqual([2])
  })

  it('n’annonce pas au premier fix d’un tracé minuscule', () => {
    // Jamais été en route : un tracé de 20 m ne doit pas s'annoncer arrivé d'emblée.
    const { arrived, state } = run([20, 15, 10])
    expect(arrived).toBe(false)
    expect(state.seenEnRoute).toBe(false)
  })

  it('n’annonce pas sur un saut brutal du restant (changement de passage)', () => {
    // Boucle dont l'arrivée frôle le départ : la projection saute de 30 km à 10 m.
    const { arrived } = run([30000, 29000, 10])
    expect(arrived).toBe(false)
  })

  it('accepte un trou GPS dès que le fix suivant confirme', () => {
    // Le saut n'annonce rien, mais le fix d'après (précédent déjà proche) le fait.
    const { arrived, arrivedAt } = run([30000, 29000, 10, 8])
    expect(arrived).toBe(true)
    expect(arrivedAt).toEqual([3])
  })

  it('n’annonce pas hors-tracé, et ne retient pas sa distance comme référence', () => {
    // Fix 2 hors-tracé à 10 m : pas d'annonce, et sa distance n'arme pas l'approche —
    // le fix 3, sur le tracé, part donc encore de la référence de 2000 m.
    const { arrived } = run([5000, 2000, 10, 10], { onRoute: (i) => i !== 2 })
    expect(arrived).toBe(false)
  })

  it('exige d’avoir été franchement en route, pas juste au bord de la zone', () => {
    // Osciller autour du seuil d'arrivée n'arme pas la détection.
    const { state } = run([ARRIVAL_M + 10, ARRIVAL_M + 20, ARRIVAL_M + 40])
    expect(state.seenEnRoute).toBe(false)
    // Franchir la marge, si.
    expect(run([ARRIVAL_M + 60]).state.seenEnRoute).toBe(true)
  })

  it('garde la fenêtre d’approche à ARRIVAL_APPROACH_M', () => {
    // Restant précédent juste au-delà de la fenêtre : pas encore d'annonce…
    expect(run([5000, ARRIVAL_M + ARRIVAL_APPROACH_M + 1, 5]).arrived).toBe(false)
    // … juste dedans : oui.
    expect(run([5000, ARRIVAL_M + ARRIVAL_APPROACH_M, 5]).arrived).toBe(true)
  })

  it('sans tracé, ne s’arme jamais (navigation libre)', () => {
    const step = arrivalStep(INITIAL_ARRIVAL_STATE, {
      remainingM: 0, hasRoute: false, onRoute: true, arrived: false,
    })
    expect(step.seenEnRoute).toBe(false)
    expect(step.justArrived).toBe(false)
  })

  it('ne mute pas l’état qu’on lui passe', () => {
    const state: ArrivalState = { seenEnRoute: false, lastRemainingM: 100 }
    arrivalStep(state, { remainingM: 5000, hasRoute: true, onRoute: true, arrived: false })
    expect(state).toEqual({ seenEnRoute: false, lastRemainingM: 100 })
    expect(INITIAL_ARRIVAL_STATE).toEqual({ seenEnRoute: false, lastRemainingM: null })
  })
})
