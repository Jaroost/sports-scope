// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installCompanionBridge, inCompanionApp, revealCompanionLinks, companionScreen, companionLinkTarget, companionNav } from './companionBridge'
import { navStateFor } from './navHelpers'
import type { TurnHint } from './navHelpers'
import { companionStore } from './stores/companionStore'

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

  describe('companionNav', () => {
    const hint: TurnHint = {
      direction: 'left', distM: 128.4, kind: 'turn', angle: -85, state: 'near',
    }
    const state = (over: Partial<Parameters<typeof navStateFor>[0]> = {}) => navStateFor({
      hasRoute: true, hint, turnCoord: [6.63229, 46.52313], offRoute: false,
      arrived: false, speedKmh: 27.4, remainingM: 18450, remainingGainM: 312,
      climb: null, at: 1_000_000, ...over,
    })

    it('publie le virage et sa position vers l\'appli', () => {
      const sent = fakeChannel()

      companionNav(state())

      expect(JSON.parse(sent[0])).toMatchObject({
        type: 'nav',
        turn: { state: 'near', lat: 46.52313, lng: 6.63229 },
      })
    })

    it('ne renvoie pas deux fois le même état dans la seconde', () => {
      // À l'arrêt, la position ne bouge plus : republier à l'identique ne dirait
      // rien de neuf et réveillerait l'appli pour rien.
      const sent = fakeChannel()

      companionNav(state({ at: 1_000_000 }))
      companionNav(state({ at: 1_000_400 }))

      expect(sent).toHaveLength(1)
    })

    it('republie passé la seconde, même identique', () => {
      // Un signe de vie régulier : c'est lui qui dit à l'appli que
      // l'information est encore fraîche.
      const sent = fakeChannel()

      companionNav(state({ at: 2_000_000 }))
      companionNav(state({ at: 2_001_500 }))

      expect(sent).toHaveLength(2)
    })

    it('republie aussitôt quand l\'état change', () => {
      const sent = fakeChannel()

      companionNav(state({ at: 3_000_000 }))
      companionNav(state({ at: 3_000_100, hint: { ...hint, distM: 40 } }))

      expect(sent).toHaveLength(2)
      expect(JSON.parse(sent[1]).turn.distM).toBe(40)
    })

    it('ne fait rien dans un navigateur ordinaire', () => {
      // Pas de canal injecté : la navigation web marche seule, sans erreur.
      expect(() => companionNav(state())).not.toThrow()
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

  describe('companionLinkTarget', () => {
    const realFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = realFetch
    })

    function stubFetch(response: unknown): void {
      globalThis.fetch = (async () => response) as unknown as typeof fetch
    }

    it('joint le jeton de passage au lien', async () => {
      stubFetch({ ok: true, json: async () => ({ token: 'jeton-1' }) })

      expect(await companionLinkTarget('sportsscope://navigate/abc'))
        .toBe('sportsscope://navigate/abc?handoff=jeton-1')
    })

    it('ouvre le lien tel quel quand le serveur refuse', async () => {
      // Session expirée entre l'affichage de la page et le tap : la navigation
      // partagée reste publique, elle s'ouvrira en anonyme.
      stubFetch({ ok: false, json: async () => ({}) })

      expect(await companionLinkTarget('sportsscope://navigate/abc'))
        .toBe('sportsscope://navigate/abc')
    })

    it('ouvre le lien tel quel hors ligne', async () => {
      globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch

      expect(await companionLinkTarget('sportsscope://navigate/abc'))
        .toBe('sportsscope://navigate/abc')
    })

    it('fonctionne aussi sur l\'App Link https', async () => {
      stubFetch({ ok: true, json: async () => ({ token: 'jeton-2' }) })

      expect(await companionLinkTarget('https://sports.logicraft.ch/routes/abc/navigate'))
        .toBe('https://sports.logicraft.ch/routes/abc/navigate?handoff=jeton-2')
    })
  })
})
