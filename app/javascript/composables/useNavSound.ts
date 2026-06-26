import { ref } from 'vue'
import { unlockAudio, setSoundVolume } from '../navAudio'
import { userPreferences } from '../userPreferences'

// Son de la séance de navigation (alertes virage / radar). L'état est persisté en
// localStorage pour survivre d'une séance à l'autre, et l'AudioContext est
// (ré)autorisé au moment où l'utilisateur réactive le son — un geste utilisateur
// fiable. Partagé entre navigation libre et navigation sur itinéraire.
const SOUND_KEY = 'sportsScope.navSound'
const VOLUME_KEY = 'sportsScope.navVolume'

function loadSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}

function loadVolume(fallback: number): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw == null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch { return fallback }
}

export function useNavSound() {
  const soundOn = ref(loadSound())

  // Volume général des alertes (virages + radar). Initialisé sur le dernier réglage de
  // séance (localStorage), à défaut la préférence du profil. Modifiable en direct depuis
  // le tiroir via setVolume : le changement est appliqué immédiatement (setSoundVolume)
  // et persisté pour les séances suivantes.
  const soundVolume = ref(loadVolume(userPreferences().navigation.sound_volume ?? 100))
  setSoundVolume(soundVolume.value)

  function toggleSound() {
    soundOn.value = !soundOn.value
    try { localStorage.setItem(SOUND_KEY, soundOn.value ? 'on' : 'off') } catch { /* ignore */ }
    if (soundOn.value) unlockAudio()
  }

  function setVolume(percent: number) {
    soundVolume.value = percent
    setSoundVolume(percent)
    try { localStorage.setItem(VOLUME_KEY, String(percent)) } catch { /* ignore */ }
  }

  return { soundOn, toggleSound, soundVolume, setVolume }
}
