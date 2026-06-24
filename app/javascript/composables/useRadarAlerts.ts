import { ref, watch, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import { radarStore } from '../stores/radarStore'
import { connectRadar, disconnectRadar, hasKnownRadar } from '../variaRadar'
import { playRadarThreat, playRadarClose } from '../navAudio'
import { userPreferences } from '../userPreferences'

// Radar arrière (Garmin Varia) : connexion/déconnexion et alertes sonores. Partagé
// entre navigation libre et navigation sur itinéraire.
//
// État exposé au template via le store (radarStore). Le clic est un geste utilisateur,
// requis par Web Bluetooth pour ouvrir le sélecteur d'appareil ; si un Varia a déjà
// été appairé, le clic le reconnecte directement (radarKnown l'indique dans le libellé).
//
// Alertes sonores, deux niveaux, chacun déclenché une seule fois par véhicule
// (suivi par id de cible) : entrée en portée → bip d'avertissement ; passage sous le
// seuil rapproché → bip insistant. On ne re-bipe pas tant que la même voiture reste
// dans le même état ; le watchdog du store vide la liste une fois la voie dégagée,
// donc une nouvelle approche re-déclenche bien les alertes.
// `muted` (optionnel) coupe ponctuellement toutes les alertes radar sans toucher au
// réglage son — p.ex. pendant la recherche d'un nouvel itinéraire, où l'utilisateur a
// la tête dans la carte et pas sur la route.
export function useRadarAlerts(deps: { soundOn: Ref<boolean>; muted?: Ref<boolean> }) {
  const { soundOn, muted } = deps
  const RADAR_CLOSE_M = userPreferences().navigation.radar_close_m

  const radarKnown = ref(false)
  void hasKnownRadar().then((known) => { radarKnown.value = known })

  function toggleRadar() {
    if (radarStore.isConnected.value || radarStore.status.value === 'connecting') {
      disconnectRadar()
    } else {
      void connectRadar()
    }
  }

  let knownThreatIds = new Set<number>()
  let closeAlertedIds = new Set<number>()
  watch(() => radarStore.targets.value, (targets) => {
    if (soundOn.value && !muted?.value) {
      if (targets.some((tg) => !knownThreatIds.has(tg.id))) playRadarThreat()
      if (targets.some((tg) => tg.distanceM <= RADAR_CLOSE_M && !closeAlertedIds.has(tg.id))) {
        playRadarClose()
      }
    }
    knownThreatIds = new Set(targets.map((tg) => tg.id))
    // On ne garde l'état « déjà alerté de près » que pour les cibles encore présentes,
    // pour qu'une voiture qui repart puis se rapproche à nouveau re-bipe.
    closeAlertedIds = new Set(
      targets.filter((tg) => tg.distanceM <= RADAR_CLOSE_M).map((tg) => tg.id),
    )
  })

  // Au démontage de l'écran de navigation, on coupe le radar (les deux composants le
  // faisaient dans leur onBeforeUnmount).
  onBeforeUnmount(() => { disconnectRadar() })

  return { radarKnown, toggleRadar }
}
