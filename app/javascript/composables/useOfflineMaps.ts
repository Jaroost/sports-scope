import { ref, computed, type Ref } from 'vue'
import { mapStyleFor } from '../mapStyles'
import {
  offlineSupported, hasOfflineArchive, registerOfflineArchive, offlineStyle, OFFLINE_DEFAULTS,
  downloadOfflineArchive, deleteOfflineArchive, estimateOffline, saveOfflinePois, deleteOfflinePois,
  routeSignature, saveArchiveSignature, archiveSignature, deleteArchiveSignature,
  purgeLegacyArchive, OFFLINE_LAYERS, isOfflineLayer, type OfflineLayer,
} from '../offline/offlineMaps'

// Chaque fond swisstopo (gris / couleur / satellite) a sa propre archive : le coureur
// coche ce qu'il veut emporter, et ne paie que ça en Mo.
type LayerFlags = Record<OfflineLayer, boolean>

interface OfflinePoi { name: string; type: string; lat: number; lng: number }

export interface UseOfflineMapsOptions {
  // Accès paresseux à la carte et au module maplibre : tous deux sont (ré)assignés au
  // montage (`initMap`), donc on les lit à l'appel plutôt que de les capturer au setup.
  getMap: () => any
  getMaplibre: () => any
  // Fond de carte actif (préférence de la nav guidée) — lu par wantOffline/resolveBaseStyle.
  mapStyleId: Ref<string>
  // Trajet actif : `null` en navigation libre (rien à archiver).
  routeToken: Ref<string | null>
  // Coordonnées et POI du tracé actif, retenus pour définir le corridor à télécharger.
  coords: Ref<[number, number][]>
  pois: Ref<OfflinePoi[]>
  // Rappelé après un échange du fond de carte (bascule en/hors-ligne) pour réinstaller
  // les couches de tracé et le marqueur de position (cf. `afterStyleLoad` côté composant).
  onBaseStyleReload: () => void
}

