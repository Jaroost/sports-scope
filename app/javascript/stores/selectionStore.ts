import { ref } from 'vue'

class SelectionStore {
  readonly selectionRange = ref<{ startKm: number; endKm: number } | null>(null)
  // true quand la sélection vient d'un clic / glissé (persistante) plutôt que d'un
  // simple survol de col : un survol temporaire est effacé quand on quitte le col,
  // une sélection épinglée reste.
  readonly selectionPinned = ref(false)
  readonly hoverIdx = ref<number | null>(null)
  readonly isZoomed = ref(false)

  // Non-reactive — reassigned in bulk, never patched in place
  cumDistKm: number[] = []
  zoomMin: number | null = null
  zoomMax: number | null = null

  clear() {
    this.selectionRange.value = null
    this.selectionPinned.value = false
    this.hoverIdx.value = null
    this.isZoomed.value = false
    this.cumDistKm = []
    this.zoomMin = null
    this.zoomMax = null
  }
}

export const selectionStore = new SelectionStore()
