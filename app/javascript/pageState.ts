// Page-level state classes for the two map-heavy pages.
//
// Usage in a component:
//   const state = reactive(new ActivityMapState())
//   onMounted(() => state.load())
//   watch(state, () => state.save(), { deep: true })
//
// Prototype getters work reactively with Vue's reactive() because `this`
// inside the getter refers to the reactive proxy, so Vue tracks the
// dependency on any reactive property the getter reads.

export type ColorMode = 'grade' | 'none'

// ─── Base ─────────────────────────────────────────────────────────────────

export class MapPageState {
  mapStyleId: string
  is3D = false
  mapExpanded = false
  showClimbs = true

  constructor(defaultMapStyle: string) {
    this.mapStyleId = defaultMapStyle
  }

  // Subclasses override to declare which fields survive a page reload.
  protected persistedFields(): string[] {
    return ['mapStyleId', 'showClimbs']
  }

  // Subclasses override to use a distinct localStorage key.
  protected storageKey(): string {
    return 'sportsScope.mapPageState'
  }

  load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey())
      if (!raw) return
      const saved = JSON.parse(raw) as Record<string, unknown>
      for (const field of this.persistedFields()) {
        if (Object.prototype.hasOwnProperty.call(saved, field)) {
          ;(this as Record<string, unknown>)[field] = saved[field]
        }
      }
    } catch { /* ignore — corrupted or missing */ }
  }

  save(): void {
    try {
      const data: Record<string, unknown> = {}
      for (const field of this.persistedFields()) {
        data[field] = (this as Record<string, unknown>)[field]
      }
      localStorage.setItem(this.storageKey(), JSON.stringify(data))
    } catch { /* ignore */ }
  }
}

// ─── Résumé d'activité ────────────────────────────────────────────────────

export class ActivityMapState extends MapPageState {
  showPhotos = true
  showGrade = true

  constructor() {
    super('cyclosm')
  }

  protected override storageKey(): string {
    return 'sportsScope.activityMapState'
  }

  protected override persistedFields(): string[] {
    return [...super.persistedFields(), 'showPhotos', 'showGrade']
  }
}

// ─── Créateur d'itinéraire ────────────────────────────────────────────────

export class RouteBuilderState extends MapPageState {
  colorMode: ColorMode = 'grade'

  constructor() {
    super('topo')
  }

  // Derived from colorMode — reactive because `this` is the reactive proxy
  // when accessed through state.showGrade, so Vue tracks state.colorMode.
  get showGrade(): boolean {
    return this.colorMode === 'grade'
  }

  protected override storageKey(): string {
    return 'sportsScope.routeBuilderState'
  }

  protected override persistedFields(): string[] {
    return [...super.persistedFields(), 'colorMode']
  }
}
