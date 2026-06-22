import { onMounted, onBeforeUnmount } from 'vue'

// Maintient l'écran allumé pendant la navigation (Screen Wake Lock API). Le verrou
// est relâché par le navigateur quand l'onglet passe en arrière-plan : on le
// reprend automatiquement au retour au premier plan (onVisibilityChange). Le
// composable gère son propre écouteur de visibilité et sa libération au démontage ;
// l'appelant déclenche l'acquisition initiale (geste utilisateur requis sur mobile)
// via acquire(), et interroge isHeld() pour éviter une double demande.
export function useScreenWakeLock() {
  let wakeLock: any = null

  async function acquire() {
    try {
      if ('wakeLock' in navigator) wakeLock = await (navigator as any).wakeLock.request('screen')
    } catch { /* non supporté ou refusé */ }
  }

  function release() {
    try { wakeLock?.release() } catch { /* ignore */ }
    wakeLock = null
  }

  function onVisibilityChange() {
    // Le verrou est abandonné quand la page est masquée ; on le reprend au retour.
    if (document.visibilityState === 'visible' && !wakeLock) acquire()
  }

  onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    release()
  })

  return { acquire, isHeld: () => wakeLock != null }
}
