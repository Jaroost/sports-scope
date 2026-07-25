// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest'
import { escapeHtml } from './html'
import {
  googleMapsUrl, popupHeaderHtml, popupLinkHtml, popupActionHtml, popupMapLinksHtml,
  popupCoordsRowHtml,
} from './placePopup'
import { i18n } from './i18n'

// Briques de balisage des tooltips de carte. Elles composent du HTML à la main : ce qui doit
// être vérifié, c'est que les données interpolées (noms de POI venus d'OpenStreetMap, URL)
// ne peuvent pas casser le balisage, et que les classes de ciblage attendues par les
// composants sont bien là — c'est par elles que les gestionnaires de clic se branchent.

beforeAll(() => {
  i18n.store({
    en: {
      routes: {
        close: 'Fermer',
        street_view: 'Street View',
        copy_latitude: 'Copier la latitude',
        copy_longitude: 'Copier la longitude',
      },
    },
  })
  i18n.locale = 'en'
  i18n.enableFallback = true
})

/** Parse le fragment pour l'interroger comme du DOM plutôt que comme du texte. */
function parse(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  return wrap
}

describe('escapeHtml', () => {
  it('neutralise les cinq caractères sensibles', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`))
      .toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  })

  it('laisse le texte ordinaire intact', () => {
    expect(escapeHtml('Boulangerie du Col')).toBe('Boulangerie du Col')
  })

  it('accepte autre chose qu’une chaîne', () => {
    expect(escapeHtml(42)).toBe('42')
    expect(escapeHtml(null)).toBe('null')
    expect(escapeHtml(undefined)).toBe('undefined')
  })
})

describe('googleMapsUrl', () => {
  it('vise la fiche du point', () => {
    expect(googleMapsUrl(46.5, 6.1)).toBe('https://www.google.com/maps?q=46.5,6.1')
  })
})

describe('popupHeaderHtml', () => {
  it('affiche le titre et une croix de fermeture traduite', () => {
    const el = parse(popupHeaderHtml('Fontaine'))

    expect(el.querySelector('.place-popup-name')?.textContent).toBe('Fontaine')
    const close = el.querySelector<HTMLElement>('.place-popup-close')!
    expect(close.getAttribute('aria-label')).toBe('Fermer')
    expect(close.textContent).toBe('×')
  })

  it('ne laisse pas un nom de POI injecter du balisage', () => {
    // Les noms viennent d'OpenStreetMap : on n'en présume rien.
    const el = parse(popupHeaderHtml('<img src=x onerror=alert(1)>'))

    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('.place-popup-name')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('ne laisse pas un nom casser l’attribut voisin', () => {
    const el = parse(popupHeaderHtml('Café "Chez Toto"'))
    expect(el.querySelector('.place-popup-name')?.textContent).toBe('Café "Chez Toto"')
    expect(el.querySelectorAll('.place-popup-close')).toHaveLength(1)
  })
})

describe('popupLinkHtml', () => {
  it('ouvre dans un nouvel onglet, sans fuite de référent', () => {
    const a = parse(popupLinkHtml({ href: 'https://exemple.test/x', icon: 'fa-solid fa-map', label: 'OpenStreetMap' }))
      .querySelector<HTMLAnchorElement>('a')!

    expect(a.getAttribute('href')).toBe('https://exemple.test/x')
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
    expect(a.querySelector('i')?.className).toBe('fa-solid fa-map')
    expect(a.querySelector('span')?.textContent).toBe('OpenStreetMap')
    expect(a.className).toBe('place-popup-link')
  })

  it('ajoute la classe de ciblage demandée', () => {
    const a = parse(popupLinkHtml({
      href: '#', icon: 'fa-solid fa-street-view', label: 'Street View',
      className: 'place-popup-link--streetview',
    })).querySelector<HTMLAnchorElement>('a')!

    expect(a.classList.contains('place-popup-link')).toBe(true)
    expect(a.classList.contains('place-popup-link--streetview')).toBe(true)
  })

  it('échappe l’URL au lieu de la laisser fermer l’attribut', () => {
    const a = parse(popupLinkHtml({ href: 'https://x.test/?q="><script>', icon: 'i', label: 'x' }))
      .querySelector<HTMLAnchorElement>('a')!

    expect(a.getAttribute('href')).toBe('https://x.test/?q="><script>')
    expect(parse(popupLinkHtml({ href: 'https://x.test/?q="><script>', icon: 'i', label: 'x' }))
      .querySelector('script')).toBeNull()
  })
})

describe('popupActionHtml', () => {
  it('rend un bouton porteur de sa classe de ciblage', () => {
    const btn = parse(popupActionHtml({
      className: 'place-popup-link--add-route', icon: 'fa-solid fa-circle-plus', label: 'Ajouter',
    })).querySelector<HTMLButtonElement>('button')!

    expect(btn.type).toBe('button')     // jamais un submit : ces tooltips vivent hors formulaire
    expect(btn.classList.contains('place-popup-link')).toBe(true)
    expect(btn.classList.contains('place-popup-link--add-route')).toBe(true)
    expect(btn.querySelector('span')?.textContent).toBe('Ajouter')
  })
})

describe('popupMapLinksHtml', () => {
  it('rend les deux liens externes, Street View ciblable', () => {
    const el = parse(popupMapLinksHtml('https://maps.test/x', 'https://sv.test/y'))
    const links = el.querySelectorAll<HTMLAnchorElement>('a')

    expect(links).toHaveLength(2)
    expect(links[0].getAttribute('href')).toBe('https://maps.test/x')
    // C'est par cette classe que la sonde vient griser le lien après coup.
    expect(links[1].classList.contains('place-popup-link--streetview')).toBe(true)
    expect(links[1].getAttribute('href')).toBe('https://sv.test/y')
    expect(links[1].querySelector('span')?.textContent).toBe('Street View')
  })

  it('n’impose pas l’URL de la fiche (décalage du POI, cap de la caméra)', () => {
    // Les appelants composent leurs URL : décalage de ~15 m pour ne pas masquer le POI
    // derrière l'épingle Google, cap de la caméra Street View depuis le tracé.
    const el = parse(popupMapLinksHtml(googleMapsUrl(46.50008, 6.10008), 'https://sv.test/?heading=90'))
    expect(el.querySelector('a')!.getAttribute('href')).toContain('46.50008,6.10008')
  })
})

describe('popupCoordsRowHtml', () => {
  it('rend deux boutons copiables à six décimales', () => {
    const btns = parse(popupCoordsRowHtml(46.5, 6.1)).querySelectorAll<HTMLElement>('.place-popup-link--copy')

    expect(btns).toHaveLength(2)
    expect(btns[0].dataset.coord).toBe('46.500000')
    expect(btns[0].title).toBe('Copier la latitude')
    expect(btns[0].textContent?.trim()).toContain('Lat')
    expect(btns[1].dataset.coord).toBe('6.100000')
    expect(btns[1].title).toBe('Copier la longitude')
  })

  it('arrondit à six décimales (≈ 10 cm), pas plus', () => {
    const btns = parse(popupCoordsRowHtml(46.123456789, 6.987654321))
      .querySelectorAll<HTMLElement>('.place-popup-link--copy')

    expect(btns[0].dataset.coord).toBe('46.123457')
    expect(btns[1].dataset.coord).toBe('6.987654')
  })
})
