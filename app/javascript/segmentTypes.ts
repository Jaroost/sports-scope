// Forme des segments renvoyés par le serveur (`SegmentMatcher`), partagée par la liste
// des segments découverts (`ActivitySegments`), le panneau de comparaison d'un tronçon
// choisi (`SegmentCompare`) et l'historique commun aux deux (`SegmentEfforts`).
//
// Les deux points d'entrée du serveur rendent exactement la même chose : un segment
// découvert et un tronçon comparé à la demande ne diffèrent que par l'origine de leur
// plage — d'où un seul type.

export interface SegmentEffort {
  source: string
  external_id: string
  name: string
  started_at: string | null
  duration_s: number
  reverse: boolean
  // Passage de la sortie affichée elle-même : elle repasse par le segment (aller-retour).
  own: boolean
}

export interface Segment {
  start_idx: number
  end_idx: number
  distance_m: number
  elevation_gain_m: number | null
  count: number
  reverse_count: number
  // `reverse` : sens de CETTE sortie par rapport au sens de référence du segment
  // nommé (faux tant que le segment n'a pas de nom — sans nom, pas de référence).
  // `podium` : 1/2/3 (or, argent, bronze) parmi les passages comparables, null hors
  // podium. `record` en est la marche du haut.
  current: {
    duration_s: number
    rank: number
    total: number
    reverse: boolean
    podium: number | null
    record: boolean
  }
  best: SegmentEffort | null
  efforts: SegmentEffort[]
  // Nom donné par l'utilisateur, s'il a déjà baptisé ce chemin (depuis n'importe
  // quelle sortie qui le traverse) — cf. NamedSegment côté serveur.
  named_segment_id: number | null
  name: string | null
  // Repli d'affichage quand `name` est absent : la localité la plus proche du milieu
  // du segment (côté serveur). Nul si aucune localité n'est assez proche.
  place_name?: string | null
}
