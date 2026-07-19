// Helpers purs de la navigation (RouteNavigation.vue). Aucune dépendance à l'état
// réactif ni à MapLibre : tout est passé en paramètre, pour rester testable et
// réutilisable par les sous-composants (NavTurnBanner, NavClimbCard, NavScreenOff…).
import { colorForGrade, gradeForIndex } from './routeHelpers'
import type { Climb, LngLat, Maneuver, TurnPoint } from './routeHelpers'

// ─── Types partagés des overlays de navigation ─────────────────────────────────

// Indice de virage affiché (bandeau éveillé / carte de veille).
// state : 'far' (lointain, bandeau discret) · 'near' (approche) · 'now' (atteint, vert).
export interface TurnHint {
  direction: 'left' | 'right'
  distM: number
  kind: Maneuver
  angle: number
  exitNumber?: number
  state: 'far' | 'near' | 'now'
}

export interface ProfilePoint { x: number; y: number }
export interface ProfileSegment { d: string; color: string }

// Profil d'altitude gradué d'un col (viewBox 0–100), construit une fois par col.
export interface ClimbProfile {
  segments: ProfileSegment[]   // polygones colorés par pente
  areaD: string                // aire remplie sous toute la ligne d'altitude (gris « fait »)
  pts: ProfilePoint[]          // points de la ligne d'altitude
  topY: number                 // y du sommet (point le plus haut)
}

// Données complètes de la carte de col (climbInfo).
export interface ClimbInfo {
  climb: Climb
  ratio: number
  remainingGainM: number
  segments: ProfileSegment[]
  areaD: string
  posX: number      // curseur x (% de la largeur du profil)
  posY: number      // curseur y (% de la hauteur)
  topY: number      // sommet y (%)
  grade: number     // pente instantanée au coureur (%)
  gradeColor: string  // couleur de fond du badge (par tranche de pente)
  gradeText: string   // couleur de texte contrastée (noir/blanc)
}

// ─── Couleurs / icônes ──────────────────────────────────────────────────────────

// Noir ou blanc, selon ce qui se lit le mieux sur `hex` (luminance perçue, BT.601).
export function textColorOn(hex: string): string {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111827' : '#ffffff'
}

// Icône FontAwesome de l'indicateur de virage : flèches directionnelles simples pour
// les virages, droit-devant quand la déviation est négligeable, icônes distinctes pour
// ronds-points et demi-tours.
export function turnIcon(h: { direction: 'left' | 'right'; kind: Maneuver; angle: number }): string {
  if (h.kind === 'roundabout') return h.direction === 'left' ? 'fa-rotate-left' : 'fa-rotate-right'
  if (h.kind === 'uturn') return 'fa-arrow-down'
  if (Math.abs(h.angle) < 20) return 'fa-arrow-up'
  return h.direction === 'left' ? 'fa-arrow-left' : 'fa-arrow-right'
}

// Rafale de virages enchaînés à partir du virage `ptr` : renvoie les virages SUIVANTS
// qui se succèdent de près (au plus `gapM` entre deux consécutifs). Le virage `ptr`
// lui-même reste le principal (affiché en grand) et n'est PAS inclus ; le tableau ne
// contient donc que les virages secondaires, chacun avec sa distance depuis la position
// courante `here`. Total plafonné à `max` virages (donc au plus `max - 1` suivants).
export function buildTurnChain(
  turns: TurnPoint[],
  ptr: number,
  here: number,
  gapM: number,
  max: number,
): TurnHint[] {
  const out: TurnHint[] = []
  if (ptr < 0 || ptr >= turns.length) return out
  let prevDistM = turns[ptr].distM
  for (let i = ptr + 1; i < turns.length && out.length < max - 1; i++) {
    const tn = turns[i]
    if (tn.distM - prevDistM > gapM) break
    out.push({
      direction: tn.direction,
      distM: tn.distM - here,
      kind: tn.kind,
      angle: tn.angle,
      exitNumber: tn.exitNumber,
      state: 'near',
    })
    prevDistM = tn.distM
  }
  return out
}

