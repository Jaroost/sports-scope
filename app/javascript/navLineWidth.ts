// Largeur du tracé de navigation selon le zoom + découpage en tronçons de largeur
// constante. Extrait de RouteNavigation.vue. Pas d'état réactif : `useNavLineWidth` est une
// fabrique qui fige la config (zoom de référence, bornes) une fois et rend des fonctions
// pures ; `widthRunsCollection` est totalement pure. Testables sans monter de composant.

export interface NavLineWidthConfig {
  // Zoom de référence : à ce zoom l'échelle vaut 1 (aspect identique à l'ancien réglage fixe).
  refZoom: number
  minScale: number   // clamp bas (trait invisible en dézoom total évité)
  maxScale: number   // clamp haut (trait ridicule en zoom max évité)
  // Bornes de zoom du suivi caméra : plage des stops de l'expression MapLibre.
  zoomMin: number
  zoomMax: number
}

// Découpe une polyligne en tronçons de largeur constante (paliers de 0,05) : une Feature par
// run, portant sa propriété `wscale`. Sert à réduire la largeur sur les recouvrements sans
// multiplier les features. Totalement pure.
export function widthRunsCollection(coords: number[][], scales: number[]) {
  const q = (w: number) => Math.round(w / 0.05) * 0.05   // paliers de 0.05 → peu de features
  const seg = (c: number[][], wscale: number) =>
    ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: c }, properties: { wscale } })
  const features: ReturnType<typeof seg>[] = []
  if (coords.length < 2) return { type: 'FeatureCollection' as const, features }
  let start = 0
  let cur = q(scales[0] ?? 1)
  for (let i = 1; i < coords.length; i++) {
    const w = q(scales[i] ?? 1)
    if (w !== cur) {
      features.push(seg(coords.slice(start, i + 1), cur))   // inclut le sommet frontière i
      start = i
      cur = w
    }
  }
  features.push(seg(coords.slice(start), cur))
  return { type: 'FeatureCollection' as const, features }
}

// Tracé et indicateurs de virage doivent se comporter comme un ruban posé au sol : épais
// quand on zoome, fin quand on dézoome (et non l'inverse, ce que donnait une largeur fixe en
// pixels). On suit une loi base 2 (chaque niveau de zoom double l'échelle, soit une largeur
// au sol constante), ancrée sur `refZoom`. Les extrêmes sont clampés.
export function useNavLineWidth(cfg: NavLineWidthConfig) {
  function zoomWidthScale(z: number): number {
    return Math.min(cfg.maxScale, Math.max(cfg.minScale, 2 ** (z - cfg.refZoom)))
  }

  // Expression MapLibre `line-width` : stops à chaque niveau de zoom entier (clampés aux
  // bornes du suivi), interpolés linéairement. MapLibre clampe hors plage sur le
  // premier/dernier stop, ce qui borne naturellement la largeur.
  // `perFeature` : si vrai, chaque palier est multiplié par la propriété `wscale` de la feature
  // (largeur réduite sur les recouvrements). On garde `zoom` en entrée de l'interpolation de
  // plus haut niveau — seule forme acceptée par MapLibre pour une expression zoom + data-driven.
  function zoomWidthExpr(base: number, perFeature = false): any {
    const stops: any[] = []
    for (let z = cfg.zoomMin; z <= cfg.zoomMax; z++) {
      const w = Math.round(base * zoomWidthScale(z) * 100) / 100
      stops.push(z, perFeature ? ['*', w, ['get', 'wscale']] : w)
    }
    return ['interpolate', ['linear'], ['zoom'], ...stops]
  }

  return { zoomWidthScale, zoomWidthExpr }
}
