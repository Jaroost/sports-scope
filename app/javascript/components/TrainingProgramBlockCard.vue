<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { t } from '../i18n'
import { trainingProgramStore, MAX_DESCRIPTION_LEN, SOUND_SECONDS, SOUNDS, MILESTONE_ICONS, CUE_TIMINGS, TARGET_CEILINGS, fillCounters, fillTargets } from '../stores/trainingProgramStore'
import type { Block, Sound, TargetBound, TargetRange, TargetVariable } from '../stores/trainingProgramStore'
import { formatTime, parseTime } from '../trainingProgramTime'
import * as editing from '../stores/trainingProgramEditing'
import CompanionColorPicker from './CompanionColorPicker.vue'

// Un bloc du programme : durée, nom, icône, couleurs, sons de début/fin et cibles.
// Édite directement l'objet `block` reçu (même patron que les autres éditeurs) ; tout
// ce qui touche à la place du bloc dans la liste (déplacer, dupliquer, supprimer,
// sélectionner) remonte en événements.
const props = defineProps<{
  block: Block
  // Instant de départ (s) de la première occurrence du bloc — informatif.
  // Le tout premier bloc du programme : rien avant lui, donc pas de moment pour son son de début.
  first: boolean
  selectable?: boolean
  // Nombre de tours de chaque groupe englobant : l'aperçu montre le tour 1 de chacun.
  rounds?: number[]
  selected?: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  canDuplicate: boolean
  startSoundIssue?: boolean
  endSoundIssue?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-select'): void
  (e: 'move-up'): void
  (e: 'move-down'): void
  (e: 'duplicate'): void
  (e: 'remove'): void
  (e: 'drag-start', event: DragEvent): void
  (e: 'drag-end'): void
  (e: 'hover', on: boolean): void
}>()

// Une durée nulle donnerait deux sons au même instant et un bloc invisible : 1 s minimum.
function onDurationChange(event: Event) {
  const input = event.target as HTMLInputElement
  const parsed = parseTime(input.value)
  if (parsed != null) props.block.durationSeconds = Math.max(1, parsed)
  input.value = formatTime(props.block.durationSeconds)
}

// Canaux à structure identique (min/cible/max en valeur absolue) — la vitesse est
// traitée à part car son unité change selon `trainingProgramStore.sport`.
// Une icône par mesure ciblée, devant son libellé.
const CHANNEL_ICONS: Record<string, string> = {
  power: 'fa-bolt', heartRate: 'fa-heart-pulse', cadence: 'fa-arrows-spin', speed: 'fa-gauge-high',
}

const TARGET_CHANNELS = ['power', 'heartRate', 'cadence'] as const

// i18n en snake_case (`target_heart_rate`), clés du store en camelCase (`heartRate`).
const CHANNEL_I18N_KEYS: Record<typeof TARGET_CHANNELS[number], string> = {
  power: 'target_power',
  heartRate: 'target_heart_rate',
  cadence: 'target_cadence',
}

function channelLabel(key: typeof TARGET_CHANNELS[number]): string {
  return t(`training_programs.${CHANNEL_I18N_KEYS[key]}`)
}

// Les cibles posées, pour le badge du menu : « 180 W », « 130 bpm »… (la cible seule, pas
// les bornes). La vitesse suit l'unité du sport, comme son champ.
// Cliquer ou glisser un badge écrit la variable de cette cible (`{power}`…) dans le nom ou
// la description : le serveur la remplace par la valeur au dépliage.
function targetTags(m: Block): { label: string; variable: TargetVariable }[] {
  const tags: { label: string; variable: TargetVariable }[] = []
  if (m.power.target != null) tags.push({ label: `${Math.round(m.power.target)} W`, variable: 'power' })
  if (m.heartRate.target != null) tags.push({ label: `${Math.round(m.heartRate.target)} bpm`, variable: 'hr' })
  if (m.cadence.target != null) tags.push({ label: `${Math.round(m.cadence.target)} rpm`, variable: 'cadence' })
  if (m.speedKmh.target != null) {
    const running = trainingProgramStore.sport.value === 'running'
    tags.push({ label: `${speedFieldDisplay(m.speedKmh, 'target')} ${running ? '/km' : 'km/h'}`, variable: running ? 'pace' : 'speed' })
  }
  return tags
}

