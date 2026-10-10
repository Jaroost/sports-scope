import { ref, shallowRef, computed, toRaw } from 'vue'
import { trainingProgramStore, newBlock, soundIssues, flattenItems, flatSize, itemSeconds, cycleSeconds, groupDepth, isGroup, MAX_BLOCKS, MAX_REPEAT, MAX_GROUP_DEPTH } from './trainingProgramStore'
import type { Block, Group, Item, SoundIssue, SoundSlotRef } from './trainingProgramStore'

// L'édition de la liste d'éléments (blocs et groupes de répétition) : sélection,
// déplacements, groupes imbriqués, glisser-déposer. Un singleton comme le store
// auquel il se rattache — l'éditeur et la liste récursive (TrainingProgramItemList)
// en partagent l'état.
//
// Partout, `owner` désigne la liste concernée : un groupe, ou `null` pour la racine.
// `multiplier` est le nombre de fois que cette liste est jouée (le produit des
// répétitions de ses groupes parents) : ajouter un bloc dans une liste jouée 4 fois
// pèse 4 dans le plafond du programme déplié.

const items = trainingProgramStore.items

// ---- Vue dépliée : durée, départ de chaque bloc, contrôle des sons ----

// Le programme tel que l'appli le jouera : chaque répétition d'un groupe compte.
export const flat = computed(() => flattenItems(items.value))
export const flatCount = computed(() => flat.value.length)
export const durationSeconds = computed(() => flat.value.reduce((sum, b) => sum + b.durationSeconds, 0))

// Instant de départ de la **première** occurrence de chaque élément — purement
// informatif, c'est la durée qui est saisie.
const startOf = computed(() => {
  const starts = new Map<object, number>()
  const walk = (list: Item[], from: number): number => {
    let offset = from
    for (const item of list) {
      starts.set(toRaw(item), offset)
      if (isGroup(item)) walk(item.items, offset)
      offset += itemSeconds(item)
    }
    return offset
  }
  walk(items.value, 0)
  return starts
})

export function startSecondsOf(item: object): number {
  return startOf.value.get(toRaw(item)) ?? 0
}

// Départ de chaque bloc de la vue dépliée, pour situer un son fautif dans le temps.
const flatStarts = computed(() => {
  let acc = 0
  return flat.value.map((b) => { const start = acc; acc += b.durationSeconds; return start })
})

// Sons qui se chevauchent : détectés à chaque modification, l'enregistrement est
// bloqué tant qu'il en reste (le serveur les refuserait de toute façon). Désignés par
// leur instant plutôt que par un numéro : un bloc répété y figure plusieurs fois.
export const issues = computed(() => soundIssues(flat.value))

export function issueSlots(issue: SoundIssue): SoundSlotRef[] {
  return issue.kind === 'overlap' ? [issue.a, issue.b] : [issue.slot]
}

export function slotStart(ref: SoundSlotRef): number {
  return flatStarts.value[ref.block] ?? 0
}

export function slotHasIssue(block: Block, edge: 'start' | 'end'): boolean {
  const raw = toRaw(block)
  return issues.value.some((issue) => issueSlots(issue).some((r) => r.edge === edge && toRaw(flat.value[r.block]) === raw))
}

// Le profil du programme en cours d'édition, au même format que `profile` dans la liste
// (cf. TrainingProgramsController#serialize_profile) pour alimenter le même graphique :
// les blocs dépliés réduits à leur durée et, par mesure ciblée quelque part,
// `[cible, min, max]`. `null` tant qu'aucune cible n'est posée.
const PROFILE_CHANNELS = [
  ['power', 'power'],
  ['heart_rate', 'heartRate'],
  ['cadence', 'cadence'],
  ['speed_kmh', 'speedKmh'],
] as const

// L'élément survolé dans la liste — un bloc, ou un groupe répété : le graphique éclaire
// la (ou les) tranche(s) de temps de tous les blocs qu'il contient.
const hovered = shallowRef<Set<Block> | null>(null)
export function setHovered(item: Item | null) {
  hovered.value = item ? new Set(flattenItems([item]).map((b) => toRaw(b))) : null
}

export const profile = computed(() => {
  const channels = PROFILE_CHANNELS.filter(([, key]) => flat.value.some((b) => b[key].target != null))
  if (channels.length === 0) return null
  return {
    channels: channels.map(([name]) => name as string),
    steps: flat.value.map((b) => ({
      duration_seconds: b.durationSeconds,
      color: b.color,
      highlight: hovered.value?.has(toRaw(b)) ?? false,
      ...Object.fromEntries(channels.map(([name, key]) => [name, [b[key].target, b[key].min, b[key].max]])),
    })),
  }
})

