import { ref, onScopeDispose } from 'vue'

// Toast transitoire de la navigation guidée : un court message (succès / échec) auto-effacé
// après 3 s. Partagé par plusieurs actions (recherche POI, reroutage, reset, sauvegarde
// d'édition…). Extrait de RouteNavigation.vue.
export function useNavToast() {
  // `ok` pilote l'icône et la couleur (nav-toast--ok / --err) ; `text` le libellé.
  const poiToast = ref<{ ok: boolean; text: string } | null>(null)
  let poiToastTimer: number | null = null

  function showPoiToast(ok: boolean, text: string) {
    poiToast.value = { ok, text }
    if (poiToastTimer != null) clearTimeout(poiToastTimer)
    poiToastTimer = window.setTimeout(() => { poiToast.value = null; poiToastTimer = null }, 3000)
  }

  // Évite qu'un setTimeout en vol ne rappelle après démontage (le manuel dans onBeforeUnmount
  // du composant n'est donc plus nécessaire).
  onScopeDispose(() => { if (poiToastTimer != null) clearTimeout(poiToastTimer) })

  return { poiToast, showPoiToast }
}
