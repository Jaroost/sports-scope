// Préférences utilisateur injectées dans la page via <meta name="user-preferences">
// (cf. layouts/application.html.erb, rempli pour les utilisateurs connectés).
//
// Lisible à la fois par les composants Vue et par les modules hors-Vue
// (placesStore, routeHelpers). Tombe sur des valeurs par défaut sûres quand la
// balise est absente — page publique, utilisateur déconnecté, navigation partagée.
//
// Le schéma reflète User::DEFAULT_PREFERENCES côté serveur.

export type MapStyleId = 'cyclosm' | 'topo' | 'swisstopo' | 'swissgrau' | 'swissimage' | 'liberty'
export type Sport = 'cycling' | 'mtb' | 'hiking'

export interface UserPreferences {
  points_of_interest: {
    show_cemeteries: boolean
    show_bakeries: boolean
    show_localities: boolean
    show_water: boolean
    show_food: boolean
    show_viewpoints: boolean
    show_toilets: boolean
    show_picnic: boolean
    radius_m: number
  }
  map: { default_style: MapStyleId; overlays: string[] }
  search: { country_codes: string[]; worldwide_fallback: boolean }
  navigation: { default_style: MapStyleId; zoom: number; pitch: number; terrain: boolean; nav_fps: number; line_width: number; line_color: string; line_opacity: number; turn_alert_m: number; turn_hint_m: number; turn_urgent_m: number; turn_repeat_ms: number; turn_repeat_urgent_ms: number; turn_green_hold_m: number; turn_green_hold_s: number; sound_volume: number; turn_marker_size: number; turn_marker_color: string; turn_marker_icon_color: string; show_climb_card: boolean; radar_always_visible: boolean; radar_close_m: number }
  display: {
    default_sport: Sport
    show_grade_colors: boolean
    show_elevation_chart: boolean
    route_color: string
    route_opacity: number
    route_width: number
  }
  climb_detection: {
    min_grade: number
    min_gain_m: number
    min_length_m: number
    grade_smoothing_m: number
    merge_gap_m: number
  }
  speeds: Record<Sport, number>
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  points_of_interest: {
    show_cemeteries: true,
    show_bakeries: true,
    show_localities: false,
    show_water: true,
    show_food: false,
    show_viewpoints: false,
    show_toilets: false,
    show_picnic: false,
    radius_m: 1500,
  },
  map: { default_style: 'cyclosm', overlays: [] },
  search: {
    country_codes: ['ch', 'fr', 'it', 'at', 'de'],
    worldwide_fallback: false,
  },
  navigation: { default_style: 'liberty', zoom: 19.5, pitch: 0, terrain: false, nav_fps: 8, line_width: 40, line_color: '#7c3aed', line_opacity: 0.8, turn_alert_m: 100, turn_hint_m: 150, turn_urgent_m: 50, turn_repeat_ms: 2000, turn_repeat_urgent_ms: 1000, turn_green_hold_m: 100, turn_green_hold_s: 10, sound_volume: 100, turn_marker_size: 40, turn_marker_color: '#f97316', turn_marker_icon_color: '#ffffff', show_climb_card: true, radar_always_visible: false, radar_close_m: 30 },
  display: {
    default_sport: 'cycling',
    show_grade_colors: true,
    show_elevation_chart: true,
    route_color: '#7c3aed',
    route_opacity: 0.8,
    route_width: 5,
  },
  climb_detection: {
    min_grade: 2,
    min_gain_m: 60,
    min_length_m: 500,
    grade_smoothing_m: 40,
    merge_gap_m: 350,
  },
  speeds: {
    cycling: 18,
    mtb: 14,
    hiking: 4.5,
  },
}

let cached: UserPreferences | null = null

export function userPreferences(): UserPreferences {
  if (cached) return cached
  cached = parse()
  return cached
}

// Présence de la balise = utilisateur connecté (cf. layouts/application.html.erb).
// Les visiteurs déconnectés tombent sur les valeurs par défaut, sans profil à mettre
// à jour côté serveur.
export function isLoggedIn(): boolean {
  return !!document.querySelector('meta[name="user-preferences"]')
}

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

// Reporte sur le profil le style de carte choisi dans le créateur d'itinéraire :
// il devient le réglage par défaut du compte. Met à jour le cache local puis envoie
// l'objet complet de préférences (PATCH /api/profile/preferences attend tout l'objet
// et assainit le reste). Best-effort : silencieux pour les visiteurs déconnectés et
// tolérant aux erreurs réseau — ce n'est qu'un miroir d'un réglage de vue.
export function persistDefaultMapStyle(styleId: MapStyleId): void {
  if (!isLoggedIn()) return
  const prefs = userPreferences()
  if (prefs.map.default_style === styleId) return
  prefs.map.default_style = styleId
  patchPreferences(prefs)
}

// Reporte sur le profil le zoom, l'inclinaison et le relief 3D de la caméra réglés
// en cours de navigation : ils deviennent les réglages par défaut du compte (même
// contrat best-effort que persistDefaultMapStyle).
export function persistNavCamera(zoom: number, pitch: number, terrain: boolean): void {
  if (!isLoggedIn()) return
  const prefs = userPreferences()
  if (prefs.navigation.zoom === zoom && prefs.navigation.pitch === pitch && prefs.navigation.terrain === terrain) return
  prefs.navigation.zoom = zoom
  prefs.navigation.pitch = pitch
  prefs.navigation.terrain = terrain
  patchPreferences(prefs)
}

// Miroir des overlays actifs sur le profil (même contrat que persistDefaultMapStyle).
export function persistOverlays(overlays: string[]): void {
  if (!isLoggedIn()) return
  const prefs = userPreferences()
  prefs.map.overlays = [...overlays]
  patchPreferences(prefs)
}

// PATCH best-effort de l'objet complet de préférences. Silencieux pour les visiteurs
// déconnectés (garde en amont) et tolérant aux erreurs réseau — ce n'est qu'un miroir
// de réglages de vue.
function patchPreferences(prefs: UserPreferences): void {
  void fetch('/api/profile/preferences', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken(),
    },
    credentials: 'same-origin',
    body: JSON.stringify({ preferences: prefs }),
  }).catch(() => { /* ignore — miroir best-effort */ })
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
      map: {
        ...d.map,
        ...incoming.map,
        overlays: Array.isArray(incoming.map?.overlays) ? incoming.map.overlays : d.map.overlays,
      },
      search: {
        country_codes: Array.isArray(incoming.search?.country_codes)
          ? incoming.search.country_codes
          : d.search.country_codes,
        worldwide_fallback: typeof incoming.search?.worldwide_fallback === 'boolean'
          ? incoming.search.worldwide_fallback
          : d.search.worldwide_fallback,
      },
      navigation: { ...d.navigation, ...incoming.navigation },
      display: { ...d.display, ...incoming.display },
      climb_detection: { ...d.climb_detection, ...incoming.climb_detection },
      speeds: { ...d.speeds, ...incoming.speeds },
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

// Vitesse moyenne (km/h) configurée pour une catégorie d'activité, avec repli sur
// la vitesse vélo puis sur une valeur sûre. Source unique pour l'estimation du
// temps de parcours (créateur d'itinéraire + liste).
export function speedForSport(sport: Sport): number {
  const v = userPreferences().speeds[sport]
  if (Number.isFinite(v) && v >= 3 && v <= 80) return v
  return DEFAULT_PREFERENCES.speeds[sport] ?? 18
}
