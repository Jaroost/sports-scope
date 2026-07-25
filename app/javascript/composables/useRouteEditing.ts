import { ref, type Ref } from 'vue'
import { t } from '../i18n'
import { computeGainLoss } from '../routeHelpers'
import type { Coord, LngLat, VoiceHint } from '../routeHelpers'
import { fetchRouteFromWaypoints, waypointInsertIndex } from '../navRoute'
import type { Waypoint } from '../navRoute'
import { MAX_WAYPOINTS } from '../stores/routeStore'
import { buildDestPointPopupContent } from '../mapCoordPopup'
import { csrfToken } from '../userPreferences'

export interface UseRouteEditingOptions {
  getMap: () => any
  getMaplibre: () => any
  // Le tracé suivi et ses sources vivent dans le composant en tableaux NON réactifs
  // (gros volumes lus dans des callbacks) : on y accède par accesseurs. `routeWaypoints`
  // est muté en place (splice) et parfois remplacé d'un bloc (annulation) — d'où le setter.
  getGeometry: () => Coord[]
  getRawHints: () => VoiceHint[]
  getCumDistM: () => number[]
  getWaypoints: () => Waypoint[]
  setWaypoints: (waypoints: Waypoint[]) => void
  /** Id de l'itinéraire sauvegardé, ou null (lien partagé d'autrui, destination ad hoc). */
  getRouteId: () => number | null
  loggedIn: boolean
  routeProfile: Ref<string>
  hasRoute: Ref<boolean>
  following: Ref<boolean>
  cameraUnlocked: Ref<boolean>
  // Réinstallation du tracé après un recalcul (mêmes étapes que les autres sources).
  rebuildRouteState: (geometry: Coord[], hints: VoiceHint[]) => void
  resetRouteTracking: (atStart: boolean) => void
  ensureRouteInstalled: () => void
  refreshRemaining: () => void
  persistSession: () => void
  /** Oublie le détour du dernier reroutage : le tracé recalculé n'en a plus. */
  clearDetour: () => void
  closeCoordPopup: () => void
  hideControls: () => void
  recenter: () => void
  showToast: (ok: boolean, message: string) => void
}

