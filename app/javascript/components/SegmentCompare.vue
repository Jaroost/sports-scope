<script setup lang="ts">
// Comparaison d'un tronçon CHOISI à la main : on prend la sélection partagée du détail
// d'activité (poignées A/B de la carte, clic sur un col, un split, un intervalle) et on
// la fait chronométrer comme un segment découvert — même classement, même podium, même
// historique (`SegmentMatcher.compare` côté serveur).
//
// La comparaison n'est PAS automatique : chaque plage coûte une passe d'appariement sur
// tout l'historique proche (~200 ms). C'est un bouton, donc une intention.
//
// Une fois le tronçon comparé, le baptiser en fait un vrai segment : le serveur sème
// désormais les chemins nommés sur toutes les sorties qui les traversent, il ressortira
// donc tout seul les prochaines fois.
import { ref, computed, watch } from 'vue'
import type { PropType } from 'vue'
import { t } from '../i18n'
import { formatChrono, formatPace, paceMinPerKm } from '../activityHelpers'
import SegmentEfforts from './SegmentEfforts.vue'
import type { Segment, SegmentEffort } from '../segmentTypes'
import { csrfToken } from '../csrf'

interface Selection { startIdx: number, endIdx: number }

const props = defineProps({
  activityId: { type: [String, Number], required: true },
  source: { type: String, default: 'strava' }, // 'strava' | 'imported'
  isRun: { type: Boolean, default: false },
  selection: { type: Object as PropType<Selection | null>, default: null },
  activityDate: { type: String, default: '' },
})

const loading = ref(false)
const error = ref<string | null>(null)
const segment = ref<Segment | null>(null)
// Plage effectivement comparée, pour savoir si le résultat affiché correspond encore à
// la sélection courante (elle bouge dès qu'on redrague une poignée).
const comparedRange = ref<string | null>(null)

const rangeKey = computed(() => (props.selection
  ? `${props.selection.startIdx}-${props.selection.endIdx}`
  : null))
const stale = computed(() => comparedRange.value !== null && comparedRange.value !== rangeKey.value)

