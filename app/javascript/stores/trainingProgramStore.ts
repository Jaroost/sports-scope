import { ref, computed } from 'vue'

// Catalogue fermé — miroir de TrainingProgram::SOUNDS (training_program.rb) et des
// fichiers `assets/sounds/*.wav` du dépôt companion. `null` = pas de son (jalon à 0).
export const SOUNDS = ['start', 'end', 'end2', 'end3', 'bell', 'horn', 'horn2', 'booster'] as const
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

// Catalogue fermé — miroir de TrainingProgram::CUE_TIMINGS (training_program.rb).
// `before` (par défaut, absent inclus) : le son démarre en avance pour se terminer
// pile au départ du jalon (WorkoutCuePolicy, dépôt companion). `at` : le son part
// au franchissement lui-même.
export const CUE_TIMINGS = ['before', 'at'] as const
export type CueTiming = typeof CUE_TIMINGS[number]

// Catalogue fermé — miroir de TrainingProgram::SPORTS (training_program.rb). Pilote
// uniquement l'unité de saisie/affichage de la vitesse cible (km/h vs allure min/km) —
// le stockage reste toujours en km/h (cf. TargetRange sur `speedKmh`).
export const SPORTS = ['cycling', 'running'] as const
export type Sport = typeof SPORTS[number]

// Une cible + ses bornes pour un canal (puissance, FC, cadence ou vitesse). `min`/`max`
// n'ont de sens qu'accompagnés de `target` (cf. TrainingProgram#validate_target_bounds).
export interface TargetRange {
  target: number | null
  min: number | null
  max: number | null
}

function emptyTargetRange(): TargetRange {
  return { target: null, min: null, max: null }
}

// Miroir de TrainingProgram::TARGET_FIELDS (training_program.rb) — plafonds de
// sanité, pas des zones physio. Le serveur reclampe de toute façon à l'enregistrement.
export const TARGET_CEILINGS: Record<'power' | 'heartRate' | 'cadence' | 'speedKmh', number> = {
  power: 3000,
  heartRate: 250,
  cadence: 220,
  speedKmh: 120,
}

export interface Milestone {
  offsetSeconds: number
  sound: Sound | null
  segmentName: string
  icon: MilestoneIcon | null
  cueTiming: CueTiming | null
  color: string | null
  textColor: string | null
  power: TargetRange
  heartRate: TargetRange
  cadence: TargetRange
  speedKmh: TargetRange
}

export const MAX_MILESTONES = 200

// Jalon d'ouverture obligatoire : porte le nom du premier tronçon, jamais de son
// (rien ne l'annonce, la sortie vient tout juste de démarrer).
export function openingMilestone(): Milestone {
  return {
    offsetSeconds: 0,
    sound: null,
    segmentName: '',
    icon: null,
    cueTiming: null,
    color: null,
    textColor: null,
    power: emptyTargetRange(),
    heartRate: emptyTargetRange(),
    cadence: emptyTargetRange(),
    speedKmh: emptyTargetRange(),
  }
}

class TrainingProgramStore {
  readonly name = ref('')
  readonly sport = ref<Sport>('cycling')
  readonly milestones = ref<Milestone[]>([openingMilestone()])
  readonly currentId = ref<number | null>(null)
  readonly shareToken = ref<string | null>(null)
  readonly error = ref<string | null>(null)

  readonly isEditMode = computed(() => this.currentId.value != null)

  reset() {
    this.name.value = ''
    this.sport.value = 'cycling'
    this.milestones.value = [openingMilestone()]
    this.currentId.value = null
    this.shareToken.value = null
    this.error.value = null
  }
}

export const trainingProgramStore = new TrainingProgramStore()
