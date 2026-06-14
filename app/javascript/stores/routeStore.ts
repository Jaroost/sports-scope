import { ref, computed } from 'vue'
import { haversine, detectClimbs, computeGainLoss, buildDistancesM, formatDuration } from '../routeHelpers'
import type { Coord, Climb } from '../routeHelpers'

const SPEED_KEY = 'sportsScope.routeBuilderAvgSpeed'

function loadSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    const v = raw != null ? parseFloat(raw) : NaN
    return Number.isFinite(v) && v >= 3 && v <= 80 ? v : 18
  } catch { return 18 }
}

class RouteStore {
  // ─── Core route data ────────────────────────────────────────────────────────
  readonly geometry = ref<Coord[]>([])
  readonly waypoints = ref<Array<{ lng: number; lat: number }>>([])
  readonly distanceM = ref(0)
  readonly elevGainM = ref(0)
  readonly elevLossM = ref(0)
  readonly isFetchingRoute = ref(false)
  readonly isFetchingElevation = ref(false)
  readonly name = ref('')
  readonly error = ref<string | null>(null)
  readonly currentId = ref<number | null>(null)
  readonly avgSpeedKmh = ref(loadSpeed())

  // ─── Computed ───────────────────────────────────────────────────────────────
  readonly hasGeometry = computed(() => this.geometry.value.length >= 2)
  readonly isEditMode = computed(() => this.currentId.value != null)

  readonly estimatedSeconds = computed(() => {
    const d = this.distanceM.value
    const v = this.avgSpeedKmh.value
    if (!d || !Number.isFinite(v) || v <= 0) return 0
    return Math.round(((d / 1000) / v) * 3600)
  })

  readonly detectedClimbs = computed((): Climb[] => {
    const g = this.geometry.value
    if (g.length < 2) return []
    const altitudes = g.map((c) => c[2])
    const distances = buildDistancesM(g)
    return detectClimbs(altitudes, distances)
  })

  persistSpeed() {
    const v = this.avgSpeedKmh.value
    if (!Number.isFinite(v) || v < 3 || v > 80) return
    try { localStorage.setItem(SPEED_KEY, String(v)) } catch { /* ignore */ }
  }

  reset() {
    this.geometry.value = []
    this.waypoints.value = []
    this.distanceM.value = 0
    this.elevGainM.value = 0
    this.elevLossM.value = 0
  }

  recomputeGain() {
    const { gain, loss } = computeGainLoss(this.geometry.value)
    this.elevGainM.value = gain
    this.elevLossM.value = loss
  }
}

export const routeStore = new RouteStore()
