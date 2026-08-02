import { describe, expect, it } from 'vitest'
import {
  textColorOn, turnIcon, buildTurnChain, turnEta, remainingSeconds, formatDuration,
  arrivalClock, moveLngLat, buildClimbProfile, profileYAt, buildDebugClimb,
  smoothEtaSpeed, arrivalStep, INITIAL_ARRIVAL_STATE,
  turnBanner, turnAlertStep, INITIAL_TURN_ALERT_STATE, TURN_PASSED_M, revealZoomStep,
  navStateFor, resyncOnTurn, turnLabel, turnsNearTap, TURN_TAP_RADIUS_PX,
} from './navHelpers'
import type { ArrivalState, ReachedTurn, TurnAlertState, TurnHint, ClimbInfo } from './navHelpers'
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

describe('resyncOnTurn', () => {
  // Aller-retour : 10 sommets tous les 100 m à l'aller, demi-tour au sommet 10, puis les
  // mêmes 10 sommets à l'envers. Le demi-tour est le virage d'indice 0 de `turns`.
  const cumDistM = Array.from({ length: 21 }, (_, i) => i * 100)
  const turns = [
    turn(1000, { idx: 10, kind: 'uturn' }),
    turn(1500, { idx: 15, direction: 'left' }),
  ]

  it('ancre la projection APRÈS le virage donné pour franchi, et avance le pointeur', () => {
    // C'est cette ancre qui compte : elle sort la fenêtre de recherche de la voie de
    // l'aller (sommets ≤ 10) pour la poser sur celle du retour.
    expect(resyncOnTurn(turns, cumDistM, 0, true)).toEqual({ idx: 11, distAlongM: 1100, nextTurnPtr: 1 })
  })

  it('ancre AVANT le virage donné pour non franchi, et y ramène le pointeur', () => {
    expect(resyncOnTurn(turns, cumDistM, 1, false)).toEqual({ idx: 14, distAlongM: 1400, nextTurnPtr: 1 })
  })

  it('ne sort jamais de la géométrie', () => {
    // Dernier virage donné pour franchi : l'ancre s'arrête au dernier sommet, pas au-delà.
    const last = [turn(2000, { idx: 20 })]
    expect(resyncOnTurn(last, cumDistM, 0, true)).toMatchObject({ idx: 20, distAlongM: 2000 })
    // Virage sur le tout premier sommet, donné pour non franchi.
    const first = [turn(0, { idx: 0 })]
    expect(resyncOnTurn(first, cumDistM, 0, false)).toMatchObject({ idx: 0, distAlongM: 0 })
  })

  it('rend null sur un virage inexistant ou sans géométrie', () => {
    expect(resyncOnTurn(turns, cumDistM, 7, true)).toBeNull()
    expect(resyncOnTurn(turns, [], 0, true)).toBeNull()
  })
})

describe('turnsNearTap', () => {
  // Un aller et un retour qui se superposent à l'écran : virages 1 et 2 au même pixel.
  const projected = [
    { ptr: 0, x: 500, y: 500 },
    { ptr: 1, x: 100, y: 100 },
    { ptr: 2, x: 104, y: 98 },
  ]

  it('ne rend rien pour un tap dans le vide', () => {
    expect(turnsNearTap(projected, { x: 300, y: 300 })).toEqual([])
  })

  it('rend TOUS les virages sous le doigt, du plus proche au plus loin', () => {
    // Deux passages superposés : choisir le plus proche priverait le coureur de l'autre,
    // qui est précisément celui qu'il vient de faire une fois sur deux.
    expect(turnsNearTap(projected, { x: 104, y: 98 })).toEqual([2, 1])
    expect(turnsNearTap(projected, { x: 100, y: 100 })).toEqual([1, 2])
  })

  it('vise bien plus large que la pastille, mais pas au-delà du rayon', () => {
    // 20 px du centre : hors de la pastille (11 px de rayon), dans la zone tactile.
    expect(turnsNearTap([{ ptr: 0, x: 0, y: 0 }], { x: 20, y: 0 })).toEqual([0])
    expect(turnsNearTap([{ ptr: 0, x: 0, y: 0 }], { x: TURN_TAP_RADIUS_PX + 1, y: 0 })).toEqual([])
  })

  it('départage deux virages à distance égale sur leur rang', () => {
    // Sinon l'ordre de la liste dépendrait de l'arrondi flottant, donc du zoom.
    const tied = [{ ptr: 5, x: 10, y: 0 }, { ptr: 3, x: -10, y: 0 }]
    expect(turnsNearTap(tied, { x: 0, y: 0 })).toEqual([3, 5])
  })
})

