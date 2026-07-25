import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useNavDebug, debugModeEnabled, debugTurnScenarios } from './useNavDebug'
import type { NavPoiHint } from './useNavDebug'
import type { TurnHint, ClimbInfo } from '../navHelpers'
import { radarStore } from '../stores/radarStore'

// Le mode débug ne fait que piloter des refs partagées avec le composant : on les
// fabrique ici et on vérifie ce qu'il y écrit. Le son est mocké — on veut savoir qu'il
// est demandé (prévisualisation sonore), pas l'entendre.
vi.mock('../navAudio', () => ({
  playManeuver: vi.fn(),
  playPoi: vi.fn(),
}))
import { playManeuver, playPoi } from '../navAudio'

function setup(over: { turnUrgentM?: number; soundOn?: boolean } = {}) {
  const refs = {
    hasFix: ref(false),
    turnHint: ref<TurnHint | null>(null),
    followTurns: ref<TurnHint[]>([]),
    climbInfo: ref<ClimbInfo | null>(null),
    poiHint: ref<NavPoiHint | null>(null),
    soundOn: ref(over.soundOn ?? false),
  }
  const debug = useNavDebug({
    canDebug: true,
    getTurnUrgentM: () => over.turnUrgentM ?? 150,
    ...refs,
  })
  return { ...refs, debug }
}

beforeEach(() => {
  vi.clearAllMocks()
  radarStore.reset()
})

describe('debugModeEnabled', () => {
  it('s’active pour un compte autorisé', () => {
    expect(debugModeEnabled(true, '')).toBe(true)
  })

  it('s’active via ?debug dans l’URL', () => {
    expect(debugModeEnabled(false, '?debug=1')).toBe(true)
    expect(debugModeEnabled(undefined, '?a=1&debug')).toBe(true)
  })

  it('reste inactif sans autorisation ni paramètre', () => {
    expect(debugModeEnabled(false, '')).toBe(false)
    expect(debugModeEnabled(undefined, '?a=1')).toBe(false)
    expect(debugModeEnabled(false, '?debugger=1')).toBe(false)
  })
})

describe('debugTurnScenarios', () => {
  it('couvre chaque état visuel du bandeau de virage', () => {
    const labels = debugTurnScenarios(150).map((s) => s.label)
    expect(labels).toEqual(['Lointain', 'Approche', 'Urgent', 'Rond-point', 'Rafale', 'Maintenant'])
  })

  it('place le scénario « Urgent » sous le seuil du sport suivi', () => {
    expect(debugTurnScenarios(150).find((s) => s.label === 'Urgent')!.distM).toBe(40)
    // Sport au seuil serré (marche) : on descend avec lui pour rester dans la zone orange.
    expect(debugTurnScenarios(25).find((s) => s.label === 'Urgent')!.distM).toBe(25)
  })
})

describe('cycleDebugTurn', () => {
  it('parcourt les scénarios un par un puis s’éteint', () => {
    const { debug, turnHint, followTurns } = setup()
    const total = debugTurnScenarios(150).length

    for (let i = 0; i < total; i++) {
      debug.cycleDebugTurn()
      expect(debug.dbgTurn.value).toBe(true)
      expect(debug.dbgTurnLabel.value).toBe(debugTurnScenarios(150)[i].label)
    }

    debug.cycleDebugTurn()   // un cran de plus → off
    expect(debug.dbgTurn.value).toBe(false)
    expect(debug.dbgTurnLabel.value).toBeNull()
    expect(turnHint.value).toBeNull()
    expect(followTurns.value).toEqual([])
  })

  it('repart du premier scénario après extinction', () => {
    const { debug } = setup()
    for (let i = 0; i < debugTurnScenarios(150).length + 1; i++) debug.cycleDebugTurn()

    debug.cycleDebugTurn()
    expect(debug.dbgTurnLabel.value).toBe('Lointain')
  })

  it('remplit le bandeau avec le scénario courant', () => {
    const { debug, turnHint, hasFix } = setup()
    debug.cycleDebugTurn()

    expect(hasFix.value).toBe(true)   // sans fix, l'overlay ne serait pas rendu
    expect(turnHint.value).toEqual({
      direction: 'right', distM: 850, kind: 'turn', angle: 60, exitNumber: undefined, state: 'far',
    })
  })

  it('installe les virages secondaires du scénario « Rafale », et seulement lui', () => {
    const { debug, followTurns } = setup()
    const burstIdx = debugTurnScenarios(150).findIndex((s) => s.label === 'Rafale')

    for (let i = 0; i <= burstIdx; i++) debug.cycleDebugTurn()
    expect(followTurns.value).toHaveLength(2)

    debug.cycleDebugTurn()   // « Maintenant » : plus de rafale
    expect(followTurns.value).toEqual([])
  })

  it('joue le bip du virage seulement si le son est actif', () => {
    const muet = setup({ soundOn: false })
    muet.debug.cycleDebugTurn()
    expect(playManeuver).not.toHaveBeenCalled()

    const sonore = setup({ soundOn: true })
    sonore.debug.cycleDebugTurn()
    expect(playManeuver).toHaveBeenCalledWith('turn', 'right')
  })
})

describe('toggleDebugClimb', () => {
  it('injecte puis retire la carte de col', () => {
    const { debug, climbInfo, hasFix } = setup()

    debug.toggleDebugClimb()
    expect(debug.dbgClimb.value).toBe(true)
    expect(hasFix.value).toBe(true)
    expect(climbInfo.value?.segments.length).toBeGreaterThan(0)

    debug.toggleDebugClimb()
    expect(debug.dbgClimb.value).toBe(false)
    expect(climbInfo.value).toBeNull()
  })
})

describe('toggleDebugPoi', () => {
  it('épingle puis retire le bandeau POI', () => {
    const { debug, poiHint, hasFix } = setup()

    debug.toggleDebugPoi()
    expect(debug.dbgPoi.value).toBe(true)
    expect(hasFix.value).toBe(true)
    expect(poiHint.value).toMatchObject({ name: 'Boulangerie du Col', distM: 80 })
    expect(poiHint.value?.icon).toBeTruthy()

    debug.toggleDebugPoi()
    expect(debug.dbgPoi.value).toBe(false)
    expect(poiHint.value).toBeNull()
  })

  it('joue la ritournelle POI seulement si le son est actif', () => {
    setup({ soundOn: false }).debug.toggleDebugPoi()
    expect(playPoi).not.toHaveBeenCalled()

    setup({ soundOn: true }).debug.toggleDebugPoi()
    expect(playPoi).toHaveBeenCalledOnce()
  })
})

describe('toggleDebugRadar', () => {
  it('simule une connexion radar avec deux véhicules', () => {
    const { debug } = setup()

    debug.toggleDebugRadar()
    expect(debug.dbgRadar.value).toBe(true)
    expect(radarStore.isConnected.value).toBe(true)
    expect(radarStore.threatCount.value).toBe(2)
    // Le store trie du plus proche au plus lointain : la voiture rapprochée passe devant.
    expect(radarStore.nearest.value?.distanceM).toBe(18)
  })

  it('remet le store à zéro en sortant', () => {
    const { debug } = setup()
    debug.toggleDebugRadar()
    debug.toggleDebugRadar()

    expect(debug.dbgRadar.value).toBe(false)
    expect(radarStore.isConnected.value).toBe(false)
    expect(radarStore.threatCount.value).toBe(0)
  })
})
