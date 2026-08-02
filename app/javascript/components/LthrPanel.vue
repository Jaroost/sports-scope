<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, watchEffect, nextTick } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'

// ── Types du payload /api/performance/lthr ──────────────────────────────────
// Jumeau de FtpPanel, en bpm : même forme de payload côté serveur (`LthrEstimator`
// calque `FtpEstimator`), donc même panneau, mêmes gestes. Ce qui change tient à
// deux choses — l'unité, et le fait qu'un seuil cardiaque n'a pas de W/kg.
interface Contributor {
  duration: number
  bpm: number
  name: string
  source: string
  external_id: string
  started_at: string | null
}
interface AutoEstimate {
  bpm: number
  method: string
  best_20min: number | null
  best_60min: number | null
  max_hr: number | null
  contributors?: Contributor[]
  samples: number
}
interface LthrSummary {
  current: { bpm: number | null; source: string | null; method: string | null; stale: boolean }
  auto: AutoEstimate | null
  manual: { bpm: number | null; at: string | null }
  history: { date: string; bpm: number; method: string; contributors?: Contributor[] }[]
}

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

function activityHref(a: { source: string; external_id: string }): string {
  const base = a.source === 'imported' ? '/imported_activities' : '/activities'
  return `${localePrefix}${base}/${a.external_id}`
}

const loading = ref(true)
const error = ref<string | null>(null)
const saving = ref(false)
const data = ref<LthrSummary | null>(null)

const editing = ref(false)
// v-model sur <input type="number"> peut y déposer un number ; on tolère les deux.
const lthrInput = ref<string | number>('')

