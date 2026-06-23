import { ref } from 'vue'
import { unlockAudio } from '../navAudio'

// Son de la séance de navigation (alertes virage / radar). L'état est persisté en
// localStorage pour survivre d'une séance à l'autre, et l'AudioContext est
// (ré)autorisé au moment où l'utilisateur réactive le son — un geste utilisateur
// fiable. Partagé entre navigation libre et navigation sur itinéraire.
const SOUND_KEY = 'sportsScope.navSound'

function loadSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}

export function useNavSound() {
  const soundOn = ref(loadSound())

  function toggleSound() {
    soundOn.value = !soundOn.value
    try { localStorage.setItem(SOUND_KEY, soundOn.value ? 'on' : 'off') } catch { /* ignore */ }
    if (soundOn.value) unlockAudio()
  }

  return { soundOn, toggleSound }
}
