<script setup lang="ts">
// Atterrissage d'un `.fit` partagé à l'application, ou ouvert avec elle.
//
// Pourquoi une page et pas un import direct : le conteneur `.fit` porte deux choses
// que rien ne distingue à l'œil — une sortie enregistrée (`activity`) et un parcours
// planifié (`course`) — et le même fichier sert légitimement aux deux usages, un
// parcours qu'on vient de rouler pouvant se rejouer. Deviner sans le dire enverrait
// une sortie dans le créateur d'itinéraire, ou un parcours dans le journal, sans que
// le cycliste comprenne où son fichier est passé. On lit donc le fichier, on montre
// ce qu'il contient, et on laisse choisir — `file_id` ne servant qu'à mettre en avant
// l'issue probable.
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { csrfToken } from '../csrf'
import {
  FitImportError,
  buildImportedActivityPayload,
  fitSummary,
  fitWaypoints,
  parseFitFile,
} from '../fitImport'

const props = defineProps({
  sharedFit: { type: String, default: null },
  sharedFitName: { type: String, default: null },
})

const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
const localePrefix = lang ? `/${lang}` : ''

type Status = 'loading' | 'ready' | 'empty' | 'working'

const status = ref<Status>('loading')
const error = ref<string | null>(null)
const summary = ref<ReturnType<typeof fitSummary> | null>(null)
const filename = ref<string | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)

// Le décodé, gardé tel quel : les deux issues repartent du même arbre, et redécoder
// un fichier de plusieurs mégaoctets au clic ferait attendre une seconde de plus.
let parsed: any = null

// La trace sert à savoir si « en faire un itinéraire » a un sens : un `.fit`
// d'home-trainer n'a aucune position, et le bouton doit se désactiver plutôt que
// d'ouvrir un créateur vide.
const hasTrack = computed(() => (summary.value?.pointCount ?? 0) >= 2)
// Un parcours n'a ni session ni flux : il n'y a pas de sortie à journaliser.
const canLogRide = computed(() => summary.value != null && summary.value.kind !== 'course')
const suggestsRoute = computed(() => summary.value?.kind === 'course')

function formatKm(m: number | null | undefined) {
  return m == null ? '—' : `${(m / 1000).toFixed(1)} km`
}

function formatDuration(sec: number | null | undefined) {
  if (!sec || sec < 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')}`
}

function formatDate(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : '—'
}

async function load(buf: ArrayBuffer, name: string | null) {
  filename.value = name
  try {
    parsed = await parseFitFile(buf)
    summary.value = fitSummary(parsed, name)
    status.value = 'ready'
  } catch (e) {
    parsed = null
    error.value = t('fit.landing.error_invalid')
    status.value = 'empty'
  }
}

// Voie normale du partage : le service worker a mis le binaire en cache et nous a
// redirigés ici. La récupération est one-shot côté SW — un rechargement de page ne
// rejouera donc pas le fichier, d'où le retrait du paramètre dans la foulée.
async function loadFromShare(): Promise<boolean> {
  const u = new URL(window.location.href)
  if (u.searchParams.get('fromShare') !== '1') return false
  u.searchParams.delete('fromShare')
  window.history.replaceState({}, '', u.toString())
  try {
    const res = await fetch('/__shared_fit__', { cache: 'no-store' })
    if (!res.ok) return false
    const name = decodeURIComponent(res.headers.get('X-Filename') || '').trim()
    await load(await res.arrayBuffer(), name || null)
    return true
  } catch {
    return false
  }
}

// Filet de sécurité serveur : le SW n'a pas intercepté le POST, le fichier arrive
// en prop base64.
function loadFromProp(): boolean {
  if (!props.sharedFit) return false
  try {
    const bin = atob(props.sharedFit)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const name = (props.sharedFitName ?? '').trim()
    void load(bytes.buffer, name ? `${name}.fit` : null)
    return true
  } catch {
    return false
  }
}

// File Handling API : l'OS ouvre un `.fit` avec l'application installée et nous le
// passe par `launchQueue`. Le consommateur doit être posé au montage — le fichier
// est déjà en attente au chargement de la page.
function setupFileHandler(): void {
  const queue = (window as { launchQueue?: { setConsumer: (cb: (p: { files?: FileSystemFileHandle[] }) => void) => void } }).launchQueue
  if (!queue || typeof queue.setConsumer !== 'function') return
  queue.setConsumer(async (params) => {
    const handle = params?.files?.[0]
    if (!handle) return
    try {
      const file = await handle.getFile()
      await load(await file.arrayBuffer(), file.name)
    } catch {
      error.value = t('fit.landing.error_invalid')
      status.value = 'empty'
    }
  })
}

function openPicker() {
  fileInputEl.value?.click()
}

async function onFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  status.value = 'loading'
  error.value = null
  await load(await file.arrayBuffer(), file.name)
}

