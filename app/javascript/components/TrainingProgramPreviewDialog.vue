<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { trainingProgramStore, expandWithRounds, fillCounters, fillTargets, MILESTONE_ICONS } from '../stores/trainingProgramStore'
import type { Block, TargetRange } from '../stores/trainingProgramStore'
import { formatHuman, formatTime } from '../trainingProgramTime'

// Le programme déplié, ligne par ligne, tel que l'appli le déroulera : chaque tour d'un
// groupe est une ligne, avec le nom et la description **définitifs** (variables remplacées).
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const running = computed(() => trainingProgramStore.sport.value === 'running')

const rows = computed(() => {
  let start = 0
  return expandWithRounds(trainingProgramStore.items.value).map(({ block, rounds }, index) => {
    const row = {
      index: index + 1,
      start,
      block,
      name: fillCounters(fillTargets(block.segmentName.trim(), block), rounds),
      description: fillCounters(fillTargets(block.description.trim(), block), rounds),
      targets: targetsOf(block),
    }
    start += block.durationSeconds
    return row
  })
})

const totalSeconds = computed(() => rows.value.reduce((sum, r) => sum + r.block.durationSeconds, 0))

function iconClass(icon: string | null): string {
  return icon ? MILESTONE_ICONS.find((i) => i.key === icon)?.icon ?? '' : ''
}

// La vitesse se lit en km/h (vélo) ou en allure m:ss/km (course), comme son champ.
function speedText(value: number): string {
  if (running.value) return formatTime(Math.round(3600 / value))
  return String(Math.round(value * 10) / 10)
}

const CHANNELS = [
  { key: 'power', icon: 'fa-bolt', unit: 'W' },
  { key: 'heartRate', icon: 'fa-heart-pulse', unit: 'bpm' },
  { key: 'cadence', icon: 'fa-arrows-spin', unit: 'rpm' },
  { key: 'speedKmh', icon: 'fa-gauge-high', unit: '' },
] as const

// Par mesure ciblée : la cible en avant, les bornes entre parenthèses (ou seules).
function targetsOf(block: Block) {
  const out: { key: string; icon: string; text: string }[] = []
  for (const c of CHANNELS) {
    const range: TargetRange = block[c.key]
    const fmt = (v: number) => (c.key === 'speedKmh' ? speedText(v) : String(Math.round(v)))
    const unit = c.key === 'speedKmh' ? (running.value ? '/km' : 'km/h') : c.unit
    // Une allure plus rapide = une vitesse plus haute : on affiche min puis max dans l'ordre du champ.
    const bounds = range.min != null || range.max != null ? `${range.min != null ? fmt(range.min) : '…'}–${range.max != null ? fmt(range.max) : '…'}` : ''
    if (range.target == null && !bounds) continue
    const text = range.target != null ? `${fmt(range.target)} ${unit}${bounds ? ` (${bounds})` : ''}` : `${bounds} ${unit}`
    out.push({ key: c.key, icon: c.icon, text })
  }
  return out
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}
watch(() => props.show, (open) => {
  if (open) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
}, { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="tp-preview-backdrop" @click.self="emit('close')">
      <div class="tp-preview-dialog shadow-lg" role="dialog" aria-modal="true" :aria-label="t('training_programs.preview_title')">
        <div class="tp-preview-header">
          <strong><i class="fa-regular fa-eye me-2" aria-hidden="true"></i>{{ t('training_programs.preview_title') }}</strong>
          <button type="button" class="btn-close" :aria-label="t('training_programs.preview_close')" @click="emit('close')"></button>
        </div>
        <div class="tp-preview-body">
          <table class="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{{ t('training_programs.preview_col_block') }}</th>
                <th scope="col">{{ t('training_programs.preview_col_duration') }}</th>
                <th scope="col">{{ t('training_programs.preview_col_targets') }}</th>
                <th scope="col">{{ t('training_programs.preview_col_description') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.index">
                <td class="text-body-secondary small">{{ row.index }}</td>
                <td>
                  <div class="tp-preview-tile" :style="{ backgroundColor: row.block.color || '#6c757d', color: row.block.textColor || '#ffffff' }">
                    <i v-if="row.block.icon" class="fa-solid" :class="iconClass(row.block.icon)" aria-hidden="true"></i>
                    <span class="tp-preview-tile-text">{{ row.name }}</span>
                  </div>
                </td>
                <td class="text-nowrap" :title="`${formatTime(row.start)} → ${formatTime(row.start + row.block.durationSeconds)}`">{{ formatHuman(row.block.durationSeconds) }}</td>
                <td class="small">
                  <div v-for="target in row.targets" :key="target.key" class="text-nowrap">
                    <i :class="`fa-solid ${target.icon} fa-fw me-1 text-body-secondary`" aria-hidden="true"></i>{{ target.text }}
                  </div>
                </td>
                <td class="small tp-preview-description">{{ row.description }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th colspan="2">{{ t('training_programs.preview_total') }}</th>
                <th colspan="3">{{ formatHuman(totalSeconds) }}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.tp-preview-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}
.tp-preview-dialog {
  width: 100%;
  max-width: 62rem;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bs-body-bg, #fff);
  border-radius: 0.75rem;
  overflow: hidden;
}
.tp-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--bs-border-color, #e5e7eb);
}
.tp-preview-body {
  overflow: auto;
  padding: 0 1rem 1rem;
}
.tp-preview-body thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bs-body-bg, #fff);
}
.tp-preview-tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-width: 6rem;
  max-width: 12rem;
  height: 2.25rem;
  padding: 0 0.6rem;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 0.8rem;
  overflow: hidden;
}
.tp-preview-tile-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-preview-description {
  min-width: 12rem;
  white-space: pre-wrap;
}
.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
