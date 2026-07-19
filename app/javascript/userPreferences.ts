// Préférences utilisateur injectées dans la page via <meta name="user-preferences">
// (cf. layouts/application.html.erb, rempli pour les utilisateurs connectés).
//
// Lisible à la fois par les composants Vue et par les modules hors-Vue
// (placesStore, routeHelpers). Tombe sur des valeurs par défaut sûres quand la
// balise est absente — page publique, utilisateur déconnecté, navigation partagée.
//
// Le schéma reflète User::DEFAULT_PREFERENCES côté serveur.

import { isProfileValidForSport, catalogDefaultForSport } from './brouter'

export type MapStyleId = 'cyclosm' | 'topo' | 'swisstopo' | 'swissgrau' | 'swissimage' | 'liberty'
export type Sport = 'cycling' | 'mtb' | 'hiking'

export const SPORTS: Sport[] = ['cycling', 'mtb', 'hiking']

// Réglages d'un sport. Tout ce qui dépend de la pratique vit ici plutôt qu'au premier
// niveau : le sport courant (cf. currentSport) sélectionne le bloc à lire.
export interface SportPreferences {
  speed: number
  route_profile: string
  // Diamètre (m) de détection d'amas de virages dans le créateur.
  turn_anomaly_m: number
  // Écart (m) au-delà duquel un point d'étape accroché loin du clic est signalé.
  snap_warn_m: number
  map: { default_style: MapStyleId; overlays: string[] }
  route: { color: string; opacity: number; width: number }
  climb_detection: {
    min_grade: number
    min_gain_m: number
    min_length_m: number
    grade_smoothing_m: number
    merge_gap_m: number
  }
  // Navigation guidée : aspect du tracé, indicateurs de direction, distances et cadences
  // des annonces de virage.
  navigation: {
    line_width: number
    line_color: string
    line_opacity: number
    turn_marker_size: number
    turn_marker_color: string
    turn_marker_icon_color: string
    turn_alert_m: number
    turn_hint_m: number
    turn_urgent_m: number
    turn_now_m: number
    turn_repeat_count: number
    turn_repeat: boolean
    turn_repeat_ms: number
    turn_repeat_urgent_count: number
    turn_repeat_urgent: boolean
    turn_repeat_urgent_ms: number
    turn_green_hold_m: number
    turn_green_hold_s: number
  }
}

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
    alert_m: number
  }
  search: { country_codes: string[]; worldwide_fallback: boolean }
  navigation: { default_style: MapStyleId; zoom: number; pitch: number; terrain: boolean; nav_fps: number; sound_volume: number; show_climb_card: boolean; radar_close_m: number; auto_reroute: boolean; auto_reroute_cooldown_s: number }
  display: {
    default_sport: Sport
    show_grade_colors: boolean
    show_elevation_chart: boolean
    show_chain_widget: boolean
    show_performance_widget: boolean
  }
  sports: Record<Sport, SportPreferences>
}

// Réglages communs à tous les sports ; seuls ceux qu'on différencie sont passés en
// argument (miroir de User.sport_defaults).
function sportDefaults(
  speed: number,
  route_profile: string,
  turn_anomaly_m: number,
  map_style: MapStyleId,
  climb_detection: SportPreferences['climb_detection'],
): SportPreferences {
  return {
    speed,
    route_profile,
    turn_anomaly_m,
    snap_warn_m: 25,
    map: { default_style: map_style, overlays: [] },
    route: { color: '#7c3aed', opacity: 0.8, width: 5 },
    climb_detection,
    navigation: {
      line_width: 40,
      line_color: '#7c3aed',
      line_opacity: 0.8,
      turn_marker_size: 25,
      turn_marker_color: '#f97316',
      turn_marker_icon_color: '#ffffff',
      turn_alert_m: 100,
      turn_hint_m: 150,
      turn_urgent_m: 50,
      turn_now_m: 15,
      turn_repeat_count: 3,
      turn_repeat: false,
      turn_repeat_ms: 2000,
      turn_repeat_urgent_count: 5,
      turn_repeat_urgent: false,
      turn_repeat_urgent_ms: 1000,
      turn_green_hold_m: 100,
      turn_green_hold_s: 10,
    },
  }
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
    alert_m: 100,
  },
  search: {
    country_codes: ['ch', 'fr', 'it', 'at', 'de'],
    worldwide_fallback: false,
  },
  navigation: { default_style: 'liberty', zoom: 17, pitch: 0, terrain: false, nav_fps: 8, sound_volume: 100, show_climb_card: true, radar_close_m: 30, auto_reroute: true, auto_reroute_cooldown_s: 10 },
  display: {
    default_sport: 'cycling',
    show_grade_colors: true,
    show_elevation_chart: true,
    show_chain_widget: true,
    show_performance_widget: true,
  },
  // Sur climb_detection, `min_grade` ouvre et ferme une montée en comparant la pente lissée
  // point par point. L'altitude étant quantifiée au mètre, une fenêtre de w mètres laisse un
  // bruit de ±100/w % : le couple (grade_smoothing_m, min_grade) est calé sur
  // min_grade ≈ 2 × 100/grade_smoothing_m, sinon le bruit hache la montée. Miroir de
  // User::DEFAULT_PREFERENCES.
  sports: {
    cycling: sportDefaults(18, 'trekking', 100, 'cyclosm',
      { min_grade: 3, min_gain_m: 50, min_length_m: 500, grade_smoothing_m: 60, merge_gap_m: 500 }),
    mtb: sportDefaults(14, 'gravel', 80, 'topo',
      { min_grade: 4, min_gain_m: 50, min_length_m: 300, grade_smoothing_m: 40, merge_gap_m: 300 }),
    hiking: sportDefaults(4.5, 'hiking-mountain', 60, 'topo',
      { min_grade: 6, min_gain_m: 100, min_length_m: 250, grade_smoothing_m: 30, merge_gap_m: 200 }),
  },
}

