import { ref, reactive } from 'vue'
import { POI_CATEGORIES } from '../poiCategories'
import { fetchSavedPois, createPoi, updatePoi, deletePoi } from '../savedPois'
import type { SavedPoi, SavedPoiInput } from '../savedPois'

// Store des POI sauvegardés (table `pois`), partagé entre le créateur d'itinéraire et
// la navigation. Singleton de classe sur le modèle de placesStore.ts. La persistance
// passe par savedPois.ts ; le store tient le miroir réactif local + l'état d'affichage
// par catégorie (réutilise les bascules de POI_CATEGORIES).
class SavedPoisStore {
  readonly pois = ref<SavedPoi[]>([])
  readonly loaded = ref(false)
  // Affichage par catégorie (réactif) — toutes visibles par défaut. Pilote le filtrage
  // des marqueurs sauvegardés dans le créateur et la navigation.
  readonly show = reactive<Record<string, boolean>>(
    Object.fromEntries(POI_CATEGORIES.map((c) => [c.key, true])),
  )

  // Charge une fois les POI de l'utilisateur. Idempotent (no-op après le premier
  // chargement réussi) — appelé au montage du créateur comme de la navigation.
  async load(force = false): Promise<void> {
    if (this.loaded.value && !force) return
    this.pois.value = await fetchSavedPois()
    this.loaded.value = true
  }

  // Crée un POI et l'ajoute au miroir local. Renvoie le POI persisté ou null en cas
  // d'échec (réseau / non connecté).
  async add(input: SavedPoiInput): Promise<SavedPoi | null> {
    const poi = await createPoi(input)
    if (poi) this.pois.value = [poi, ...this.pois.value]
    return poi
  }

  async update(id: number, input: Partial<SavedPoiInput>): Promise<SavedPoi | null> {
    const poi = await updatePoi(id, input)
    if (poi) this.pois.value = this.pois.value.map((p) => (p.id === id ? poi : p))
    return poi
  }

  async remove(id: number): Promise<boolean> {
    const ok = await deletePoi(id)
    if (ok) this.pois.value = this.pois.value.filter((p) => p.id !== id)
    return ok
  }
}

export const savedPoisStore = new SavedPoisStore()