// Temps estimé jusqu'au prochain virage, à la vitesse actuelle. Renvoie null tant
// qu'on est quasi à l'arrêt (vitesse < 1 km/h) : l'estimation exploserait et n'aurait
// aucun sens. Format horloge m:ss au-delà d'une minute, « N s » en deçà.
export function turnEta(distM: number, speedKmh: number): string | null {
  if (speedKmh < 1) return null
  const sec = distM / (speedKmh / 3.6)
  if (sec < 60) return `${Math.round(sec)} s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Durée restante estimée (en secondes) à `speedKmh`. Renvoie null sous 1 km/h :
// l'estimation exploserait à l'arrêt et n'aurait aucun sens. À alimenter avec une
// vitesse lissée (et non instantanée) pour une ETA stable feu rouge / relance.
export function remainingSeconds(distM: number, speedKmh: number): number | null {
  if (speedKmh < 1) return null
  return distM / (speedKmh / 3.6)
}

// Format compact d'une durée : « 12 min » en deçà d'une heure, « 1 h 05 » au-delà.
export function formatDuration(sec: number): string {
  const totalMin = Math.max(0, Math.round(sec / 60))
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  return `${h} h ${String(totalMin % 60).padStart(2, '0')}`
}

// Heure d'arrivée estimée au format horloge « 14:32 », soit maintenant + `sec`.
export function arrivalClock(sec: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() + sec * 1000)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ─── Géométrie ────────────────────────────────────────────────────────────────

// Déplace un lng/lat de `distM` selon `bearingDeg` (équirectangulaire — précis au
// centimètre près sur les quelques mètres extrapolés entre deux fixes GPS).
export function moveLngLat([lng, lat]: LngLat, bearingDeg: number, distM: number): LngLat {
  const R = 6371000
  const br = (bearingDeg * Math.PI) / 180
  const dLat = (distM * Math.cos(br)) / R
  const dLng = (distM * Math.sin(br)) / (R * Math.cos((lat * Math.PI) / 180))
  return [lng + (dLng * 180) / Math.PI, lat + (dLat * 180) / Math.PI]
}

// ─── Profil de col ───────────────────────────────────────────────────────────

// Construit le profil d'altitude gradué d'un col. Chaque segment est un polygone rempli
// de la ligne d'altitude jusqu'à la base, coloré par sa pente. Coordonnées dans un
// viewBox 0–100 : x couvre la distance du col, y est l'altitude normalisée sur la plage.
// Pur : la mise en cache par startIdx reste à la charge de l'appelant.
export function buildClimbProfile(
  climb: Climb,
  alts: (number | null)[],
  cumDistM: number[],
): ClimbProfile {
  const { startIdx: s, endIdx: e } = climb
  const startM = cumDistM[s]
  const span = (cumDistM[e] - startM) || 1
  let minA = Infinity
  let maxA = -Infinity
  for (let i = s; i <= e; i++) { const a = alts[i] ?? 0; if (a < minA) minA = a; if (a > maxA) maxA = a }
  const range = (maxA - minA) || 1
  const xOf = (i: number) => ((cumDistM[i] - startM) / span) * 100
  const yOf = (i: number) => 96 - (((alts[i] ?? 0) - minA) / range) * 88  // 4–96, sommet en haut
  const pts: ProfilePoint[] = []
  for (let i = s; i <= e; i++) pts.push({ x: xOf(i), y: yOf(i) })
  const topY = Math.min(...pts.map((p) => p.y))
  // Aire remplie sous toute la ligne d'altitude — réutilisée (clippée) pour le gris « fait ».
  let areaD = `M${pts[0].x},100`
  for (const p of pts) areaD += ` L${p.x},${p.y}`
  areaD += ` L${pts[pts.length - 1].x},100 Z`
  const segments: ProfileSegment[] = []
  for (let i = s; i < e; i++) {
    const x1 = xOf(i)
    const x2 = xOf(i + 1)
    segments.push({
      d: `M${x1},${yOf(i)} L${x2},${yOf(i + 1)} L${x2},100 L${x1},100 Z`,
      color: colorForGrade(gradeForIndex(i, alts, cumDistM)),
    })
  }
  return { segments, areaD, pts, topY }
}

// Altitude (y, % de hauteur) à un x donné (% de largeur), interpolée entre points.
export function profileYAt(pts: ProfilePoint[], x: number): number {
  if (!pts.length) return 100
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x >= x) {
      const a = pts[i - 1]
      const b = pts[i]
      const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0
      return a.y + t * (b.y - a.y)
    }
  }
  return pts[pts.length - 1].y
}

// ─── Débug ────────────────────────────────────────────────────────────────────

// Profil de col synthétique pour la carte de col (climbInfo). Reproduit la forme des
// données réelles (segments colorés par pente, aire remplie, curseur « vous êtes ici »)
// sans dépendre de la géométrie de l'itinéraire.
export function buildDebugClimb(): ClimbInfo {
  const n = 28
  const pts: ProfilePoint[] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    pts.push({ x: f * 100, y: 96 - Math.pow(f, 1.5) * 90 })   // altitude haute = y bas
  }
  const segments: ProfileSegment[] = []
  for (let i = 0; i < n; i++) {
    const g = 3 + (i / n) * 11   // 3 % en bas → 14 % au sommet
    segments.push({
      d: `M${pts[i].x},${pts[i].y} L${pts[i + 1].x},${pts[i + 1].y} L${pts[i + 1].x},100 L${pts[i].x},100 Z`,
      color: colorForGrade(g),
    })
  }
  let areaD = `M${pts[0].x},100`
  for (const p of pts) areaD += ` L${p.x},${p.y}`
  areaD += ` L${pts[n].x},100 Z`
  const ratio = 0.42
  const posX = ratio * 100
  // y de la ligne d'altitude au curseur (interpolation linéaire entre points).
  const posY = profileYAt(pts, posX)
  const grade = 9
  const gradeColor = colorForGrade(grade)
  const climb: Climb = { startIdx: 0, endIdx: 0, gain: 560, lengthM: 8400, avgGrade: 6.7, category: '2', startKm: 0, endKm: 8.4 }
  return {
    climb, ratio, remainingGainM: climb.gain * (1 - ratio),
    segments, areaD, posX, posY,
    topY: Math.min(...pts.map((p) => p.y)),
    grade, gradeColor, gradeText: textColorOn(gradeColor),
  }
}