describe('turnLabel', () => {
  it('nomme la manœuvre, en distinguant demi-tour et rond-point', () => {
    expect(turnLabel({ kind: 'uturn', direction: 'left' })).toEqual({ key: 'routes.turn_uturn' })
    expect(turnLabel({ kind: 'roundabout', direction: 'right', exitNumber: 3 }))
      .toEqual({ key: 'routes.turn_roundabout', params: { exit: 3 } })
    expect(turnLabel({ kind: 'turn', direction: 'left' })).toEqual({ key: 'routes.turn_left' })
    expect(turnLabel({ kind: 'sharp', direction: 'right' })).toEqual({ key: 'routes.turn_right' })
  })

  it('tolère un rond-point sans numéro de sortie', () => {
    // BRouter n'en donne pas toujours ; « sortie 0 » vaut mieux qu'un libellé cassé.
    expect(turnLabel({ kind: 'roundabout', direction: 'right' })).toEqual({ key: 'routes.turn_roundabout', params: { exit: 0 } })
  })
})

describe('turnBanner', () => {
  // Seuils du profil vélo par défaut : « on est dessus » à 15 m, « en grand » à 300 m.
  const NOW = 15
  const HINT = 300
  const next = turn(500, { direction: 'left', kind: 'turn', angle: 80 })
  const follow: TurnHint = { direction: 'right', distM: 40, kind: 'turn', angle: 70, state: 'near' }
  const reached: ReachedTurn = { direction: 'right', kind: 'turn', angle: 70, distM: 480 }

  function banner(over: Partial<Parameters<typeof turnBanner>[0]> = {}) {
    return turnBanner({
      turn: next, distM: 200, chain: [], reached: null, greenActive: false,
      nowM: NOW, hintM: HINT, ...over,
    })
  }

  it('affiche le prochain virage en grand dans la zone d’approche, avec sa rafale', () => {
    const { hint, follow: f } = banner({ distM: 120, chain: [follow] })
    expect(hint).toMatchObject({ state: 'near', distM: 120, direction: 'left', angle: 80 })
    expect(f).toEqual([follow])
  })

  it('reste discret au-delà de la zone d’approche, sans rafale', () => {
    // Une rafale à 2 km ne sert à rien : on ne montre que le virage, en petit.
    const { hint, follow: f } = banner({ distM: HINT + 1, chain: [follow] })
    expect(hint).toMatchObject({ state: 'far', distM: HINT + 1 })
    expect(f).toEqual([])
  })

  it('sur le virage, passe en confirmation verte à distance nulle', () => {
    const { hint, follow: f } = banner({ distM: 10 })
    expect(hint).toMatchObject({ state: 'now', distM: 0, direction: 'left' })
    expect(f).toEqual([])
  })

  it('sur le virage, montre déjà le suivant s’il enchaîne de près', () => {
    // Plus utile qu'un vert sur le virage qu'on est en train de prendre.
    const second: TurnHint = { ...follow, distM: 30 }
    const { hint, follow: f } = banner({ distM: 5, chain: [follow, second] })
    expect(hint).toBe(follow)
    expect(f).toEqual([second])
  })

  it('ne fait pas flasher le vert sur un virage tout juste passé', () => {
    // Fenêtre distM ∈ [−5, 0] : le pointeur n'a pas encore avancé mais un virage suit.
    const { hint } = banner({ distM: -3, chain: [follow] })
    expect(hint).toBe(follow)
  })

  it('maintient en vert le virage franchi quand plus rien ne suit de près', () => {
    const { hint } = banner({ turn: undefined, distM: Infinity, reached, greenActive: true })
    expect(hint).toMatchObject({ state: 'now', distM: 0, direction: 'right', angle: 70 })
  })

  it('donne la priorité au prochain virage sur le maintien vert', () => {
    const { hint } = banner({ distM: 100, reached, greenActive: true })
    expect(hint).toMatchObject({ state: 'near', direction: 'left' })
  })

  it('n’affiche rien en fin de tracé, maintien vert expiré', () => {
    expect(banner({ turn: undefined, distM: Infinity, reached, greenActive: false }))
      .toEqual({ hint: null, follow: [] })
  })

  it('reporte le numéro de sortie d’un rond-point', () => {
    const rp = turn(100, { kind: 'roundabout', exitNumber: 3 })
    expect(banner({ turn: rp, distM: 100 }).hint).toMatchObject({ kind: 'roundabout', exitNumber: 3 })
  })
})

