// Préférences utilisateur injectées dans la page via <meta name="user-preferences">
// (cf. layouts/application.html.erb, rempli pour les utilisateurs connectés).
//
// Lisible à la fois par les composants Vue et par les modules hors-Vue
// (placesStore, routeHelpers). Tombe sur des valeurs par défaut sûres quand la
// balise est absente — page publique, utilisateur déconnecté, navigation partagée.
//
// Le schéma reflète User::DEFAULT_PREFERENCES côté serveur.

export type MapStyleId = 'cyclosm' | 'topo' | 'swisstopo' | 'liberty'
export type Sport = 'cycling' | 'mtb' | 'hiking'

export interface UserPreferences {
  points_of_interest: {
    show_cemeteries: boolean
    show_bakeries: boolean
    show_localities: boolean
    radius_m: number
  }
  map: { default_style: MapStyleId }
  display: {
    default_sport: Sport
    show_grade_colors: boolean
    show_elevation_chart: boolean
  }
  climb_detection: {
    min_grade: number
    min_gain_m: number
    min_length_m: number
  }
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  points_of_interest: {
    show_cemeteries: true,
    show_bakeries: true,
    show_localities: false,
    radius_m: 1500,
  },
  map: { default_style: 'cyclosm' },
  display: {
    default_sport: 'cycling',
    show_grade_colors: true,
    show_elevation_chart: true,
  },
  climb_detection: {
    min_grade: 2,
    min_gain_m: 60,
    min_length_m: 500,
  },
}

let cached: UserPreferences | null = null

export function userPreferences(): UserPreferences {
  if (cached) return cached
  cached = parse()
  return cached
}

function parse(): UserPreferences {
  try {
    const raw = document
      .querySelector('meta[name="user-preferences"]')
      ?.getAttribute('content')
    if (!raw) return DEFAULT_PREFERENCES
    const incoming = JSON.parse(raw) as Partial<UserPreferences>
    const d = DEFAULT_PREFERENCES
    return {
      points_of_interest: { ...d.points_of_interest, ...incoming.points_of_interest },
      map: { ...d.map, ...incoming.map },
      display: { ...d.display, ...incoming.display },
      climb_detection: { ...d.climb_detection, ...incoming.climb_detection },
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}
