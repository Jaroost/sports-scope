import { ref } from 'vue'
import type { AthleteState } from '../routeLoad'
import type { Sport } from '../userPreferences'

// Ce que le modèle consomme (AthleteState), plus la vitesse réellement tenue sur
// tes sorties vélo — proposée comme suggestion, mais jamais appliquée d'office : la
// vitesse qui pilote l'estimation reste celle du profil. `typicalSpeedSamples` est
// le nombre de sorties derrière la médiane, affiché comme indice de fiabilité.
export interface AthleteContext extends AthleteState {
  typicalSpeedKmh: number | null
  typicalSpeedSamples: number
}

// ─── Seuils + forme du jour de l'athlète, pour l'estimation du TSS d'un itinéraire ──
// Extrait le strict nécessaire de /api/performance/training_load (FTP, poids, CTL,
// ATL) : de quoi estimer la puissance (donc le TSS) d'un itinéraire et le situer
// par rapport à la forme actuelle (cf. routeLoad.ts).
//
// La requête est partagée par tous les appelants (créateur d'itinéraire, liste) :
// une seule fois par page, quel que soit le nombre de composants. Le payload est
// déjà mis en cache côté serveur.
//
// `null` = pas d'estimation possible, et c'est NORMAL, pas une erreur : visiteur
// non connecté sur un lien de partage (401), ou compte sans aucune activité. Les
// appelants masquent simplement l'info.

let request: Promise<AthleteContext | null> | null = null
const athlete = ref<AthleteContext | null>(null)

async function fetchAthleteState(): Promise<AthleteContext | null> {
  const res = await fetch('/api/performance/training_load', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (!res.ok) return null

  const data = await res.json()
  return {
    ftp: data?.thresholds?.ftp_current ?? null,
    weightKg: data?.thresholds?.weight_kg ?? null,
    ctl: data?.current?.ctl ?? null,
    atl: data?.current?.atl ?? null,
    typicalSpeedKmh: data?.thresholds?.typical_speed_kmh ?? null,
    typicalSpeedSamples: data?.thresholds?.typical_speed_samples ?? 0,
  }
}

export function useAthleteState() {
  request ??= fetchAthleteState().catch(() => null)
  request.then((value) => { athlete.value = value })
  return { athlete }
}

export interface SpeedSuggestion {
  speed: number
  samples: number
}

// Vitesse à proposer pour un champ « vitesse moyenne », ou null s'il n'y a rien à
// proposer. Partagé par le profil, la liste et le créateur — ils remplissent le même
// genre de champ à partir de la même médiane.
//
// `step` = pas du champ visé, et ce n'est pas cosmétique : un `<input type="number">`
// n'accepte que les valeurs `min + k × step`. Y écrire une médiane brute (20.2 dans
// un champ au pas de 0,5) rend le champ invalide, ce qui bloque l'envoi du formulaire
// du profil. On arrondit donc au pas, et c'est la valeur arrondie qui est affichée sur
// le bouton — sans quoi il promettrait autre chose que ce qu'il applique.
//
// Vélo de route uniquement : côté serveur la catégorie « cycling » agrège route ET
// VTT (cf. PerformanceRecords::SPORT_MATCHERS), la médiane tirerait donc le VTT vers
// des vitesses de route.
export function speedSuggestionFor(
  athlete: AthleteContext | null,
  sport: Sport,
  current: number,
  step: number,
): SpeedSuggestion | null {
  const typical = athlete?.typicalSpeedKmh
  if (!typical || sport !== 'cycling') return null

  const speed = Math.round(typical / step) * step
  // Moins d'un pas d'écart : rien à corriger, le bouton n'aurait rien à apporter.
  if (!Number.isFinite(current) || Math.abs(speed - current) < step) return null

  return { speed, samples: athlete.typicalSpeedSamples }
}