describe('turnAlertStep', () => {
  const ALERT = 200
  const URGENT = 60

  function step(state: TurnAlertState, distM: number, ptr = 0) {
    return turnAlertStep(state, { ptr, distM, alertM: ALERT, urgentM: URGENT })
  }

  it('ne dit rien hors de la zone d’alerte', () => {
    const d = step(INITIAL_TURN_ALERT_STATE, ALERT + 1)
    expect(d.active).toBeNull()
    expect(d.announce).toBe(false)
    expect(d.state).toBe(INITIAL_TURN_ALERT_STATE)      // état inchangé
  })

  it('annonce une fois à l’entrée dans la zone d’alerte', () => {
    const d = step(INITIAL_TURN_ALERT_STATE, ALERT)
    expect(d).toMatchObject({ announce: true, urgentBurst: false, buzzApproach: false, buzzManeuver: true })
    expect(d.active).toEqual({ urgent: false })

    // Fix suivant, toujours dans la zone lointaine : plus rien (la répétition périodique
    // prend le relais via `active`).
    const d2 = step(d.state, 150)
    expect(d2.announce).toBe(false)
    expect(d2.active).toEqual({ urgent: false })
  })

  it('rejoue une annonce à l’entrée en zone proche, avec son propre paquet', () => {
    let d = step(INITIAL_TURN_ALERT_STATE, ALERT)
    d = step(d.state, URGENT)

    expect(d).toMatchObject({ announce: true, urgentBurst: true, buzzApproach: true })
    // La vibration de manœuvre n'appartient qu'à la première détection.
    expect(d.buzzManeuver).toBe(false)
    expect(d.active).toEqual({ urgent: true })

    // On reste dans la zone proche : plus d'annonce ni de buzz.
    const d2 = step(d.state, 30)
    expect(d2).toMatchObject({ announce: false, buzzApproach: false })
    expect(d2.active).toEqual({ urgent: true })
  })

  it('n’annonce qu’une fois un virage apparu déjà en zone proche', () => {
    // Les deux déclencheurs coïncident (virage détecté tard, ou tracé rerouté sous le nez).
    const d = step(INITIAL_TURN_ALERT_STATE, 40)
    expect(d).toMatchObject({ announce: true, urgentBurst: true, buzzApproach: true, buzzManeuver: true })

    const d2 = step(d.state, 20)
    expect(d2.announce).toBe(false)
  })

  it('réarme les annonces au virage suivant', () => {
    const first = step(INITIAL_TURN_ALERT_STATE, 40)
    const second = step(first.state, 180, 1)
    expect(second).toMatchObject({ announce: true, urgentBurst: false, buzzManeuver: true })
  })

  it('tolère quelques mètres derrière soi avant de couper l’alerte', () => {
    // Le snapping fait osciller la projection : on ne coupe pas l'alerte pile au virage.
    const armed = step(INITIAL_TURN_ALERT_STATE, 10)
    expect(step(armed.state, -(TURN_PASSED_M - 1)).active).toEqual({ urgent: true })
    expect(step(armed.state, -(TURN_PASSED_M + 1)).active).toBeNull()
  })

  it('ne dit rien en fin de tracé (plus de virage)', () => {
    expect(step(INITIAL_TURN_ALERT_STATE, Infinity).active).toBeNull()
  })
})

