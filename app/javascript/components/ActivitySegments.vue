<script setup lang="ts">
// Onglet « Segments » du détail d'une activité : les portions de tracé déjà
// parcourues lors d'autres sorties, retrouvées côté serveur (`SegmentMatcher` —
// aucun segment défini à la main ni repris de Strava). Ce composant ne fait que le
// rendu : il ne recalcule rien, il liste et met en forme.
//
// Deux niveaux d'interaction, calqués sur les marqueurs de cols de la carte :
//   survol → `hover` : le parent prévisualise la portion sur la carte (surlignage
//            seul, rien n'est committé)
//   clic   → `select` : le parent committe la sélection partagée — la carte zoome
//            dessus et la garde surlignée. La ligne active est déduite de
//            `selection` (et non d'un état local), pour rester juste quand la
//            sélection change ailleurs (poignées A/B de la carte, autre segment).
import { ref, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'
import { formatPace, paceMinPerKm, formatChrono } from '../activityHelpers'
import SegmentHistoryChart from './SegmentHistoryChart.vue'

const props = defineProps({
  activityId: { type: [String, Number], required: true },
  source: { type: String, default: 'strava' }, // 'strava' | 'imported'
  // Course à pied → allure (min/km) plutôt que vitesse, comme partout ailleurs.
  isRun: { type: Boolean, default: false },
  // L'onglet ne charge qu'à l'affichage : la recherche balaie tout l'historique
  // proche, inutile de la lancer tant qu'on ne regarde pas.
  active: { type: Boolean, default: false },
  // Sélection partagée du détail d'activité — { startIdx, endIdx } | null.
  selection: { type: Object, default: null },
  // Date de l'activité affichée : le passage du jour n'est pas dans `efforts`, c'est
  // elle qui le place sur le graphique de progression.
  activityDate: { type: String, default: '' },
})

const emit = defineEmits(['hover', 'select'])

interface Effort {
  source: string
  external_id: string
  name: string
  started_at: string | null
  duration_s: number
  reverse: boolean
  // Passage de la sortie affichée elle-même : elle repasse par le segment (aller-retour).
  own: boolean
}

interface Segment {
  start_idx: number
  end_idx: number
  distance_m: number
  elevation_gain_m: number | null
  count: number
  reverse_count: number
  // `reverse` : sens de CETTE sortie par rapport au sens de référence du segment
  // nommé (faux tant que le segment n'a pas de nom — sans nom, pas de référence).
  // `podium` : 1/2/3 (or, argent, bronze) parmi les passages comparables, null hors
  // podium. `record` en est la marche du haut.
  current: {
    duration_s: number, rank: number, total: number, reverse: boolean,
    podium: number | null, record: boolean,
  }
  best: Effort | null
  efforts: Effort[]
  // Nom donné par l'utilisateur, s'il a déjà baptisé ce chemin (depuis n'importe
  // quelle sortie qui le traverse) — cf. NamedSegment côté serveur.
  named_segment_id: number | null
  name: string | null
  // Repli d'affichage quand `name` est absent : la localité la plus proche du milieu
  // du segment (côté serveur). Nul si aucune localité n'est assez proche.
  place_name?: string | null
}

const loading = ref(false)
const error = ref<string | null>(null)
const segments = ref<Segment[]>([])
const fetched = ref(false)
const expanded = ref<number | null>(null)

const segmentsUrl = computed(() => props.source === 'imported'
  ? `/api/imported_activities/${props.activityId}/segments`
  : `/strava/activities/${props.activityId}/segments`)

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

async function fetchSegments() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(segmentsUrl.value, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    segments.value = (json.segments ?? []) as Segment[]
    fetched.value = true
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

watch(() => props.active, (isActive) => {
  if (isActive && !fetched.value && !loading.value) fetchSegments()
}, { immediate: true })

// ── Renommage ────────────────────────────────────────────────────────────────
// Le nom appartient au CHEMIN, pas à cette sortie : une fois posé, il s'affiche sur
// toutes les activités qui passent par là (rapprochement serveur sur les cellules).
const renaming = ref<number | null>(null) // index de la ligne en cours d'édition
const draftName = ref('')
const savingName = ref(false)
// Ref de fonction : le champ vit dans un `v-for`, un `ref` nommé y deviendrait un
// tableau. Une seule ligne est en édition à la fois, donc une seule référence suffit.
const nameInput = ref<HTMLInputElement | null>(null)
// Les `li` de la liste, pour ramener à l'écran celle qu'on vient d'ouvrir.
const rowEls: HTMLElement[] = []

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

// Le champ n'existe qu'une fois la ligne passée en édition : on attend le rendu pour
// lui donner le focus. `select()` présélectionne le nom existant — renommer, c'est le
// plus souvent le remplacer.
async function startRename(index: number, segment: Segment) {
  renaming.value = index
  // Segment encore anonyme : on part de la localité proposée en repli — le plus
  // souvent on la garde, sinon on la remplace (le champ est présélectionné).
  draftName.value = segment.name || segment.place_name || ''
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function cancelRename() {
  renaming.value = null
  draftName.value = ''
}

async function saveName(segment: Segment) {
  const name = draftName.value.trim()
  // Nom vidé sur un segment déjà nommé = on retire le nom (il redevient anonyme,
  // mais reste détecté).
  if (!name) {
    if (segment.named_segment_id) await removeName(segment)
    else cancelRename()
    return
  }

  savingName.value = true
  try {
    const res = segment.named_segment_id
      ? await request(`/api/named_segments/${segment.named_segment_id}`, 'PATCH', { name })
      : await request('/api/named_segments', 'POST', {
        name,
        source: props.source,
        activity_id: props.activityId,
        start_idx: segment.start_idx,
        end_idx: segment.end_idx,
      })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    applyName(segment, json.named_segment.id, json.named_segment.name)
    cancelRename()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    savingName.value = false
  }
}

async function removeName(segment: Segment) {
  if (!segment.named_segment_id) return
  savingName.value = true
  try {
    const res = await request(`/api/named_segments/${segment.named_segment_id}`, 'DELETE')
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    applyName(segment, null, null)
    cancelRename()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    savingName.value = false
  }
}

// Le nom vaut pour le chemin : si plusieurs lignes pointent le même segment nommé
// (cas d'un aller-retour découpé en deux), toutes suivent.
function applyName(segment: Segment, id: number | null, name: string | null) {
  const previousId = segment.named_segment_id
  for (const s of segments.value) {
    if (s === segment || (previousId && s.named_segment_id === previousId)) {
      s.named_segment_id = id
      s.name = name
    }
  }
}

function request(url: string, method: string, body?: Record<string, unknown>) {
  return fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// ── Formatage ────────────────────────────────────────────────────────────────
// Chronos de segment en « m:ss » (partagé avec le graphique d'historique).
const chrono = formatChrono

// Écart au temps du jour, signé (négatif = ce passage-là était plus rapide).
function delta(seconds: number, reference: number): string {
  const d = Math.round(seconds - reference)
  if (d === 0) return '='
  return `${d > 0 ? '+' : '−'}${chrono(Math.abs(d))}`
}

function km(metres: number): string {
  return `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`
}

// Allure (course) ou vitesse moyenne (le reste) d'un passage sur le segment.
function speed(segment: Segment, seconds: number): string {
  if (!seconds) return '–'
  const mps = segment.distance_m / seconds
  if (props.isRun) return `${formatPace(paceMinPerKm(mps))} /km`
  return `${(mps * 3.6).toFixed(1)} km/h`
}

function activityUrl(effort: Effort): string {
  const path = effort.source === 'imported' ? 'imported_activities' : 'activities'
  return `${localePrefix}/${path}/${effort.external_id}`
}

function effortDate(effort: Effort): string {
  if (!effort.started_at) return '–'
  return new Date(effort.started_at).toLocaleDateString(lang || undefined, {
    day: '2-digit', month: '2-digit', year: '2-digit',
  })
}

function hover(segment: Segment | null) {
  emit('hover', segment ? { startIdx: segment.start_idx, endIdx: segment.end_idx } : null)
}

// Or / argent / bronze. Le libellé porte la place en clair : la couleur seule ne
// distingue pas argent et bronze pour tout le monde.
const PODIUM = ['rank_first', 'rank_second', 'rank_third'] as const
const PODIUM_CLASS = ['badge-gold', 'badge-silver', 'badge-bronze'] as const

function podiumLabel(place: number): string {
  return t(`strava.segments.${PODIUM[place - 1] ?? 'rank_first'}`)
}

function podiumClass(place: number): string {
  return PODIUM_CLASS[place - 1] ?? 'badge-gold'
}

// La ligne est active tant que la sélection partagée porte exactement sur elle.
function isSelected(segment: Segment): boolean {
  const sel = props.selection as { startIdx: number, endIdx: number } | null
  return !!sel && sel.startIdx === segment.start_idx && sel.endIdx === segment.end_idx
}

// Clic sur une ligne : on épingle le segment ET on déplie son détail. `expanded` ne
// retient qu'un index, donc le détail précédemment ouvert se referme tout seul.
// Reclic sur la même ligne : on referme et on désépingle.
async function activate(index: number, segment: Segment) {
  if (isSelected(segment)) {
    expanded.value = null
    emit('select', null)
    return
  }
  expanded.value = index
  emit('select', { startIdx: segment.start_idx, endIdx: segment.end_idx })
  // La ligne cliquée peut se retrouver hors écran : celle d'avant s'est repliée (tout
  // remonte) et la carte collée mange le haut de la fenêtre. On la ramène juste sous
  // la carte, une fois le détail rendu.
  await nextTick()
  scrollRowIntoView(index)
}

// `scrollIntoView` plutôt qu'un `scrollTo` calculé : la place à réserver en haut
// (navbar + carte collée) est déclarée en CSS via `scroll-margin-top`, et c'est le
// navigateur qui l'applique APRÈS mise en page. Un calcul JS au moment du clic, lui,
// mesure une carte qui n'est pas encore collée et vise à côté.
function scrollRowIntoView(index: number) {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  rowEls[index]?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
}
</script>

<template>
  <div class="mt-3 mb-3">
    <h2 class="h5 d-flex align-items-center gap-2 mb-1">
      <i class="fa-solid fa-route text-warning" aria-hidden="true"></i>
      <span>{{ t('strava.segments.title') }}</span>
    </h2>
    <p class="text-muted small mb-3">{{ t('strava.segments.intro') }}</p>

    <div v-if="loading" class="text-muted d-flex align-items-center gap-2 py-3">
      <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
      <span>{{ t('strava.segments.loading') }}</span>
    </div>

    <div v-else-if="error" class="alert alert-danger d-flex align-items-center gap-2">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>

    <div v-else-if="!segments.length" class="card shadow-sm border-0">
      <div class="card-body">
        <p class="mb-1">{{ t('strava.segments.none') }}</p>
        <p class="text-muted small mb-0">{{ t('strava.segments.none_hint') }}</p>
      </div>
    </div>

    <div v-else class="card shadow-sm border-0">
      <ul class="list-group list-group-flush">
        <li
          v-for="(segment, i) in segments" :key="`${segment.start_idx}-${segment.end_idx}`"
          :ref="(el) => { rowEls[i] = el as HTMLElement }"
          class="list-group-item segment-row"
          :class="{ 'segment-row-selected': isSelected(segment) }"
          role="button"
          tabindex="0"
          :aria-pressed="isSelected(segment)"
          :aria-expanded="expanded === i"
          :title="isSelected(segment) ? t('strava.segments.unselect_hint') : t('strava.segments.select_hint')"
          @mouseenter="hover(segment)"
          @mouseleave="hover(null)"
          @click="activate(i, segment)"
          @keydown.enter.self.prevent="activate(i, segment)"
          @keydown.space.self.prevent="activate(i, segment)"
        >
          <div class="segment-head">
            <div class="segment-id flex-grow-1">
              <!-- Édition du nom : le clic ne doit ni épingler ni déplier la ligne. -->
              <div v-if="renaming === i" class="input-group input-group-sm segment-rename" @click.stop>
                <input
                  :ref="(el) => { nameInput = el as HTMLInputElement }"
                  v-model="draftName"
                  type="text"
                  class="form-control"
                  :maxlength="80"
                  :placeholder="t('strava.segments.name_placeholder')"
                  :disabled="savingName"
                  @keydown.enter.prevent="saveName(segment)"
                  @keydown.esc.prevent="cancelRename()"
                />
                <button
                  type="button" class="btn btn-warning" :disabled="savingName"
                  :title="t('strava.segments.save_name')" @click="saveName(segment)"
                >
                  <i class="fa-solid fa-check" aria-hidden="true"></i>
                </button>
                <button
                  type="button" class="btn btn-outline-secondary" :disabled="savingName"
                  :title="t('strava.segments.cancel_name')" @click="cancelRename()"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
              <div v-else class="fw-semibold d-flex align-items-center gap-2">
                <i
                  class="fa-solid fa-location-dot segment-pin"
                  :class="isSelected(segment) ? 'text-warning' : 'text-body-tertiary'"
                  aria-hidden="true"
                ></i>
                <span class="segment-name">{{ segment.name || segment.place_name || t('strava.segments.segment_n', { n: i + 1 }) }}</span>
                <button
                  type="button" class="btn btn-sm btn-link p-0 segment-rename-btn"
                  :title="segment.name ? t('strava.segments.rename') : t('strava.segments.name_it')"
                  @click.stop="startRename(i, segment)"
                >
                  <i class="fa-solid fa-pen" aria-hidden="true"></i>
                </button>
              </div>
              <div class="text-muted small">
                {{ km(segment.distance_m) }}
                <span v-if="segment.elevation_gain_m"> · D+{{ segment.elevation_gain_m }} m</span>
                <!-- Sens de référence = celui enregistré au baptême du segment. -->
                <span v-if="segment.current.reverse" class="badge text-bg-light border ms-1">
                  {{ t('strava.segments.reverse') }}
                </span>
              </div>
            </div>

            <div class="segment-metrics d-flex gap-3">
            <div class="segment-metric">
              <div class="text-muted small">{{ t('strava.segments.your_time') }}</div>
              <div class="fw-semibold">{{ chrono(segment.current.duration_s) }}</div>
              <div class="text-muted small">{{ speed(segment, segment.current.duration_s) }}</div>
            </div>

            <div class="segment-metric">
              <div class="text-muted small">{{ t('strava.segments.best') }}</div>
              <template v-if="segment.best">
                <div class="fw-semibold">{{ chrono(segment.best.duration_s) }}</div>
                <div class="text-muted small">{{ t('strava.segments.best_on', { date: effortDate(segment.best) }) }}</div>
              </template>
              <div v-else class="text-muted">–</div>
            </div>
            </div>

            <div class="segment-badges d-flex flex-column align-items-start gap-1">
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
              <span v-if="segment.reverse_count" class="text-muted small">
                {{ t('strava.segments.reverse_count', { count: segment.reverse_count }) }}
              </span>
            </div>
          </div>

          <!-- L'historique est dans la ligne : on stoppe le clic pour qu'ouvrir un
               passage ne désépingle pas le segment. -->
          <div v-if="expanded === i" class="segment-history mt-3" @click.stop>
            <!-- Progression : un point par passage, date en x, chrono en y, un sens
                 par série (le sens inverse n'est pas comparable au sens direct). -->
            <SegmentHistoryChart
              class="mb-3"
              :efforts="segment.efforts"
              :current-duration-s="segment.current.duration_s"
              :current-reverse="segment.current.reverse"
              :current-date="activityDate"
            />
            <div class="table-responsive">
              <table class="table table-sm align-middle mb-1">
                <thead>
                  <tr class="text-muted small">
                    <th scope="col">{{ t('strava.segments.date') }}</th>
                    <th scope="col">{{ t('strava.segments.time') }}</th>
                    <th scope="col">{{ t('strava.segments.delta') }}</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr class="table-active">
                    <td>
                      {{ t('strava.segments.this_activity') }}
                      <span v-if="segment.current.reverse" class="badge text-bg-light border ms-1">{{ t('strava.segments.reverse') }}</span>
                    </td>
                    <td class="fw-semibold">{{ chrono(segment.current.duration_s) }}</td>
                    <td class="text-muted">=</td>
                    <td class="text-muted small">{{ speed(segment, segment.current.duration_s) }}</td>
                  </tr>
                  <tr v-for="effort in segment.efforts" :key="`${effort.source}-${effort.external_id}-${effort.started_at}-${effort.duration_s}`">
                    <td>{{ effortDate(effort) }}</td>
                    <td>
                      {{ chrono(effort.duration_s) }}
                      <span v-if="effort.reverse" class="badge text-bg-light border ms-1">{{ t('strava.segments.reverse') }}</span>
                    </td>
                    <td :class="effort.duration_s < segment.current.duration_s ? 'text-success' : 'text-danger'">
                      {{ effort.reverse === segment.current.reverse ? delta(effort.duration_s, segment.current.duration_s) : '–' }}
                    </td>
                    <td class="small">
                      <a :href="activityUrl(effort)" class="link-secondary text-decoration-none">
                        {{ effort.name }}
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="segment.efforts.length < segment.count - 1" class="text-muted small mb-0">
              {{ t('strava.segments.truncated', { count: segment.efforts.length }) }}
            </p>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.segment-row {
  /* La carte reste collée en haut : une ligne amenée à l'écran doit s'arrêter SOUS
     elle. `--sticky-map-h` est publiée par ActivityMapCard (sa hauteur réelle une
     fois collée, 0 sinon), `--navbar-h` par trackNavbar. */
  scroll-margin-top: calc(var(--navbar-h, 4rem) + var(--sticky-map-h, 0px) + 0.5rem);
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.segment-row:hover {
  background: var(--bs-tertiary-bg);
}
/* Segment épinglé : il reste surligné sur la carte, la ligne doit le dire. */
.segment-row-selected {
  border-left-color: var(--bs-warning);
  background: color-mix(in srgb, var(--bs-warning) 12%, transparent);
}
.segment-row-selected:hover {
  background: color-mix(in srgb, var(--bs-warning) 18%, transparent);
}
.segment-metric {
  min-width: 6.5rem;
}
.segment-rename {
  max-width: 22rem;
}

/* Disposition de la ligne en CSS et non via `d-flex`/`gap-3` : les utilitaires
   Bootstrap sont en `!important`, la grille du mode téléphone ne pourrait pas
   passer devant. */
.segment-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
}

/* Téléphone : les cinq blocs de la ligne (nom, temps, meilleur, badges, chevron) ne
   tiennent pas côte à côte et s'enroulaient n'importe comment. On repasse en grille :
   le nom et le chevron sur la première ligne, les badges dessous, les deux chronos
   en dernier — l'ordre de lecture d'une fiche. */
@media (max-width: 575.98px) {
  .segment-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "id"
      "badges"
      "metrics";
    gap: 0.5rem;
  }
  .segment-id { grid-area: id; }
  .segment-metrics { grid-area: metrics; }
  .segment-badges {
    grid-area: badges;
    min-width: 0;
    flex-direction: row !important;
    flex-wrap: wrap;
    align-items: center !important;
  }
  /* Le nom peut être long : il se coupe plutôt que de pousser le chevron dehors. */
  .segment-id .segment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
/* Médailles. Le doré reprend l'accent de l'app (`btn-warning`) ; argent et bronze
   sont assez contrastés pour porter du texte foncé / clair sans ambiguïté. */
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

/* Hors podium, le rang est une information de contexte, pas une distinction : fond
   clair et encre atténuée, pour qu'il ne rivalise pas avec les médailles. */
.badge-rank {
  background: var(--bs-tertiary-bg);
  color: var(--bs-secondary-color);
  border: 1px solid var(--bs-border-color);
}

/* Le crayon reste discret jusqu'au survol de la ligne. */
.segment-rename-btn {
  opacity: 0;
  color: var(--bs-secondary-color);
  transition: opacity 0.12s ease;
}
.segment-row:hover .segment-rename-btn,
.segment-rename-btn:focus-visible {
  opacity: 1;
}
.segment-badges {
  min-width: 9rem;
}
</style>