// Cibles incohérentes : une borne (min/max) n'a de sens qu'avec une cible, et la cible
// doit tomber entre les deux. Miroir de TrainingProgram#validate_target_bounds — le
// serveur refuse l'enregistrement sinon, avec un message qui ne dit pas quel bloc.
export type TargetChannel = 'power' | 'heartRate' | 'cadence' | 'speedKmh'
export type TargetIssue = { block: Block; channel: TargetChannel; kind: 'needs_target' | 'out_of_range' }

const TARGET_CHANNELS: TargetChannel[] = ['power', 'heartRate', 'cadence', 'speedKmh']

export const targetIssues = computed<TargetIssue[]>(() => {
  const out: TargetIssue[] = []
  // Un bloc répété n'est signalé qu'une fois.
  for (const block of new Set(flat.value.map((b) => toRaw(b)))) {
    for (const channel of TARGET_CHANNELS) {
      const { target, min, max } = block[channel]
      if ((min != null || max != null) && target == null) out.push({ block, channel, kind: 'needs_target' })
      else if (target != null && ((min != null && target < min) || (max != null && target > max))) out.push({ block, channel, kind: 'out_of_range' })
    }
  }
  return out
})

// ---- Plafonds ----

export function canAdd(extraBlocks: number, multiplier: number): boolean {
  return flatCount.value + extraBlocks * multiplier <= MAX_BLOCKS
}

export function canDuplicate(item: Item, multiplier: number): boolean {
  return canAdd(flatSize(item), multiplier)
}

// Le plus grand nombre de répétitions que le plafond du programme déplié autorise.
export function maxRepeatFor(group: Group, multiplier: number): number {
  const inner = group.items.reduce((sum, i) => sum + flatSize(i), 0)
  const others = flatCount.value - multiplier * group.repeat * inner
  return Math.max(2, Math.min(MAX_REPEAT, Math.floor((MAX_BLOCKS - others) / (multiplier * inner))))
}

// ---- Sélection : des éléments d'une même liste, pour les envelopper dans un groupe ----

// Par référence d'objet et non par index, qui se périme à chaque déplacement. Un
// `shallowRef` d'objets **bruts** : dans un `ref`, le Set serait réactif et lui
// demander ses éléments les rendrait en proxys, que `has(brut)` ne retrouve plus.
export const selected = shallowRef<Set<Item>>(new Set())
export const repeatCount = ref(2)

export function isSelected(item: Item): boolean {
  return selected.value.has(toRaw(item))
}

export function toggleSelected(item: Item) {
  const next = new Set(selected.value)
  const raw = toRaw(item)
  if (next.has(raw)) next.delete(raw)
  else next.add(raw)
  selected.value = next
}

export function clearSelection() {
  selected.value = new Set()
}

function listOf(owner: Group | null): Item[] {
  return owner ? owner.items : items.value
}

// Où se trouve un élément : sa liste et sa position, ou `null`.
function locate(target: Item, list: Item[] = items.value, owner: Group | null = null): { owner: Group | null; index: number } | null {
  const raw = toRaw(target)
  for (let i = 0; i < list.length; i++) {
    if (toRaw(list[i]) === raw) return { owner, index: i }
    const item = list[i]
    if (isGroup(item)) {
      const found = locate(target, item.items, item)
      if (found) return found
    }
  }
  return null
}

// La sélection, si elle forme une suite contiguë d'une seule liste.
const selection = computed(() => {
  const places = [...selected.value].map((item) => locate(item))
  if (places.length === 0 || places.some((p) => !p)) return null
  const owner = places[0]!.owner
  if (places.some((p) => toRaw(p!.owner as object) !== toRaw(owner as object))) return null
  const indices = places.map((p) => p!.index).sort((a, b) => a - b)
  for (let k = 1; k < indices.length; k++) {
    if (indices[k] !== indices[k - 1] + 1) return null
  }
  return { owner, indices }
})

// Pourquoi on ne peut pas encore grouper : rien de cohérent n'est sélectionné, ou le
// groupe dépasserait la profondeur autorisée. `null` = on peut.
export const groupBlocker = computed<'contiguous' | 'depth' | null>(() => {
  const sel = selection.value
  if (!sel) return 'contiguous'
  const list = listOf(sel.owner)
  const deepest = Math.max(...sel.indices.map((i) => groupDepth(list[i])))
  const depthOfList = ancestorsDepth(sel.owner)
  return depthOfList + 1 + deepest > MAX_GROUP_DEPTH ? 'depth' : null
})