function boundToken(variable: TargetVariable, bound: TargetBound): string {
  return `{${variable}${bound === 'target' ? '' : `-${bound}`}}`
}

const TARGET_BOUNDS: TargetBound[] = ['min', 'target', 'max']
const BOUND_ICONS: Record<TargetBound, string> = { min: 'fa-angles-down', target: 'fa-bullseye', max: 'fa-angles-up' }

// Une ligne par mesure ciblée (la vitesse en dernier, son unité suit le sport) : son canal,
// son libellé, son icône et la variable qu'elle écrit.
const targetRows = computed(() => {
  const running = trainingProgramStore.sport.value === 'running'
  return [
    ...TARGET_CHANNELS.map((channel) => ({
      channel: channel as typeof TARGET_CHANNELS[number] | 'speedKmh', label: channelLabel(channel), icon: CHANNEL_ICONS[channel],
      variable: ({ power: 'power', heartRate: 'hr', cadence: 'cadence' } as const)[channel] as TargetVariable,
    })),
    { channel: 'speedKmh' as const, label: speedUnitLabel(), icon: CHANNEL_ICONS.speed, variable: (running ? 'pace' : 'speed') as TargetVariable },
  ]
})

function onTargetTagDragStart(variable: TargetVariable, event: DragEvent, bound: TargetBound = 'target') {
  event.dataTransfer?.setData('text/plain', boundToken(variable, bound))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

function onNumberFieldChange(range: TargetRange, field: 'target' | 'min' | 'max', ceiling: number, event: Event) {
  const text = (event.target as HTMLInputElement).value.trim()
  if (!text) { range[field] = null; return }
  const value = Number(text)
  if (Number.isFinite(value)) range[field] = Math.min(Math.max(value, 0), ceiling)
}

// Vitesse : km/h pour un programme vélo, allure (mm:ss/km) pour un programme course —
// stockage toujours en km/h. Attention : le champ "min" reste la borne basse de
// *vitesse*, donc l'allure la plus lente (le plus grand mm:ss) une fois convertie —
// on ne renomme pas les bornes en passant en allure, on ne fait que les afficher autrement.
function speedUnitLabel(): string {
  return trainingProgramStore.sport.value === 'running' ? t('training_programs.target_pace') : t('training_programs.target_speed')
}

function speedFieldDisplay(range: TargetRange, field: 'target' | 'min' | 'max'): string {
  const value = range[field]
  if (value == null) return ''
  if (trainingProgramStore.sport.value === 'running') return formatTime(Math.round(3600 / value))
  return String(Math.round(value * 10) / 10)
}

function onSpeedFieldChange(range: TargetRange, field: 'target' | 'min' | 'max', event: Event) {
  const text = (event.target as HTMLInputElement).value.trim()
  if (!text) { range[field] = null; return }
  if (trainingProgramStore.sport.value === 'running') {
    const paceSeconds = parseTime(text)
    if (paceSeconds && paceSeconds > 0) range[field] = Math.min(3600 / paceSeconds, TARGET_CEILINGS.speedKmh)
  } else {
    const value = Number(text)
    if (Number.isFinite(value)) range[field] = Math.min(Math.max(value, 0), TARGET_CEILINGS.speedKmh)
  }
}

// Le nom tel que le téléphone l'écrira au premier tour.
// Le champ texte (nom ou description) où écrit un clic sur une variable de répétition,
// proposée dans l'en-tête de chaque groupe (TrainingProgramItemList).
function onFieldFocus(event: FocusEvent) {
  editing.rememberTextField(event.target as HTMLInputElement | HTMLTextAreaElement)
}

const uid = Math.random().toString(36).slice(2, 8)

const roundOnes = () => (props.rounds ?? []).map((max): [number, number] => [1, max])
// La description telle que l'appli la dira au premier tour : lue par l'aperçu vocal, et
// base de l'estimation de durée.
const previewDescription = computed(() => fillCounters(fillTargets(props.block.description.trim(), props.block), roundOnes()))
const previewName = computed(() => fillCounters(fillTargets(props.block.segmentName.trim(), props.block), roundOnes()))

function iconClass(icon: string): string {
  return MILESTONE_ICONS.find((i) => i.key === icon)?.icon ?? ''
}

function soundLabel(sound: Sound): string {
  return t(`training_programs.sound_${sound}`)
}

// Un seul lecteur pour tous les blocs : écouter un son coupe le précédent.
let previewAudio: HTMLAudioElement | null = null

function playSound(sound: Sound | null) {
  if (!sound) return
  previewAudio ??= new Audio()
  previewAudio.src = `/sounds/${sound}.wav`
  previewAudio.currentTime = 0
  previewAudio.play().catch(() => { /* lecture bloquée (autoplay) — pas grave, c'est un aperçu */ })
}

// Durée de lecture estimée (~15 caractères/s en français) contre la place réellement
// laissée à la voix : l'appli la fait parler après le son de début s'il joue sur le
// bloc (`at`, ou premier bloc), et la coupe quand le son de fin « avant » démarre (en
// avance sur la frontière), à la frontière sinon. Ne regarde que ce bloc : un son de
// début du bloc suivant réglé « avant », ou un son de fin `at` du bloc précédent,
// rognent encore la place sans qu'on le voie d'ici.
const SPEECH_CHARS_PER_SECOND = 15

const speechSeconds = computed(() => Math.ceil(previewDescription.value.length / SPEECH_CHARS_PER_SECOND))

const speechRoom = computed(() => {
  const b = props.block
  const startCost = b.startSound && (props.first || b.startCueTiming === 'at') ? SOUND_SECONDS[b.startSound] : 0
  const endCost = b.endSound && b.endCueTiming === 'before' ? SOUND_SECONDS[b.endSound] : 0
  return Math.max(0, b.durationSeconds - startCost - endCost)
})

const speechTooLong = computed(() => speechSeconds.value > speechRoom.value)

// Lecture de la description par la synthèse vocale du navigateur — un aperçu de ce que
// l'appli dira au début du bloc (voix du téléphone, donc pas tout à fait la même).
// Relancer sur un autre bloc coupe le précédent ; recliquer sur celui qui parle l'arrête.
const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
const speaking = ref(false)

function speakDescription() {
  if (!speechSupported) return
  const synth = window.speechSynthesis
  if (speaking.value) {
    synth.cancel()
    return
  }
  const text = previewDescription.value
  if (!text) return
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = document.querySelector<HTMLMetaElement>('meta[name="i18n-locale"]')?.content === 'fr' ? 'fr-FR' : 'en-US'
  const end = () => { speaking.value = false }
  utterance.onend = end
  utterance.onerror = end
  speaking.value = true
  synth.speak(utterance)
}

onBeforeUnmount(() => {
  if (speaking.value) window.speechSynthesis.cancel()
})
</script>

<template>
  <div class="tp-block card" :class="{ 'tp-block-selected': selected }"
       @mouseenter="emit('hover', true)" @mouseleave="emit('hover', false)"
       :style="block.color ? { '--tp-dot-color': block.color } : {}">
    <div class="card-body d-flex align-items-start gap-2 flex-wrap">
      <!-- Aperçu de la case telle que le téléphone la peint : fond, icône, texte. -->
      <div class="tp-phone-preview tp-phone-preview-mobile d-md-none" :title="t('training_programs.phone_preview')"
           :style="{ backgroundColor: block.color || '#6c757d', color: block.textColor || '#ffffff' }">
        <i v-if="block.icon" class="fa-solid" :class="iconClass(block.icon)" aria-hidden="true"></i>
        <span class="tp-phone-preview-text">{{ previewName }}</span>
      </div>

      <div class="d-flex align-items-center gap-2 w-100">
        <span class="tp-handle text-body-secondary" draggable="true"
              :title="t('training_programs.drag_hint')" :aria-label="t('training_programs.drag_hint')"
              @dragstart="emit('drag-start', $event)" @dragend="emit('drag-end')">
          <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
        </span>
        <div v-if="selectable" class="form-check">
          <input type="checkbox" class="form-check-input" :checked="selected"
                 :aria-label="t('training_programs.select_block')"
                 @change="emit('toggle-select')">
        </div>
        <!-- Aperçu de la case telle que le téléphone la peint (bureau : à côté de la sélection). -->
        <div class="tp-phone-preview d-none d-md-inline-flex" :title="t('training_programs.phone_preview')"
             :style="{ backgroundColor: block.color || '#6c757d', color: block.textColor || '#ffffff' }">
          <i v-if="block.icon" class="fa-solid" :class="iconClass(block.icon)" aria-hidden="true"></i>
          <span class="tp-phone-preview-text">{{ previewName }}</span>
        </div>
        <div class="d-flex gap-1 ms-auto">
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!canMoveUp"
                  :title="t('training_programs.move_up')" :aria-label="t('training_programs.move_up')"
                  @click="emit('move-up')">
            <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!canMoveDown"
                  :title="t('training_programs.move_down')" :aria-label="t('training_programs.move_down')"
                  @click="emit('move-down')">
            <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!canDuplicate"
                  :title="t('training_programs.duplicate')" :aria-label="t('training_programs.duplicate')"
                  @click="emit('duplicate')">
            <i class="fa-regular fa-copy" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger"
                  :title="t('training_programs.delete')" :aria-label="t('training_programs.delete')"
                  @click="emit('remove')">
            <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <div class="d-flex align-items-center gap-2 flex-wrap w-100">
        <span class="d-inline-flex align-items-center gap-1">
          <!-- L'horloge écrit {duration} (durée en clair) dans le nom ou la description. -->
          <button type="button" class="btn btn-sm btn-link p-0 text-body-secondary" draggable="true"
                  :title="t('training_programs.duration_token_hint')"
                  @mousedown.prevent @click="editing.insertIntoLastField('{duration}')"
                  @dragstart="onTargetTagDragStart('duration', $event)">
            <i class="fa-regular fa-clock" aria-hidden="true"></i>
          </button>
          <input type="text" class="form-control form-control-sm tp-time-input"
                 :title="t('training_programs.block_duration_hint')" :aria-label="t('training_programs.block_duration_hint')"
                 :value="formatTime(block.durationSeconds)" @change="onDurationChange">
        </span>
        <div class="flex-grow-1" style="min-width: 10rem">
          <input v-model="block.segmentName" type="text" class="form-control form-control-sm"
               @focus="onFieldFocus" @drop.stop
                 :placeholder="t('training_programs.segment_name_placeholder')" maxlength="60">
        </div>
        <div class="d-flex align-items-center gap-1">
          <i v-if="block.icon" class="fa-solid tp-icon-preview" :class="iconClass(block.icon)" aria-hidden="true"></i>
          <select v-model="block.icon" class="form-select form-select-sm" style="width: auto">
            <option :value="null">{{ t('training_programs.icon_none') }}</option>
            <option v-for="icon in MILESTONE_ICONS" :key="icon.key" :value="icon.key">{{ t(`training_programs.icon_${icon.key}`) }}</option>
          </select>
        </div>
        <div class="d-flex align-items-center gap-1">
          <CompanionColorPicker v-model="block.color" fallback="#6c757d" :label="t('training_programs.segment_color')" />
          <CompanionColorPicker v-model="block.textColor" fallback="#ffffff" :label="t('training_programs.segment_text_color')" />
        </div>

        <div class="form-check form-switch mb-0" :title="t('training_programs.optional_hint')">
          <input :id="`tp-optional-${uid}`" v-model="block.optional" type="checkbox" class="form-check-input" role="switch">
          <label :for="`tp-optional-${uid}`" class="form-check-label small">
            <i class="fa-solid fa-forward me-1" aria-hidden="true"></i>{{ t('training_programs.optional_label') }}
          </label>
        </div>
      </div>

      <div class="d-flex align-items-start gap-2 w-100">
        <i class="fa-solid fa-comment-dots text-body-secondary tp-line-icon" :title="t('training_programs.description_label') + ' — ' + t('training_programs.repeat_vars_hint')" aria-hidden="true"></i>
        <textarea v-model="block.description" class="form-control form-control-sm" rows="1"
                  @focus="onFieldFocus" @drop.stop
                  :title="t('training_programs.repeat_vars_hint')"
                  :maxlength="MAX_DESCRIPTION_LEN" :placeholder="t('training_programs.description_placeholder')"
                  :aria-label="t('training_programs.description_label')"></textarea>
        <button v-if="speechSupported" type="button" class="btn btn-sm btn-link p-1"
                :disabled="!speaking && !block.description.trim()"
                :title="speaking ? t('training_programs.description_stop') : t('training_programs.description_play')"
                :aria-label="speaking ? t('training_programs.description_stop') : t('training_programs.description_play')"
                @click="speakDescription">
          <i class="fa-solid" :class="speaking ? 'fa-stop' : 'fa-volume-high'" aria-hidden="true"></i>
        </button>
      </div>

      <div v-if="speechTooLong" class="small text-warning-emphasis w-100">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        {{ t('training_programs.description_too_long', { speech: formatTime(speechSeconds), room: formatTime(speechRoom) }) }}
      </div>

    </div>

    <details class="tp-targets px-3 pb-2" :open="!!(startSoundIssue || endSoundIssue)">
      <summary class="small text-body-secondary">
        <i class="fa-solid fa-volume-high fa-fw me-1" aria-hidden="true"></i>{{ t('training_programs.sounds_summary') }}
        <span v-if="block.startSound || block.endSound" class="badge text-bg-warning ms-1">
          <template v-if="block.startSound"><i class="fa-solid fa-flag me-1" aria-hidden="true"></i>{{ soundLabel(block.startSound) }}</template>
          <template v-if="block.startSound && block.endSound"> – </template>
          <template v-if="block.endSound"><i class="fa-solid fa-flag-checkered me-1" aria-hidden="true"></i>{{ soundLabel(block.endSound) }}</template>
        </span>
      </summary>
      <div class="d-flex flex-column gap-2 mt-2">
        <div class="d-flex align-items-center gap-1 flex-wrap tp-sound-slot" :class="{ 'tp-sound-error': startSoundIssue }">
          <i class="fa-solid fa-flag text-body-secondary fa-fw" aria-hidden="true"></i>
          <span class="small text-body-secondary tp-sound-label">{{ t('training_programs.sound_start_label') }}</span>
          <select v-model="block.startSound" class="form-select form-select-sm" style="width: auto">
            <option :value="null">{{ t('training_programs.sound_none') }}</option>
            <option v-for="sound in SOUNDS" :key="sound" :value="sound">{{ soundLabel(sound) }}</option>
          </select>
          <button type="button" class="btn btn-sm btn-link p-1" :disabled="!block.startSound"
                  :title="t('training_programs.play_preview')" :aria-label="t('training_programs.play_preview')"
                  @click="playSound(block.startSound)">
            <i class="fa-solid fa-play" aria-hidden="true"></i>
          </button>
          <select v-if="!first && block.startSound" v-model="block.startCueTiming" class="form-select form-select-sm" style="width: auto">
            <option v-for="timing in CUE_TIMINGS" :key="timing" :value="timing">{{ t(`training_programs.start_cue_timing_${timing}`) }}</option>
          </select>
        </div>
        <div class="d-flex align-items-center gap-1 flex-wrap tp-sound-slot" :class="{ 'tp-sound-error': endSoundIssue }">
          <i class="fa-solid fa-flag-checkered text-body-secondary fa-fw" aria-hidden="true"></i>
          <span class="small text-body-secondary tp-sound-label">{{ t('training_programs.sound_end_label') }}</span>
          <select v-model="block.endSound" class="form-select form-select-sm" style="width: auto">
            <option :value="null">{{ t('training_programs.sound_none') }}</option>
            <option v-for="sound in SOUNDS" :key="sound" :value="sound">{{ soundLabel(sound) }}</option>
          </select>
          <button type="button" class="btn btn-sm btn-link p-1" :disabled="!block.endSound"
                  :title="t('training_programs.play_preview')" :aria-label="t('training_programs.play_preview')"
                  @click="playSound(block.endSound)">
            <i class="fa-solid fa-play" aria-hidden="true"></i>
          </button>
          <select v-if="block.endSound" v-model="block.endCueTiming" class="form-select form-select-sm" style="width: auto">
            <option v-for="timing in CUE_TIMINGS" :key="timing" :value="timing">{{ t(`training_programs.end_cue_timing_${timing}`) }}</option>
          </select>
        </div>
      </div>
    </details>

    <details class="tp-targets px-3 pb-3">
      <summary class="small text-body-secondary">
        <i class="fa-solid fa-bullseye fa-fw me-1" aria-hidden="true"></i>{{ t('training_programs.targets_summary') }}
        <button v-for="tag in targetTags(block)" :key="tag.variable" type="button" class="badge text-bg-warning border-0 ms-1 tp-target-tag"
                draggable="true" :title="t('training_programs.target_tag_hint', { token: `{${tag.variable}}` })"
                @mousedown.prevent @click.prevent.stop="editing.insertIntoLastField(`{${tag.variable}}`)"
                @dragstart="onTargetTagDragStart(tag.variable, $event)">{{ tag.label }}</button>
      </summary>
      <div class="tp-targets-grid mt-2">
        <div v-for="row in targetRows" :key="row.channel" class="tp-target-row">
          <span class="small text-body-secondary tp-target-label" :title="row.label">
            <i :class="`fa-solid ${row.icon} fa-fw me-1`" aria-hidden="true"></i>{{ row.label }}
          </span>
          <div v-for="bound in TARGET_BOUNDS" :key="bound" class="input-group input-group-sm flex-nowrap">
            <!-- L'icône écrit la variable de cette valeur dans le nom ou la description (clic ou glisser). -->
            <button type="button" class="input-group-text tp-bound-icon" draggable="true"
                    :title="`${t(`training_programs.target_${bound}`)} — ${t('training_programs.target_tag_hint', { token: boundToken(row.variable, bound) })}`"
                    @mousedown.prevent @click="editing.insertIntoLastField(boundToken(row.variable, bound))"
                    @dragstart="onTargetTagDragStart(row.variable, $event, bound)">
              <i :class="`fa-solid ${BOUND_ICONS[bound]}`" aria-hidden="true"></i>
            </button>
            <input v-if="row.channel !== 'speedKmh'" type="number" class="form-control" :aria-label="t(`training_programs.target_${bound}`)"
                   :value="block[row.channel][bound] ?? ''" @change="onNumberFieldChange(block[row.channel], bound, TARGET_CEILINGS[row.channel], $event)">
            <input v-else type="text" class="form-control" :aria-label="t(`training_programs.target_${bound}`)"
                   :value="speedFieldDisplay(block.speedKmh, bound)" @change="onSpeedFieldChange(block.speedKmh, bound, $event)">
          </div>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.tp-block {
  border-left: 4px solid var(--tp-dot-color, var(--bs-warning));
}
.tp-block-selected {
  border-color: var(--bs-warning);
  box-shadow: 0 0 0 1px var(--bs-warning);
}
.tp-handle {
  cursor: grab;
  padding: 0 0.25rem;
}
.tp-time-input {
  width: 5rem;
}
.tp-phone-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-width: 7rem;
  max-width: 11rem;
  height: 2.5rem;
  padding: 0 0.6rem;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 0.85rem;
  overflow: hidden;
}
.tp-phone-preview-mobile {
  /* Première ligne de la carte, sur toute la largeur. */
  display: flex;
  width: 100%;
  max-width: none;
}
.tp-phone-preview-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-icon-preview {
  width: 1.5rem;
  text-align: center;
  color: var(--bs-warning);
}
.tp-line-icon {
  flex-shrink: 0;
  width: 1.25rem;
  text-align: center;
  line-height: calc(1.5em + 0.5rem); /* centrée sur la première ligne du champ */
}
.tp-sound-label {
  min-width: 5.5rem; /* aligne les deux listes de sons l'une sous l'autre */
}
.tp-sound-slot {
  padding: 0.15rem 0.4rem;
  border: 1px solid transparent;
  border-radius: var(--bs-border-radius);
}
.tp-sound-error {
  border-color: var(--bs-danger);
}
.tp-targets summary {
  cursor: pointer;
}
.tp-targets-grid {
  display: grid;
  gap: 0.4rem;
  max-width: 38rem;
}
.tp-target-row {
  display: grid;
  grid-template-columns: 9.5rem repeat(3, minmax(0, 1fr));
  gap: 0.4rem;
  align-items: center;
}
.tp-target-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tp-bound-icon {
  cursor: pointer;
  padding: 0 0.4rem;
}
@media (max-width: 575.98px) {
  /* Téléphone : le libellé a sa propre ligne, les trois champs dessous. */
  .tp-target-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .tp-target-label {
    grid-column: 1 / -1;
  }
}
.tp-target-tag {
  cursor: pointer;
}
</style>
