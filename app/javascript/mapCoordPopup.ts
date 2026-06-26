// Tooltip « point quelconque » partagée entre le créateur d'itinéraire et la
// navigation : un clic droit (ordinateur) ou un appui long (mobile) n'importe où sur
// la carte ouvre un popup MapLibre affichant la latitude / longitude (copiables) ainsi
// que des liens Google Maps et Street View. Le rendu réutilise les classes globales
// `.place-popup*` présentes dans les deux composants ; on ne dépend donc d'aucune
// feuille de style propre à un composant.
import { t } from './i18n'

// ─── Street View (disponibilité) ───────────────────────────────────────────────
// Sonde best-effort du service d'imagerie Google (JSONP) : true si une vue existe à
// proximité. Repli optimiste sur erreur / délai. Le cache est partagé par toutes les
// tooltips (créateur, navigation, POI) pour éviter de re-sonder un même point.
const svCache = new Map<string, boolean>()

function svCacheKey(lat: number, lng: number) { return `${lat.toFixed(4)},${lng.toFixed(4)}` }

export function checkStreetView(lat: number, lng: number): Promise<boolean> {
  const key = svCacheKey(lat, lng)
  if (svCache.has(key)) return Promise.resolve(svCache.get(key)!)
  return new Promise<boolean>((resolve) => {
    const cb = `_sv${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    const s = document.createElement('script')
    let settled = false
    const finish = (v: boolean) => {
      if (settled) return; settled = true
      clearTimeout(timer); delete (window as any)[cb]; s.remove()
      svCache.set(key, v); resolve(v)
    }
    const timer = setTimeout(() => finish(true), 4000)
    ;(window as any)[cb] = (d: any) => finish(Array.isArray(d?.[1]) && d[1].length > 0)
    s.src = `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lng}!2d50!3m18!2m2!1sen!2sUS!9m1!1e2!11m12!1m3!1e2!2b1!3e2!1m3!1e3!2b1!3e2!1m3!1e10!2b1!3e2!4m6!1e1!1e2!1e3!1e4!1e8!1e6&callback=${cb}`
    s.onerror = () => finish(true)
    document.head.appendChild(s)
  })
}

function escapeHtml(s: string) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

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
): HTMLElement {
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`
  const svUrl = `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}`
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  const addAction = onAddToRoute
    ? `<button type="button" class="place-popup-link place-popup-link--add-route">
        <i class="fa-solid fa-circle-plus" aria-hidden="true"></i>
        <span>${escapeHtml(t('routes.add_to_route'))}</span>
      </button>`
    : ''
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(t('routes.map_point'))}</span>
      <button type="button" class="place-popup-close" aria-label="${escapeHtml(t('routes.close'))}">×</button>
    </div>
    ${addAction}
    <div class="place-popup-coords-row">
      <button type="button" class="place-popup-link place-popup-link--copy" data-coord="${lat.toFixed(6)}" title="${escapeHtml(t('routes.copy_latitude'))}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span>Lat&nbsp;${lat.toFixed(6)}</span>
      </button>
      <button type="button" class="place-popup-link place-popup-link--copy" data-coord="${lng.toFixed(6)}" title="${escapeHtml(t('routes.copy_longitude'))}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span>Lng&nbsp;${lng.toFixed(6)}</span>
      </button>
    </div>
    <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.street_view'))}</span>
    </a>`
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
  const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
  if (svLink) {
    checkStreetView(lat, lng).then((ok) => {
      svLink.classList.toggle('place-popup-link--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
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
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`
  const svUrl = `https://www.google.com/maps?q=&layer=c&cbll=${lat},${lng}`
  const wrap = document.createElement('div')
  wrap.className = 'place-popup'
  wrap.innerHTML = `
    <div class="place-popup-header">
      <span class="place-popup-name">${escapeHtml(t('routes.waypoint'))}</span>
      <button type="button" class="place-popup-close" aria-label="${escapeHtml(t('routes.close'))}">×</button>
    </div>
    <button type="button" class="place-popup-link place-popup-link--delete">
      <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.delete_point'))}</span>
    </button>
    <div class="place-popup-coords-row">
      <button type="button" class="place-popup-link place-popup-link--copy" data-coord="${lat.toFixed(6)}" title="${escapeHtml(t('routes.copy_latitude'))}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span>Lat&nbsp;${lat.toFixed(6)}</span>
      </button>
      <button type="button" class="place-popup-link place-popup-link--copy" data-coord="${lng.toFixed(6)}" title="${escapeHtml(t('routes.copy_longitude'))}">
        <i class="fa-regular fa-copy" aria-hidden="true"></i>
        <span>Lng&nbsp;${lng.toFixed(6)}</span>
      </button>
    </div>
    <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-brands fa-google" aria-hidden="true"></i>
      <span>Google Maps</span>
    </a>
    <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa-solid fa-street-view" aria-hidden="true"></i>
      <span>${escapeHtml(t('routes.street_view'))}</span>
    </a>`
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
  const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
  if (svLink) {
    checkStreetView(lat, lng).then((ok) => {
      svLink.classList.toggle('place-popup-link--disabled', !ok)
      if (!ok) svLink.setAttribute('aria-disabled', 'true')
      else svLink.removeAttribute('aria-disabled')
    })
  }
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