// Édition de l'itinéraire en séance. Extrait de RouteNavigation.vue.
//
// Un itinéraire chargé (avec ses points d'ancrage) peut être retouché sans quitter la
// navigation : déplacement, ajout et suppression de points. Chaque modification re-route
// l'itinéraire entier via BRouter (mêmes règles que le créateur, tronçons libres
// compris), puis on relocalise au prochain fix. À la sortie du mode, les modifications
// sont enregistrées sur l'itinéraire sauvegardé (si on en est le propriétaire connecté).
export function useRouteEditing(opts: UseRouteEditingOptions) {
  const {
    getMap, getMaplibre, getGeometry, getRawHints, getCumDistM, getWaypoints, setWaypoints,
    getRouteId, loggedIn, routeProfile, hasRoute, following, cameraUnlocked,
    rebuildRouteState, resetRouteTracking, ensureRouteInstalled, refreshRemaining,
    persistSession, clearDetour, closeCoordPopup, hideControls, recenter, showToast,
  } = opts

  // Mode édition : affiche les points d'ancrage déplaçables ; un tap sur la carte en
  // ajoute un (au plus proche du tracé), un tap sur un point ouvre sa suppression.
  const editMode = ref(false)
  // Bandeau d'aide de l'édition : visible à l'entrée, masqué dès qu'on tape dessus
  // (il recouvre la poignée du tiroir de commandes en haut au centre).
  const editHintVisible = ref(false)
  // Recalcul BRouter d'une édition en cours : neutralise les actions concurrentes.
  const editBusy = ref(false)
  // Vrai dès qu'un point a été modifié : pilote l'enregistrement à la sortie du mode.
  const editDirty = ref(false)
  const editError = ref<string | null>(null)
  const editSaving = ref(false)
  // L'itinéraire est-il éditable ? Il faut ses points d'ancrage (≥ 2). Les waypoints ne
  // sont pas réactifs (gros tableau lu dans des callbacks), donc on reflète l'éligibilité
  // dans ce ref, recalculé via syncEditable() aux moments où elle peut changer
  // (chargement, reroutage, déchargement).
  const canEditRoute = ref(false)

  let editMarkers: any[] = []
  let editPopup: any = null
  let editToken = 0
  // Instantané de l'itinéraire pris à l'entrée du mode édition : permet d'annuler
  // (restaurer points d'ancrage, géométrie et voicehints d'origine) sans enregistrer.
  let editSnapshot: { waypoints: Waypoint[]; geometry: Coord[]; hints: VoiceHint[] } | null = null

  function syncEditable() { canEditRoute.value = hasRoute.value && getWaypoints().length >= 2 }

  // Cadre la carte sur l'ensemble du tracé (vue tous-points).
  function fitRouteBounds() {
    const map = getMap()
    const maplibre = getMaplibre()
    const geometry = getGeometry()
    if (!map || !maplibre || geometry.length < 2) return
    const coords = geometry.map(([lng, lat]) => [lng, lat] as LngLat)
    const b = new maplibre.LngLatBounds(coords[0], coords[0])
    coords.forEach((c) => b.extend(c))
    map.fitBounds(b, { padding: 70, duration: 500, pitch: 0 })
  }

  // Installe une géométrie recalculée à la place du tracé courant, sans toucher à ses
  // sources (points d'ancrage, étapes). Le coureur peut être n'importe où dessus, donc on
  // relocalise au prochain fix plutôt que de repartir du début.
  function installRecomputedRoute(geom: Coord[], hints: VoiceHint[]) {
    rebuildRouteState(geom, hints)
    resetRouteTracking(false)
    clearDetour()
    ensureRouteInstalled()
    refreshRemaining()
    persistSession()
  }

  // Re-route l'itinéraire entier à travers les points d'ancrage courants et remplace la
  // géométrie de navigation. Appelé après chaque déplacement / ajout / suppression en mode
  // édition, et par recomputeForRoutingChange quand le profil de la séance change.
  // `markDirty` n'a de sens qu'en édition : un changement de profil ne modifie pas
  // l'itinéraire sauvegardé, il ne doit donc pas le marquer comme à enregistrer.
  async function recomputeFromWaypoints({ markDirty = true } = {}): Promise<boolean> {
    const waypoints = getWaypoints()
    if (waypoints.length < 2) return false
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      editError.value = t('routes.reroute_offline')
      return false
    }
    editBusy.value = true
    editError.value = null
    const token = ++editToken
    try {
      const { geometry: geom, hints } = await fetchRouteFromWaypoints(waypoints, routeProfile.value)
      if (token !== editToken) return false
      installRecomputedRoute(geom, hints)
      if (markDirty) editDirty.value = true
      return true
    } catch {
      if (token === editToken) editError.value = t('routes.error_routing')
      return false
    } finally {
      if (token === editToken) editBusy.value = false
    }
  }

  function closeEditPopup() {
    if (editPopup) { editPopup.remove(); editPopup = null }
  }

  /** Une bulle d'ancrage est-elle ouverte ? (un tap sur la carte la referme d'abord). */
  function hasEditPopup(): boolean { return editPopup != null }

  // Renumérote les pastilles d'ancrage d'après leur rang courant.
  function renumberEditMarkers() {
    editMarkers.forEach((m, i) => {
      const span = m.getElement().querySelector('.nav-edit-num')
      if (span) span.textContent = String(i + 1)
    })
  }

  // (Re)pose un marqueur déplaçable par point d'ancrage. Glisser-déposer → met à jour le
  // point et re-route ; un tap (sans glissement) ouvre la suppression.
  function makeEditMarker(wp: Waypoint): any {
    const el = document.createElement('div')
    el.className = 'nav-edit-marker'
    el.innerHTML = '<span class="nav-edit-num"></span>'
    const marker = new (getMaplibre().Marker)({ element: el, anchor: 'center', draggable: true })
      .setLngLat([wp.lng, wp.lat]).addTo(getMap())
    let dragged = false
    marker.on('dragstart', () => { dragged = true; closeEditPopup() })
    marker.on('dragend', () => {
      const idx = editMarkers.indexOf(marker)
      if (idx >= 0) {
        const ll = marker.getLngLat()
        const waypoints = getWaypoints()
        waypoints[idx] = { ...waypoints[idx], lng: ll.lng, lat: ll.lat }
        void recomputeFromWaypoints()
      }
      setTimeout(() => { dragged = false }, 300)
    })
    el.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (dragged) return
      showEditPointPopup(marker)
    })
    return marker
  }

  // Tooltip d'un point d'ancrage (clic sur sa pastille) : suppression + liens carto.
  function showEditPointPopup(marker: any) {
    const map = getMap()
    const maplibre = getMaplibre()
    if (!maplibre || !map) return
    const idx = editMarkers.indexOf(marker)
    if (idx < 0) return
    closeEditPopup()
    const wp = getWaypoints()[idx]
    editPopup = new maplibre.Popup({ offset: 18, closeButton: false, closeOnClick: false, className: 'place-popup-container' })
      .setLngLat([wp.lng, wp.lat])
      .setDOMContent(buildDestPointPopupContent(wp.lng, wp.lat, closeEditPopup, () => {
        closeEditPopup()
        const i = editMarkers.indexOf(marker)
        if (i >= 0) removeEditWaypoint(i)
      }))
      .addTo(map)
  }

  function refreshEditMarkers() {
    for (const m of editMarkers) m.remove()
    editMarkers = []
    if (!getMap() || !getMaplibre() || !editMode.value) return
    getWaypoints().forEach((w) => editMarkers.push(makeEditMarker(w)))
    renumberEditMarkers()
  }

  // Ajoute un point d'ancrage au tap sur la carte (inséré au plus proche du tracé).
  function addEditWaypoint(lng: number, lat: number) {
    const waypoints = getWaypoints()
    if (waypoints.length >= MAX_WAYPOINTS) {
      editError.value = t('routes.error_max_waypoints', { count: MAX_WAYPOINTS })
      return
    }
    waypoints.splice(waypointInsertIndex(getGeometry(), waypoints, lng, lat), 0, { lng, lat })
    refreshEditMarkers()
    void recomputeFromWaypoints()
  }

  // Retire un point d'ancrage (on en garde au moins deux).
  function removeEditWaypoint(idx: number) {
    const waypoints = getWaypoints()
    if (waypoints.length <= 2) { editError.value = t('routes.error_min_points'); return }
    waypoints.splice(idx, 1)
    refreshEditMarkers()
    void recomputeFromWaypoints()
  }

  function enterEditMode() {
    if (!canEditRoute.value) return
    editMode.value = true
    editHintVisible.value = true
    editError.value = null
    editDirty.value = false
    // Sauvegarde l'état d'origine pour pouvoir l'annuler (copies profondes : ces tableaux
    // sont mutés en place pendant l'édition).
    editSnapshot = {
      waypoints: getWaypoints().map((w) => ({ ...w })),
      geometry: getGeometry().map((c) => [...c] as Coord),
      hints: getRawHints().map((h) => ({ ...h })),
    }
    // L'édition se fait carte en main : on débraye le suivi caméra et on referme le tiroir.
    following.value = false
    cameraUnlocked.value = true
    closeCoordPopup()
    hideControls()
    fitRouteBounds()
    refreshEditMarkers()
  }

  // Retire marqueurs et popup d'édition et quitte le mode (sans enregistrer).
  function closeEditMode() {
    destroyEditOverlays()
    editMode.value = false
    editError.value = null
    editSnapshot = null
  }

  /** Retire bulle et marqueurs de la carte, sans toucher à l'état du mode (démontage). */
  function destroyEditOverlays() {
    closeEditPopup()
    for (const m of editMarkers) m.remove()
    editMarkers = []
  }

  // Annule l'édition : restaure l'itinéraire d'origine (si des modifications ont eu lieu),
  // quitte le mode sans enregistrer et rend la caméra au suivi.
  function cancelEditMode() {
    if (editSaving.value) return
    // Neutralise un éventuel reroutage BRouter en cours pour qu'il n'écrase pas la restauration.
    editToken++
    editBusy.value = false
    if (editDirty.value && editSnapshot) {
      setWaypoints(editSnapshot.waypoints)
      rebuildRouteState(editSnapshot.geometry, editSnapshot.hints)
      resetRouteTracking(false)
      ensureRouteInstalled()
      refreshRemaining()
      persistSession()
    }
    closeEditMode()
    following.value = true
    cameraUnlocked.value = false
    recenter()
  }

  // Termine l'édition : enregistre les modifications (si itinéraire possédé et connecté)
  // puis quitte le mode et rend la caméra au suivi.
  async function finishEditMode() {
    if (editBusy.value || editSaving.value) return
    if (editDirty.value && getRouteId() != null && loggedIn) await saveRouteEdits()
    closeEditMode()
    following.value = true
    cameraUnlocked.value = false
    recenter()
  }

  // Enregistre l'itinéraire modifié (PATCH). Silencieux à l'échec d'appartenance (404) :
  // un lien partagé d'autrui n'a pas de routeId → on n'arrive jamais ici dans ce cas.
  async function saveRouteEdits() {
    const routeId = getRouteId()
    if (routeId == null) return
    editSaving.value = true
    try {
      const geometry = getGeometry()
      const cumDistM = getCumDistM()
      const totals = computeGainLoss(geometry)
      const body = JSON.stringify({
        waypoints: getWaypoints(),
        geometry,
        voice_hints: getRawHints(),
        distance_m: cumDistM[cumDistM.length - 1] || 0,
        elevation_gain_m: totals.gain,
        elevation_loss_m: totals.loss,
      })
      const res = await fetch(`/api/routes/${routeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
        credentials: 'same-origin',
        body,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      editDirty.value = false
      showToast(true, t('routes.edit_saved'))
    } catch {
      showToast(false, t('routes.edit_save_error'))
    } finally {
      editSaving.value = false
    }
  }

  return {
    editMode, editHintVisible, editBusy, editDirty, editError, editSaving, canEditRoute,
    syncEditable, installRecomputedRoute, recomputeFromWaypoints,
    enterEditMode, cancelEditMode, finishEditMode, closeEditMode, destroyEditOverlays,
    addEditWaypoint, closeEditPopup, hasEditPopup, refreshEditMarkers,
  }
}
