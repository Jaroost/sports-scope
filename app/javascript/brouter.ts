import type { Sport } from './userPreferences'

// Endpoint du moteur de routage BRouter. Surchargé via VITE_BROUTER_URL pour
// pointer vers une instance auto-hébergée (le serveur public brouter.de n'a ni
// SLA ni quota garanti). Voir .env.example.
export const BROUTER_URL = import.meta.env.VITE_BROUTER_URL || 'https://brouter.de/brouter'

// Catalogue des profils de routage BRouter proposés, par catégorie d'activité
// (Route#activity). Le 1er de chaque liste est le défaut catalogue du sport ; il
// peut être surchargé par la préférence compte `route_profiles` (cf.
// routeProfileForSport dans userPreferences). Le profil retenu est envoyé tel quel
// à BRouter dans le paramètre `&profile=` (voir RouteBuilder.recomputeRoute).
//
// Tous ces profils existent sur l'instance publique brouter.de. Les profils alpins
// SAC (Hiking-Alpine-SAC6) n'y sont PAS installés (HTTP 500) ; si on passe à une
// instance auto-hébergée qui les fournit, on pourra les ajouter ici.
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
