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

// One short note. `start` and `durationS` are seconds; the gain envelope keeps
// it soft and click-free.
function beep(freq: number, start: number, durationS: number, gainPeak = 0.18): void {
  if (!ctx || ctx.state !== 'running') return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  const t0 = ctx.currentTime + start
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + durationS + 0.02)
}

// Two notes that rise for a right turn and fall for a left turn, so the rider
// can tell the direction without looking at the screen.
export function playTurn(direction: 'left' | 'right'): void {
  unlockAudio()
  if (direction === 'right') {
    beep(620, 0, 0.16)
    beep(900, 0.18, 0.22)
  } else {
    beep(900, 0, 0.16)
    beep(620, 0.18, 0.22)
  }
}

// Low, doubled buzz — an unmistakable warning that you have left the route.
export function playOffRoute(): void {
  unlockAudio()
  beep(360, 0, 0.2, 0.22)
  beep(280, 0.24, 0.3, 0.22)
}