// Combien de groupes englobent cette liste.
function ancestorsDepth(owner: Group | null, list: Item[] = items.value, depth = 0): number {
  if (!owner) return 0
  for (const item of list) {
    if (!isGroup(item)) continue
    if (toRaw(item) === toRaw(owner)) return depth + 1
    const found = ancestorsDepth(owner, item.items, depth + 1)
    if (found) return found
  }
  return 0
}

// Enveloppe la sélection dans un groupe répété `repeatCount` fois — les éléments ne
// sont plus dupliqués, c'est le groupe qui porte le nombre de répétitions.
export function groupSelected() {
  const sel = selection.value
  if (!sel || groupBlocker.value) return
  const list = listOf(sel.owner)
  const body = sel.indices.map((i) => list[i])
  const times = Math.min(Math.max(Math.floor(repeatCount.value) || 2, 2), MAX_REPEAT)
  const bodySize = body.reduce((sum, i) => sum + flatSize(i), 0)
  if (flatCount.value + multiplierOf(sel.owner) * bodySize * (times - 1) > MAX_BLOCKS) return

  list.splice(sel.indices[0], body.length, { repeat: times, items: body })
  clearSelection()
}

// Le nombre de fois que la liste de `owner` est jouée (1 pour la racine).
export function multiplierOf(owner: Group | null): number {
  const find = (list: Item[], acc: number): number | null => {
    for (const item of list) {
      if (!isGroup(item)) continue
      if (toRaw(item) === toRaw(owner)) return acc * item.repeat
      const found = find(item.items, acc * item.repeat)
      if (found !== null) return found
    }
    return null
  }
  return owner ? find(items.value, 1) ?? 1 : 1
}

// ---- Édition de la liste ----

export function addBlock(owner: Group | null, multiplier: number) {
  if (!canAdd(1, multiplier)) return
  const list = listOf(owner)
  const last = [...list].reverse().find((item) => !isGroup(item)) as Block | undefined
  list.push({ ...newBlock(), durationSeconds: last?.durationSeconds ?? newBlock().durationSeconds })
}

export function duplicate(owner: Group | null, index: number, multiplier: number) {
  const list = listOf(owner)
  if (!canDuplicate(list[index], multiplier)) return
  list.splice(index + 1, 0, structuredClone(toRaw(list[index])))
}

export function move(owner: Group | null, from: number, to: number) {
  const list = listOf(owner)
  if (to < 0 || to >= list.length || from === to) return
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
}

export function remove(owner: Group | null, index: number) {
  const list = listOf(owner)
  const [removed] = list.splice(index, 1)
  if (selected.value.has(toRaw(removed))) {
    const next = new Set(selected.value)
    next.delete(toRaw(removed))
    selected.value = next
  }
  // Un groupe vidé n'a plus de sens : il disparaît à son tour.
  if (owner && owner.items.length === 0) {
    const place = locate(owner)
    if (place) remove(place.owner, place.index)
  }
}

// Défait le groupe : ses éléments restent, joués une seule fois.
export function ungroup(owner: Group | null, index: number) {
  const list = listOf(owner)
  const group = list[index]
  if (!isGroup(group)) return
  list.splice(index, 1, ...group.items)
}

export function setRepeat(group: Group, value: number, multiplier: number) {
  group.repeat = Math.min(Math.max(Number.isFinite(value) ? Math.floor(value) : group.repeat, 2), maxRepeatFor(group, multiplier))
}

export { cycleSeconds }

// ---- Glisser-déposer natif : dans une même liste (racine, ou un groupe) ----

type DragState = { owner: Group | null; index: number }
const drag = ref<DragState | null>(null)
const dropTarget = ref<DragState | null>(null)

function sameOwner(a: Group | null, b: Group | null): boolean {
  return (a && toRaw(a)) === (b && toRaw(b))
}

export function onDragStart(owner: Group | null, index: number, event: DragEvent) {
  drag.value = { owner, index }
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

export function onDragOver(owner: Group | null, index: number, event: DragEvent) {
  if (!drag.value || !sameOwner(drag.value.owner, owner)) return
  event.preventDefault()
  event.stopPropagation()
  dropTarget.value = { owner, index }
}

export function onDrop(owner: Group | null, index: number) {
  if (drag.value && sameOwner(drag.value.owner, owner)) move(owner, drag.value.index, index)
  onDragEnd()
}

export function onDragEnd() {
  drag.value = null
  dropTarget.value = null
}

export function isDropTarget(owner: Group | null, index: number): boolean {
  const target = dropTarget.value
  return !!target && sameOwner(target.owner, owner) && target.index === index && drag.value?.index !== index
}

export function isDragging(owner: Group | null, index: number): boolean {
  return !!drag.value && sameOwner(drag.value.owner, owner) && drag.value.index === index
}
