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

// Exécute `render` une fois le contexte audio réellement en marche. unlockAudio()
// recrée/réveille le contexte, mais resume() est ASYNCHRONE : appeler beep() dans la
// foulée alors que le contexte est encore `suspended` (cas classique sur mobile quand
// l'écran s'est mis en veille entre deux virages) fait tomber tous les bips (beep sort si
// l'état n'est pas `running`). On planifie donc le rendu après la reprise. Quand le
// contexte tourne déjà, rendu synchrone immédiat — aucun délai.
function whenAudioReady(render: () => void): void {
  unlockAudio()
  if (!ctx) return
  if (ctx.state === 'running') { render(); return }
  void ctx.resume().then(render).catch(() => { /* contexte bloqué — silencieux */ })
}

// Planifie le signal sonore d'un virage à l'instant `atS` (secondes) après
// ctx.currentTime, via le temps absolu de beep(). Découplé de playManeuver pour que la
// répétition « à la suite » (playManeuverBurst) empile plusieurs bips en une seule passe
// de planification Web Audio, sans timer.
//
// Signal UNIQUE pour tous les virages : un simple bip triangle à 1000 Hz (l'onde triangle
// est celle de beep()), identique quels que soient le type de manœuvre et le côté.
// `kind`/`direction` sont ignorés mais gardés dans la signature (appelants inchangés, et
// pour pouvoir re-différencier les signaux plus tard sans re-toucher aux appels).
function renderManeuver(_kind: Maneuver, _direction: 'left' | 'right', atS: number): void {
  beep(1000, atS, 0.1)
}

// Distinct audio cue per maneuver — une lecture unique.
export function playManeuver(kind: Maneuver, direction: 'left' | 'right'): void {
  whenAudioReady(() => renderManeuver(kind, direction, 0))
}

// Écart (s) entre les débuts de deux lectures consécutives d'un « paquet » (cf.
// playManeuverBurst) : la « repeat frequency » du signal. 0,15 s → bip répété toutes les
// 150 ms. Supérieur à la durée d'un bip (0,1 s) pour laisser un court silence entre chacun.
const MANEUVER_BURST_GAP_S = 0.15

// Joue le signal d'un virage `count` fois à la suite (1–10). Tout le paquet est PLANIFIÉ
// EN UNE PASSE via les temps absolus de Web Audio (renderManeuver à i × gap) : pas de
// setTimeout — donc aucune dérive quand l'onglet/l'écran est en veille (les timers JS y
// sont fortement bridés) et le son sort d'un bloc, sans latence entre les lectures.
// count = 1 revient à une seule annonce.
export function playManeuverBurst(kind: Maneuver, direction: 'left' | 'right', count: number): void {
  const n = Math.max(1, Math.min(10, Math.round(count) || 1))
  whenAudioReady(() => {
    for (let i = 0; i < n; i++) renderManeuver(kind, direction, i * MANEUVER_BURST_GAP_S)
  })
}

// Low, doubled buzz — an unmistakable warning that you have left the route.
export function playOffRoute(): void {
  unlockAudio()
  beep(360, 0, 0.2, 0.22)
  beep(280, 0.24, 0.3, 0.22)
}

// Petite ritournelle enjouée — un point d'intérêt approche. Une courte montée en
// arpège majeur (do-mi-sol-do) suivie d'une note d'accroche, plus musicale qu'un
// simple bip : ça s'entend comme « tiens, il y a quelque chose à voir ici ».
// Volontairement plus douce que les alertes virage/radar : c'est une invitation,
// pas une consigne de sécurité.
export function playPoi(): void {
  unlockAudio()
  // do5 · mi5 · sol5 · do6, puis un petit « ding » d'accroche sur le mi6.
  beep(523, 0, 0.1, 0.09)
  beep(659, 0.11, 0.1, 0.09)
  beep(784, 0.22, 0.1, 0.09)
  beep(1047, 0.33, 0.14, 0.1)
  beep(1319, 0.5, 0.2, 0.1)
}

// Petite fanfare ascendante — destination atteinte. Un arpège majeur qui monte
// (do-mi-sol-do) puis une quinte tenue par-dessus (sol), plus triomphant et plus long
// que la ritournelle POI : ça s'entend clairement comme « c'est fini, tu es arrivé ».
export function playArrival(): void {
  unlockAudio()
  whenAudioReady(() => {
    beep(523, 0, 0.12, 0.12)     // do5
    beep(659, 0.13, 0.12, 0.12)  // mi5
    beep(784, 0.26, 0.12, 0.12)  // sol5
    beep(1047, 0.39, 0.18, 0.14) // do6
    beep(784, 0.6, 0.35, 0.14)   // sol5 tenu
  })
}

// Two quick rising notes — a car has just entered radar range behind you. Kept
// distinct from the turn cues (which carry a left/right pitch direction) so it
// reads clearly as "vehicle approaching", not a maneuver.
export function playRadarThreat(): void {
  unlockAudio()
  beep(880, 0, 0.09, 0.2)
  beep(1180, 0.1, 0.14, 0.2)
}

// Three fast, louder notes — the car has closed in (under ~30 m). More insistent
// than the entry cue so it stands out as "it's right behind you now".
export function playRadarClose(): void {
  unlockAudio()
  beep(1180, 0, 0.08, 0.24)
  beep(1180, 0.1, 0.08, 0.24)
  beep(1180, 0.2, 0.16, 0.24)
}
