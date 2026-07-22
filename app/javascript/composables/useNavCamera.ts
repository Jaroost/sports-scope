import { ref } from 'vue'
import { userPreferences, persistNavCamera } from '../userPreferences'

// Réglages caméra de la navigation (zoom), ajustables en séance via le panneau de
// commandes et reportés sur le profil. Partagé entre navigation libre et navigation
// sur itinéraire.
//
// On part des valeurs du profil ; les régler met à jour la vue immédiatement. La
// boucle d'animation et followOptions du composant lisent ces refs (et non plus
// navPrefs) pour que toute modification prenne effet à la frame suivante.
//
// La caméra reste toujours à plat (pitch 0) pour économiser la batterie : plus de
// réglage d'inclinaison ni de relief 3D. Le zoom n'est reporté sur le profil que
// manuellement via saveZoomToProfile, pour ne pas écraser le réglage par défaut par
// un zoom ponctuel de la séance.

export const CAM_ZOOM_MIN = 14
export const CAM_ZOOM_MAX = 20

export function useNavCamera(deps: {
  getMap: () => any
  // Appelé quand l'utilisateur prend la main sur le zoom via le curseur : le composant
  // y détache la caméra du suivi (following=false, cameraUnlocked=true, hasInitialZoom=true).
  onManualZoom: () => void
}) {
  const { getMap, onManualZoom } = deps
  const navPrefs = userPreferences().navigation

  const camZoom = ref(navPrefs.zoom)
  // Confirmation éphémère affichée sur le bouton « enregistrer le zoom ».
  const zoomSaved = ref(false)

  function onZoomInput() {
    const map = getMap()
    if (!map) return
    map.setZoom(camZoom.value)
    onManualZoom()
  }

  // Reporte le zoom courant de la navigation sur le profil (bouton dédié du panneau
  // caméra). Le zoom ne s'enregistre plus automatiquement au pinch ou au curseur.
  function saveZoomToProfile() {
    persistNavCamera(camZoom.value)
    zoomSaved.value = true
    window.setTimeout(() => { zoomSaved.value = false }, 1800)
  }

  return {
    camZoom, zoomSaved,
    onZoomInput, saveZoomToProfile,
  }
}
