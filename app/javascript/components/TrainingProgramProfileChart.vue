<script setup lang="ts">
import { ref, computed } from 'vue'
import { t } from '../i18n'

// Le profil d'un programme : le temps en abscisse, la mesure ciblée en ordonnée. Chaque
// bloc trace sa cible en trait. Une mesure à la fois ; des boutons permettent de passer
// de l'une à l'autre quand il y en a plusieurs.

type Bounds = [number | null, number | null, number | null] // [cible, min, max]
interface Step {
  duration_seconds: number
  // Couleur du bloc, `#rrggbb` (celle du « fond » réglé dans l'éditeur), ou absente.
  color?: string | null
  [channel: string]: number | string | Bounds | null | undefined
}
interface Profile {
  channels: string[]
  steps: Step[]
}

const props = defineProps<{ profile: Profile; sport: string; wide?: boolean }>()

const W = 200
const H = 48
const PAD = 3

const chosen = ref(props.profile.channels[0])
// En édition les mesures ciblées changent : si celle choisie n'existe plus, on prend la première.
const channel = computed(() => (props.profile.channels.includes(chosen.value) ? chosen.value : props.profile.channels[0]))

const CHANNEL_UNITS: Record<string, string> = { power: 'W', heart_rate: 'bpm', cadence: 'rpm', speed_kmh: 'km/h' }

function channelLabel(c: string): string {
  if (c === 'speed_kmh') return props.sport === 'running' ? t('training_programs.target_pace') : t('training_programs.target_speed')
  return t(`training_programs.target_${c}`)
}

const total = computed(() => props.profile.steps.reduce((sum, s) => sum + s.duration_seconds, 0) || 1)

// [début, fin, cible, min, max] de chaque bloc, pour la mesure affichée.
const spans = computed(() => {
  let acc = 0
  return props.profile.steps.map((step) => {
    const start = acc
    acc += step.duration_seconds
    const [target, min, max] = (step[channel.value] as Bounds | undefined) ?? [null, null, null]
    return { start, end: acc, target, min, max, color: step.color ?? null }
  })
})

// Échelle verticale : de la plus basse à la plus haute valeur rencontrée, avec un peu d'air.
const range = computed(() => {
  const values = spans.value.flatMap((s) => [s.target, s.min, s.max]).filter((v): v is number => v != null)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi === lo) { lo -= 1; hi += 1 }
  const margin = (hi - lo) * 0.1
  return { lo: lo - margin, hi: hi + margin }
})

const x = (seconds: number) => (seconds / total.value) * W
const y = (value: number) => H - PAD - ((value - range.value.lo) / (range.value.hi - range.value.lo)) * (H - 2 * PAD)

// La cible en escalier : un palier par bloc, tracé de la couleur du bloc, relié par un
// trait vertical au palier précédent quand celui-ci a une cible aussi.
const segments = computed(() => {
  const out: { d: string; area: string; color: string | null }[] = []
  let previousY: number | null = null
  for (const s of spans.value) {
    if (s.target == null) { previousY = null; continue }
    const level = y(s.target)
    const d = previousY == null
      ? `M ${x(s.start)} ${level} H ${x(s.end)}`
      : `M ${x(s.start)} ${previousY} V ${level} H ${x(s.end)}`
    const area = `M ${x(s.start)} ${H} V ${level} H ${x(s.end)} V ${H} Z`
    out.push({ d, area, color: s.color })
    previousY = level
  }
  return out
})

const title = computed(() => {
  const values = spans.value.flatMap((s) => [s.target, s.min, s.max]).filter((v): v is number => v != null)
  const unit = CHANNEL_UNITS[channel.value]
  return `${channelLabel(channel.value)} · ${Math.round(Math.min(...values) * 10) / 10}–${Math.round(Math.max(...values) * 10) / 10} ${unit}`
})
</script>

<template>
  <div class="tp-profile" :class="{ 'tp-profile-wide': wide }">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="tp-profile-svg" role="img" :aria-label="title">
      <title>{{ title }}</title>
      <path v-for="(seg, i) in segments" :key="`a${i}`" :d="seg.area" class="tp-profile-area"
            :style="seg.color ? { fill: seg.color } : {}" />
      <path v-for="(seg, i) in segments" :key="i" :d="seg.d" class="tp-profile-line" fill="none"
            :style="seg.color ? { stroke: seg.color } : {}" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="d-flex justify-content-between align-items-center tp-profile-foot">
      <span class="text-body-secondary">{{ channelLabel(channel) }}</span>
      <span v-if="profile.channels.length > 1" class="d-flex gap-1">
        <button v-for="c in profile.channels" :key="c" type="button" class="tp-profile-chip"
                :class="{ active: c === channel }" :title="channelLabel(c)" @click="chosen = c">
          {{ CHANNEL_UNITS[c] }}
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.tp-profile {
  width: 12rem;
}
.tp-profile-wide {
  width: 100%;
}
.tp-profile-wide .tp-profile-svg {
  height: 7rem;
}
.tp-profile-svg {
  display: block;
  width: 100%;
  height: 3.5rem;
  border-bottom: 1px solid var(--bs-border-color);
}
.tp-profile-area {
  fill: var(--bs-warning);
  fill-opacity: 0.3;
}
.tp-profile-line {
  stroke: var(--bs-warning);
  stroke-width: 2;
  stroke-linejoin: round;
}
.tp-profile-foot {
  font-size: 0.7rem;
  line-height: 1.4;
}
.tp-profile-chip {
  border: 1px solid var(--bs-border-color);
  background: transparent;
  color: var(--bs-secondary-color);
  border-radius: 0.5rem;
  padding: 0 0.35rem;
  font-size: 0.65rem;
}
.tp-profile-chip.active {
  border-color: var(--bs-warning);
  color: var(--bs-body-color);
}
</style>
