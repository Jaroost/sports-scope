// @vitest-environment happy-dom
// happy-dom refuse de charger un <script> distant et LÈVE une exception à l'insertion, ce
// qu'aucun navigateur ne fait : on lui demande de traiter ce refus comme un chargement
// silencieux, sans quoi la sonde JSONP ne serait pas testable du tout.
// @vitest-environment-options { "settings": { "handleDisabledFileLoadingAsSuccess": true } }
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  streetViewUrl, checkStreetView, applyStreetViewState, probeStreetViewLink, SV_DISABLED_CLASS,
} from './streetView'

// Le lien Street View est rendu tout de suite puis grisé si la sonde dit qu'il n'y a rien à
// voir. La sonde est un JSONP best-effort : le service peut ne jamais répondre, d'où un
// repli OPTIMISTE — mieux vaut un lien qui ouvre une page vide qu'un lien grisé à tort.

// Répond à la sonde en cours en appelant son callback JSONP, comme le ferait le script
// Google. `hasPano` : le service renvoie un tableau de panoramas en 2e position.
function respond(hasPano: boolean) {
  const script = document.head.querySelector('script[src*="GeoPhotoService"]') as HTMLScriptElement
  expect(script).toBeTruthy()
  const cb = new URL(script.src).searchParams.get('callback')!
  ;(window as any)[cb](hasPano ? [null, [{}]] : [null, []])
}

const pendingScripts = () => document.head.querySelectorAll('script[src*="GeoPhotoService"]').length