async function fetchData() {
  loading.value = true
  try {
    const res = await fetch('/api/performance/lthr', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as LthrSummary
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
  // Rendu APRÈS `loading = false` : sinon le template affiche encore le spinner et le
  // <canvas> n'est pas monté (ref null → graphique jamais dessiné). Cf. FtpPanel.
  await nextTick()
  renderChart()
}

onMounted(fetchData)

function startEdit() {
  lthrInput.value = data.value?.manual.bpm != null ? String(data.value.manual.bpm) : ''
  editing.value = true
}

async function save() {
  saving.value = true
  try {
    const res = await fetch('/api/athlete', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      // Chaîne vide = « effacer » (repli sur l'auto) côté serveur. On force en chaîne :
      // v-model sur <input type="number"> peut fournir un number (pas de .trim() dessus).
      body: JSON.stringify({ athlete: { lthr_manual: String(lthrInput.value ?? '').trim() } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    editing.value = false
    await fetchData()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function resetToAuto() {
  lthrInput.value = ''
  await save()
}

// ── Affichage ────────────────────────────────────────────────────────────────
const current = computed(() => data.value?.current ?? null)

// Remonte le seuil courant au parent, pour la pastille du sous-onglet Seuils — le
// panneau reste monté même quand l'onglet ne l'est pas, donc la valeur est là avant
// qu'on ouvre l'onglet.
const emit = defineEmits<{ summary: [payload: { lthrBpm: number | null }] }>()
watchEffect(() => emit('summary', { lthrBpm: current.value?.bpm ?? null }))

const hasAnything = computed(() => !!(current.value?.bpm || data.value?.auto || data.value?.manual.bpm))

function methodLabel(method: string | undefined | null): string {
  if (method === 'lthr_60min') return t('performance.lthr.method_60min')
  if (method === 'lthr_20min') return t('performance.lthr.method_20min')
  return ''
}

const sourceBadge = computed(() => {
  const c = current.value
  if (!c || !c.bpm) return null
  if (c.source === 'manual') return { text: t('performance.ftp.source_manual'), cls: 'text-bg-primary' }
  if (c.stale) return { text: t('performance.ftp.source_stale'), cls: 'text-bg-secondary' }
  return { text: t('performance.ftp.source_auto'), cls: 'text-bg-success' }
})

// ── Historique (Chart.js) ────────────────────────────────────────────────────
const chartCanvas = ref<HTMLCanvasElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chart: any = null

const hasHistory = computed(() => (data.value?.history?.length ?? 0) >= 2)

function formatMonth(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  if (!m) return ym
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
}

function formatShortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = seconds / 60
  return Number.isInteger(m) ? `${m}min` : `${m.toFixed(1)}min`
}

function formatDay(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' })
}

// Détail sous la courbe plutôt qu'en bulle flottante : sur 220 px de haut, un tooltip
// recouvrait presque tout le tracé, et les sorties déterminantes doivent être de vrais
// liens — à la souris comme au doigt. Même choix que FtpPanel.
const hoverIndex = ref<number | null>(null)

const detail = computed(() => {
  const hist = data.value?.history ?? []
  if (!hist.length) return null
  return hist[hoverIndex.value ?? hist.length - 1] ?? null
})
const detailContributors = computed<Contributor[]>(() => detail.value?.contributors ?? [])

// Repère vertical sur le mois lu : le détail n'étant pas ancré au curseur, il faut
// montrer quel point il décrit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hoverLinePlugin: any = {
  id: 'hoverLineLthr',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  afterDatasetsDraw(c: any) {
    if (hoverIndex.value == null) return
    const pt = c.getDatasetMeta(0)?.data?.[hoverIndex.value]
    const area = c.chartArea
    if (!pt || !area) return
    const { ctx } = c
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(pt.x, area.top)
    ctx.lineTo(pt.x, area.bottom)
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = 'rgba(33,37,41,0.5)'
    ctx.stroke()
    ctx.restore()
  },
}

// Chart.js n'expose pas d'événement « index survolé » : on détourne le hook du
// tooltip (désactivé visuellement), seul à connaître le point actif.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syncDetail(context: { tooltip: any }) {
  const idx = context.tooltip?.dataPoints?.[0]?.dataIndex
  if (idx != null) hoverIndex.value = idx
}

watch(hoverIndex, () => chart?.render())

async function renderChart() {
  if (chart) { chart.destroy(); chart = null }
  if (!hasHistory.value || !chartCanvas.value) return
  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  const hist = data.value!.history
  const ctx = chartCanvas.value.getContext('2d')
  if (!ctx) return
  chart = new Chart(ctx, {
    type: 'line',
    plugins: [hoverLinePlugin],
    data: {
      labels: hist.map((p) => formatMonth(p.date)),
      datasets: [{
        label: 'LTHR',
        data: hist.map((p) => p.bpm),
        borderColor: '#dc3545',
        backgroundColor: 'rgba(220, 53, 69, 0.12)',
        pointBackgroundColor: '#dc3545',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Le point le plus proche en X répond au survol, sans avoir à le toucher.
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: syncDetail },
      },
      scales: {
        // Jamais à zéro : les seuils cardiaques vivent entre 140 et 180 bpm, et partir
        // de 0 écraserait toute la progression en une ligne plate.
        y: { beginAtZero: false, title: { display: true, text: 'bpm' } },
      },
    },
  })
}

onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
})
</script>

<template>
  <div class="mb-4">
    <h2 class="h5 d-flex align-items-center gap-2 mb-3">
      <i class="fa-solid fa-heart-pulse text-danger" aria-hidden="true"></i>
      <span>{{ t('performance.lthr.title') }}</span>
    </h2>

    <div class="card shadow-sm border-0">
      <div class="card-body">
        <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
          <span class="spinner-border spinner-border-sm text-danger" aria-hidden="true"></span>
          <span>{{ t('performance.loading') }}</span>
        </div>

        <div v-else-if="error" class="alert alert-danger mb-0 d-flex align-items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span>{{ error }}</span>
        </div>

        <template v-else-if="data">
          <div class="row g-4 align-items-center">
            <!-- Valeur courante -->
            <div class="col-12 col-md-4">
              <div v-if="current && current.bpm" class="text-center text-md-start">
                <div class="d-flex align-items-baseline gap-2 justify-content-center justify-content-md-start">
                  <span class="display-5 fw-bold">{{ current.bpm }}</span>
                  <span class="fs-5 text-muted">bpm</span>
                  <span v-if="sourceBadge" class="badge" :class="sourceBadge.cls">{{ sourceBadge.text }}</span>
                </div>
                <div v-if="data.auto?.max_hr" class="small text-muted">
                  {{ t('performance.lthr.max_hr') }} : {{ data.auto.max_hr }} bpm
                </div>
              </div>
              <p v-else class="text-muted mb-0">{{ t('performance.lthr.no_estimate') }}</p>
            </div>

            <!-- Détail de l'estimation auto -->
            <div class="col-12 col-md-4">
              <div v-if="data.auto" class="small">
                <div class="text-muted mb-1">{{ t('performance.lthr.auto_detail') }}</div>
                <div><i class="fa-solid fa-calculator me-1 text-muted"></i>{{ methodLabel(data.auto.method) }} — <strong>{{ data.auto.bpm }} bpm</strong></div>
                <div class="text-muted">
                  <span v-if="data.auto.best_20min">20&nbsp;min : {{ data.auto.best_20min }} bpm</span>
                  <span v-if="data.auto.best_60min"> · 60&nbsp;min : {{ data.auto.best_60min }} bpm</span>
                </div>
                <div class="text-muted">{{ t('performance.lthr.samples', { count: data.auto.samples }) }}</div>
              </div>
            </div>

            <!-- Actions manuel -->
            <div class="col-12 col-md-4 text-md-end">
              <div v-if="!editing">
                <button type="button" class="btn btn-sm btn-outline-secondary" @click="startEdit">
                  <i class="fa-solid fa-pen me-1"></i>{{ t('performance.lthr.edit') }}
                </button>
                <div v-if="data.manual.bpm && data.manual.at" class="small text-muted mt-1">
                  {{ t('performance.lthr.manual_since', { date: new Date(data.manual.at).toLocaleDateString() }) }}
                </div>
              </div>

              <div v-else class="text-start">
                <div class="mb-2">
                  <label class="form-label small mb-1">{{ t('performance.lthr.manual_label') }}</label>
                  <div class="input-group input-group-sm">
                    <input v-model="lthrInput" type="number" class="form-control" min="100" max="220" :placeholder="t('performance.lthr.auto_placeholder')" />
                    <span class="input-group-text">bpm</span>
                  </div>
                </div>
                <div class="d-flex gap-2">
                  <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="save">
                    <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>{{ t('performance.lthr.save') }}
                  </button>
                  <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="saving" @click="resetToAuto">{{ t('performance.lthr.use_auto') }}</button>
                  <button type="button" class="btn btn-sm btn-link text-muted" :disabled="saving" @click="editing = false">{{ t('performance.lthr.cancel') }}</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Aide : ce qu'est le seuil FC et comment il est estimé -->
          <details class="lthr-how mt-3">
            <summary class="small fw-semibold text-primary">
              <i class="fa-solid fa-circle-question me-1" aria-hidden="true"></i>{{ t('performance.lthr.how_title') }}
            </summary>
            <div class="lthr-how-body small mt-2">
              <p :class="data.auto ? 'mb-2' : 'mb-0'">{{ t('performance.lthr.what_body') }}</p>
              <p v-if="data.auto" class="text-muted mb-0">{{ t('performance.lthr.how_body') }}</p>
            </div>
          </details>

          <!-- Historique -->
          <template v-if="hasHistory">
            <hr class="my-3" />
            <div class="text-muted small mb-2">
              <i class="fa-solid fa-chart-line me-1"></i>{{ t('performance.lthr.history_title') }}
            </div>
            <div class="lthr-chart-wrap" @mouseleave="hoverIndex = null">
              <canvas ref="chartCanvas"></canvas>
            </div>

            <!-- Détail du mois lu : sous le graphe plutôt qu'en bulle par-dessus -->
            <div v-if="detail" class="lthr-detail">
              <div class="d-flex flex-wrap align-items-baseline gap-2 mb-1">
                <span class="fw-semibold text-capitalize">{{ formatMonth(detail.date) }}</span>
                <span>{{ t('performance.load.lthr_title') }} : <b>{{ detail.bpm }} bpm</b></span>
                <span class="small text-muted">{{ methodLabel(detail.method) }}</span>
                <span v-if="hoverIndex === null" class="small text-body-tertiary ms-auto">{{ t('performance.lthr.detail_hint') }}</span>
              </div>
              <div v-if="detailContributors.length" class="pt-2 border-top">
                <div class="small text-muted mb-1">{{ t('performance.lthr.based_on') }}</div>
                <a
                  v-for="ct in detailContributors" :key="`${ct.source}-${ct.external_id}-${ct.duration}`"
                  :href="activityHref(ct)" class="lthr-detail-act small"
                >
                  <b>{{ formatShortDuration(ct.duration) }}</b> : {{ ct.bpm }} bpm
                  <span class="text-body-tertiary">— {{ ct.name }}<template v-if="ct.started_at"> · {{ formatDay(ct.started_at) }}</template></span>
                </a>
              </div>
            </div>
          </template>
          <p v-else-if="!hasAnything" class="text-muted small mb-0 mt-2">{{ t('performance.lthr.no_hr_hint') }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lthr-chart-wrap {
  position: relative;
  height: 220px;
}
.lthr-detail {
  margin-top: 0.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}
.lthr-detail-act {
  display: block;
  padding: 2px 0;
  color: var(--bs-body-color);
  text-decoration: none;
}
.lthr-detail-act:hover {
  color: var(--bs-primary);
  text-decoration: underline;
}
.lthr-how summary {
  cursor: pointer;
  list-style: revert;
}
/* Texte explicatif : borné en largeur, une ligne trop longue devient illisible. */
.lthr-how-body {
  max-width: 68ch;
}
</style>
