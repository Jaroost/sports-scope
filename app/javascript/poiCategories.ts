// Registre central des catégories de points d'intérêt (POI).
//
// Source de vérité unique pour tout le pipeline POI côté front :
//   - construction du paramètre `types` envoyé à /api/geocode/places
//   - état de recherche / d'affichage par catégorie (placesStore)
//   - rendu des marqueurs (créateur d'itinéraire + navigation) et des filtres
//
// Le contrat avec le serveur tient en deux champs :
//   - `key`          → valeur passée dans `types=` (le contrôleur déclenche les
//                      clauses Overpass correspondantes)
//   - `serverTypes`  → valeurs possibles du champ `type` renvoyé par le serveur
//                      pour cette catégorie (classification des éléments OSM)
//
// Pour ajouter une catégorie : une entrée ici + la clause Overpass et la
// classification dans GeocodesController + le booléen de préférence
// (User::DEFAULT_PREFERENCES, ProfilesController, userPreferences.ts, UserProfile.vue)
// + les libellés i18n (profile.poi.<labelKey>).

import type { UserPreferences } from './userPreferences'

export interface PoiCategory {
  /** Valeur envoyée dans le paramètre `types=` de /api/geocode/places. */
  key: string
  /** Champ booléen correspondant dans points_of_interest. */
  prefField: keyof UserPreferences['points_of_interest']
  /** Valeurs possibles du champ `type` renvoyé par le serveur pour cette catégorie. */
  serverTypes: string[]
  /** Icône FontAwesome (classe complète, ex. "fa-bread-slice"). */
  icon: string
  /** Couleur du marqueur (appliquée en inline pour piloter currentColor). */
  color: string
  /**
   * true  = POI ponctuel : marqueur posé sur le lieu, filtré par le rayon de détection.
   * false = localité : accrochée au point le plus proche du tracé, liste uniquement.
   */
  point: boolean
  /** Clé i18n du libellé (profile.poi.<labelKey>). */
  labelKey: string
}

export const POI_CATEGORIES: PoiCategory[] = [
  { key: 'cemeteries',  prefField: 'show_cemeteries', serverTypes: ['cemetery'],  icon: 'fa-cross',       color: '#6b7280', point: true,  labelKey: 'cemeteries' },
  { key: 'bakeries',    prefField: 'show_bakeries',   serverTypes: ['bakery'],    icon: 'fa-bread-slice', color: '#b45309', point: true,  labelKey: 'bakeries' },
  { key: 'water',       prefField: 'show_water',      serverTypes: ['water'],     icon: 'fa-faucet-drip', color: '#2563eb', point: true,  labelKey: 'water' },
  { key: 'food',        prefField: 'show_food',       serverTypes: ['food'],      icon: 'fa-utensils',    color: '#dc2626', point: true,  labelKey: 'food' },
  { key: 'viewpoints',  prefField: 'show_viewpoints', serverTypes: ['viewpoint'], icon: 'fa-binoculars',  color: '#7c3aed', point: true,  labelKey: 'viewpoints' },
  { key: 'picnic',      prefField: 'show_picnic',     serverTypes: ['picnic'],    icon: 'fa-tree',        color: '#15803d', point: true,  labelKey: 'picnic' },
  { key: 'toilets',     prefField: 'show_toilets',    serverTypes: ['toilets'],   icon: 'fa-restroom',    color: '#0891b2', point: true,  labelKey: 'toilets' },
  { key: 'parking',     prefField: 'show_parking',    serverTypes: ['parking'],   icon: 'fa-square-parking', color: '#1d4ed8', point: true, labelKey: 'parking' },
  { key: 'localities',  prefField: 'show_localities', serverTypes: ['city', 'town', 'village', 'hamlet'], icon: 'fa-location-dot', color: '#475569', point: false, labelKey: 'localities' },
]

const BY_TYPE = new Map<string, PoiCategory>()
for (const cat of POI_CATEGORIES) {
  for (const t of cat.serverTypes) BY_TYPE.set(t, cat)
}

/** Catégorie correspondant à un `type` de POI renvoyé par le serveur. */
export function categoryForType(type: string): PoiCategory | undefined {
  return BY_TYPE.get(type)
}

/** POI ponctuel (marqueur sur le lieu) — par opposition aux localités. */
export function isPointType(type: string): boolean {
  return categoryForType(type)?.point ?? false
}
