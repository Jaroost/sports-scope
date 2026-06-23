// Synthesised audio cues for turn-by-turn navigation. Built on the Web Audio
// API so there are no asset files to ship and everything works offline. Browsers
// suspend the audio context until a user gesture (autoplay policy), so unlock()
// must be called from a real touch/click before any cue can be heard.

let ctx: AudioContext | null = null

export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return
      ctx = new AC()
    }
    if (ctx.state === 'suspended') void ctx.resume()
  } catch { /* unsupported or blocked */ }
}

// Global loudness multiplier applied to every cue. A web app can't request the
// OS to "duck" (lower) the music the user is playing, so the cues are mixed on
// top of it at full music volume — they have to be loud and bright to cut
// through. This base value is then scaled by the user's volume preference
// (`setSoundVolume`, 0–100 %), so every cue — turns and radar — is retuned at once.
const BASE_GAIN = 10
let MASTER_GAIN = BASE_GAIN
// Facteur de volume courant (1 = 100 %). Mémorisé à part pour faire monter aussi le
// plafond d'écrêtage au-delà de 100 % : sans ça, les bips forts saturent déjà le
// plafond à 100 % et l'augmentation du pourcentage resterait inaudible pour eux.
let volumeFactor = 1

// Règle le volume général des alertes (virages + radar), en pourcentage du volume
// de base (100 % = comportement par défaut). Piloté par la préférence du profil
// `navigation.sound_volume`. Borné à [0, 200] %.
export function setSoundVolume(percent: number): void {
  const clamped = Math.min(200, Math.max(0, percent))
  volumeFactor = clamped / 100
  MASTER_GAIN = BASE_GAIN * volumeFactor
}

// One short note. `start` and `durationS` are seconds; the gain envelope keeps
// it click-free. A `triangle` wave (richer in harmonics than a pure sine)
// carries much better over music than a sine at the same level.
function beep(freq: number, start: number, durationS: number, gainPeak = 0.18): void {
  if (!ctx || ctx.state !== 'running') return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq
  // Plafond d'écrêtage : 2 jusqu'à 100 % (comportement d'origine inchangé), puis relevé
  // proportionnellement au-dessus, pour que le réglage > 100 % pousse réellement les
  // bips déjà forts (écrêtage plus marqué = onde plus carrée = perçue plus forte).
  const peak = Math.min(gainPeak * MASTER_GAIN, 2 * Math.max(1, volumeFactor))
  const t0 = ctx.currentTime + start
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + durationS + 0.02)
}

import type { Maneuver } from './routeHelpers'

// Distinct audio cue per maneuver. Across every cue, a rising pitch means right
// and a falling pitch means left, so the side is recognisable without looking;
// the rhythm/shape conveys the maneuver type (slight, sharp, roundabout…).
export function playManeuver(kind: Maneuver, direction: 'left' | 'right'): void {
  unlockAudio()
  const right = direction === 'right'
  switch (kind) {
    case 'slight':
      // A single soft note — a gentle nudge.
      beep(right ? 760 : 560, 0, 0.18, 0.13)
      break
    case 'sharp':
      // Three quick, louder notes climbing/falling steeply — urgent.
      if (right) { beep(600, 0, 0.1, 0.2); beep(820, 0.12, 0.1, 0.2); beep(1060, 0.24, 0.22, 0.2) }
      else { beep(1060, 0, 0.1, 0.2); beep(820, 0.12, 0.1, 0.2); beep(600, 0.24, 0.22, 0.2) }
      break
    case 'keep':
      // Two very short, quiet notes close together — a subtle "stay this side".
      beep(right ? 700 : 620, 0, 0.09, 0.1)
      beep(right ? 780 : 540, 0.11, 0.11, 0.1)
      break
    case 'uturn':
      // Low descending triple — unmistakably "turn around".
      beep(520, 0, 0.16, 0.2); beep(400, 0.18, 0.16, 0.2); beep(300, 0.36, 0.26, 0.2)
      break
    case 'roundabout':
      // Even triplet on one pitch — like going round.
      beep(700, 0, 0.1, 0.18); beep(700, 0.14, 0.1, 0.18); beep(700, 0.28, 0.18, 0.18)
      break
    case 'turn':
    default:
      // Two notes; rising for right, falling for left.
      if (right) { beep(620, 0, 0.16); beep(900, 0.18, 0.22) }
      else { beep(900, 0, 0.16); beep(620, 0.18, 0.22) }
  }
}

// Low, doubled buzz — an unmistakable warning that you have left the route.
export function playOffRoute(): void {
  unlockAudio()
  beep(360, 0, 0.2, 0.22)
  beep(280, 0.24, 0.3, 0.22)
}

// Two quick rising notes — a car has just entered radar range behind you. Kept
// distinct from the turn cues (which carry a left/right pitch direction) so it
// reads clearly as "vehicle approaching", not a maneuver.
export function playRadarThreat(): void {
  unlockAudio()
  beep(880, 0, 0.09, 0.16)
  beep(1180, 0.1, 0.14, 0.16)
}

// Three fast, louder notes — the car has closed in (under ~30 m). More insistent
// than the entry cue so it stands out as "it's right behind you now".
export function playRadarClose(): void {
  unlockAudio()
  beep(1180, 0, 0.08, 0.24)
  beep(1180, 0.1, 0.08, 0.24)
  beep(1180, 0.2, 0.16, 0.24)
}
