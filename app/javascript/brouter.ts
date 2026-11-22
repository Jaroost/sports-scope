import type { Sport } from './userPreferences'
import { specBase } from './routingProfile'

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
  cycling: [
    'preset-cycling-trekking',
    'preset-cycling-fast',
    'preset-cycling-fast-quiet',
    'preset-cycling-shortest',
  ],
  mtb: ['preset-mtb-gravel', 'preset-mtb-trekking', 'preset-mtb-shortest'],
  hiking: ['preset-hiking-mountain', 'preset-hiking-easy', 'preset-hiking-shortest'],
}

// Anciens profils BRouter amont, remplacés par des presets de l'atelier (leurs formules
// internes ne se retranscrivent pas à l'identique en variables). Plus proposés, mais un
// itinéraire ou un réglage qui les porte garde son tracé.
export const LEGACY_PROFILES = [
  'trekking-paved',
  'fastbike-quiet-paved',
  'trekking',
  'fastbike',
  'fastbike-lowtraffic',
  'shortest',
  'gravel',
  'hiking-mountain',
]

// Profil « atelier » de chaque sport : tout est réglable, rien n'est figé (custom-*.brf).
// Il n'est pas proposé tel quel dans les listes : on y accède par l'éditeur de profils
// (« Partir de zéro »), mais un spec qui en part reste valide pour son sport.
export const WORKSHOP_BY_SPORT: Record<Sport, string> = {
  cycling: 'custom-cycling',
  mtb: 'custom-mtb',
  hiking: 'custom-hiking',
}

// Union dédoublonnée de tous les profils du catalogue — sert à la validation
// (miroir de ALLOWED_PROFILES côté serveur).
export const ALL_PROFILES: string[] = [...new Set([...Object.values(PROFILES_BY_SPORT).flat(), ...LEGACY_PROFILES])]

// Liste ordonnée des profils pertinents pour un sport.
export function profilesForSport(sport: Sport): string[] {
  return PROFILES_BY_SPORT[sport] ?? PROFILES_BY_SPORT.cycling
}

// Un profil est-il proposé pour ce sport ? (filtrage strict : pas de combos
// incohérents type rando + profil vélo.)
export function isProfileValidForSport(profile: string, sport: Sport): boolean {
  // Un spec personnalisé (`base~k=v`) est valide si son profil de base l'est.
  const base = specBase(profile)
  return profilesForSport(sport).includes(base) || base === WORKSHOP_BY_SPORT[sport] || LEGACY_PROFILES.includes(base)
}

// Défaut catalogue d'un sport (1er de la liste), utilisé quand la préférence
// compte est absente ou invalide.
export function catalogDefaultForSport(sport: Sport): string {
  return profilesForSport(sport)[0]
}
