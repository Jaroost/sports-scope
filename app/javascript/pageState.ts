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

import { sportPreferences, userPreferences } from './userPreferences'

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
  // Public (et non `protected`) à dessein : une instance passée en prop traverse
  // `reactive()`, dont le type `UnwrapNestedRefs` ne conserve que les membres publics.
  // En `protected`, le proxy réactif n'est plus assignable au type de la classe.
  persistedFields(): string[] {
    return ['mapStyleId', 'showClimbs']
  }

  // Subclasses override to use a distinct localStorage key. Public pour la même
  // raison que persistedFields().
  storageKey(): string {
    return 'sportsScope.mapPageState'
  }

  // Vrai quand load() a effectivement trouvé des réglages enregistrés : permet à
  // l'appelant de n'imposer ses valeurs par défaut qu'à la toute première visite,
  // sans écraser les choix déjà faits par l'utilisateur.
  hasStoredState = false

  load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey())
      if (!raw) return
      const saved = JSON.parse(raw) as Record<string, unknown>
      this.hasStoredState = true
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

  override storageKey(): string {
    return 'sportsScope.activityMapState'
  }

  override persistedFields(): string[] {
    return [...super.persistedFields(), 'showPhotos', 'showGrade']
  }
}

// ─── Créateur d'itinéraire ────────────────────────────────────────────────

export class RouteBuilderState extends MapPageState {
  colorMode: ColorMode = 'grade'
  showWaypoints = true
  showPois = true
  // Repères posés à la main (départ / arrivée / parking). Affichés par défaut.
  showMarkers = true
  // Opacité (0.05–1) des couches superposées swisstopo/SuisseMobile sélectionnées.
  overlayOpacity = 0.9
  showStatsSidebar = true
  showElevationChart = true
  overlays: string[] = []

  // Vue en lecture seule (lien de partage) : les calques y sont forcés à un rendu
  // « invité » (repères + pentes seuls). Ces réglages ne doivent PAS atterrir dans la
  // configuration du créateur — sinon ouvrir un lien partagé éteint durablement les
  // points d'étape, les POI et les cols de sa propre session d'édition.
  readonly shared: boolean

  constructor(shared = false) {
    super(sportPreferences().map.default_style)
    this.shared = shared
    const prefs = userPreferences()
    this.colorMode = prefs.display.show_grade_colors ? 'grade' : 'none'
    this.showElevationChart = prefs.display.show_elevation_chart
    this.overlays = [...sportPreferences().map.overlays]
  }

  // Derived from colorMode — reactive because `this` is the reactive proxy
  // when accessed through state.showGrade, so Vue tracks state.colorMode.
  get showGrade(): boolean {
    return this.colorMode === 'grade'
  }

  override storageKey(): string {
    return this.shared ? 'sportsScope.sharedRouteViewState' : 'sportsScope.routeBuilderState'
  }

  // mapStyleId, colorMode, showElevationChart et overlays sont gouvernés par les
  // préférences du profil (cf. constructeur) : on ne les persiste pas en localStorage,
  // sinon une ancienne valeur de session écraserait silencieusement le profil. Les autres
  // réglages de vue (épingles, panneau, cols) restent locaux à la session.
  override persistedFields(): string[] {
    return ['showClimbs', 'showWaypoints', 'showPois', 'showMarkers', 'showStatsSidebar', 'overlayOpacity']
  }
}