// Sous-système « cartes hors-ligne » de la navigation guidée : téléchargement du corridor
// d'un itinéraire (tuiles swisstopo dans l'OPFS), suivi de l'archive, et bascule du fond
// vers la version locale quand le réseau tombe. Extrait de RouteNavigation.vue.
//
// On n'utilise le fond local QUE lorsque le réseau est absent : en ligne, le WMTS reste
// préféré (tuiles fraîches, couverture au-delà du corridor).
export function useOfflineMaps(opts: UseOfflineMapsOptions) {
  const { getMap, getMaplibre, mapStyleId, routeToken, coords, pois, onBaseStyleReload } = opts

  const noLayers = (): LayerFlags => ({ swissgrau: false, swisstopo: false, swissimage: false })

  let baseIsOffline = false              // le fond actif est-il la version locale ?
  const offlineIsSup = offlineSupported()
  const offlineDownloading = ref(false)
  const offlineProgress = ref({ done: 0, total: 0, failed: 0 })
  const offlineErrored = ref(false)
  let offlineAbort: AbortController | null = null
  // Archives présentes dans l'OPFS, et celles branchées sur le protocole pmtiles://.
  const offlineHas = ref<LayerFlags>(noLayers())
  let offlineRegistered: LayerFlags = noLayers()
  // Couches cochées pour le prochain téléchargement.
  const offlineSelected = ref<LayerFlags>(noLayers())
  // Empreinte du tracé au moment du téléchargement, par couche. `null` = archive absente, ou
  // téléchargée avant l'introduction du suivi (on ne réclame alors rien).
  const archivedSigs = ref<Record<OfflineLayer, string | null>>({ swissgrau: null, swisstopo: null, swissimage: null })

  // Le tracé a changé depuis le téléchargement (reroutage, détour, édition) : l'archive ne
  // couvre plus tout l'itinéraire, il faut la retélécharger.
  const currentSig = computed(() => routeSignature(coords.value))
  function layerStale(l: OfflineLayer): boolean {
    const sig = archivedSigs.value[l]
    return offlineHas.value[l] && !!sig && sig !== currentSig.value
  }
  const offlineReady = computed(() => OFFLINE_LAYERS.some((l) => offlineHas.value[l]))
  const offlineStale = computed(() => OFFLINE_LAYERS.some(layerStale))
  const selectedLayers = computed(() => OFFLINE_LAYERS.filter((l) => offlineSelected.value[l]))
  const offlineEst = computed(() => estimateOffline(coords.value, selectedLayers.value))
  // Vue à plat pour le panneau : une ligne par fond téléchargeable.
  const offlineLayerRows = computed(() =>
    OFFLINE_LAYERS.map((id) => ({ id, ready: offlineHas.value[id], stale: layerStale(id), selected: offlineSelected.value[id] })),
  )
  function toggleOfflineLayer(id: OfflineLayer) {
    offlineSelected.value = { ...offlineSelected.value, [id]: !offlineSelected.value[id] }
  }
  const offlinePct = computed(() =>
    offlineProgress.value.total ? Math.round((offlineProgress.value.done / offlineProgress.value.total) * 100) : 0,
  )

  function wantOffline(): boolean {
    const id = mapStyleId.value
    return isOfflineLayer(id) && offlineRegistered[id] && typeof navigator !== 'undefined' && navigator.onLine === false
  }

  function resolveBaseStyle(id: string): string | object {
    if (isOfflineLayer(id) && wantOffline()) return offlineStyle(routeToken.value!, id, OFFLINE_DEFAULTS.maxZoom)
    return mapStyleFor(id)
  }

  // À appeler après que le composant a (ré)appliqué le fond de carte, pour mémoriser
  // si le fond courant est la version locale (remplace `baseIsOffline = wantOffline()`).
  function noteBaseReloaded() { baseIsOffline = wantOffline() }

  // Recharge le fond seulement si la décision en-ligne/hors-ligne a changé (évite un
  // rechargement à chaque scintillement de connectivité).
  function refreshBaseMap() {
    const map = getMap()
    if (!map) return
    const want = wantOffline()
    if (want === baseIsOffline) return
    baseIsOffline = want
    map.setStyle(resolveBaseStyle(mapStyleId.value), { diff: false })
    map.once('style.load', onBaseStyleReload)
  }

  // (Re)calcule l'état hors-ligne du trajet courant : présence de l'archive, branchement
  // sur le protocole pmtiles://, empreinte du tracé archivé. À appeler chaque fois que
  // `routeToken` change (montage, choix d'un autre itinéraire, retour en navigation libre)
  // — sans quoi l'archive du trajet précédent resterait annoncée, voire affichée.
  async function syncOfflineState() {
    const maplibre = getMaplibre()
    offlineRegistered = noLayers()
    offlineHas.value = noLayers()
    archivedSigs.value = { swissgrau: null, swisstopo: null, swissimage: null }
    const token = routeToken.value
    if (token && offlineIsSup) {
      void purgeLegacyArchive(token)
      const has = noLayers()
      const sigs: Record<OfflineLayer, string | null> = { swissgrau: null, swisstopo: null, swissimage: null }
      for (const l of OFFLINE_LAYERS) {
        if (!await hasOfflineArchive(token, l)) continue
        has[l] = true
        sigs[l] = archiveSignature(token, l)
        if (maplibre) {
          try { await registerOfflineArchive(token, l, maplibre); offlineRegistered[l] = true } catch { /* archive illisible : on reste en ligne */ }
        }
      }
      offlineHas.value = has
      archivedSigs.value = sigs
    }
    resetOfflineSelection()
    refreshBaseMap()
  }

  // Pré-coche ce qui est déjà téléchargé (pour proposer un re-téléchargement à l'identique),
  // à défaut le fond actif s'il est archivable, sinon le gris.
  function resetOfflineSelection() {
    const sel = noLayers()
    for (const l of OFFLINE_LAYERS) sel[l] = offlineHas.value[l]
    if (!OFFLINE_LAYERS.some((l) => sel[l])) {
      sel[isOfflineLayer(mapStyleId.value) ? mapStyleId.value : 'swissgrau'] = true
    }
    offlineSelected.value = sel
  }

  // Appelée quand l'archive d'une couche vient d'être écrite, pour le tracé d'empreinte `sig`.
  async function onOfflineAvailable(layer: OfflineLayer, sig: string) {
    const maplibre = getMaplibre()
    offlineHas.value = { ...offlineHas.value, [layer]: true }
    archivedSigs.value = { ...archivedSigs.value, [layer]: sig }
    // Re-branchement systématique : après un re-téléchargement, la même clé désigne un
    // nouveau fichier, et le protocole doit servir celui-là.
    if (maplibre && routeToken.value) {
      try { await registerOfflineArchive(routeToken.value, layer, maplibre); offlineRegistered[layer] = true } catch { /* ignore */ }
    }
    refreshBaseMap()
  }

  function onOfflineRemoved() {
    offlineHas.value = noLayers()
    offlineRegistered = noLayers()
    archivedSigs.value = { swissgrau: null, swisstopo: null, swissimage: null }
    resetOfflineSelection()
    refreshBaseMap()
  }

  // Télécharge les couches cochées, l'une après l'autre : la progression affichée agrège les
  // couches (le corridor a le même nombre de tuiles pour chacune). Un échec ou une annulation
  // interrompt la suite, mais les couches déjà écrites restent utilisables.
  async function startOfflineDownload() {
    if (offlineDownloading.value || !routeToken.value) return
    const token = routeToken.value
    const layers = selectedLayers.value
    if (layers.length === 0) return
    // Fige le tracé : un reroutage pendant le téléchargement remplace `coords`, et
    // l'empreinte enregistrée doit décrire ce qui a réellement été archivé.
    const dlCoords = coords.value
    const archivedPois = pois.value
    const sig = routeSignature(dlCoords)
    const perLayer = estimateOffline(dlCoords, [layers[0]]).tiles
    offlineErrored.value = false
    offlineDownloading.value = true
    offlineProgress.value = { done: 0, total: perLayer * layers.length, failed: 0 }
    offlineAbort = new AbortController()
    try {
      let base = 0
      let failed = 0
      for (const layer of layers) {
        await downloadOfflineArchive(
          token, layer, dlCoords, undefined,
          (p) => { offlineProgress.value = { done: base + p.done, total: perLayer * layers.length, failed: failed + p.failed } },
          offlineAbort.signal,
        )
        base += perLayer
        failed = offlineProgress.value.failed
        saveArchiveSignature(token, layer, sig)
        // Le trajet a pu être déchargé/remplacé pendant le téléchargement : ne branche
        // l'archive que si elle correspond toujours au trajet affiché.
        if (routeToken.value === token) await onOfflineAvailable(layer, sig)
      }
      if (archivedPois.length > 0) saveOfflinePois(token, archivedPois)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) offlineErrored.value = true
    } finally {
      offlineDownloading.value = false
      offlineAbort = null
    }
  }

  function cancelOfflineDownload() { offlineAbort?.abort() }

  // Le bouton « Supprimer » libère tout ce qui a été emporté pour ce trajet, toutes couches.
  async function removeOfflineMap() {
    if (!routeToken.value) return
    const token = routeToken.value
    for (const l of OFFLINE_LAYERS) {
      await deleteOfflineArchive(token, l)
      deleteArchiveSignature(token, l)
    }
    deleteOfflinePois(token)
    onOfflineRemoved()
  }

  return {
    offlineIsSup,
    offlineDownloading, offlineProgress, offlineErrored,
    offlineReady, offlineStale, offlinePct, offlineEst, offlineLayerRows, selectedLayers,
    toggleOfflineLayer,
    resolveBaseStyle, refreshBaseMap, noteBaseReloaded, syncOfflineState,
    startOfflineDownload, cancelOfflineDownload, removeOfflineMap,
  }
}
