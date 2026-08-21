import { ref, computed } from 'vue'

// Catalogue fermé — miroir de TrainingProgram::SOUNDS (training_program.rb) et des
// fichiers `assets/sounds/*.wav` du dépôt companion. `null` = pas de son (jalon à 0).
export const SOUNDS = ['start', 'end', 'bell', 'horn', 'horn2', 'booster'] as const
export type Sound = typeof SOUNDS[number]

// Catalogue fermé — miroir de TrainingProgram::ICONS (training_program.rb). Purement
// visuel côté éditeur pour l'instant (pas encore consommé par l'appli companion).
export const MILESTONE_ICONS = [
  { key: 'warmup', icon: 'fa-person-walking' },
  { key: 'sprint', icon: 'fa-bolt' },
  { key: 'effort', icon: 'fa-fire' },
  { key: 'recovery', icon: 'fa-heart-pulse' },
  { key: 'climb', icon: 'fa-mountain' },
  { key: 'cooldown', icon: 'fa-snowflake' },
  { key: 'interval', icon: 'fa-repeat' },
  { key: 'hydration', icon: 'fa-droplet' },
  { key: 'alert', icon: 'fa-triangle-exclamation' },
  { key: 'finish', icon: 'fa-flag-checkered' },
] as const
export type MilestoneIcon = typeof MILESTONE_ICONS[number]['key']

export interface Milestone {
  offsetSeconds: number
  sound: Sound | null
  segmentName: string
  icon: MilestoneIcon | null
}

export const MAX_MILESTONES = 200

// Jalon d'ouverture obligatoire : porte le nom du premier tronçon, jamais de son
// (rien ne l'annonce, la sortie vient tout juste de démarrer).
export function openingMilestone(): Milestone {
  return { offsetSeconds: 0, sound: null, segmentName: '', icon: null }
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
