import { computed, ref } from 'vue'
import { userPreferences, persistNavCamera, isLoggedIn } from '../userPreferences'

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
//
// Naviguer depuis un lien de partage ne suppose pas de compte (cf. companion). Sans
// profil serveur à reporter, saveZoomToProfile retombe sur un enregistrement en
// localStorage, propre à cet appareil.

export const CAM_ZOOM_MIN = 14
export const CAM_ZOOM_MAX = 20

const ZOOM_STORAGE_KEY = 'sportsScope.navZoom'

function loadStoredZoom(fallback: number): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY)
    if (raw == null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

function storeZoom(zoom: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom))
  } catch {
    // Quota dépassé ou navigation privée : la séance courante garde son zoom,
    // seule la mémorisation pour la prochaine fois est perdue.
  }
}

export function useNavCamera(deps: {
  getMap: () => any
  // Appelé quand l'utilisateur prend la main sur le zoom via le curseur : le composant
  // y détache la caméra du suivi (following=false, cameraUnlocked=true, hasInitialZoom=true).
  onManualZoom: () => void
}) {
  const { getMap, onManualZoom } = deps
  const navPrefs = userPreferences().navigation

  // Zoom de référence auquel comparer la séance : celui du profil pour un compte
  // connecté, sinon le dernier zoom enregistré sur cet appareil (fallback
  // localStorage). saveZoomToProfile met à jour cette référence pour que le bouton
  // disparaisse dès l'enregistrement.
  const savedZoom = ref(isLoggedIn() ? navPrefs.zoom : loadStoredZoom(navPrefs.zoom))
  const camZoom = ref(savedZoom.value)
  // Confirmation éphémère affichée sur le bouton « enregistrer le zoom ».
  const zoomSaved = ref(false)

  // Le bouton « enregistrer » ne s'affiche que si la séance s'est écartée du zoom
  // de référence — inutile de le proposer quand il n'y a rien à enregistrer.
  const hasUnsavedZoom = computed(() => camZoom.value !== savedZoom.value)

  function onZoomInput() {
    const map = getMap()
    if (!map) return
    map.setZoom(camZoom.value)
    onManualZoom()
  }

  // Reporte le zoom courant de la navigation sur le profil (bouton dédié du panneau
  // caméra), ou en localStorage sans compte. Le zoom ne s'enregistre plus
  // automatiquement au pinch ou au curseur.
  function saveZoomToProfile() {
    savedZoom.value = camZoom.value
    if (isLoggedIn()) {
      persistNavCamera(camZoom.value)
    } else {
      storeZoom(camZoom.value)
    }
    zoomSaved.value = true
    window.setTimeout(() => { zoomSaved.value = false }, 1800)
  }

  return {
    camZoom, zoomSaved, hasUnsavedZoom, savedZoom,
    onZoomInput, saveZoomToProfile,
  }
}
