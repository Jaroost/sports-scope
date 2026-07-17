import type { Sport } from './userPreferences'

// ─── TSS estimé d'un itinéraire (avant de l'avoir roulé) ──────────────────────
// Le TSS d'une ACTIVITÉ se calcule à partir de la puissance réellement produite
// (cf. TrainingLoad côté serveur). Un itinéraire n'a pas de puissance : on
// l'estime par la physique, à partir de la vitesse moyenne visée et du D+ :
//
//   P ≈ ( Crr·m·g·v  +  ½·ρ·CdA·v³  +  m·g·(D+/T) ) / rendement
//   IF = P / FTP        TSS = h × IF² × 100
//
// Les trois termes = résistance au roulement, aéro, et travail contre la gravité
// (le D+ total sur la durée totale). C'est ce dernier qui fait qu'à vitesse égale
// 80 km vallonnés coûtent bien plus que 80 km plats — un modèle basé sur la seule
// vitesse ne le verrait pas.
//
// Approximations assumées :
//   • ½·ρ·CdA·v³ utilise la vitesse MOYENNE : comme la puissance aéro est cubique,
//     une allure irrégulière en demande plus → sous-estimation sur terrain roulant.
//   • Roulement et aéro sont comptés sur toute la durée, descentes en roue libre
//     comprises → surestimation sur terrain très vallonné.
//   Les deux biais se compensent en partie ; l'ordre de grandeur reste bon, mais
//   ça reste une ESTIMATION (à afficher comme telle, avec « ≈ »).
//
// Sans FTP ni poids (préférences athlète vides), on retombe sur le facteur
// d'intensité par défaut du sport — le même repli que le serveur.

const G = 9.81
const AIR_DENSITY = 1.225 // kg/m³, ~niveau de la mer
const DRIVETRAIN_EFFICIENCY = 0.97

// Coefficients par sport : résistance au roulement, CdA (m², position + gabarit
// moyens), et masse de l'équipement (vélo + équipement porté), faute de poids de
// vélo en base.
const BIKE: Record<string, { crr: number; cda: number; massKg: number }> = {
  cycling: { crr: 0.005, cda: 0.32, massKg: 9 },
  mtb: { crr: 0.012, cda: 0.45, massKg: 13 },
}

// Facteur d'intensité par défaut, repli sans FTP/poids. Mêmes valeurs que
// TrainingLoad::ESTIMATED_IF côté serveur (mtb = vélo).
const ESTIMATED_IF: Record<string, number> = { cycling: 0.7, mtb: 0.7, hiking: 0.5 }

// Borne l'IF, comme TrainingLoad::INTENSITY_CAP : évite un TSS absurde sur une
// vitesse saisie irréaliste (80 km/h) ou une FTP fantaisiste.
const INTENSITY_CAP = 1.5

// Constantes des moyennes mobiles CTL (42 j) / ATL (7 j), cf. TrainingLoad.
const K_CTL = 1 - Math.exp(-1 / 42)
const K_ATL = 1 - Math.exp(-1 / 7)

export interface RouteShape {
  distanceM: number
  elevGainM: number
  speedKmh: number
  sport: Sport
}

// Seuils + forme du jour, tels que servis par /api/performance/training_load.
export interface AthleteState {
  ftp: number | null
  weightKg: number | null
  ctl: number | null
  atl: number | null
}

export interface RouteLoad {
  tss: number
  intensity: number // IF
  durationS: number
  watts: number | null // puissance moyenne estimée (null en mode repli)
  source: 'power' | 'estimated'
  // Contexte de forme — null tant qu'on n'a pas de CTL (pas d'historique).
  ctlRatio: number | null // TSS de la sortie / CTL : combien de fois la charge quotidienne habituelle
  level: 'ok' | 'demanding' | 'hard' | null
  tsbNow: number | null
  tsbAfter: number | null
}

// Puissance moyenne estimée (W), ou null si le modèle ne s'applique pas (sport
// non cyclable, poids inconnu, données non exploitables).
export function estimatedWatts(route: RouteShape, weightKg: number | null, durationS: number): number | null {
  const bike = BIKE[route.sport]
  if (!bike || !weightKg || weightKg <= 0 || durationS <= 0) return null

  const v = route.speedKmh / 3.6
  if (!Number.isFinite(v) || v <= 0) return null

  const mass = weightKg + bike.massKg
  const rolling = bike.crr * mass * G * v
  const aero = 0.5 * AIR_DENSITY * bike.cda * v ** 3
  const climbing = (mass * G * Math.max(0, route.elevGainM)) / durationS

  const watts = (rolling + aero + climbing) / DRIVETRAIN_EFFICIENCY
  return Number.isFinite(watts) && watts > 0 ? watts : null
}

// Estimation complète. Renvoie null si l'itinéraire n'a pas de quoi estimer une
// durée (pas de distance ou pas de vitesse).
export function estimateRouteLoad(route: RouteShape, athlete: AthleteState): RouteLoad | null {
  const km = route.distanceM / 1000
  if (!(km > 0) || !Number.isFinite(route.speedKmh) || route.speedKmh <= 0) return null

  const hours = km / route.speedKmh
  const durationS = Math.round(hours * 3600)

  const watts = estimatedWatts(route, athlete.weightKg, durationS)
  const usePower = watts != null && !!athlete.ftp && athlete.ftp > 0
  const rawIf = usePower ? watts! / athlete.ftp! : (ESTIMATED_IF[route.sport] ?? ESTIMATED_IF.cycling)
  const intensity = Math.min(Math.max(rawIf, 0), INTENSITY_CAP)
  const tss = Math.round(hours * intensity ** 2 * 100)

  return {
    tss,
    intensity: Math.round(intensity * 100) / 100,
    durationS,
    watts: usePower ? Math.round(watts!) : null,
    source: usePower ? 'power' : 'estimated',
    ...formContext(tss, athlete),
  }
}

// Contexte de forme : poids de la sortie rapporté à la charge habituelle (CTL) et
// fraîcheur (TSB) au lendemain si on la fait aujourd'hui.
function formContext(tss: number, athlete: AthleteState) {
  const { ctl, atl } = athlete
  if (ctl == null || atl == null || ctl <= 0) {
    return { ctlRatio: null, level: null, tsbNow: null, tsbAfter: null }
  }

  const ctlRatio = tss / ctl
  // Mêmes paliers que la faisabilité d'une sortie objectif (useTrainingPlan) :
  // au-delà de ~1,5 × la charge quotidienne habituelle la sortie pique, au-delà
  // de ~2,5 × elle sort franchement de l'ordinaire.
  const level: RouteLoad['level'] = ctlRatio <= 1.5 ? 'ok' : ctlRatio <= 2.5 ? 'demanding' : 'hard'

  // Projection à un jour : on avance les EWMA d'un cran avec le TSS de la sortie.
  // Approximation assumée : on part de la forme du jour, donc si tu as déjà roulé
  // aujourd'hui, cette sortie compte comme un jour de plus.
  const ctlAfter = ctl + (tss - ctl) * K_CTL
  const atlAfter = atl + (tss - atl) * K_ATL

  return {
    ctlRatio: Math.round(ctlRatio * 10) / 10,
    level,
    tsbNow: Math.round(ctl - atl),
    tsbAfter: Math.round(ctlAfter - atlAfter),
  }
}
