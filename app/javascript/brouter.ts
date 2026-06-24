import type { Sport } from './userPreferences'

// Endpoint du moteur de routage BRouter. Surchargé via VITE_BROUTER_URL pour
// pointer vers une instance auto-hébergée (le serveur public brouter.de n'a ni
// SLA ni quota garanti). Voir .env.example.
export const BROUTER_URL = import.meta.env.VITE_BROUTER_URL || 'https://brouter.de/brouter'

// Profil de routage BRouter selon la catégorie d'activité (Route#activity). La rando
// utilise `hiking-mountain`, bien plus permissif que `trekking` : il accepte les
// sentiers de montagne étroits, non balisés et les passages exigeants que `trekking`
// évite. Les profils alpins SAC (Hiking-Alpine-SAC6) ne sont PAS installés sur
// l'instance publique brouter.de (HTTP 500) ; si on passe à une instance auto-hébergée
// qui les fournit, on pourra basculer ici.
export const BROUTER_PROFILES: Record<Sport, string> = {
  cycling: 'trekking',
  mtb: 'gravel',
  hiking: 'hiking-mountain',
}

export function brouterProfile(sport: Sport): string {
  return BROUTER_PROFILES[sport] ?? 'trekking'
}
