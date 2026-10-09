import { ref, computed } from 'vue'

// Catalogue fermé — miroir de TrainingProgram::SOUNDS (training_program.rb) et des
// fichiers `assets/sounds/*.wav` du dépôt companion. `null` = pas de son.
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
// Le « moment » d'un son par rapport à la frontière qu'il accompagne (début ou fin
// de bloc) : `before` se termine pile sur la frontière, `at` démarre pile dessus.
export const CUE_TIMINGS = ['before', 'at'] as const
export type CueTiming = typeof CUE_TIMINGS[number]

// Moments pris par défaut — miroir de TrainingProgram::DEFAULT_START_TIMING /
// DEFAULT_END_TIMING : dans les deux cas le son joue à l'intérieur du bloc.
export const DEFAULT_START_TIMING: CueTiming = 'at'
export const DEFAULT_END_TIMING: CueTiming = 'before'

// Durée de chaque son arrondie à la seconde supérieure (précision de l'appli) —
// miroir de TrainingProgram::SOUND_SECONDS, durées réelles des `*.wav`.
export const SOUND_SECONDS: Record<Sound, number> = {
  start: 5, end: 5, end2: 4, end3: 2, bell: 1, horn: 2, horn2: 5, booster: 7,
}

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

// Un bloc de l'éditeur : une durée et ses cibles. Les blocs sont posés bout à bout ;
// c'est le serveur/l'appli qui voient des jalons (`offset_seconds` cumulé), la conversion
// se fait dans TrainingProgramBuilder.vue. Un bloc peut jouer un son à son début et/ou
// à sa fin, chacun avec son moment.
export interface Block {
  durationSeconds: number
  startSound: Sound | null
  startCueTiming: CueTiming
  endSound: Sound | null
  endCueTiming: CueTiming
  segmentName: string
  icon: MilestoneIcon | null
  color: string | null
  textColor: string | null
  power: TargetRange
  heartRate: TargetRange
  cadence: TargetRange
  speedKmh: TargetRange
}

// Miroirs de TrainingProgram::MAX_BLOCKS (programme **déplié**, chaque répétition compte)
// et MAX_REPEAT.
export const MAX_BLOCKS = 200
export const MAX_REPEAT = 99

export const DEFAULT_BLOCK_SECONDS = 300

// Un groupe de répétition : ses éléments, joués `repeat` fois de suite. Il peut en
// contenir d'autres, jusqu'à MAX_GROUP_DEPTH niveaux. Le serveur le déplie pour l'appli.
export interface Group {
  repeat: number
  items: Item[]
}

// Un élément du programme : un bloc seul ou un groupe de répétition.
export type Item = Block | Group

// Miroir de TrainingProgram::MAX_GROUP_DEPTH.
export const MAX_GROUP_DEPTH = 3

export function isGroup(item: Item): item is Group {
  return 'repeat' in item
}

// Les blocs du programme dépliés — un groupe répété trois fois y apparaît trois fois
// (le même objet). C'est sur cette liste que portent la durée et les contrôles de sons.
export function flattenItems(items: Item[]): Block[] {
  return items.flatMap((item) => {
    if (!isGroup(item)) return [item]
    const inner = flattenItems(item.items)
    return Array.from({ length: item.repeat }, () => inner).flat()
  })
}

// Combien de blocs un élément pèse une fois déplié, et combien de secondes il dure.
export function flatSize(item: Item): number {
  return isGroup(item) ? item.repeat * item.items.reduce((sum, i) => sum + flatSize(i), 0) : 1
}

export function itemSeconds(item: Item): number {
  return isGroup(item) ? item.repeat * cycleSeconds(item) : item.durationSeconds
}

// La durée d'un tour du groupe.
export function cycleSeconds(group: Group): number {
  return group.items.reduce((sum, i) => sum + itemSeconds(i), 0)
}

// Niveaux de groupes sous cet élément (0 pour un bloc).
export function groupDepth(item: Item): number {
  return isGroup(item) ? 1 + Math.max(0, ...item.items.map(groupDepth)) : 0
}

export function newBlock(): Block {
  return {
    durationSeconds: DEFAULT_BLOCK_SECONDS,
    startSound: null,
    startCueTiming: DEFAULT_START_TIMING,
    endSound: null,
    endCueTiming: DEFAULT_END_TIMING,
    segmentName: '',
    icon: null,
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
  readonly items = ref<Item[]>([newBlock()])
  readonly currentId = ref<number | null>(null)
  readonly shareToken = ref<string | null>(null)
  readonly error = ref<string | null>(null)

  readonly isEditMode = computed(() => this.currentId.value != null)

  reset() {
    this.name.value = ''
    this.sport.value = 'cycling'
    this.items.value = [newBlock()]
    this.currentId.value = null
    this.shareToken.value = null
    this.error.value = null
  }
}

export const trainingProgramStore = new TrainingProgramStore()

// Un problème de sons : deux sons qui joueraient en même temps (`overlap`, entre `a` et
// `b`) ou un son qui devrait démarrer avant le début du programme (`before_start`).
export type SoundSlotRef = { block: number; edge: 'start' | 'end' }
export type SoundIssue =
  | { kind: 'overlap'; a: SoundSlotRef; b: SoundSlotRef }
  | { kind: 'before_start'; slot: SoundSlotRef }

// Miroir de TrainingProgram.sound_slots / validate_sounds_do_not_overlap (training_program.rb) :
// chaque son occupe un intervalle [from, to] en secondes depuis le départ ; se toucher
// n'est pas se chevaucher. Le serveur refuse l'enregistrement de toute façon.
export function soundIssues(blocks: Block[]): SoundIssue[] {
  const slots: { from: number; to: number; ref: SoundSlotRef }[] = []
  let offset = 0
  blocks.forEach((b, i) => {
    const finish = offset + b.durationSeconds
    if (b.startSound) {
      const len = SOUND_SECONDS[b.startSound]
      // Rien avant le premier bloc : son part au départ, quoi qu'on ait réglé.
      const from = i > 0 && b.startCueTiming === 'before' ? offset - len : offset
      slots.push({ from, to: from + len, ref: { block: i, edge: 'start' } })
    }
    if (b.endSound) {
      const len = SOUND_SECONDS[b.endSound]
      const from = b.endCueTiming === 'at' ? finish : finish - len
      slots.push({ from, to: from + len, ref: { block: i, edge: 'end' } })
    }
    offset = finish
  })
  slots.sort((x, y) => x.from - y.from || x.to - y.to)

  const issues: SoundIssue[] = []
  if (slots.length && slots[0].from < 0) issues.push({ kind: 'before_start', slot: slots[0].ref })
  for (let k = 1; k < slots.length; k++) {
    if (slots[k].from < slots[k - 1].to) issues.push({ kind: 'overlap', a: slots[k - 1].ref, b: slots[k].ref })
  }
  return issues
}