// Chaque test sonde des coordonnées différentes : le cache du module est global et vit
// pour toute la session (c'est bien son intérêt), on ne peut donc pas le remettre à zéro.
let lat = 46.0
function nextPoint(): [number, number] {
  lat += 0.01
  return [lat, 6.0]
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

afterEach(() => { vi.useRealTimers() })

describe('streetViewUrl', () => {
  it('vise le panorama le plus proche du point', () => {
    expect(streetViewUrl(46.5, 6.1))
      .toBe('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=46.5,6.1')
  })

  it('oriente la caméra quand un cap est fourni', () => {
    expect(streetViewUrl(46.5, 6.1, 90)).toContain('&heading=90')
    expect(streetViewUrl(46.5, 6.1, 89.6)).toContain('&heading=90')     // arrondi
  })

  it('ramène le cap dans [0, 360[', () => {
    expect(streetViewUrl(46.5, 6.1, -90)).toContain('&heading=270')
    expect(streetViewUrl(46.5, 6.1, 450)).toContain('&heading=90')
  })

  it('omet le cap quand il n’est pas exploitable', () => {
    expect(streetViewUrl(46.5, 6.1, undefined)).not.toContain('heading')
    expect(streetViewUrl(46.5, 6.1, NaN)).not.toContain('heading')
  })
})

describe('checkStreetView', () => {
  it('répond vrai quand le service annonce un panorama', async () => {
    const p = checkStreetView(...nextPoint())
    respond(true)
    await expect(p).resolves.toBe(true)
  })

  it('répond faux quand le service n’en annonce aucun', async () => {
    const p = checkStreetView(...nextPoint())
    respond(false)
    await expect(p).resolves.toBe(false)
  })

  it('nettoie derrière elle : script retiré, callback global effacé', async () => {
    const p = checkStreetView(...nextPoint())
    const script = document.head.querySelector('script[src*="GeoPhotoService"]') as HTMLScriptElement
    const cb = new URL(script.src).searchParams.get('callback')!
    expect((window as any)[cb]).toBeTypeOf('function')

    respond(true)
    await p

    expect(pendingScripts()).toBe(0)
    expect((window as any)[cb]).toBeUndefined()
  })

  it('reste optimiste si le service ne répond pas à temps', async () => {
    vi.useFakeTimers()
    const p = checkStreetView(...nextPoint())

    await vi.advanceTimersByTimeAsync(4000)

    await expect(p).resolves.toBe(true)
    expect(pendingScripts()).toBe(0)
  })

  it('reste optimiste si le script échoue (hors ligne, bloqueur)', async () => {
    const p = checkStreetView(...nextPoint())
    const script = document.head.querySelector('script[src*="GeoPhotoService"]') as HTMLScriptElement

    script.onerror?.(new Event('error'))

    await expect(p).resolves.toBe(true)
  })

  it('ne sonde qu’une fois par point, pour toute l’app', async () => {
    const point = nextPoint()
    const first = checkStreetView(...point)
    respond(false)
    await expect(first).resolves.toBe(false)
    document.head.innerHTML = ''

    // Deuxième appel (autre tooltip, autre composant) : réponse immédiate, pas de script.
    await expect(checkStreetView(...point)).resolves.toBe(false)
    expect(pendingScripts()).toBe(0)
  })

  it('partage la réponse entre points voisins (clé arrondie à ~11 m)', async () => {
    const [la, ln] = nextPoint()
    const first = checkStreetView(la, ln)
    respond(true)
    await first
    document.head.innerHTML = ''

    // 1e-5° ≈ 1 m : même clé de cache, aucune nouvelle sonde.
    await expect(checkStreetView(la + 0.00001, ln)).resolves.toBe(true)
    expect(pendingScripts()).toBe(0)
  })

  it('sonde à nouveau un point franchement différent', async () => {
    const first = checkStreetView(...nextPoint())
    respond(true)
    await first
    document.head.innerHTML = ''

    void checkStreetView(...nextPoint())
    expect(pendingScripts()).toBe(1)
  })
})

describe('applyStreetViewState', () => {
  function link(): HTMLElement {
    const a = document.createElement('a')
    a.className = 'place-popup-link place-popup-link--streetview'
    document.body.appendChild(a)
    return a
  }

  it('grise le lien et l’annonce aux lecteurs d’écran', () => {
    const a = link()
    applyStreetViewState(a, false)

    expect(a.classList.contains(SV_DISABLED_CLASS)).toBe(true)
    expect(a.getAttribute('aria-disabled')).toBe('true')
  })

  it('réactive un lien précédemment grisé', () => {
    const a = link()
    applyStreetViewState(a, false)
    applyStreetViewState(a, true)

    expect(a.classList.contains(SV_DISABLED_CLASS)).toBe(false)
    expect(a.hasAttribute('aria-disabled')).toBe(false)
  })

  it('respecte la convention de classe des tooltips de point', () => {
    const a = link()
    applyStreetViewState(a, false, 'wp-tooltip-action--disabled')

    expect(a.classList.contains('wp-tooltip-action--disabled')).toBe(true)
    expect(a.classList.contains(SV_DISABLED_CLASS)).toBe(false)
  })

  it('ne bronche pas sans lien (popup déjà refermé)', () => {
    expect(() => applyStreetViewState(null, false)).not.toThrow()
  })
})

describe('probeStreetViewLink', () => {
  it('grise le lien quand aucun panorama n’existe', async () => {
    const a = document.createElement('a')
    document.body.appendChild(a)

    probeStreetViewLink(a, ...nextPoint())
    respond(false)
    await vi.waitFor(() => expect(a.classList.contains(SV_DISABLED_CLASS)).toBe(true))
  })

  it('réactive le lien quand un panorama existe', async () => {
    const a = document.createElement('a')
    // Lien grisé au départ, pour que le test prouve bien un changement d'état.
    a.classList.add(SV_DISABLED_CLASS)
    a.setAttribute('aria-disabled', 'true')
    document.body.appendChild(a)

    probeStreetViewLink(a, ...nextPoint())
    respond(true)

    await vi.waitFor(() => expect(a.classList.contains(SV_DISABLED_CLASS)).toBe(false))
    expect(a.hasAttribute('aria-disabled')).toBe(false)
  })

  it('n’appelle même pas le service sans lien à renseigner', () => {
    probeStreetViewLink(null, ...nextPoint())
    expect(pendingScripts()).toBe(0)
  })
})
