<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'

// ── Types du payload /api/performance/ftp ───────────────────────────────────
// Effort ayant déterminé une estimation : une FTP agrège plusieurs sorties (le
// modèle CP ajuste 5/10/20 min, potentiellement issus de trois sorties distinctes),
// d'où une liste plutôt qu'une activité unique.
interface Contributor {
  duration: number
  watts: number
  name: string
  source: string
  external_id: string
  started_at: string | null
}
interface AutoEstimate {
  watts: number
  method: string
  contributors?: Contributor[]
  cp: number | null
  w_prime?: number | null
  cp_points?: number
  ftp_20min: number | null
  ftp_60min?: number | null
  best_20min: number | null
  best_60min?: number | null
  best_5min: number | null
  samples: number
}
interface FtpSummary {
  current: { watts: number | null; source: string | null; stale: boolean; w_per_kg: number | null }
  auto: AutoEstimate | null
  manual: { watts: number | null; at: string | null }
  weight_kg: number | null
  history: { date: string; watts: number; method: string; contributors?: Contributor[] }[]
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
const data = ref<FtpSummary | null>(null)

// Édition manuelle
const editing = ref(false)
// v-model sur <input type="number"> peut y déposer un number ; on tolère les deux.
const ftpInput = ref<string | number>('')
const weightInput = ref<string | number>('')

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

async function fetchData() {
  loading.value = true
  try {
    const res = await fetch('/api/performance/ftp', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = (await res.json()) as FtpSummary
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
  // Rendu APRÈS `loading = false` : sinon le template affiche encore le spinner et le
  // <canvas> n'est pas monté (ref null → graphique jamais dessiné). Cf. PerformanceAnalysis.
  await nextTick()
  renderChart()
}

onMounted(fetchData)

function startEdit() {
  ftpInput.value = data.value?.manual.watts != null ? String(data.value.manual.watts) : ''
  weightInput.value = data.value?.weight_kg != null ? String(data.value.weight_kg) : ''
  editing.value = true
}

async function save() {
  saving.value = true
  try {
    const body = {
      athlete: {
        // Chaîne vide = « effacer » (repli sur l'auto) côté serveur. On force en chaîne :
        // v-model sur <input type="number"> peut fournir un number (pas de .trim() dessus).
        ftp_manual: String(ftpInput.value ?? '').trim(),
        weight_kg: String(weightInput.value ?? '').trim(),
      },
    }
    const res = await fetch('/api/athlete', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(body),
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
  ftpInput.value = ''
  await save()
}

// ── Affichage ────────────────────────────────────────────────────────────────
const current = computed(() => data.value?.current ?? null)
const hasAnything = computed(() => !!(current.value?.watts || data.value?.auto || data.value?.manual.watts))

function methodLabel(method: string | undefined | null): string {
  if (method === 'cp_model') return t('performance.ftp.method_cp')
  if (method === 'ftp_60min') return t('performance.ftp.method_60min')
  if (method === 'ftp_20min') return t('performance.ftp.method_20min')
  return ''
}

const sourceBadge = computed(() => {
  const c = current.value
  if (!c || !c.watts) return null
  if (c.source === 'manual') return { key: 'manual', text: t('performance.ftp.source_manual'), cls: 'text-bg-primary' }
  if (c.stale) return { key: 'stale', text: t('performance.ftp.source_stale'), cls: 'text-bg-secondary' }
  return { key: 'auto', text: t('performance.ftp.source_auto'), cls: 'text-bg-success' }
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

// ── Panneau de détail (sous le graphe) ───────────────────────────────────────
// Un tooltip flottant listant les efforts déterminants recouvrait presque tout le
// tracé (220 px de haut) : le détail vit dans un bloc dédié sous la courbe, où les
// efforts sont de vrais liens — à la souris comme au doigt.
const hoverIndex = ref<number | null>(null)

// Hors survol : le dernier mois, pour que le bloc soit informatif au repos et garde
// sa hauteur.
const detail = computed(() => {
  const hist = data.value?.history ?? []
  if (!hist.length) return null
  return hist[hoverIndex.value ?? hist.length - 1] ?? null
})
const detailContributors = computed<Contributor[]>(() => detail.value?.contributors ?? [])

// Repère vertical sur le mois lu : le détail n'étant plus ancré au curseur, il faut
// montrer quel point il décrit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hoverLinePlugin: any = {
  id: 'hoverLine',
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
        label: 'FTP',
        data: hist.map((p) => p.watts),
        borderColor: '#fc4c02',
        backgroundColor: 'rgba(252, 76, 2, 0.12)',
        pointBackgroundColor: '#fc4c02',
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
        y: { beginAtZero: false, title: { display: true, text: 'W' } },
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
      <i class="fa-solid fa-gauge-high text-warning" aria-hidden="true"></i>
      <span>{{ t('performance.ftp.title') }}</span>
    </h2>

    <div class="card shadow-sm border-0">
      <div class="card-body">
        <div v-if="loading" class="text-muted d-flex align-items-center gap-2">
          <span class="spinner-border spinner-border-sm text-warning" aria-hidden="true"></span>
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
              <div v-if="current && current.watts" class="text-center text-md-start">
                <div class="d-flex align-items-baseline gap-2 justify-content-center justify-content-md-start">
                  <span class="display-5 fw-bold">{{ current.watts }}</span>
                  <span class="fs-5 text-muted">W</span>
                  <span v-if="sourceBadge" class="badge" :class="sourceBadge.cls">{{ sourceBadge.text }}</span>
                </div>
                <div v-if="current.w_per_kg" class="text-warning fw-semibold">{{ current.w_per_kg }} W/kg</div>
                <div v-else class="small text-muted">{{ t('performance.ftp.set_weight_hint') }}</div>
              </div>
              <p v-else class="text-muted mb-0">{{ t('performance.ftp.no_estimate') }}</p>
            </div>

            <!-- Détail de l'estimation auto -->
            <div class="col-12 col-md-4">
              <div v-if="data.auto" class="small">
                <div class="text-muted mb-1">{{ t('performance.ftp.auto_detail') }}</div>
                <div><i class="fa-solid fa-calculator me-1 text-muted"></i>{{ methodLabel(data.auto.method) }} — <strong>{{ data.auto.watts }} W</strong></div>
                <div class="text-muted">
                  <span v-if="data.auto.best_20min">20&nbsp;min : {{ data.auto.best_20min }} W</span>
                  <span v-if="data.auto.best_60min"> · 60&nbsp;min : {{ data.auto.best_60min }} W</span>
                  <span v-if="data.auto.cp"> · CP : {{ data.auto.cp }} W</span>
                </div>
                <div class="text-muted">{{ t('performance.ftp.samples', { count: data.auto.samples }) }}</div>
              </div>
            </div>

            <!-- Actions manuel -->
            <div class="col-12 col-md-4 text-md-end">
              <div v-if="!editing">
                <button type="button" class="btn btn-sm btn-outline-secondary" @click="startEdit">
                  <i class="fa-solid fa-pen me-1"></i>{{ t('performance.ftp.edit') }}
                </button>
                <div v-if="data.manual.watts && data.manual.at" class="small text-muted mt-1">
                  {{ t('performance.ftp.manual_since', { date: new Date(data.manual.at).toLocaleDateString() }) }}
                </div>
              </div>

              <div v-else class="text-start">
                <div class="mb-2">
                  <label class="form-label small mb-1">{{ t('performance.ftp.manual_label') }}</label>
                  <div class="input-group input-group-sm">
                    <input v-model="ftpInput" type="number" class="form-control" min="50" max="600" :placeholder="t('performance.ftp.auto_placeholder')" />
                    <span class="input-group-text">W</span>
                  </div>
                </div>
                <div class="mb-2">
                  <label class="form-label small mb-1">{{ t('performance.ftp.weight_label') }}</label>
                  <div class="input-group input-group-sm">
                    <input v-model="weightInput" type="number" class="form-control" min="30" max="250" step="0.1" />
                    <span class="input-group-text">kg</span>
                  </div>
                </div>
                <div class="d-flex gap-2">
                  <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="save">
                    <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>{{ t('performance.ftp.save') }}
                  </button>
                  <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="saving" @click="resetToAuto">{{ t('performance.ftp.use_auto') }}</button>
                  <button type="button" class="btn btn-sm btn-link text-muted" :disabled="saving" @click="editing = false">{{ t('performance.ftp.cancel') }}</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Aide : comment la FTP est estimée automatiquement -->
          <!-- La définition vaut aussi pour une FTP saisie à la main : seule l'explication
               de l'estimation auto dépend de `data.auto`. -->
          <details class="ftp-how mt-3">
            <summary class="small fw-semibold text-primary">
              <i class="fa-solid fa-circle-question me-1" aria-hidden="true"></i>{{ t('performance.ftp.how_title') }}
            </summary>
            <div class="ftp-how-body small mt-2">
              <p :class="data.auto ? 'mb-2' : 'mb-0'">{{ t('performance.ftp.what_body') }}</p>
              <p v-if="data.auto" class="text-muted mb-0">{{ t('performance.ftp.how_body') }}</p>
            </div>
          </details>

          <!-- Historique -->
          <template v-if="hasHistory">
            <hr class="my-3" />
            <div class="text-muted small mb-2">
              <i class="fa-solid fa-chart-line me-1"></i>{{ t('performance.ftp.history_title') }}
            </div>
            <div class="ftp-chart-wrap" @mouseleave="hoverIndex = null">
              <canvas ref="chartCanvas"></canvas>
            </div>

            <!-- Détail du mois lu : sous le graphe plutôt qu'en bulle par-dessus -->
            <div v-if="detail" class="ftp-detail">
              <div class="d-flex flex-wrap align-items-baseline gap-2 mb-1">
                <span class="fw-semibold text-capitalize">{{ formatMonth(detail.date) }}</span>
                <span>FTP : <b>{{ detail.watts }} W</b></span>
                <span class="small text-muted">{{ methodLabel(detail.method) }}</span>
                <span v-if="hoverIndex === null" class="small text-body-tertiary ms-auto">{{ t('performance.ftp.detail_hint') }}</span>
              </div>
              <div v-if="detailContributors.length" class="pt-2 border-top">
                <div class="small text-muted mb-1">{{ t('performance.ftp.based_on') }}</div>
                <a
                  v-for="ct in detailContributors" :key="`${ct.source}-${ct.external_id}-${ct.duration}`"
                  :href="activityHref(ct)" class="ftp-detail-act small"
                >
                  <b>{{ formatShortDuration(ct.duration) }}</b> : {{ ct.watts }} W
                  <span class="text-body-tertiary">— {{ ct.name }}<template v-if="ct.started_at"> · {{ formatDay(ct.started_at) }}</template></span>
                </a>
              </div>
            </div>
          </template>
          <p v-else-if="!hasAnything" class="text-muted small mb-0 mt-2">{{ t('performance.ftp.no_power_hint') }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ftp-chart-wrap {
  position: relative;
  height: 220px;
}
.ftp-detail {
  margin-top: 0.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}
.ftp-detail-act {
  display: block;
  padding: 2px 0;
  color: var(--bs-body-color);
  text-decoration: none;
}
.ftp-detail-act:hover {
  color: var(--bs-primary);
  text-decoration: underline;
}
.ftp-how summary {
  cursor: pointer;
  list-style: revert;
}
/* Texte explicatif : borné en largeur, une ligne trop longue devient illisible. */
.ftp-how-body {
  max-width: 68ch;
}
</style>
