import { ref, computed } from 'vue'

// Catalogue fermé — miroir de TrainingProgram::SOUNDS (training_program.rb) et des
// fichiers `assets/sounds/*.wav` du dépôt companion. `null` = pas de son (jalon à 0).
export const SOUNDS = ['start', 'end', 'bell', 'horn', 'horn2', 'booster'] as const
export type Sound = typeof SOUNDS[number]

export interface Milestone {
  offsetSeconds: number
  sound: Sound | null
  segmentName: string
}

export const MAX_MILESTONES = 200

// Jalon d'ouverture obligatoire : porte le nom du premier tronçon, jamais de son
// (rien ne l'annonce, la sortie vient tout juste de démarrer).
export function openingMilestone(): Milestone {
  return { offsetSeconds: 0, sound: null, segmentName: '' }
}

class TrainingProgramStore {
  readonly name = ref('')
  readonly milestones = ref<Milestone[]>([openingMilestone()])
  readonly currentId = ref<number | null>(null)
  readonly shareToken = ref<string | null>(null)
  readonly error = ref<string | null>(null)

  readonly isEditMode = computed(() => this.currentId.value != null)

  reset() {
    this.name.value = ''
    this.milestones.value = [openingMilestone()]
    this.currentId.value = null
    this.shareToken.value = null
    this.error.value = null
  }
}

export const trainingProgramStore = new TrainingProgramStore()
