// Street View : construction du lien, et disponibilité d'un panorama à proximité d'un point.
//
// Chaque tooltip de l'app (POI de la carte, point d'ancrage, repère, coordonnée quelconque)
// propose un lien Street View. Le lien est rendu tout de suite, puis grisé si la sonde
// répond qu'il n'y a rien à voir là-bas. La sonde et son cache vivaient en TROIS copies
// identiques (créateur d'itinéraire, POI de navigation, tooltips de coordonnées), chacune
// avec son propre cache : le même point était donc sondé jusqu'à trois fois.

// Construit l'URL Google Maps Street View d'un point. Quand `heading` est fourni (cap en
// degrés, 0 = nord), le panorama est orienté dans cette direction — typiquement le cap
// depuis le tracé vers un POI, pour regarder le POI plutôt que la route. Utilise l'API
// Google Maps URLs (action `pano`), qui « snappe » au panorama le plus proche du `viewpoint`
// et, contrairement au format `cbll`, honore l'orientation de la caméra.
export function streetViewUrl(lat: number, lng: number, heading?: number): string {
  const base = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`
  if (heading == null || Number.isNaN(heading)) return base
  const h = ((Math.round(heading) % 360) + 360) % 360
  return `${base}&heading=${h}`
}

// Disponibilité, mise en cache pour toute l'app. La clé est arrondie à ~11 m : deux points
// voisins partagent leur réponse, ce qui est bien le comportement voulu (un panorama
// « proche » l'est pour les deux).
const svCache = new Map<string, boolean>()

function svCacheKey(lat: number, lng: number) { return `${lat.toFixed(4)},${lng.toFixed(4)}` }

// Délai au-delà duquel on cesse d'attendre le service.
const SV_PROBE_TIMEOUT_MS = 4000

// Sonde best-effort du service d'imagerie Google (JSONP) : true si une vue existe à
// proximité. Le repli est OPTIMISTE (erreur réseau, service muet, délai dépassé → true) :
// mieux vaut un lien qui ouvre une page vide qu'un lien grisé à tort sur un point qui a
// bien un panorama.
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
    const timer = setTimeout(() => finish(true), SV_PROBE_TIMEOUT_MS)
    ;(window as any)[cb] = (d: any) => finish(Array.isArray(d?.[1]) && d[1].length > 0)
    s.src = `https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch?pb=!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lng}!2d50!3m18!2m2!1sen!2sUS!9m1!1e2!11m12!1m3!1e2!2b1!3e2!1m3!1e3!2b1!3e2!1m3!1e10!2b1!3e2!4m6!1e1!1e2!1e3!1e4!1e8!1e6&callback=${cb}`
    s.onerror = () => finish(true)
    document.head.appendChild(s)
  })
}

/** Classe « désactivé » des liens de popup de lieu (la convention la plus répandue). */
export const SV_DISABLED_CLASS = 'place-popup-link--disabled'

// Reflète la disponibilité sur un lien déjà rendu : classe désactivée + `aria-disabled`,
// pour que le lecteur d'écran l'annonce comme les voyants le voient. Les tooltips de point
// d'ancrage ont leur propre convention de classe, d'où le paramètre.
export function applyStreetViewState(
  link: HTMLElement | null | undefined,
  available: boolean,
  disabledClass = SV_DISABLED_CLASS,
): void {
  if (!link) return
  link.classList.toggle(disabledClass, !available)
  if (available) link.removeAttribute('aria-disabled')
  else link.setAttribute('aria-disabled', 'true')
}

// Sonde puis grise le lien. Sans lien (popup jamais rendu, ou déjà refermé), on ne sonde
// même pas — inutile d'appeler Google pour un élément qui n'existe pas.
export function probeStreetViewLink(
  link: HTMLElement | null | undefined,
  lat: number,
  lng: number,
  disabledClass = SV_DISABLED_CLASS,
): void {
  if (!link) return
  void checkStreetView(lat, lng).then((ok) => applyStreetViewState(link, ok, disabledClass))
}
