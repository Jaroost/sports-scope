import { reactive, ref, computed, watch } from 'vue'
import { t } from '../i18n'
import { haversine, streetViewUrl, bearingFromRoute } from '../routeHelpers'
import type { Coord, LngLat } from '../routeHelpers'
import { userPreferences } from '../userPreferences'
import { POI_CATEGORIES, categoryForType } from '../poiCategories'
import { savedPoisStore } from '../stores/savedPoisStore'

// ─── Points d'intérêt de la navigation (POI ponctuels du profil) ───────────────
// Sous-système autonome de RouteNavigation.vue : recherche Overpass des POI autour
// du tracé, pose les marqueurs, gère leur popup (Google Maps / Street View) et leur
// mise à l'échelle au zoom. Sans aucun lien avec l'état de navigation (GPS, virages,
// caméra) — d'où l'extraction. L'appelant fournit des accès paresseux à la carte et
// à la géométrie (non encore prêtes au montage) ainsi que la loi d'échelle du tracé,
// pour caler la taille des POI sur celle des indicateurs de virage.

// `saved` : POI provenant de la table `pois` (badge étoile, rendu en permanence) par
// opposition aux POI Overpass découverts à la volée.
export interface NavPlace { name: string; type: string; lng: number; lat: number; saved?: boolean }

// Résultat d'une recherche POI, remonté à l'appelant pour un retour visuel (toast) :
// `ok` faux signale un échec réseau / serveur Overpass ; sinon `count` est le nombre
// de lieux trouvés dans le rayon (0 = recherche aboutie mais vide).
export type PoiSearchResult = { ok: true; count: number } | { ok: false }