let cached: UserPreferences | null = null

export function userPreferences(): UserPreferences {
  if (cached) return cached
  cached = parse()
  return cached
}

// ─── Sport courant ────────────────────────────────────────────────────────────
// Les réglages par sport sont lus depuis des modules sans accès au sport (routeHelpers,
// pageState) autant que depuis des composants qui, eux, le connaissent. Plutôt que de
// faire descendre le sport dans chaque appel, la page déclare le sien une fois — celui
// de l'itinéraire ouvert — et tout le monde lit le même. Hors page d'itinéraire (résumé
// d'activité, liste), c'est le sport par défaut du profil qui sert.

let activeSport: Sport | null = null

// À appeler dès que le sport de la page est connu (chargement d'un itinéraire, choix
// du sport dans le créateur). Sans effet sur les préférences enregistrées.
export function setActiveSport(sport: Sport): void {
  activeSport = sport
}

export function currentSport(): Sport {
  return activeSport ?? userPreferences().display.default_sport
}

// Bloc de réglages d'un sport (celui de la page par défaut), défauts compris.
export function sportPreferences(sport: Sport = currentSport()): SportPreferences {
  return userPreferences().sports[sport] ?? DEFAULT_PREFERENCES.sports[sport] ?? DEFAULT_PREFERENCES.sports.cycling
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

// Reporte sur le profil le style de carte choisi dans le créateur d'itinéraire : il
// devient le réglage par défaut du compte POUR LE SPORT COURANT — on ne roule pas avec
// le même fond de carte qu'on ne marche. Met à jour le cache local puis envoie l'objet
// complet de préférences (PATCH /api/profile/preferences attend tout l'objet et assainit
// le reste). Best-effort : silencieux pour les visiteurs déconnectés et tolérant aux
// erreurs réseau — ce n'est qu'un miroir d'un réglage de vue.
export function persistDefaultMapStyle(styleId: MapStyleId, sport: Sport = currentSport()): void {
  if (!isLoggedIn()) return
  const prefs = userPreferences()
  const map = prefs.sports[sport].map
  if (map.default_style === styleId) return
  map.default_style = styleId
  patchPreferencesQuietly(prefs)
}

// Style de carte de la navigation guidée : global, contrairement à celui du créateur.
export function persistNavigationStyle(styleId: MapStyleId): void {
  if (!isLoggedIn()) return
  const prefs = userPreferences()
  if (prefs.navigation.default_style === styleId) return
  prefs.navigation.default_style = styleId
  patchPreferencesQuietly(prefs)
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
  patchPreferencesQuietly(prefs)
}

// Miroir des overlays actifs sur le profil, pour le sport courant (même contrat que
// persistDefaultMapStyle).
export function persistOverlays(overlays: string[], sport: Sport = currentSport()): void {
  if (!isLoggedIn()) return
  const prefs = userPreferences()
  prefs.sports[sport].map.overlays = [...overlays]
  patchPreferencesQuietly(prefs)
}

// Vitesse moyenne d'un sport, enregistrée sur le profil depuis la page des
// itinéraires (elle pilote le temps de parcours estimé ET le TSS estimé, cf.
// routeLoad.ts). Contrairement aux miroirs de réglages de vue ci-dessus, c'est ici
// une saisie explicite de l'utilisateur : on renvoie la promesse pour que
// l'appelant puisse signaler l'échec plutôt que de le perdre en silence.
export function persistSportSpeed(sport: Sport, speed: number): Promise<void> {
  if (!isLoggedIn()) return Promise.resolve()
  const prefs = userPreferences()
  const previous = prefs.sports[sport].speed
  if (previous === speed) return Promise.resolve()

  // Le cache doit porter la nouvelle valeur pour être envoyé — mais un échec doit
  // la remettre comme avant, sinon la garde ci-dessus prendrait une nouvelle
  // tentative pour un no-op et la vitesse ne serait jamais enregistrée.
  prefs.sports[sport].speed = speed
  return patchPreferences(prefs).catch((e) => {
    prefs.sports[sport].speed = previous
    throw e
  })
}

// PATCH de l'objet complet de préférences — l'endpoint attend tout l'objet et
// assainit le reste. Rejette sur échec : à l'appelant de décider quoi en faire.
function patchPreferences(prefs: UserPreferences): Promise<void> {
  return fetch('/api/profile/preferences', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken(),
    },
    credentials: 'same-origin',
    body: JSON.stringify({ preferences: prefs }),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  })
}

