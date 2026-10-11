<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { useOfflineMaps } from '../composables/useOfflineMaps'
import { registerOfflineMapsHandlers, pushOfflineMapsState } from '../companionBridge'
import { userPreferences } from '../userPreferences'
import { styleCoversPoint, suggestedStyleForPoint } from '../mapStyles'

// Télécharge la carte hors-ligne d'un itinéraire SANS ouvrir la navigation.
//
// L'appli mobile charge cette page dans un WebView hors écran depuis la liste de ses
// itinéraires : même stockage (OPFS) que la navigation, donc l'archive est ensuite trouvée
// là-bas, mais sans carte, sans GPS, sans écran gardé allumé — et surtout sans toucher à la
// session de navigation mémorisée (`navSession`), que charger la vraie page écraserait : le
// « Continuer l'itinéraire en cours » de l'appli pointerait sur le tracé qu'on vient de
// télécharger.
//
// Même sous-système (`useOfflineMaps`) et même message vers l'appli que la navigation : elle
// n'a qu'un langage à comprendre. Ne manque que ce qui touche la carte (`getMap`/`getMaplibre`
// nuls : le composable les protège), donc pas de branchement de l'archive ici — c'est la
// navigation qui la branche à son ouverture.

const props = defineProps<{ shareToken: string }>()

const routeToken = ref<string | null>(null)
const coords = ref<[number, number][]>([])
const pois = ref<Array<{ name: string; type: string; lat: number; lng: number }>>([])
const mapStyleId = ref(userPreferences().navigation.default_style as string)
const loadFailed = ref(false)

const {
  offlineErrored, offlineDownloading, offlineReady, offlineStale, offlinePct, bridgeState,
  syncOfflineState, startOfflineDownload, cancelOfflineDownload,
} = useOfflineMaps({
  getMap: () => null,
  getMaplibre: () => null,
  mapStyleId,
  routeToken,
  coords,
  pois,
  onBaseStyleReload: () => {},
})

registerOfflineMapsHandlers({
  start: () => { void startOfflineDownload() },
  cancel: cancelOfflineDownload,
  remove: () => {},
  toggleLayer: () => {},
})
onBeforeUnmount(() => registerOfflineMapsHandlers(null))

watch(bridgeState, (state) => pushOfflineMapsState(state), { immediate: true, deep: true })

onMounted(async () => {
  try {
    const res = await fetch(`/api/routes/shared/${props.shareToken}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    const route = data.route || data
    const geom = (route.geometry || []) as number[][]
    if (geom.length < 2) throw new Error('no_geometry')
    coords.value = geom.map(([lng, lat]) => [lng, lat])
    pois.value = Array.isArray(route.pois) ? route.pois : []
    // Même choix de fond que la navigation à l'ouverture : le fond préféré du compte s'il
    // couvre le départ, sinon celui du pays — c'est ce qui sera pré-coché.
    const [lng, lat] = geom[0]
    mapStyleId.value = styleCoversPoint(mapStyleId.value, lng, lat)
      ? mapStyleId.value
      : suggestedStyleForPoint({ lng, lat })
    routeToken.value = props.shareToken
    // Pré-coche (archives déjà là, sinon fond actif) puis décide : une archive à jour n'est
    // pas refaite, l'appli le lit dans l'état (`ready && !stale`) et conclut tout de suite.
    await syncOfflineState()
    if (!offlineReady.value || offlineStale.value) await startOfflineDownload()
  } catch {
    loadFailed.value = true
    offlineErrored.value = true
  }
})
</script>

<template>
  <div class="container py-5 text-center">
    <p v-if="loadFailed || offlineErrored" class="text-danger mb-0">{{ t('routes.offline_error') }}</p>
    <p v-else-if="offlineDownloading" class="mb-0">{{ bridgeState.phase }} · {{ offlinePct }} %</p>
    <p v-else-if="offlineReady && !offlineStale" class="mb-0">{{ t('routes.offline_ready') }}</p>
    <p v-else class="mb-0">…</p>
  </div>
</template>