describe('revealZoomStep', () => {
  // Vue de 800 px : bande visée entre 144 px (0,18) et 240 px (0,30) du haut.
  const H = 800
  const base = { h: H, camZoom: 16, minZoom: 12 }

  it('dézoome quand le virage est trop haut à l’écran (ou hors champ)', () => {
    expect(revealZoomStep({ ...base, y: 100, base: 16 })).toBeCloseTo(15.8, 6)
    // Frame après frame, le dézoom se cumule.
    expect(revealZoomStep({ ...base, y: 100, base: 15.8 })).toBeCloseTo(15.6, 6)
  })

  it('resserre vers le zoom du profil quand le virage laisse trop d’espace devant', () => {
    expect(revealZoomStep({ ...base, y: 400, base: 15 })).toBeCloseTo(15.2, 6)
  })

  it('ne bouge pas dans la bande morte (pas d’oscillation)', () => {
    expect(revealZoomStep({ ...base, y: 200, base: 15 })).toBe(15)
    // Bornes de la bande incluses.
    expect(revealZoomStep({ ...base, y: H * 0.18, base: 15 })).toBe(15)
    expect(revealZoomStep({ ...base, y: H * 0.30, base: 15 })).toBe(15)
  })

  it('ne zoome jamais au-delà du zoom du profil', () => {
    // Déjà au zoom du profil et virage bas : on ne resserre pas davantage.
    expect(revealZoomStep({ ...base, y: 700, base: 16 })).toBe(16)
  })

  it('ne descend pas sous le plancher caméra', () => {
    expect(revealZoomStep({ ...base, y: 0, base: 12 })).toBe(12)
    expect(revealZoomStep({ ...base, y: 0, base: 12.1 })).toBe(12)
  })
})

describe('navStateFor', () => {
  const hint: TurnHint = {
    direction: 'left', distM: 128.4, kind: 'turn', angle: -85, state: 'near',
  }
  const base = {
    hasRoute: true,
    hint: null as TurnHint | null,
    turnCoord: null as [number, number] | null,
    offRoute: false,
    arrived: false,
    speedKmh: 27.4,
    remainingM: 18450,
    remainingGainM: 312,
    climb: null as ClimbInfo | null,
    at: 1753790000000,
  }

  it('publie le virage avec sa position', () => {
    // La position est ce qui permet à l'appli de juger l'approche avec son propre
    // GPS quand la page ne parle plus.
    const state = navStateFor({ ...base, hint, turnCoord: [6.63229, 46.52313] })

    expect(state.type).toBe('nav')
    expect(state.at).toBe(1753790000000)
    expect(state.turn).toEqual({
      state: 'near', distM: 128.4, direction: 'left', kind: 'turn',
      exitNumber: null, lat: 46.52313, lng: 6.63229,
    })
    expect(state.speedKmh).toBe(27.4)
    expect(state.remainingM).toBe(18450)
  })

  it('tolère un virage sans position connue', () => {
    const state = navStateFor({ ...base, hint, turnCoord: null })

    expect(state.turn?.lat).toBeNull()
    expect(state.turn?.lng).toBeNull()
    expect(state.turn?.state).toBe('near')
  })

  it('tait le virage hors-trace', () => {
    // Le virage annoncé porte sur un tracé qu'on a quitté : le publier ferait
    // revenir l'appli sur la carte pour une consigne qui ne s'applique plus.
    const state = navStateFor({ ...base, hint, turnCoord: [6.6, 46.5], offRoute: true })

    expect(state.turn).toBeNull()
    expect(state.offRoute).toBe(true)
  })

  it('n’a ni virage ni arrivée en navigation libre', () => {
    const state = navStateFor({
      ...base, hasRoute: false, hint, turnCoord: [6.6, 46.5], arrived: true,
    })

    expect(state.route).toBe(false)
    expect(state.turn).toBeNull()
    expect(state.arrived).toBe(false)
    expect(state.remainingM).toBe(0)
    // La vitesse, elle, garde son sens sans tracé.
    expect(state.speedKmh).toBe(27.4)
  })

  it('résume le col sans son profil', () => {
    // Les segments SVG sont volumineux et statiques pour tout le col : les
    // renvoyer chaque seconde ne servirait à rien.
    const climb = {
      climb: {
        startIdx: 10, endIdx: 90, gain: 780, lengthM: 12400,
        avgGrade: 6.3, category: '2', startKm: 4, endKm: 16.4,
      },
      ratio: 0.42, remainingGainM: 210, segments: [{ d: 'M0,0', color: '#f00' }],
      areaD: 'M0,0 L100,100 Z', posX: 42, posY: 60, topY: 5,
      grade: 6.4, gradeColor: '#f00', gradeText: '#fff',
    } as ClimbInfo

    const state = navStateFor({ ...base, climb })

    expect(state.climb).toEqual({
      ratio: 0.42, remainingGainM: 210, grade: 6.4,
      gain: 780, lengthM: 12400, category: '2',
    })
    expect(JSON.stringify(state)).not.toContain('M0,0')
  })

  it('n’a pas de col hors d’un col', () => {
    expect(navStateFor(base).climb).toBeNull()
  })
})
