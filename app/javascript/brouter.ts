import type { Sport } from './userPreferences'

// Endpoint du moteur de routage BRouter. Par défaut l'instance auto-hébergée,
// servie sous le domaine de l'app (même origine, cf. service `brouter` des
// docker-compose). Surcharger via VITE_BROUTER_URL pour repointer ailleurs, par
// ex. le serveur public 'https://brouter.de/brouter' (sans SLA ni quota garanti).
// Le défaut doit rester une valeur qui marche sans configuration : en prod les
// import.meta.env sont figés au build (assets:precompile). Voir .env.example.
export const BROUTER_URL = import.meta.env.VITE_BROUTER_URL || '/brouter'

// Catalogue des profils de routage BRouter proposés, par catégorie d'activité
// (Route#activity). Le 1er de chaque liste est le défaut catalogue du sport ; il
// peut être surchargé par la préférence compte du sport (`sports.<sport>.route_profile`,
// cf. routeProfileForSport dans userPreferences). Le profil retenu est envoyé tel quel
// à BRouter dans le paramètre `&profile=` (voir RouteBuilder.recomputeRoute).
//
// Ces profils sont fournis par l'instance auto-hébergée, qui miroite les .brf de
// brouter.de (`fastbike-lowtraffic` n'est pas livré dans le jar BRouter, il vient
// de ce miroir). Pour ajouter un profil maison, déposer son .brf dans
// deploy/brouter/profiles/ (voir le README) puis l'ajouter ici ET dans
// ALLOWED_PROFILES (app/controllers/routes_controller.rb).
export const PROFILES_BY_SPORT: Record<Sport, string[]> = {
  cycling: ['trekking', 'fastbike', 'fastbike-lowtraffic', 'shortest'],
  mtb: ['gravel', 'trekking', 'shortest'],
  hiking: ['hiking-mountain', 'trekking', 'shortest'],
}

// Union dédoublonnée de tous les profils du catalogue — sert à la validation
// (miroir de ALLOWED_PROFILES côté serveur).
export const ALL_PROFILES: string[] = [...new Set(Object.values(PROFILES_BY_SPORT).flat())]

// Liste ordonnée des profils pertinents pour un sport.
export function profilesForSport(sport: Sport): string[] {
  return PROFILES_BY_SPORT[sport] ?? PROFILES_BY_SPORT.cycling
}

// Un profil est-il proposé pour ce sport ? (filtrage strict : pas de combos
// incohérents type rando + profil vélo.)
export function isProfileValidForSport(profile: string, sport: Sport): boolean {
  return profilesForSport(sport).includes(profile)
}

// Défaut catalogue d'un sport (1er de la liste), utilisé quand la préférence
// compte est absente ou invalide.
export function catalogDefaultForSport(sport: Sport): string {
  return profilesForSport(sport)[0]
}