// Issue 1 — journaliser la sortie. Même charge utile que le dépôt du tableau de bord :
// c'est le même `buildImportedActivityPayload`, donc une sortie partagée et une sortie
// déposée entrent en base identiques.
async function logAsRide() {
  if (!parsed) return
  status.value = 'working'
  error.value = null
  try {
    const payload = buildImportedActivityPayload(parsed, filename.value)
    const res = await fetch('/api/imported_activities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    })
    if (!res.ok && res.status !== 201) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const id = body?.activity?.id
    window.location.href = id ? `${localePrefix}/imported_activities/${id}` : `${localePrefix}/dashboard`
  } catch (e) {
    error.value = (e as Error).message
    status.value = 'ready'
  }
}

// Issue 2 — en faire un itinéraire. On passe par le canal que le créateur consomme
// déjà pour l'import GPX (`sessionStorage` + `?fromGpx=1`) : rien à ajouter côté
// RouteBuilder, et le tracé y reçoit le même calage BRouter qu'un itinéraire dessiné
// à la main.
function makeRoute() {
  if (!parsed) return
  try {
    const waypoints = fitWaypoints(parsed)
    const baseName = (filename.value || summary.value?.name || '')
      .replace(/\.fit$/i, '')
      .trim()
      .slice(0, 80)
    sessionStorage.setItem('sportsScope.gpxImport', JSON.stringify({ name: baseName, waypoints }))
    window.location.href = `${localePrefix}/routes/new?fromGpx=1`
  } catch (e) {
    error.value = e instanceof FitImportError && e.code === 'no_points'
      ? t('fit.landing.error_no_points')
      : t('fit.landing.error_invalid')
  }
}

onMounted(async () => {
  setupFileHandler()
  if (await loadFromShare()) return
  if (loadFromProp()) return
  // Ni partage ni prop : soit `launchQueue` va nous livrer un fichier, soit l'URL a
  // été ouverte à la main. On propose le sélecteur plutôt qu'un écran vide.
  status.value = 'empty'
})
</script>

<template>
  <div class="fit-landing">
    <div class="d-flex align-items-center gap-3 mb-3">
      <span class="dashboard-badge bg-warning-subtle text-warning">
        <i class="fa-solid fa-file-import" aria-hidden="true"></i>
      </span>
      <h1 class="h4 mb-0">{{ t('fit.landing.title') }}</h1>
    </div>

    <div v-if="error" class="alert alert-danger d-flex align-items-center gap-2" role="alert">
      <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
      <span>{{ error }}</span>
    </div>

    <div v-if="status === 'loading'" class="text-muted d-flex align-items-center gap-2">
      <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      {{ t('fit.landing.reading') }}
    </div>

    <div v-else-if="status === 'empty'" class="card shadow-sm border-0">
      <div class="card-body text-center">
        <p class="text-muted mb-3">{{ t('fit.landing.no_file') }}</p>
        <input ref="fileInputEl" type="file" accept=".fit,application/octet-stream" class="d-none" @change="onFileChange" />
        <button type="button" class="btn btn-warning" @click="openPicker">
          <i class="fa-solid fa-folder-open me-1" aria-hidden="true"></i>
          {{ t('fit.landing.pick_file') }}
        </button>
      </div>
    </div>

    <template v-else>
      <div class="card shadow-sm border-0 mb-3">
        <div class="card-body">
          <div class="d-flex align-items-center gap-2 mb-2">
            <span class="badge" :class="suggestsRoute ? 'bg-info-subtle text-info' : 'bg-success-subtle text-success'">
              {{ suggestsRoute ? t('fit.landing.kind_course') : t('fit.landing.kind_activity') }}
            </span>
            <strong class="text-truncate">{{ summary?.name || filename || t('fit.landing.untitled') }}</strong>
          </div>
          <dl class="row mb-0 small">
            <dt class="col-5 col-sm-3 text-muted fw-normal">{{ t('fit.landing.date') }}</dt>
            <dd class="col-7 col-sm-9 mb-1">{{ formatDate(summary?.startedAt) }}</dd>
            <dt class="col-5 col-sm-3 text-muted fw-normal">{{ t('fit.landing.distance') }}</dt>
            <dd class="col-7 col-sm-9 mb-1">{{ formatKm(summary?.distanceM) }}</dd>
            <dt class="col-5 col-sm-3 text-muted fw-normal">{{ t('fit.landing.duration') }}</dt>
            <dd class="col-7 col-sm-9 mb-1">{{ formatDuration(summary?.elapsedS) }}</dd>
            <dt class="col-5 col-sm-3 text-muted fw-normal">{{ t('fit.landing.elevation') }}</dt>
            <dd class="col-7 col-sm-9 mb-1">{{ summary?.elevationGainM != null ? `${summary.elevationGainM} m` : '—' }}</dd>
            <dt class="col-5 col-sm-3 text-muted fw-normal">{{ t('fit.landing.points') }}</dt>
            <dd class="col-7 col-sm-9 mb-0">{{ summary?.pointCount ?? 0 }}</dd>
          </dl>
        </div>
      </div>

      <p class="text-muted">{{ t('fit.landing.prompt') }}</p>

      <div class="row g-3">
        <div class="col-12 col-md-6">
          <button
            type="button"
            class="btn w-100 h-100 text-start p-3 fit-landing-choice"
            :class="suggestsRoute ? 'btn-outline-secondary' : 'btn-outline-warning'"
            :disabled="!canLogRide || status === 'working'"
            @click="logAsRide"
          >
            <span class="d-flex align-items-center gap-2 fw-semibold mb-1">
              <i class="fa-solid fa-chart-line" aria-hidden="true"></i>
              {{ t('fit.landing.action_ride') }}
            </span>
            <small class="d-block text-muted">
              {{ canLogRide ? t('fit.landing.action_ride_hint') : t('fit.landing.action_ride_unavailable') }}
            </small>
          </button>
        </div>

        <div class="col-12 col-md-6">
          <button
            type="button"
            class="btn w-100 h-100 text-start p-3 fit-landing-choice"
            :class="suggestsRoute ? 'btn-outline-warning' : 'btn-outline-secondary'"
            :disabled="!hasTrack || status === 'working'"
            @click="makeRoute"
          >
            <span class="d-flex align-items-center gap-2 fw-semibold mb-1">
              <i class="fa-solid fa-route" aria-hidden="true"></i>
              {{ t('fit.landing.action_route') }}
            </span>
            <small class="d-block text-muted">
              {{ hasTrack ? t('fit.landing.action_route_hint') : t('fit.landing.action_route_unavailable') }}
            </small>
          </button>
        </div>
      </div>

      <div v-if="status === 'working'" class="text-muted d-flex align-items-center gap-2 mt-3">
        <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
        {{ t('fit.landing.saving') }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.fit-landing {
  max-width: 720px;
}

/* Les deux issues sont des cibles tactiles au bord de la route, pas des boutons de
   formulaire : on leur donne la même hauteur pour qu'aucune ne paraisse secondaire
   par accident — la mise en avant passe par la seule couleur. */
.fit-landing-choice {
  min-height: 5rem;
  white-space: normal;
}
</style>
