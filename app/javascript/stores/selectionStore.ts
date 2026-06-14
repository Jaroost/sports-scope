import { ref } from 'vue'

class SelectionStore {
  readonly selectionRange = ref<{ startKm: number; endKm: number } | null>(null)
  readonly hoverIdx = ref<number | null>(null)
  readonly isZoomed = ref(false)

  // Non-reactive — reassigned in bulk, never patched in place
  cumDistKm: number[] = []
  zoomMin: number | null = null
  zoomMax: number | null = null

  clear() {
    this.selectionRange.value = null
    this.hoverIdx.value = null
    this.isZoomed.value = false
    this.cumDistKm = []
    this.zoomMin = null
    this.zoomMax = null
  }
}

export const selectionStore = new SelectionStore()
