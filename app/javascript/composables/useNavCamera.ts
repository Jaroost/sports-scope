import { ref } from 'vue'
import { userPreferences, persistNavCamera } from '../userPreferences'
import { TERRAIN_TILES } from '../navConstants'

// Réglages caméra de la navigation (inclinaison, zoom, relief 3D), ajustables en
// séance via le panneau de commandes et reportés sur le profil. Partagé entre
// navigation libre et navigation sur itinéraire.
//
// On part des valeurs du profil ; les régler met à jour la vue immédiatement. La
// boucle d'animation et followOptions du composant lisent ces refs (et non plus
// navPrefs) pour que toute modification prenne effet à la frame suivante.
//
// L'inclinaison et le relief sont reportés sur le profil au relâchement
// (persistPitchTerrain) ; le zoom ne l'est QUE manuellement via saveZoomToProfile,
// pour ne pas écraser le réglage par défaut par un zoom ponctuel de la séance.

export const CAM_PITCH_MIN = 0
export const CAM_PITCH_MAX = 75
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
  const camPitch = ref(navPrefs.pitch)
  const terrain3d = ref(navPrefs.terrain)
  // Confirmation éphémère affichée sur le bouton « enregistrer le zoom ».
  const zoomSaved = ref(false)

  function onPitchInput() {
    const map = getMap()
    if (map) map.setPitch(camPitch.value)
  }

  function onZoomInput() {
    const map = getMap()
    if (!map) return
    map.setZoom(camZoom.value)
    onManualZoom()
  }

  // Active/désactive le relief 3D (terrain MNT). Idempotente : aussi appelée après un
  // setStyle, qui efface terrain et sources.
  function applyTerrain() {
    const map = getMap()
    if (!map) return
    if (terrain3d.value) {
      if (!map.getSource('terrain-dem')) {
        map.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
      }
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
    } else {
      map.setTerrain(null)
    }
  }

  function toggleTerrain() {
    terrain3d.value = !terrain3d.value
    applyTerrain()
    persistPitchTerrain()
  }

  // Persiste l'inclinaison et le relief sur le profil. Le zoom n'est PAS capturé ici :
  // on réécrit la valeur déjà enregistrée (navPrefs.zoom) pour qu'un réglage
  // d'inclinaison ou de relief n'embarque pas le zoom courant de la séance.
  function persistPitchTerrain() {
    persistNavCamera(navPrefs.zoom, camPitch.value, terrain3d.value)
  }

  // Reporte le zoom courant de la navigation sur le profil (bouton dédié du panneau
  // caméra). Le zoom ne s'enregistre plus automatiquement au pinch ou au curseur.
  function saveZoomToProfile() {
    persistNavCamera(camZoom.value, camPitch.value, terrain3d.value)
    zoomSaved.value = true
    window.setTimeout(() => { zoomSaved.value = false }, 1800)
  }

  return {
    camZoom, camPitch, terrain3d, zoomSaved,
    onPitchInput, onZoomInput, applyTerrain, toggleTerrain, persistPitchTerrain, saveZoomToProfile,
  }
}
