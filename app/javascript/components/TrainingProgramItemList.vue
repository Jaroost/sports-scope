<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { isGroup } from '../stores/trainingProgramStore'
import type { Group, Item } from '../stores/trainingProgramStore'
import * as editing from '../stores/trainingProgramEditing'
import { formatHuman } from '../trainingProgramTime'
import TrainingProgramBlockCard from './TrainingProgramBlockCard.vue'

// Une liste d'éléments du programme : des blocs et des groupes de répétition. Récursive —
// le corps d'un groupe est lui-même une liste. `owner` est le groupe qui la contient
// (`null` à la racine), `leading` si elle commence au tout début du programme (son premier bloc n'a alors rien avant lui).
const props = defineProps<{
  items: Item[]
  owner: Group | null
  leading: boolean
}>()

// Le nombre de fois que cette liste est jouée : ajouter un bloc ici pèse autant dans le
// plafond du programme déplié.
const multiplier = computed(() => editing.multiplierOf(props.owner))

let nextKey = 0
const keys = new WeakMap<object, number>()
// Clé stable par élément : ils se déplacent, une clé d'index ferait garder aux champs
// la valeur de l'élément qui occupait la place avant.
function keyOf(item: object): number {
  let key = keys.get(item)
  if (key === undefined) { key = nextKey++; keys.set(item, key) }
  return key
}

function onRepeatChange(group: Group, event: Event) {
  const input = event.target as HTMLInputElement
  editing.setRepeat(group, Number(input.value), multiplier.value)
  input.value = String(group.repeat)
}
</script>

<template>
  <div class="tp-list">
    <div v-for="(item, index) in items" :key="keyOf(item)"
         class="tp-item mb-2"
         :class="{ 'tp-drop-target': editing.isDropTarget(owner, index), 'tp-dragging': editing.isDragging(owner, index) }"
         @dragover="editing.onDragOver(owner, index, $event)" @drop.prevent="editing.onDrop(owner, index)"
         @mouseenter="isGroup(item) && editing.setHovered(item)" @mouseleave="isGroup(item) && editing.setHovered(owner)">

      <TrainingProgramBlockCard
        v-if="!isGroup(item)"
        :block="item" :first="leading && index === 0"
        selectable :selected="editing.isSelected(item)"
        :can-move-up="index > 0" :can-move-down="index < items.length - 1"
        :can-duplicate="editing.canDuplicate(item, multiplier)"
        :start-sound-issue="editing.slotHasIssue(item, 'start')" :end-sound-issue="editing.slotHasIssue(item, 'end')"
        @toggle-select="editing.toggleSelected(item)"
        @move-up="editing.move(owner, index, index - 1)" @move-down="editing.move(owner, index, index + 1)"
        @duplicate="editing.duplicate(owner, index, multiplier)" @remove="editing.remove(owner, index)"
        @drag-start="editing.onDragStart(owner, index, $event)" @drag-end="editing.onDragEnd"
        @hover="editing.setHovered($event ? item : owner)" />

      <div v-else class="tp-group" :class="{ 'tp-group-selected': editing.isSelected(item) }">
        <div class="tp-group-header d-flex align-items-center gap-2 flex-wrap">
          <span class="tp-handle text-body-secondary" draggable="true"
                :title="t('training_programs.drag_hint')" :aria-label="t('training_programs.drag_hint')"
                @dragstart="editing.onDragStart(owner, index, $event)" @dragend="editing.onDragEnd">
            <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
          </span>
          <div class="form-check mb-0">
            <input type="checkbox" class="form-check-input" :checked="editing.isSelected(item)"
                   :aria-label="t('training_programs.select_group')"
                   @change="editing.toggleSelected(item)">
          </div>
          <i class="fa-solid fa-repeat text-warning" aria-hidden="true"></i>
          <label class="small mb-0" :for="`tp-group-repeat-${keyOf(item)}`">{{ t('training_programs.group_repeat_label') }}</label>
          <div class="input-group input-group-sm tp-repeat-input">
            <span class="input-group-text">×</span>
            <input :id="`tp-group-repeat-${keyOf(item)}`" type="number" class="form-control" min="2"
                   :max="editing.maxRepeatFor(item, multiplier)"
                   :value="item.repeat" @change="onRepeatChange(item, $event)">
          </div>
          <span class="small text-body-secondary">
            {{ t('training_programs.group_summary', { cycle: formatHuman(editing.cycleSeconds(item)), total: formatHuman(editing.cycleSeconds(item) * item.repeat) }) }}
          </span>
          <div class="d-flex gap-1 ms-auto">
            <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="index === 0"
                    :title="t('training_programs.move_up')" :aria-label="t('training_programs.move_up')"
                    @click="editing.move(owner, index, index - 1)">
              <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="index === items.length - 1"
                    :title="t('training_programs.move_down')" :aria-label="t('training_programs.move_down')"
                    @click="editing.move(owner, index, index + 1)">
              <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary"
                    :title="t('training_programs.ungroup')" :aria-label="t('training_programs.ungroup')"
                    @click="editing.ungroup(owner, index)">
              <i class="fa-solid fa-object-ungroup" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!editing.canDuplicate(item, multiplier)"
                    :title="t('training_programs.duplicate')" :aria-label="t('training_programs.duplicate')"
                    @click="editing.duplicate(owner, index, multiplier)">
              <i class="fa-regular fa-copy" aria-hidden="true"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger"
                    :title="t('training_programs.delete_group')" :aria-label="t('training_programs.delete_group')"
                    @click="editing.remove(owner, index)">
              <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <div class="tp-group-body">
          <TrainingProgramItemList :items="item.items" :owner="item"
                                   :leading="leading && index === 0" />
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!editing.canAdd(1, multiplier * item.repeat)"
                  @click="editing.addBlock(item, multiplier * item.repeat)">
            <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('training_programs.add_block_to_group') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tp-drop-target {
  outline: 2px dashed var(--bs-warning);
  outline-offset: 2px;
  border-radius: var(--bs-border-radius);
}
.tp-dragging {
  opacity: 0.5;
}
.tp-handle {
  cursor: grab;
  padding: 0 0.25rem;
}
.tp-group {
  border: 2px solid var(--bs-warning);
  border-radius: var(--bs-border-radius-lg);
  background: color-mix(in srgb, var(--bs-warning) 6%, transparent);
}
.tp-group-selected {
  box-shadow: 0 0 0 2px var(--bs-warning);
}
.tp-group-header {
  padding: 0.5rem 0.75rem;
}
.tp-group-body {
  padding: 0 0.75rem 0.75rem;
}
.tp-repeat-input {
  width: 6rem;
}
</style>