export function useNavPois(deps: {
  getMap: () => any
  getMaplibre: () => any
  getGeometry: () => Coord[]
  zoomWidthScale: (z: number) => number
  // Optionnel : si fourni, le popup d'un POI propose « Naviguer ici » qui lance la
  // navigation guidée vers ce POI (seulement en mode libre, où la destination est libre).
  onNavigateTo?: (place: NavPlace) => void
  // Optionnel : insère le POI dans l'itinéraire courant (au plus proche), sans le
  // remplacer. Le bouton n'apparaît que quand un tracé est chargé (hasRoute).
  onInsertVia?: (place: NavPlace) => void
  hasRoute?: () => boolean
}) {
  const { getMap, getMaplibre, getGeometry, zoomWidthScale, onNavigateTo, onInsertVia, hasRoute } = deps

  // Catégories de POI ponctuels affichables en navigation (eau, restos, points de
  // vue…). Le panneau de séance permet de les masquer/afficher ; l'état initial vient
  // des préférences du profil. On récupère toutes les catégories sur Overpass (pas
  // seulement celles cochées au profil) pour que les bascules soient instantanées.
  const POI_CATS = POI_CATEGORIES.filter((c) => c.point)
  const poiVisible = reactive<Record<string, boolean>>(
    Object.fromEntries(POI_CATS.map((c) => [c.key, !!userPreferences().points_of_interest[c.prefField]])),
  )

  // Recherche Overpass en cours : pilote le retour visuel (spinner) du bouton
  // « chercher autour de moi » du panneau de séance.
  const loading = ref(false)

  // Nombre de lieux trouvés par catégorie lors de la dernière recherche aboutie
  // (clé de catégorie → compte, 0 inclus). Affiché à côté de chaque catégorie dans le
  // panneau POI. Vide tant qu'aucune recherche n'a abouti (aucun nombre affiché).
  const poiCounts = reactive<Record<string, number>>({})

  let placeMarkers: any[] = []   // marqueurs POI ponctuels (filtrés par le panneau de séance)
  // POI ponctuels actuellement posés (réactif : alimente `visiblePlaces`, le parcours des
  // POI et la détection de proximité). Lien place → élément DOM du marqueur tenu en
  // parallèle (`placeEls`) pour rouvrir le popup d'un POI depuis le parcours. Indexé par
  // une clé stable (type + coordonnées) et NON par référence d'objet : Vue proxifie en
  // profondeur les éléments de `places` (ref), donc `visiblePlaces` renvoie des proxys —
  // une Map indexée par l'objet brut renverrait alors undefined.
  const places = ref<NavPlace[]>([])
  // POI sauvegardés avec le tracé dans la table `routes.pois` : affichés dès le chargement
  // du tracé, avant toute recherche Overpass. Remplacés/effacés dès qu'une recherche live
  // aboutit, pour éviter les doublons. Fallback offline : si Overpass échoue, ces POI
  // restent visibles tout au long de la séance.
  const routePlaces = ref<NavPlace[]>([])
  // POI sauvegardés (table `pois`) projetés en NavPlace : rendus en permanence, en plus
  // des POI Overpass. Alimentés depuis savedPoisStore (cf. bas du composable).
  const savedPlaces = ref<NavPlace[]>([])
  const placeEls = new Map<string, HTMLElement>()
  const placeKey = (p: NavPlace) => `${p.type}:${p.lng}:${p.lat}`
  let placePopup: any = null            // popup POI ouvert (liens Google Maps / Street View)
  let activePlaceEl: HTMLElement | null = null   // marqueur dont le popup est ouvert
  const svCache = new Map<string, boolean>()     // cache « Street View dispo ? » par POI

  // Tailles de base (px) des POI à l'échelle 1. Relevées par rapport au CSS d'origine
  // (32/26) car les POI paraissaient trop petits une fois mis à l'échelle.
  const POI_MOBILE = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  const POI_DOT_BASE = POI_MOBILE ? 38 : 30
  const POI_ICON_BASE = POI_MOBILE ? 17 : 14

  // Échelle des POI : plus douce que celle du tracé/des virages. Un point d'intérêt
  // doit rester lisible et tapable, donc plancher relevé (et plafond) pour qu'il ne
  // devienne ni minuscule en dézoom ni démesuré en zoom.
  function poiScale(z: number): number {
    return Math.min(1.8, Math.max(0.75, zoomWidthScale(z)))
  }

  // Pose les POI ponctuels, comme le créateur d'itinéraire. Mêmes catégories, même
  // rayon (points_of_interest) et même rendu de marqueur. Best-effort : un échec
  // Overpass est silencieux, les POI ne sont qu'un complément à la navigation.
  // (Les localités n'ont pas de marqueur, on ne les recherche pas ici.)
  //
  // Deux modes selon `opts.center` :
  //   • sans centre (navigation sur itinéraire) : bbox du tracé, filtre par distance
  //     au point le plus proche du tracé ;
  //   • avec centre [lng, lat] (bouton « chercher autour de moi », mode libre) : bbox
  //     autour du point, filtre par distance au centre.
  async function fetchPlaces(opts: { center?: [number, number] } = {}): Promise<PoiSearchResult> {
    const geometry = getGeometry()
    const poi = userPreferences().points_of_interest
    // Toutes les catégories ponctuelles : l'affichage est ensuite filtré par le
    // panneau (poiVisible), dont l'état initial reflète les préférences du profil.
    const types = POI_CATS.map((c) => c.key)
    const center = opts.center
    // Anchors : autour du centre fourni, sinon le long du tracé. Sans l'un ni l'autre,
    // rien à chercher.
    const anchors: (Coord | LngLat)[] = center ? [center] : geometry
    if (types.length === 0 || anchors.length < (center ? 1 : 2)) return { ok: true, count: 0 }

    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity
    for (const [lng, lat] of anchors) {
      if (lat < south) south = lat
      if (lat > north) north = lat
      if (lng < west) west = lng
      if (lng > east) east = lng
    }
    // La bbox doit englober le rayon de détection, sinon les POI au-delà de ~2 km
    // ne seraient pas remontés par Overpass.
    const radiusM = poi.radius_m
    const BUFFER = Math.max(0.02, (radiusM + 200) / 111000)
    south -= BUFFER; north += BUFFER; west -= BUFFER; east += BUFFER

    loading.value = true
    try {
      const res = await fetch(`/api/geocode/places?south=${south}&west=${west}&north=${north}&east=${east}&types=${types.join(',')}`)
      if (!res.ok) return { ok: false }
      const nodes = await res.json()

      const seen = new Set<string>()
      const places: NavPlace[] = []
      for (const node of nodes) {
        if (!categoryForType(node.type)?.point) continue
        const key = `${node.type}:${node.lat.toFixed(3)}:${node.lng.toFixed(3)}`
        if (seen.has(key)) continue
        // Filtre par le rayon configurable : distance du POI au plus proche des anchors
        // (point central en mode libre, ou point le plus proche du tracé).
        let minD = Infinity
        for (let i = 0; i < anchors.length; i++) {
          const d = haversine(anchors[i], [node.lng, node.lat])
          if (d < minD) minD = d
        }
        if (minD > radiusM) continue
        seen.add(key)
        places.push({ name: node.name, type: node.type, lng: node.lng, lat: node.lat })
      }
      // Compte par catégorie (0 inclus pour celles sans résultat) pour l'afficher
      // à côté de chaque catégorie dans le panneau.
      const counts: Record<string, number> = Object.fromEntries(POI_CATS.map((c) => [c.key, 0]))
      for (const p of places) {
        const k = categoryForType(p.type)?.key
        if (k && k in counts) counts[k]++
      }
      Object.assign(poiCounts, counts)
      installPlaceMarkers(places)
      return { ok: true, count: places.length }
    } catch { /* réseau / serveur Overpass */ return { ok: false } } finally {
      loading.value = false
    }
  }

  // Remplace les POI Overpass et redessine tous les marqueurs (Overpass + sauvegardés).
  // Les POI du tracé (routePlaces) sont effacés : la recherche live les remplace.
  function installPlaceMarkers(newPlaces: NavPlace[]) {
    places.value = newPlaces
    routePlaces.value = []
    renderMarkers()
  }

  // Installe les POI sauvegardés avec le tracé (routes.pois) comme source de secours
  // affichée avant toute recherche Overpass et en cas d'indisponibilité du réseau.
  function setRoutePlaces(pois: Array<{ name: string; type: string; lat: number; lng: number }>) {
    routePlaces.value = pois.map(({ name, type, lat, lng }) => ({ name, type, lng, lat }))
    renderMarkers()
  }

  // Marqueur HTML persistant par POI (même look que le créateur), pour l'union des POI
  // Overpass (`places`) et sauvegardés (`savedPlaces`). Les marqueurs MapLibre sont des
  // overlays DOM, ils survivent à un setStyle — pas besoin de les réinstaller au
  // changement de fond de carte. Les POI sauvegardés portent un badge étoile.
  function renderMarkers() {
    const map = getMap()
    const maplibre = getMaplibre()
    if (!map || !maplibre) return
    closePlacePopup()
    for (const m of placeMarkers) m.remove()
    placeMarkers = []
    placeEls.clear()
    const overpassOrRoute = places.value.length > 0 ? places.value : routePlaces.value
    for (const place of [...overpassOrRoute, ...savedPlaces.value]) {
      const el = document.createElement('div')
      const cat = categoryForType(place.type)
      const icon = cat?.icon ?? 'fa-location-dot'
      el.className = place.saved ? 'place-marker place-marker--saved' : 'place-marker'
      // Couleur pilotée par le registre POI (currentColor → bordure / remplissage).
      el.style.color = cat?.color ?? '#6b7280'
      // Clé de catégorie : sert au filtrage d'affichage par le panneau de séance.
      if (cat) el.dataset.poiKey = cat.key
      el.title = place.name
      el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`
      // Clic = popup Google Maps / Street View. stopPropagation pour ne pas
      // déclencher la mise en veille (tap carte) ni un déplacement de carte.
      el.addEventListener('click', (ev) => { ev.stopPropagation(); showPlacePopup(place, el) })
      el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
      const marker = new maplibre.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([place.lng, place.lat])
        .addTo(map)
      placeMarkers.push(marker)
      placeEls.set(placeKey(place), el)
    }
    applyPoiScale(map.getZoom())
    applyPoiVisibility()
  }

  // POI ponctuel visible (catégorie non masquée par le panneau) le plus proche de
  // `pos`, dans la limite `maxDistM`, ou null. Sert à la notification de proximité de
  // navigation (RouteNavigation) : on prévient le coureur quand il passe près d'un lieu.
  function nearestVisiblePoi(pos: LngLat, maxDistM: number): { place: NavPlace; distM: number } | null {
    let best: { place: NavPlace; distM: number } | null = null
    for (const place of visiblePlaces.value) {
      const d = haversine(pos, [place.lng, place.lat])
      if (d > maxDistM) continue
      if (!best || d < best.distM) best = { place, distM: d }
    }
    return best
  }

  // POI ponctuels actuellement affichés (catégorie non masquée par le panneau de séance).
  // Priorité : Overpass live > POI sauvegardés du tracé > rien. En plus : POI perso.
  const visiblePlaces = computed(() => {
    const overpassOrRoute = places.value.length > 0 ? places.value : routePlaces.value
    return [...overpassOrRoute, ...savedPlaces.value].filter((p) => {
      const cat = categoryForType(p.type)
      return !cat || poiVisible[cat.key] !== false
    })
  })

  // Ouvre le popup d'un POI (mêmes actions que le clic sur son marqueur) depuis le
  // parcours : retrouve l'élément DOM du marqueur par référence de `place`.
  function openPlacePopup(place: NavPlace) {
    const el = placeEls.get(placeKey(place))
    if (el) showPlacePopup(place, el)
  }

  // Affiche/masque les marqueurs POI selon les bascules du panneau de séance.
  function applyPoiVisibility() {
    for (const m of placeMarkers) {
      const el = m.getElement() as HTMLElement
      const key = el.dataset.poiKey
      el.style.display = key && poiVisible[key] === false ? 'none' : ''
    }
  }

  function togglePoi(key: string) {
    poiVisible[key] = !poiVisible[key]
    // Si le POI dont le popup est ouvert vient d'être masqué, on ferme le popup.
    if (!poiVisible[key] && activePlaceEl?.dataset.poiKey === key) closePlacePopup()
    applyPoiVisibility()
  }

  // Met les marqueurs POI à l'échelle du zoom (échelle plus douce que le tracé). La
  // boîte se redimensionne directement, l'icône en police suit. Appelée à l'install
  // et par la boucle de rendu de l'appelant (au changement de zoom).
  function applyPoiScale(z: number) {
    const ps = poiScale(z)
    const poiSize = POI_DOT_BASE * ps
    const poiBorder = `${Math.max(1, 2 * ps)}px`
    for (const m of placeMarkers) {
      const el = m.getElement() as HTMLElement
      el.style.width = `${poiSize}px`
      el.style.height = `${poiSize}px`
      el.style.borderWidth = poiBorder
      const icon = el.querySelector<HTMLElement>('i')
      if (icon) icon.style.fontSize = `${POI_ICON_BASE * ps}px`
    }
  }

  // Popup proposant d'ouvrir le POI sur Google Maps et en Street View — repris du
  // créateur d'itinéraire (même format d'URL `maps?q=lat,lng`). Le lien Street View
  // est grisé quand aucune imagerie n'est disponible à proximité.
  function showPlacePopup(place: NavPlace, el: HTMLElement) {
    const map = getMap()
    const maplibre = getMaplibre()
    if (!maplibre || !map) return
    closePlacePopup()
    // Décalage de ~15 m : centrée pile sur le lieu, l'épingle rouge de Google masque
    // le POI. On vise juste à côté pour le laisser visible/cliquable.
    const OFFSET = 0.00008
    const mapsUrl = `https://www.google.com/maps?q=${place.lat + OFFSET},${place.lng + OFFSET}`
    // Caméra Street View orientée depuis le tracé vers le POI (cap tracé → POI).
    const svUrl = streetViewUrl(place.lat, place.lng, bearingFromRoute(getGeometry(), place.lng, place.lat))
    const wrap = document.createElement('div')
    wrap.className = 'place-popup'
    // « Naviguer ici » en tête (action principale) : lance la navigation guidée vers le
    // POI. Présent seulement quand l'appelant fournit onNavigateTo (mode libre).
    const navAction = onNavigateTo
      ? `<button type="button" class="place-popup-link place-popup-link--navigate">
        <i class="fa-solid fa-location-arrow" aria-hidden="true"></i>
        <span>${escapeHtml(t('routes.navigate_here'))}</span>
      </button>`
      : ''
    // « Ajouter à l'itinéraire » : insère le POI dans le tracé courant (au plus proche),
    // sans le remplacer. Présent seulement quand un itinéraire est chargé.
    const insertAction = onInsertVia && hasRoute?.()
      ? `<button type="button" class="place-popup-link place-popup-link--add-route">
        <i class="fa-solid fa-circle-plus" aria-hidden="true"></i>
        <span>${escapeHtml(t('routes.add_to_route'))}</span>
      </button>`
      : ''
    wrap.innerHTML = `
      <div class="place-popup-header">
        <span class="place-popup-name">${escapeHtml(place.name)}</span>
        <button type="button" class="place-popup-close" aria-label="${escapeHtml(t('routes.close'))}">×</button>
      </div>
      ${navAction}
      ${insertAction}
      <a class="place-popup-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">
        <i class="fa-brands fa-google" aria-hidden="true"></i>
        <span>Google Maps</span>
      </a>
      <a class="place-popup-link place-popup-link--streetview" href="${svUrl}" target="_blank" rel="noopener noreferrer">
        <i class="fa-solid fa-street-view" aria-hidden="true"></i>
        <span>${escapeHtml(t('routes.street_view'))}</span>
      </a>`
    // closeOnClick désactivé : un tap carte met l'écran en veille ; la fermeture du
    // popup sur tap carte est gérée explicitement dans le handler de clic de la carte.
    placePopup = new maplibre.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
      .setLngLat([place.lng, place.lat])
      .setDOMContent(wrap)
      .addTo(map)
    // Remplit le marqueur tant que son popup est ouvert.
    activePlaceEl = el
    el.classList.add('place-marker--active')
    wrap.querySelector('.place-popup-close')?.addEventListener('click', closePlacePopup)
    wrap.querySelector('.place-popup-link--navigate')?.addEventListener('click', () => {
      closePlacePopup()
      onNavigateTo?.(place)
    })
    wrap.querySelector('.place-popup-link--add-route')?.addEventListener('click', () => {
      closePlacePopup()
      onInsertVia?.(place)
    })
    const svLink = wrap.querySelector<HTMLElement>('.place-popup-link--streetview')
    if (svLink) {
      checkSV(place.lat, place.lng).then((ok) => {
        svLink.classList.toggle('place-popup-link--disabled', !ok)
        if (!ok) svLink.setAttribute('aria-disabled', 'true')
        else svLink.removeAttribute('aria-disabled')
      })
    }
  }

  // Ferme le popup de POI et retire le surlignage « actif » de son marqueur.
  function closePlacePopup() {
    if (placePopup) { placePopup.remove(); placePopup = null }
    if (activePlaceEl) { activePlaceEl.classList.remove('place-marker--active'); activePlaceEl = null }
  }

  function escapeHtml(s: string) {
    const div = document.createElement('div')
    div.textContent = s
    return div.innerHTML
  }

  // Interroge le service d'imagerie Google : true si une vue Street View existe près
  // du point. Repris du créateur (JSONP best-effort, repli optimiste sur erreur/timeout).
  function svCacheKey(lat: number, lng: number) { return `${lat.toFixed(4)},${lng.toFixed(4)}` }

  function checkSV(lat: number, lng: number): Promise<boolean> {
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

  // ─── POI sauvegardés ──────────────────────────────────────────────────────────
  // Projette les POI du store en NavPlace : le `type` reprend le premier serverType de
  // la catégorie pour que categoryForType (couleur, icône, filtre d'affichage) les
  // classe comme les POI Overpass de même catégorie.
  function syncSavedPlaces() {
    savedPlaces.value = savedPoisStore.pois.value.map((p) => {
      const cat = POI_CATEGORIES.find((c) => c.key === p.category)
      return { name: p.name, type: cat?.serverTypes[0] ?? p.category, lng: p.lng, lat: p.lat, saved: true }
    })
  }

  // Charge une fois les POI sauvegardés et les rend. Best-effort : déconnecté → liste
  // vide. Appelé par l'hôte dès la carte prête (le set curé s'affiche sans recherche).
  async function loadSavedPois() {
    await savedPoisStore.load()
    syncSavedPlaces()
    renderMarkers()
  }

  // Réagit aux changements du store (ajout/suppression depuis une autre vue).
  watch(savedPoisStore.pois, () => { syncSavedPlaces(); renderMarkers() })

  return {
    loadSavedPois,
    setRoutePlaces,
    POI_CATS,
    poiVisible,
    poiCounts,
    loading,
    fetchPlaces,
    nearestVisiblePoi,
    visiblePlaces,
    openPlacePopup,
    togglePoi,
    applyPoiScale,
    closePlacePopup,
    hasOpenPopup: () => placePopup != null,
    routePlaces,
  }
}
