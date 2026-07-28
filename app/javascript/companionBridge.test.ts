// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installCompanionBridge, inCompanionApp, revealCompanionLinks, companionScreen } from './companionBridge'
import { companionStore } from './stores/companionStore'
import { radarStore } from './stores/radarStore'

// Le pont installe une fonction globale que l'application mobile appelle depuis son
// WebView. Les tests jouent le rôle de l'appli : ils poussent des charges utiles et
// vérifient ce qui arrive dans les stores.
function push(payload: unknown): void {
  ;(window as any).sportsScopeCompanion.push(payload)
}

// Simule le canal injecté par le WebView de l'appli, et retient ce que la page
// lui envoie.
function fakeChannel(): string[] {
  const sent: string[] = []
  ;(window as any).SportsScopeCompanion = { postMessage: (m: string) => sent.push(m) }
  return sent
}

describe('companionBridge', () => {
  beforeEach(() => {
    companionStore.reset()
    radarStore.reset()
    delete (window as any).SportsScopeCompanion
    delete (window as any).sportsScopeCompanion
    installCompanionBridge()
  })

  afterEach(() => {
    delete (window as any).SportsScopeCompanion
    delete (window as any).sportsScopeCompanion
  })

  it('expose le pont même hors de l\'appli', () => {
    // Installé partout : la page ne sait pas d'avance où elle tourne, et un
    // navigateur ordinaire n'appellera simplement jamais la fonction.
    expect(typeof (window as any).sportsScopeCompanion.push).toBe('function')
    expect(inCompanionApp()).toBe(false)
  })

  it('détecte l\'appli à la présence du canal injecté', () => {
    fakeChannel()
    expect(inCompanionApp()).toBe(true)
  })

  it('range les mesures dans le store', () => {
    push({ heartRate: 148, power: 237, cadence: 91.4 })

    expect(companionStore.present.value).toBe(true)
    expect(companionStore.heartRate.value).toBe(148)
    expect(companionStore.power.value).toBe(237)
    expect(companionStore.cadence.value).toBe(91.4)
    expect(companionStore.hasValues.value).toBe(true)
  })

  it('efface une mesure absente du message suivant', () => {
    // L'appli envoie toujours un état complet : un capteur débranché disparaît
    // de la charge utile et doit disparaître de l'écran, pas rester figé.
    push({ heartRate: 148, power: 237 })
    push({ heartRate: 150 })

    expect(companionStore.heartRate.value).toBe(150)
    expect(companionStore.power.value).toBeNull()
  })

  it('transmet les vitesses avec leurs dents', () => {
    push({ gears: { front: 2, rear: 12, frontCount: 2, rearCount: 12, frontTeeth: 50, rearTeeth: 11, ratio: 4.5454, developmentM: 9.71 } })

    expect(companionStore.gears.value?.frontTeeth).toBe(50)
    expect(companionStore.gears.value?.ratio).toBeCloseTo(4.5454, 3)
  })

  describe('radar', () => {
    it('alimente le store radar existant', () => {
      // Tout l'intérêt : le bandeau, les bips et les seuils marchent à
      // l'identique, que le radar vienne de l'appli ou de Web Bluetooth.
      push({ radar: { connected: true, targets: [{ id: 2, distanceM: 90, speedMps: 3 }, { id: 1, distanceM: 42, speedMps: 7 }] } })

      expect(radarStore.isConnected.value).toBe(true)
      expect(radarStore.targets.value).toHaveLength(2)
      expect(radarStore.nearest.value?.distanceM).toBe(42)
    })

    it('distingue voie dégagée et radar absent', () => {
      push({ radar: { connected: true, targets: [] } })

      expect(radarStore.isConnected.value).toBe(true)
      expect(radarStore.targets.value).toEqual([])
    })

    it('coupe le bandeau quand le radar se débranche', () => {
      // Un bandeau figé annoncerait une voie dégagée qu'on ne surveille plus.
      push({ radar: { connected: true, targets: [{ id: 1, distanceM: 30, speedMps: 5 }] } })
      push({ radar: { connected: false, targets: [] } })

      expect(radarStore.isConnected.value).toBe(false)
      expect(radarStore.targets.value).toEqual([])
    })

    it('ne touche pas au radar Web Bluetooth quand l\'appli n\'en publie pas', () => {
      radarStore.status.value = 'connected'
      radarStore.setTargets([{ id: 1, distanceM: 20, speedMps: 4 }])

      push({ heartRate: 120 })

      expect(radarStore.isConnected.value).toBe(true)
      expect(radarStore.targets.value).toHaveLength(1)
    })
  })

  describe('companionScreen', () => {
    it('demande à l\'appli d\'éteindre puis de rallumer le rétroéclairage', () => {
      const sent = fakeChannel()

      companionScreen('dimmed')
      companionScreen('normal')

      expect(sent.map((m) => JSON.parse(m))).toEqual([
        { type: 'screen', state: 'dimmed' },
        { type: 'screen', state: 'normal' },
      ])
    })

    it('ne fait rien dans un navigateur ordinaire', () => {
      // Pas de canal : la veille reste un simple voile noir, sans erreur.
      expect(() => companionScreen('dimmed')).not.toThrow()
    })
  })

  it('survit à une charge utile inattendue', () => {
    // La navigation prime : mieux vaut des valeurs figées qu'une carte morte.
    expect(() => push(null)).not.toThrow()
    expect(() => push('bonjour')).not.toThrow()
    expect(() => push({ radar: 'oui' })).not.toThrow()
  })

  describe('revealCompanionLinks', () => {
    beforeEach(() => {
      document.body.innerHTML = '<a data-companion-link class="d-none" href="sportsscope://navigate/abc">Ouvrir</a>'
    })

    it('montre le lien sur Android', () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true })

      revealCompanionLinks()

      expect(document.querySelector('[data-companion-link]')!.classList.contains('d-none')).toBe(false)
    })

    it('laisse le lien caché ailleurs', () => {
      // `sportsscope://` ne mène nulle part sans l'appli, et elle n'existe que
      // sur Android.
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh)', configurable: true })

      revealCompanionLinks()

      expect(document.querySelector('[data-companion-link]')!.classList.contains('d-none')).toBe(true)
    })

    it('laisse le lien caché dans l\'appli elle-même', () => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14)', configurable: true })
      fakeChannel()

      revealCompanionLinks()

      expect(document.querySelector('[data-companion-link]')!.classList.contains('d-none')).toBe(true)
    })
  })
})
