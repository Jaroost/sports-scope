// Registre des repères d'itinéraire (posés à la main : départ / arrivée / parking).
//
// Distinct des POI (poiCategories.ts) : ceux-ci proviennent d'Overpass et sont
// filtrés par rayon de détection ; les repères ici sont des points fixes posés par
// l'utilisateur dans le créateur et enregistrés avec l'itinéraire (colonne
// `routes.markers`). Source de vérité unique côté front pour l'icône, la couleur et
// le libellé de chaque type — réutilisée par le créateur ET la navigation.
//
// Le contrat avec le serveur : le champ `kind` (une clé ci-dessous) est validé par
// RoutesController (MARKER_KINDS) ; `label` est un texte libre optionnel.

import { t } from './i18n'

export type MarkerKind = 'start' | 'finish' | 'parking'

export interface RouteMarker {
  kind: MarkerKind
  lng: number
  lat: number
  /** Libellé libre optionnel (ex. « Parking payant »). */
  label?: string
}

export interface MarkerKindMeta {
  kind: MarkerKind
  /** Icône FontAwesome (classe complète, ex. "fa-flag"). */
  icon: string
  /** Couleur du marqueur (bordure / remplissage via currentColor). */
  color: string
  /** Clé i18n du libellé (routes.marker_<kind>). */
  labelKey: string
}

export const MARKER_KINDS: MarkerKindMeta[] = [
  { kind: 'start',   icon: 'fa-flag',            color: '#15803d', labelKey: 'routes.marker_start' },
  { kind: 'finish',  icon: 'fa-flag-checkered',  color: '#dc2626', labelKey: 'routes.marker_finish' },
  { kind: 'parking', icon: 'fa-square-parking',  color: '#2563eb', labelKey: 'routes.marker_parking' },
]

const BY_KIND = new Map<MarkerKind, MarkerKindMeta>()
for (const m of MARKER_KINDS) BY_KIND.set(m.kind, m)

/** Métadonnées (icône + couleur) d'un type de repère, ou undefined si inconnu. */
export function markerMeta(kind: string): MarkerKindMeta | undefined {
  return BY_KIND.get(kind as MarkerKind)
}

/** Libellé traduit d'un type de repère (ex. « Départ »). */
export function markerKindLabel(kind: string): string {
  const meta = BY_KIND.get(kind as MarkerKind)
  return meta ? t(meta.labelKey) : kind
}
