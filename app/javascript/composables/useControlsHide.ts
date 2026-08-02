import { ref, onScopeDispose } from 'vue'

// Auto-masquage des boutons de commande (interface épurée en séance). Partagé entre
// navigation libre et navigation sur itinéraire.
//
// Les commandes (retour, style de carte, son, caméra, POI…) encombrent la vue
// une fois la séance lancée. On les affiche au démarrage (découvrabilité) puis on les
// estompe après quelques secondes d'inactivité ; un swipe vers le haut depuis le bord
// bas les rappelle (cf. useRevealGesture).
//
// L'appelant fournit isPanelOpen() — vrai tant qu'un sous-panneau (caméra / POI /
// débug) est ouvert, auquel cas on ne masque pas (l'utilisateur règle quelque chose)
// et on réarme le minuteur — et closePanels(), appelé par hideControls pour refermer
// ces sous-panneaux immédiatement.
//
// enabled: false désactive le tiroir de bout en bout — il ne s'ouvre jamais, pas même
// les quelques secondes du départ. C'est le cas de l'application mobile, dont la
// coquille native possède désormais le bas de l'écran et affichera ces réglages
// elle-même : un tiroir web qu'on ne peut plus rappeler ne ferait que voler de la
// carte au démarrage.
const CONTROLS_HIDE_MS = 4000

export function useControlsHide(deps: {
  isPanelOpen: () => boolean
  closePanels: () => void
  enabled?: boolean
}) {
  const { isPanelOpen, closePanels, enabled = true } = deps
  const controlsVisible = ref(enabled)
  let controlsHideId: number | null = null

  function armControlsHide() {
    if (!enabled) return
    if (controlsHideId != null) clearTimeout(controlsHideId)
    controlsHideId = window.setTimeout(() => {
      controlsHideId = null
      if (isPanelOpen()) { armControlsHide(); return }
      controlsVisible.value = false
    }, CONTROLS_HIDE_MS)
  }

  function showControls() {
    if (!enabled) return
    controlsVisible.value = true
    armControlsHide()
  }

  // Referme le tiroir immédiatement (et ses sous-panneaux). Appelé sur un tap hors du
  // tiroir : on n'attend plus l'auto-masquage. On annule le minuteur pour éviter un
  // double déclenchement.
  function hideControls() {
    if (controlsHideId != null) { clearTimeout(controlsHideId); controlsHideId = null }
    closePanels()
    controlsVisible.value = false
  }

  // onScopeDispose et non onBeforeUnmount : identique au démontage d'un composant (son
  // scope de setup est arrêté à ce moment-là), mais valable aussi hors composant — ce
  // qui rend le composable vérifiable dans un simple effect scope.
  onScopeDispose(() => {
    if (controlsHideId != null) { clearTimeout(controlsHideId); controlsHideId = null }
  })

  return { controlsVisible, armControlsHide, showControls, hideControls }
}