// Variante des miroirs de réglages de vue : silencieuse pour les visiteurs
// déconnectés (garde en amont) et tolérante aux erreurs réseau — perdre le miroir
// d'un fond de carte ne mérite pas d'embêter l'utilisateur.
function patchPreferencesQuietly(prefs: UserPreferences): void {
  void patchPreferences(prefs).catch(() => { /* ignore — miroir best-effort */ })
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
      sports: Object.fromEntries(
        SPORTS.map((sport) => [sport, parseSport(d.sports[sport], incoming.sports?.[sport])]),
      ) as Record<Sport, SportPreferences>,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function parseSport(defaults: SportPreferences, incoming?: Partial<SportPreferences>): SportPreferences {
  return {
    ...defaults,
    ...incoming,
    map: {
      ...defaults.map,
      ...incoming?.map,
      overlays: Array.isArray(incoming?.map?.overlays) ? incoming.map.overlays : defaults.map.overlays,
    },
    route: { ...defaults.route, ...incoming?.route },
    climb_detection: { ...defaults.climb_detection, ...incoming?.climb_detection },
    navigation: { ...defaults.navigation, ...incoming?.navigation },
  }
}

// Vitesse moyenne (km/h) configurée pour une catégorie d'activité, avec repli sur
// la valeur par défaut du sport. Source unique pour l'estimation du temps de parcours
// (créateur d'itinéraire + liste).
export function speedForSport(sport: Sport): number {
  const v = sportPreferences(sport).speed
  if (Number.isFinite(v) && v >= 3 && v <= 80) return v
  return DEFAULT_PREFERENCES.sports[sport]?.speed ?? 18
}

// Diamètre (m) de détection d'amas de virages configuré pour une catégorie d'activité,
// avec repli sur la valeur par défaut du sport. Source unique pour le créateur
// d'itinéraire (cf. detectTurnAnomalies).
export function turnAnomalyDiameterForSport(sport: Sport): number {
  const v = sportPreferences(sport).turn_anomaly_m
  if (Number.isFinite(v) && v >= 30 && v <= 200) return v
  return DEFAULT_PREFERENCES.sports[sport]?.turn_anomaly_m ?? 100
}

// Écart (m) au-delà duquel un point d'étape accroché loin de l'endroit cliqué est signalé
// dans le créateur, configuré pour une catégorie d'activité. Bornes alignées sur
// ProfilesController::SNAP_WARN_RANGE.
export function snapWarnDistanceForSport(sport: Sport): number {
  const v = sportPreferences(sport).snap_warn_m
  if (Number.isFinite(v) && v >= 10 && v <= 200) return v
  return DEFAULT_PREFERENCES.sports[sport]?.snap_warn_m ?? 25
}

// Profil de routage BRouter par défaut pour un sport : préférence compte si elle
// désigne un profil valide pour ce sport, sinon défaut catalogue. Source unique
// pour l'initialisation du store et le changement de sport dans le créateur.
export function routeProfileForSport(sport: Sport): string {
  const pref = sportPreferences(sport).route_profile
  if (pref && isProfileValidForSport(pref, sport)) return pref
  return catalogDefaultForSport(sport)
}
