// Tooltip « point quelconque » partagée entre le créateur d'itinéraire et la
// navigation : un clic droit (ordinateur) ou un appui long (mobile) n'importe où sur
// la carte ouvre un popup MapLibre affichant la latitude / longitude (copiables) ainsi
// que des liens Google Maps et Street View. Le rendu réutilise les classes globales
// `.place-popup*` (`styles/placePopup.css`, chargée par `placePopup.ts`) ; on ne dépend
// donc d'aucune feuille de style propre à un composant.
import { t } from './i18n'
import { streetViewUrl, probeStreetViewLink } from './streetView'
import {
  popupHeaderHtml, popupLinkHtml, popupActionHtml, popupMapLinksHtml, popupCoordsRowHtml,
  googleMapsUrl,
} from './placePopup'

// Zoom d'ouverture d'OpenStreetMap : assez près pour voir les attributs d'un chemin
// (nom, surface, accès), sans dépendre du zoom de notre propre carte — on vient
// regarder un point précis, pas retrouver le cadrage qu'on avait.
const OSM_ZOOM = 17

// Copie un texte dans le presse-papier (avec repli execCommand sur les contextes non
// sécurisés) et bascule brièvement l'icône du bouton en « coché » comme accusé.
async function copyText(text: string, btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    document.body.removeChild(ta)
  }
  const icon = btn.querySelector('i')
  if (!icon) return
  icon.classList.replace('fa-regular', 'fa-solid')
  icon.classList.replace('fa-copy', 'fa-check')
  icon.style.color = '#16a34a'
  setTimeout(() => {
    icon.classList.replace('fa-check', 'fa-copy')
    icon.classList.replace('fa-solid', 'fa-regular')
    icon.style.color = ''
  }, 1200)
}

// Construit le contenu DOM de la tooltip d'un point quelconque. `onClose` est appelé
// par la croix de fermeture (le composant ferme alors son popup MapLibre). `onAddToRoute`,
// s'il est fourni, ajoute un bouton « Ajouter à l'itinéraire » en tête : le créateur y
// insère un waypoint au plus proche du tracé, la navigation y épisse un détour. Absent
// (lecture seule, navigation libre sans tracé), le bouton n'apparaît pas.
export function buildCoordPopupContent(
  lng: number,
  lat: number,
  onClose: () => void,
  onAddToRoute?: (lng: number, lat: number) => void,
  // Cap optionnel (degrés, 0 = nord) : quand le point cliqué est sur le tracé, oriente la
  // caméra Street View dans le sens de parcours. Absent (point hors tracé) → vue par défaut.
  heading?: number,
): HTMLElement {
  const svUrl = streetViewUrl(lat, lng, heading)
  // OpenStreetMap au point cliqué : c'est la source des données de routage, on y va pour
  // vérifier le terrain (un chemin manquant, un sens interdit) ou pour le corriger.
  // `mlat/mlon` pose le marqueur, le fragment cadre la vue — sans lui, OSM ouvrirait
  // sur la dernière position mémorisée du visiteur.
  const osmUrl = `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lng.toFixed(6)}#map=${OSM_ZOOM}/${lat.toFixed(5)}/${lng.toFixed(5)}`
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  const addAction = onAddToRoute
    ? popupActionHtml({ className: 'place-popup-link--add-route', icon: 'fa-solid fa-circle-plus', label: t('routes.add_to_route') })
    : ''
  wrap.innerHTML = `
    ${popupHeaderHtml(t('routes.map_point'))}
    ${addAction}
    ${popupCoordsRowHtml(lat, lng)}
    ${popupMapLinksHtml(googleMapsUrl(lat, lng), svUrl)}
    ${popupLinkHtml({ href: osmUrl, icon: 'fa-solid fa-map', label: 'OpenStreetMap' })}`
  wrap.querySelector('.place-popup-close')?.addEventListener('click', onClose)
  wrap.querySelector('.place-popup-link--add-route')?.addEventListener('click', (ev) => {
    ev.stopPropagation(); ev.preventDefault()
    onAddToRoute?.(lng, lat)
  })
  wrap.querySelectorAll<HTMLElement>('.place-popup-link--copy').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); ev.preventDefault()
      copyText(btn.dataset.coord || '', btn)
    })
  })
  probeStreetViewLink(wrap.querySelector<HTMLElement>('.place-popup-link--streetview'), lat, lng)
  return wrap
}

