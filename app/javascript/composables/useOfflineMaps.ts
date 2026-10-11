import { ref, computed, watch, type Ref } from 'vue'
import { mapStyleFor, styleCoversPoint, suggestedStyleForPoint, groupForStyle } from '../mapStyles'
import { dataSaverActive, type OfflineMapsBridgeState } from '../companionBridge'
import { t } from '../i18n'
import {
  offlineSupported, hasOfflineArchive, registerOfflineArchive, offlineStyle, OFFLINE_DEFAULTS,
  downloadOfflineArchive, deleteOfflineArchive, estimateOffline, saveOfflinePois, deleteOfflinePois,
  routeSignature, saveArchiveSignature, archiveSignature, deleteArchiveSignature,
  purgeLegacyArchive, OFFLINE_LAYERS, OFFLINE_BUFFER_CHOICES, isOfflineBuffer, saveArchiveBuffer, archiveBuffer, loadBufferPref, saveBufferPref, isOfflineLayer, type OfflineLayer, type DownloadPhase,
} from '../offline/offlineMaps'

// Chaque fond téléchargeable (swisstopo gris/couleur/satellite, IGN plan/ortho) a sa propre
// archive : le coureur coche ce qu'il veut emporter, et ne paie que ça en Mo.
type LayerFlags = Record<OfflineLayer, boolean>
type LayerSigs = Record<OfflineLayer, string | null>

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
  // Pays traversés (codes ISO) quand le site les connaît : plus fiable que les rectangles de
  // `mapStyles.ts`, qui se recouvrent à la frontière — un tracé La Chaux-de-Fonds → Gilley tombe
  // tout entier dans celui de la Suisse. Absent ou vide : on retombe sur les rectangles.
  countries?: Ref<string[]>
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
  const { getMap, getMaplibre, mapStyleId, routeToken, coords, pois, onBaseStyleReload, countries } = opts

  // Dérivés de `OFFLINE_LAYERS` plutôt que recopiés à chaque site d'usage : une couche de
  // plus (IGN) ne doit pas demander de retrouver toutes les initialisations à la main.
  const noLayers = (): LayerFlags =>
    Object.fromEntries(OFFLINE_LAYERS.map((l) => [l, false])) as LayerFlags
  const noBuffers = (): Record<OfflineLayer, number> =>
    Object.fromEntries(OFFLINE_LAYERS.map((l) => [l, 0])) as Record<OfflineLayer, number>
  const noSigs = (): LayerSigs =>
    Object.fromEntries(OFFLINE_LAYERS.map((l) => [l, null])) as LayerSigs

  let baseIsOffline = false              // le fond actif est-il la version locale ?
  const offlineIsSup = offlineSupported()
  const offlineDownloading = ref(false)
  const offlineProgress = ref({ done: 0, total: 0, failed: 0 })
  const offlineErrored = ref(false)
  // Étape en cours (tuiles, comblement, assemblage, écriture) et fond concerné : la barre ne
  // bouge plus une fois les tuiles reçues, or le traitement local est la partie longue.
  const offlinePhase = ref<{ phase: DownloadPhase; layer: OfflineLayer | null; sub: number | null }>(
    { phase: 'tiles', layer: null, sub: null },
  )
  let offlineAbort: AbortController | null = null
  // Archives présentes dans l'OPFS, et celles branchées sur le protocole pmtiles://.
  const offlineHas = ref<LayerFlags>(noLayers())
  let offlineRegistered: LayerFlags = noLayers()
  // Couches cochées pour le prochain téléchargement.
  const offlineSelected = ref<LayerFlags>(noLayers())
  // Empreinte du tracé au moment du téléchargement, par couche. `null` = archive absente, ou
  // téléchargée avant l'introduction du suivi (on ne réclame alors rien).
  const archivedSigs = ref<LayerSigs>(noSigs())
  // Marge de chaque côté du tracé pour le prochain téléchargement, et celle de chaque archive
  // déjà présente (une marge plus large demandée depuis reste « à télécharger »).
  const offlineBufferM = ref<number>(loadBufferPref())
  const archivedBuffers = ref<Record<OfflineLayer, number>>(noBuffers())

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
  // Une couche cochée n'est pas encore téléchargée : `offlineReady` (« au moins une archive »)
  // ne suffit plus à dire qu'il n'y a rien à faire — un tracé Suisse + France peut avoir son
  // fond suisse et attendre encore le français.
  const offlineMissing = computed(() => selectedLayers.value.some(
    (l) => !offlineHas.value[l] || archivedBuffers.value[l] < offlineBufferM.value,
  ))
  function setOfflineBuffer(m: number) {
    if (!isOfflineBuffer(m)) return
    offlineBufferM.value = m
    saveBufferPref(m)
  }
  const corridor = () => ({ ...OFFLINE_DEFAULTS, bufferM: offlineBufferM.value })
  const offlineEst = computed(() => estimateOffline(coords.value, selectedLayers.value, corridor()))
  // Vue à plat pour le panneau : une ligne par fond téléchargeable.
  const offlineLayerRows = computed(() =>
    OFFLINE_LAYERS.map((id) => ({ id, ready: offlineHas.value[id], stale: layerStale(id), selected: offlineSelected.value[id] })),
  )
  // `id` en `string` et pas `OfflineLayer` : outre le panneau web (dont les lignes sont déjà
  // typées), l'appli mobile appelle ce geste via `companionBridge.ts` avec un id de couche
  // qu'elle ne fait que relayer — une version plus ancienne ou plus récente de l'appli, ou un
  // message malformé, ne doit pas pouvoir écrire une clé arbitraire dans `offlineSelected`.
  function toggleOfflineLayer(id: string) {
    if (!isOfflineLayer(id)) return
    offlineSelected.value = { ...offlineSelected.value, [id]: !offlineSelected.value[id] }
  }
  const offlinePct = computed(() =>
    offlineProgress.value.total ? Math.round((offlineProgress.value.done / offlineProgress.value.total) * 100) : 0,
  )

  function phaseLabel(): string {
    const { phase, layer, sub } = offlinePhase.value
    const step = t(`routes.offline_phase_${phase}`)
    const suffix = sub != null ? ` (${sub} %)` : ''
    return layer ? `${t(`strava.map_style_${layer}`)} — ${step}${suffix}` : step
  }

  // Ce que l'appli mobile voit du téléchargement (`pushOfflineMapsState`). Ici plutôt que dans
  // chaque page : la navigation et la page de téléchargement seul (`OfflineDownloader.vue`)
  // parlent exactement le même message, donc l'appli n'a qu'un langage à comprendre.
  const bridgeState = computed<OfflineMapsBridgeState>(() => ({
    supported: offlineIsSup && !!routeToken.value,
    ready: offlineReady.value,
    stale: offlineStale.value,
    missing: offlineMissing.value,
    bufferM: offlineBufferM.value,
    bufferChoices: [...OFFLINE_BUFFER_CHOICES],
    downloading: offlineDownloading.value,
    pct: offlinePct.value,
    mb: offlineEst.value.mb,
    tiles: offlineEst.value.tiles,
    errored: offlineErrored.value,
    phase: offlineDownloading.value ? phaseLabel() : '',
    // Libellé déjà traduit : l'appli affiche la liste telle quelle, sans tenir sa propre
    // table de libellés par id (cf. `companionBridge.ts`).
    layers: offlineLayerRows.value.map((l) => ({ ...l, label: t(`strava.map_style_${l.id}`) })),
  }))

  function wantOffline(): boolean {
    const id = mapStyleId.value
    if (!isOfflineLayer(id) || !offlineRegistered[id]) return false
    // Sans réseau (comme avant) OU économie de données choisie par l'appli mobile
    // (`dataSaverActive` — voir companionBridge.ts, RouteNavigation.vue) : dans les
    // deux cas on ne veut plus des tuiles en direct. Sans cette seconde condition,
    // l'archive téléchargée restait ignorée tant que le téléphone avait du réseau
    // — exactement le cas où l'économie de données sert — et `transformRequest`
    // bloquait alors les tuiles en direct sans jamais faire apparaître les locales.
    return dataSaverActive.value || (typeof navigator !== 'undefined' && navigator.onLine === false)
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
    archivedSigs.value = noSigs()
    archivedBuffers.value = noBuffers()
    const token = routeToken.value
    if (token && offlineIsSup) {
      void purgeLegacyArchive(token)
      const has = noLayers()
      const sigs: LayerSigs = noSigs()
      const buffers = noBuffers()
      for (const l of OFFLINE_LAYERS) {
        if (!await hasOfflineArchive(token, l)) continue
        has[l] = true
        sigs[l] = archiveSignature(token, l)
        buffers[l] = archiveBuffer(token, l)
        if (maplibre) {
          try { await registerOfflineArchive(token, l, maplibre); offlineRegistered[l] = true } catch { /* archive illisible : on reste en ligne */ }
        }
      }
      offlineHas.value = has
      archivedSigs.value = sigs
      archivedBuffers.value = buffers
      // Une carte déjà là montre la marge avec laquelle elle a été faite (la plus large s'il y
      // en a plusieurs), pas un réglage qui ne dirait rien de ce qui est stocké. Sans archive,
      // on garde la dernière marge choisie. Non mémorisé : ce n'est pas un choix de l'utilisateur.
      const stored = OFFLINE_LAYERS.filter((l) => has[l]).map((l) => buffers[l])
      if (stored.length > 0) {
        const widest = Math.max(...stored)
        if (isOfflineBuffer(widest)) offlineBufferM.value = widest
      }
    }
    resetOfflineSelection()
    refreshBaseMap()
  }

  // Fond représentant de chaque pays archivable (même choix que `MAP_STYLE_GROUP_DEFAULT`).
  const COUNTRY_LAYER: Record<string, OfflineLayer> = { CH: 'swisstopo', FR: 'ignplan' }

  // Un fond par pays traversé qu'aucun fond coché ne couvre déjà (même groupe régional).
  function layersForCountries(selected: OfflineLayer[]): OfflineLayer[] {
    const added: OfflineLayer[] = []
    for (const code of countries?.value ?? []) {
      const layer = COUNTRY_LAYER[code.toUpperCase()]
      if (!layer || selected.includes(layer) || added.includes(layer)) continue
      const group = groupForStyle(layer)
      if ([...selected, ...added].some((l) => groupForStyle(l) === group)) continue
      added.push(layer)
    }
    return added
  }

  // Fonds à ajouter pour que la sélection couvre TOUT le tracé : un itinéraire à cheval sur deux
  // pays (Suisse + France) n'est couvert par aucun fond régional seul — swisstopo hors de Suisse
  // ne sert que du vide, qu'on comble en flou. Pour chaque point échantillonné qu'aucun fond
  // coché ne couvre, on ajoute le fond représentant de son pays s'il est archivable ; il couvre
  // alors les points suivants du même pays, d'où au plus un fond par pays traversé.
  function layersMissingFor(selected: OfflineLayer[]): OfflineLayer[] {
    const line = coords.value
    if (line.length === 0) return []
    const step = Math.max(1, Math.floor(line.length / 300))
    const have = [...selected]
    const added: OfflineLayer[] = []
    for (let i = 0; i < line.length; i += step) {
      const [lng, lat] = line[i]
      if (have.some((l) => styleCoversPoint(l, lng, lat))) continue
      const candidate = suggestedStyleForPoint({ lng, lat })
      if (!isOfflineLayer(candidate) || have.includes(candidate)) continue
      have.push(candidate)
      added.push(candidate)
    }
    return added
  }

  // Pré-coche ce qui est déjà téléchargé (pour proposer un re-téléchargement à l'identique),
  // à défaut le fond actif s'il est archivable ; puis complète pour les pays que ces fonds ne
  // couvrent pas (cf. `layersMissingFor`). Le gris suisse reste le repli quand rien n'a pu
  // être déduit du tracé (fond actif mondial, tracé hors de toute zone connue).
  function resetOfflineSelection() {
    const sel = noLayers()
    for (const l of OFFLINE_LAYERS) sel[l] = offlineHas.value[l]
    if (!OFFLINE_LAYERS.some((l) => sel[l]) && isOfflineLayer(mapStyleId.value)) sel[mapStyleId.value] = true
    for (const l of layersForCountries(OFFLINE_LAYERS.filter((id) => sel[id]))) sel[l] = true
    for (const l of layersMissingFor(OFFLINE_LAYERS.filter((id) => sel[id]))) sel[l] = true
    if (!OFFLINE_LAYERS.some((l) => sel[l])) sel.swissgrau = true
    offlineSelected.value = sel
  }

  // Appelée quand l'archive d'une couche vient d'être écrite, pour le tracé d'empreinte `sig`.
  async function onOfflineAvailable(layer: OfflineLayer, sig: string, bufferM: number) {
    const maplibre = getMaplibre()
    offlineHas.value = { ...offlineHas.value, [layer]: true }
    archivedSigs.value = { ...archivedSigs.value, [layer]: sig }
    archivedBuffers.value = { ...archivedBuffers.value, [layer]: bufferM }
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
    archivedSigs.value = noSigs()
    archivedBuffers.value = noBuffers()
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
    // Figée comme le tracé : un changement de marge pendant le téléchargement vaut pour le suivant.
    const dlCorridor = corridor()
    const perLayer = estimateOffline(dlCoords, [layers[0]], dlCorridor).tiles
    offlineErrored.value = false
    offlineDownloading.value = true
    offlineProgress.value = { done: 0, total: perLayer * layers.length, failed: 0 }
    offlineAbort = new AbortController()
    try {
      let base = 0
      let failed = 0
      for (const layer of layers) {
        await downloadOfflineArchive(
          token, layer, dlCoords, dlCorridor,
          (p) => {
            offlineProgress.value = { done: base + p.done, total: perLayer * layers.length, failed: failed + p.failed }
            offlinePhase.value = { phase: p.phase, layer, sub: p.sub ?? null }
          },
          offlineAbort.signal,
        )
        base += perLayer
        failed = offlineProgress.value.failed
        saveArchiveSignature(token, layer, sig)
        saveArchiveBuffer(token, layer, dlCorridor.bufferM)
        // Le trajet a pu être déchargé/remplacé pendant le téléchargement : ne branche
        // l'archive que si elle correspond toujours au trajet affiché.
        if (routeToken.value === token) await onOfflineAvailable(layer, sig, dlCorridor.bufferM)
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

  // Bascule le fond dès que l'appli mobile active/désactive l'économie de données en
  // pleine sortie — même geste que les écouteurs `online`/`offline` de RouteNavigation.vue,
  // pour la même raison : sans lui, activer le réglage depuis le menu ⋮ n'aurait d'effet
  // qu'au prochain rechargement de la page.
  watch(dataSaverActive, refreshBaseMap)

  return {
    offlineIsSup,
    offlineDownloading, offlineProgress, offlineErrored, offlinePhase, bridgeState,
    offlineReady, offlineStale, offlineMissing, offlinePct, offlineEst, offlineLayerRows, selectedLayers,
    toggleOfflineLayer, offlineBufferM, setOfflineBuffer,
    resolveBaseStyle, refreshBaseMap, noteBaseReloaded, syncOfflineState,
    startOfflineDownload, cancelOfflineDownload, removeOfflineMap,
  }
}