const compareUrl = computed(() => (props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}/segments/range`
  : `/strava/activities/${props.activityId}/segments/range`))

// La sélection change → le résultat précédent ne parle plus du tronçon affiché.
watch(rangeKey, () => {
  if (!rangeKey.value) reset()
})

function reset() {
  segment.value = null
  comparedRange.value = null
  error.value = null
}

async function compare() {
  const sel = props.selection
  if (!sel || loading.value) return

  loading.value = true
  error.value = null
  const key = rangeKey.value
  try {
    const url = `${compareUrl.value}?start_idx=${sel.startIdx}&end_idx=${sel.endIdx}`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    segment.value = (json.segment ?? null) as Segment | null
    comparedRange.value = key
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

// ── Baptême du tronçon ───────────────────────────────────────────────────────
// Les bornes envoyées sont celles que le SERVEUR a retenues (accrochées à la grille de
// ~60 m), pas celles de la sélection brute : c'est ce chemin-là qui a été chronométré.
const naming = ref(false)
const draftName = ref('')
const savingName = ref(false)

function startNaming() {
  naming.value = true
  draftName.value = segment.value?.name || segment.value?.place_name || ''
}

async function saveName() {
  const name = draftName.value.trim()
  const seg = segment.value
  if (!seg || !name) {
    naming.value = false
    return
  }

  savingName.value = true
  try {
    const res = await fetch('/api/named_segments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify({
        name,
        source: props.source,
        activity_id: props.activityId,
        start_idx: seg.start_idx,
        end_idx: seg.end_idx,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    seg.named_segment_id = json.named_segment.id
    seg.name = json.named_segment.name
    naming.value = false
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    savingName.value = false
  }
}

// ── Formatage ────────────────────────────────────────────────────────────────
const chrono = formatChrono

function km(metres: number): string {
  return `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`
}

function speed(seconds: number): string {
  const seg = segment.value
  if (!seg || !seconds) return '–'
  const mps = seg.distance_m / seconds
  if (props.isRun) return `${formatPace(paceMinPerKm(mps))} /km`
  return `${(mps * 3.6).toFixed(1)} km/h`
}

const PODIUM = ['rank_first', 'rank_second', 'rank_third'] as const
const PODIUM_CLASS = ['badge-gold', 'badge-silver', 'badge-bronze'] as const

function podiumLabel(place: number): string {
  return t(`strava.segments.${PODIUM[place - 1] ?? 'rank_first'}`)
}

function podiumClass(place: number): string {
  return PODIUM_CLASS[place - 1] ?? 'badge-gold'
}

function bestDate(effort: SegmentEffort): string {
  if (!effort.started_at) return '–'
  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
  return new Date(effort.started_at).toLocaleDateString(lang || undefined, {
    day: '2-digit', month: '2-digit', year: '2-digit',
  })
}
</script>

<template>
  <div class="card shadow-sm border-0 mb-3">
    <div class="card-body">
      <h3 class="h6 d-flex align-items-center gap-2 mb-1">
        <i class="fa-solid fa-arrows-left-right-to-line text-warning" aria-hidden="true"></i>
        <span>{{ t('strava.segments.compare_title') }}</span>
      </h3>

      <!-- Rien de sélectionné : on dit où se fait la sélection. -->
      <p v-if="!selection" class="text-muted small mb-0">
        {{ t('strava.segments.compare_hint') }}
      </p>

      <template v-else>
        <p class="text-muted small mb-2">{{ t('strava.segments.compare_intro') }}</p>

        <button
          v-if="!segment || stale"
          type="button"
          class="btn btn-sm btn-warning"
          :disabled="loading"
          @click="compare"
        >
          <span v-if="loading" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
          <i v-else class="fa-solid fa-stopwatch me-1" aria-hidden="true"></i>
          {{ stale ? t('strava.segments.compare_again') : t('strava.segments.compare_action') }}
        </button>

        <div v-if="error" class="alert alert-danger d-flex align-items-center gap-2 mt-2 mb-0">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span>{{ error }}</span>
        </div>

        <!-- Comparé, mais jamais refait (ou tronçon trop court pour être un segment). -->
        <p v-else-if="comparedRange && !segment && !stale" class="text-muted small mb-0 mt-2">
          {{ t('strava.segments.compare_none') }}
        </p>

        <div v-if="segment && !stale" class="mt-3">
          <div class="compare-head">
            <div class="flex-grow-1">
              <div v-if="naming" class="input-group input-group-sm compare-rename">
                <input
                  v-model="draftName"
                  type="text"
                  class="form-control"
                  :maxlength="80"
                  :placeholder="t('strava.segments.name_placeholder')"
                  :disabled="savingName"
                  @keydown.enter.prevent="saveName()"
                  @keydown.esc.prevent="naming = false"
                />
                <button
                  type="button" class="btn btn-warning" :disabled="savingName"
                  :title="t('strava.segments.save_name')" @click="saveName()"
                >
                  <i class="fa-solid fa-check" aria-hidden="true"></i>
                </button>
                <button
                  type="button" class="btn btn-outline-secondary" :disabled="savingName"
                  :title="t('strava.segments.cancel_name')" @click="naming = false"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
              <div v-else class="fw-semibold d-flex align-items-center gap-2">
                <span>{{ segment.name || segment.place_name || t('strava.segments.compare_anonymous') }}</span>
                <button
                  type="button" class="btn btn-sm btn-link p-0 text-body-tertiary"
                  :title="segment.name ? t('strava.segments.rename') : t('strava.segments.name_it')"
                  @click="startNaming()"
                >
                  <i class="fa-solid fa-pen" aria-hidden="true"></i>
                </button>
              </div>
              <div class="text-muted small">
                {{ km(segment.distance_m) }}
                <span v-if="segment.elevation_gain_m"> · D+{{ segment.elevation_gain_m }} m</span>
              </div>
              <!-- Le nom vaut pour le CHEMIN : il ressortira sur les autres sorties. -->
              <div v-if="segment.named_segment_id" class="text-success small mt-1">
                <i class="fa-solid fa-check me-1" aria-hidden="true"></i>{{ t('strava.segments.named_hint') }}
              </div>
            </div>

            <div class="compare-metric">
              <div class="text-muted small">{{ t('strava.segments.your_time') }}</div>
              <div class="fw-semibold">{{ chrono(segment.current.duration_s) }}</div>
              <div class="text-muted small">{{ speed(segment.current.duration_s) }}</div>
            </div>

            <div class="compare-metric">
              <div class="text-muted small">{{ t('strava.segments.best') }}</div>
              <template v-if="segment.best">
                <div class="fw-semibold">{{ chrono(segment.best.duration_s) }}</div>
                <div class="text-muted small">{{ t('strava.segments.best_on', { date: bestDate(segment.best) }) }}</div>
              </template>
              <div v-else class="text-muted">–</div>
            </div>

            <div class="d-flex flex-column align-items-start gap-1">
              <span
                v-if="segment.current.podium"
                class="badge" :class="podiumClass(segment.current.podium)"
                :title="t('strava.segments.rank', { rank: segment.current.rank, total: segment.current.total })"
              >
                <i
                  class="fa-solid me-1"
                  :class="segment.current.podium === 1 ? 'fa-trophy' : 'fa-medal'"
                  aria-hidden="true"
                ></i>{{ podiumLabel(segment.current.podium) }}
              </span>
              <span v-else class="badge badge-rank">
                {{ t('strava.segments.rank', { rank: segment.current.rank, total: segment.current.total }) }}
              </span>
              <span class="badge text-bg-light border">
                <i class="fa-solid fa-rotate-right me-1" aria-hidden="true"></i>
                {{ segment.count > 1 ? t('strava.segments.passages', { count: segment.count }) : t('strava.segments.passages_one') }}
              </span>
            </div>
          </div>

          <SegmentEfforts
            class="mt-3"
            :efforts="segment.efforts"
            :current-duration-s="segment.current.duration_s"
            :current-reverse="segment.current.reverse"
            :current-date="activityDate"
            :count="segment.count"
            :distance-m="segment.distance_m"
            :is-run="isRun"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.compare-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
}
.compare-metric {
  min-width: 6.5rem;
}
.compare-rename {
  max-width: 22rem;
}
/* Mêmes médailles que la liste des segments découverts : c'est le même classement. */
.badge-gold {
  background: var(--bs-warning);
  color: var(--bs-dark);
}
.badge-silver {
  background: #b6bec6;
  color: var(--bs-dark);
}
.badge-bronze {
  background: #c07636;
  color: #fff;
}
.badge-rank {
  background: var(--bs-tertiary-bg);
  color: var(--bs-secondary-color);
  border: 1px solid var(--bs-border-color);
}
</style>
