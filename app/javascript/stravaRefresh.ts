// Nom de l'événement `window` émis après un « Tout rafraîchir » réussi (composant
// RefreshAll). Les widgets d'accueil sont des îlots Vue séparés, sans état partagé :
// ils l'écoutent pour recharger leurs données après une synchronisation.
export const STRAVA_REFRESHED_EVENT = 'strava:refreshed'
