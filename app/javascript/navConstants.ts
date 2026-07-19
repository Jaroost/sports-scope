// Constantes partagées par la navigation (RouteNavigation.vue, modes libre et sur
// itinéraire). Regroupées ici pour qu'un seul réglage gouverne les deux
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

// ─── Enchaînement de virages ──────────────────────────────────────────────────
// Quand le prochain virage est en approche, les virages qui le suivent de très près
// sont ajoutés au bandeau (éveillé ET en veille) pour anticiper une rafale gauche-
// droite. Deux virages sont « enchaînés » s'ils sont espacés d'au plus TURN_CHAIN_GAP_M.
export const TURN_CHAIN_GAP_M = 50 // ≤ cette distance entre deux virages → même rafale
export const TURN_CHAIN_MAX = 4    // nombre total de virages affichés dans la rafale

// ─── Arrivée ──────────────────────────────────────────────────────────────────
// Distance restante (le long du tracé) sous laquelle on considère le coureur arrivé
// à destination. Une notification « vous êtes arrivé » s'affiche alors (éveillé + veille).
export const ARRIVAL_M = 25