// Tooltip d'un point d'étape posé en mode « cible » (navigation vers un lieu). Reprend
// les liens Google Maps / Street View de la tooltip générique, mais propose en tête un
// bouton « Supprimer ce point » (rouge) au lieu de « Ajouter à l'itinéraire ». `onDelete`
// retire le point de la séquence ; `onClose` ferme le popup.
export function buildDestPointPopupContent(
  lng: number,
  lat: number,
  onClose: () => void,
  onDelete: () => void,
): HTMLElement {
  // Ce point-ci ouvre Street View par l'ancien format `cbll` (panorama le plus proche,
  // sans orientation) : on ne connaît pas de cap pertinent pour une étape posée à la main.
  const svUrl = `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}`
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  wrap.innerHTML = `
    ${popupHeaderHtml(t('routes.waypoint'))}
    ${popupActionHtml({ className: 'place-popup-link--delete', icon: 'fa-solid fa-trash-can', label: t('routes.delete_point') })}
    ${popupCoordsRowHtml(lat, lng)}
    ${popupMapLinksHtml(googleMapsUrl(lat, lng), svUrl)}`
  wrap.querySelector('.place-popup-close')?.addEventListener('click', onClose)
  wrap.querySelector('.place-popup-link--delete')?.addEventListener('click', (ev) => {
    ev.stopPropagation(); ev.preventDefault()
    onDelete()
  })
  wrap.querySelectorAll<HTMLElement>('.place-popup-link--copy').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); ev.preventDefault()
      copyText(btn.dataset.coord || '', btn)
    })
  })
  probeStreetViewLink(wrap.querySelector<HTMLElement>('.place-popup-link--streetview'), lat, lng)
  return wrap
}

// Détecte un appui long (mobile) sur un élément (typiquement le canvas de la carte) et
// appelle `handler(clientX, clientY)` au point touché. On reste passif (aucun
// preventDefault) pour ne pas casser le pan / pinch natif de MapLibre : un déplacement
// au-delà de `moveTolPx` ou un second doigt annule l'appui. Renvoie une fonction de
// nettoyage à appeler au démontage.
export function attachLongPress(
  target: HTMLElement,
  handler: (clientX: number, clientY: number) => void,
  delayMs = 500,
  moveTolPx = 10,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let sx = 0, sy = 0
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  const onStart = (e: TouchEvent) => {
    clear()
    if (e.touches.length !== 1) return
    sx = e.touches[0].clientX; sy = e.touches[0].clientY
    timer = setTimeout(() => { timer = null; handler(sx, sy) }, delayMs)
  }
  const onMove = (e: TouchEvent) => {
    if (!timer) return
    if (e.touches.length !== 1) { clear(); return }
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy
    if (dx * dx + dy * dy > moveTolPx * moveTolPx) clear()
  }
  target.addEventListener('touchstart', onStart, { passive: true })
  target.addEventListener('touchmove', onMove, { passive: true })
  target.addEventListener('touchend', clear, { passive: true })
  target.addEventListener('touchcancel', clear, { passive: true })
  return () => {
    clear()
    target.removeEventListener('touchstart', onStart)
    target.removeEventListener('touchmove', onMove)
    target.removeEventListener('touchend', clear)
    target.removeEventListener('touchcancel', clear)
  }
}

// Tap à deux doigts (mobile) : deux doigts posés puis relevés sans bouger. Même rôle que
// l'appui long ci-dessus — ouvrir la bulle d'un point quelconque — pour les cartes où
// l'appui long sert à autre chose (en navigation, il met en veille). Le geste s'inscrit
// dans la famille que la navigation impose déjà à deux doigts : glisser déplace, écarter
// zoome, taper renseigne.
//
// Passif lui aussi : le pinch de MapLibre a besoin de ses touchmove, et un tap immobile ne
// le déclenche pas. Le tap à deux doigts de MapLibre, lui, dézoome (TapZoomHandler) — c'est
// à l'appelant de le désactiver, sinon le point se renseigne et la carte s'éloigne.
export function attachTwoFingerTap(
  target: HTMLElement,
  handler: (clientX: number, clientY: number) => void,
  maxMs = 450,
  moveTolPx = 18,
): () => void {
  type Pt = { x: number; y: number }
  let armed = false
  let startedAt = 0
  let start: Pt[] = []
  let last: Pt[] = []
  const points = (e: TouchEvent): Pt[] =>
    Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }))

  const onStart = (e: TouchEvent) => {
    // Un troisième doigt (ou un seul) : ce n'est pas ce geste-ci.
    if (e.touches.length !== 2) { armed = false; return }
    armed = true
    startedAt = Date.now()
    start = last = points(e)
  }
  const onMove = (e: TouchEvent) => {
    if (!armed) return
    if (e.touches.length !== 2) { armed = false; return }
    last = points(e)
    // Un doigt qui dérive = déplacement de carte ou pinch : on rend la main.
    for (let i = 0; i < 2; i++) {
      const dx = last[i].x - start[i].x, dy = last[i].y - start[i].y
      if (dx * dx + dy * dy > moveTolPx * moveTolPx) { armed = false; return }
    }
  }
  // Premier doigt relevé : c'est la fin du tap (touches.length retombe à 1).
  const onEnd = () => {
    if (!armed) return
    armed = false
    if (Date.now() - startedAt > maxMs) return
    handler((last[0].x + last[1].x) / 2, (last[0].y + last[1].y) / 2)
  }
  const onCancel = () => { armed = false }

  target.addEventListener('touchstart', onStart, { passive: true })
  target.addEventListener('touchmove', onMove, { passive: true })
  target.addEventListener('touchend', onEnd, { passive: true })
  target.addEventListener('touchcancel', onCancel, { passive: true })
  return () => {
    armed = false
    target.removeEventListener('touchstart', onStart)
    target.removeEventListener('touchmove', onMove)
    target.removeEventListener('touchend', onEnd)
    target.removeEventListener('touchcancel', onCancel)
  }
}
