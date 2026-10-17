import { ref, computed, onBeforeUnmount } from 'vue'

// Radar de précipitations animé sur la carte du créateur d'itinéraire. Extrait de
// RouteBuilderMap.vue.
//
// Même source que le bloc « précipitations » de l'appli compagnon : le catalogue de
// frames RainViewer servi par notre proxy (`/api/rainviewer`) — quelques frames passées
// puis la prévision courte (nowcast), en boucle.
//
// Une couche raster par frame, toutes posées d'emblée, dont seule la frame courante est
// opaque : les tuiles de chaque frame se chargent pendant que les autres s'affichent, la
// boucle ne clignote donc pas à chaque image (échanger l'URL d'une source unique
// rechargerait les tuiles à chaque pas).

interface RadarFrame { time: number; path: string }
interface RadarCatalog { host: string; frames: RadarFrame[] }

const SOURCE_PREFIX = 'radar-src-'
const LAYER_PREFIX = 'radar-layer-'
const FRAME_INTERVAL_MS = 700
// La dernière image (la plus lointaine du nowcast) marque la fin de la boucle : on la
// laisse un peu plus longtemps pour qu'on voie où elle reprend.
const LAST_FRAME_HOLD_MS = 1400
const RADAR_OPACITY = 0.75
// RainViewer ne sert rien au-delà de ce zoom (la tuile est une image d'erreur) : au-delà,
// MapLibre agrandit les tuiles du zoom 7.
const RADAR_MAX_ZOOM = 7
// Les calques d'itinéraire sont posés après coup : le radar doit rester sous eux.
const BEFORE_LAYER = 'builder-route-border'

export interface UseMapRadarOptions {
  getMap: () => any
}

export function useMapRadar(opts: UseMapRadarOptions) {
  const { getMap } = opts

  /** Le radar est-il affiché ? Pilote l'état enfoncé du bouton. */
  const radarVisible = ref(false)
  /** Catalogue en cours de relevé. */
  const radarLoading = ref(false)
  const playing = ref(true)
  const frames = ref<RadarFrame[]>([])
  const frameIndex = ref(0)

  let host = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const currentFrame = computed(() => frames.value[frameIndex.value] ?? null)

  /** Décalage de la frame courante par rapport à maintenant, en minutes arrondies à 5. */
  const offsetMinutes = computed(() => {
    const f = currentFrame.value
    if (!f) return 0
    return Math.round((f.time * 1000 - Date.now()) / 300000) * 5
  })

  function tileUrl(f: RadarFrame): string {
    return `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`
  }

  function removeLayers() {
    const map = getMap()
    if (!map) return
    for (let i = 0; map.getLayer(LAYER_PREFIX + i) || map.getSource(SOURCE_PREFIX + i); i++) {
      if (map.getLayer(LAYER_PREFIX + i)) map.removeLayer(LAYER_PREFIX + i)
      if (map.getSource(SOURCE_PREFIX + i)) map.removeSource(SOURCE_PREFIX + i)
    }
  }

  function installLayers() {
    const map = getMap()
    if (!map || !frames.value.length) return
    removeLayers()
    const before = map.getLayer(BEFORE_LAYER) ? BEFORE_LAYER : undefined
    frames.value.forEach((f, i) => {
      map.addSource(SOURCE_PREFIX + i, {
        type: 'raster', tiles: [tileUrl(f)], tileSize: 256, maxzoom: RADAR_MAX_ZOOM,
      })
      map.addLayer({
        id: LAYER_PREFIX + i, type: 'raster', source: SOURCE_PREFIX + i,
        paint: {
          'raster-opacity': i === frameIndex.value ? RADAR_OPACITY : 0,
          'raster-opacity-transition': { duration: 0 },
          'raster-fade-duration': 0,
        },
      }, before)
    })
  }

  function paintFrame() {
    const map = getMap()
    if (!map) return
    frames.value.forEach((_, i) => {
      if (map.getLayer(LAYER_PREFIX + i)) {
        map.setPaintProperty(LAYER_PREFIX + i, 'raster-opacity', i === frameIndex.value ? RADAR_OPACITY : 0)
      }
    })
  }

  function stopTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  function scheduleNext() {
    stopTimer()
    if (!radarVisible.value || !playing.value || frames.value.length < 2) return
    const last = frameIndex.value === frames.value.length - 1
    timer = setTimeout(() => {
      setFrame((frameIndex.value + 1) % frames.value.length)
      scheduleNext()
    }, last ? LAST_FRAME_HOLD_MS : FRAME_INTERVAL_MS)
  }

  /** Va à une frame précise (curseur) ; la lecture, si elle tourne, repart de là. */
  function setFrame(i: number) {
    frameIndex.value = Math.max(0, Math.min(i, frames.value.length - 1))
    paintFrame()
  }

  function seek(i: number) {
    setFrame(i)
    scheduleNext()
  }

  function togglePlay() {
    playing.value = !playing.value
    if (playing.value) scheduleNext(); else stopTimer()
  }

  async function fetchCatalog(): Promise<RadarCatalog | null> {
    try {
      const res = await fetch('/api/rainviewer', { headers: { Accept: 'application/json' } })
      if (!res.ok || res.status === 204) return null
      const json = await res.json()
      if (typeof json?.host !== 'string' || !Array.isArray(json.frames) || !json.frames.length) return null
      return json
    } catch {
      return null
    }
  }

  function hide() {
    stopTimer()
    removeLayers()
    radarVisible.value = false
  }

  /** Réinstalle les couches après un changement de fond de carte, s'il était affiché. */
  function reinstallLayers() {
    if (!radarVisible.value) return
    installLayers()
    scheduleNext()
  }

  // Bouton radar : relève le catalogue puis lance la boucle, ou l'éteint s'il tournait.
  // Un catalogue indisponible laisse simplement le bouton relâché.
  async function toggle() {
    if (radarVisible.value) { hide(); return }
    radarLoading.value = true
    try {
      const catalog = await fetchCatalog()
      if (!catalog || !getMap()) return
      host = catalog.host
      frames.value = catalog.frames
      // On démarre sur la première frame pour que la boucle raconte passé → prévision.
      frameIndex.value = 0
      playing.value = true
      radarVisible.value = true
      installLayers()
      scheduleNext()
    } finally {
      radarLoading.value = false
    }
  }

  onBeforeUnmount(stopTimer)

  return {
    radarVisible, radarLoading, playing, frames, frameIndex, currentFrame, offsetMinutes,
    toggle, togglePlay, seek, reinstallLayers,
  }
}
