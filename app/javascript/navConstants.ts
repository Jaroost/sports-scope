// Constantes partagées par les deux écrans de navigation (FreeNavigation.vue et
// RouteNavigation.vue). Regroupées ici pour qu'un seul réglage gouverne les deux
// modes — historiquement ces valeurs étaient copiées à l'identique dans chaque
// composant. Les constantes propres à un sous-système (son, caméra, contrôles,
// geste) vivent dans le composable correspondant ; ne restent ici que celles encore
// lues directement par le cœur GPS / animation des composants.

// Tuiles MNT (terrarium) pour le relief 3D — mêmes sources que le créateur d'itinéraire.
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

// ─── Suivi GPS ────────────────────────────────────────────────────────────────
export const MIN_MOVE_M = 4       // déplacement requis pour recalculer un cap
export const MIN_SPEED_MS = 0.8   // en dessous, on garde le cap précédent

// ─── Extrapolation / boucle d'animation ───────────────────────────────────────
export const MAX_EXTRAP_S = 2.5   // on cesse d'extrapoler si les fixes s'arrêtent
export const BEARING_SMOOTH = 0.18 // lissage par frame vers le cap cible
export const BEARING_EPS = 0.1    // ° — en dessous, le cap est « convergé »
