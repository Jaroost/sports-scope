<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '../i18n'

// Dialogue de chargement d'un itinéraire en navigation. Liste les itinéraires
// sauvegardés du compte (GET /api/routes) ; un clic charge la géométrie complète
// (GET /api/routes/shared/:token, public) et bascule la page en suivi de tracé.
// Une entrée « naviguer vers un lieu » reste disponible (y compris pour les anonymes).

const props = defineProps<{ loggedIn: boolean }>()

const emit = defineEmits<{
  (e: 'load', route: any): void
  (e: 'close'): void
}>()

interface PreviewSegment {
  c: number // catégorie de pente : 0 = plat, 1 = montée, 2 = descente
  d: string // path SVG (viewBox 0 0 100 100)
}

interface RouteSummary {
  id: number
  name: string
  distance_m: number | null
  share_token: string
  activity?: string
  preview_segments?: PreviewSegment[] | null
}

const routes = ref<RouteSummary[]>([])
// Itinéraires d'autres comptes ouverts via un lien partagé (catégorie séparée).
const openedRoutes = ref<RouteSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
// Token de l'itinéraire en cours de chargement (spinner sur la ligne concernée).
const loadingToken = ref<string | null>(null)

function sportIcon(activity?: string) {
  return activity === 'hiking' ? 'fa-person-hiking' : activity === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

// Couleur d'un segment de l'aperçu selon la catégorie de pente calculée côté
// serveur : 1 = montée (rouge), 2 = descente (bleu), 0 = plat (gris neutre).
// Mêmes teintes que la liste des itinéraires (RoutesList).
function gradeColor(cat: number) {
  if (cat === 1) return '#e0503f'
  if (cat === 2) return '#2f8fed'
  return '#9aa0a6'
}

function formatKm(m: number | null) {
  if (m == null) return '–'
  return `${(m / 1000).toFixed(1)} km`
}

async function fetchRoutes() {
  if (!props.loggedIn) return
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/routes', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    routes.value = Array.isArray(payload.routes) ? payload.routes : []
    openedRoutes.value = Array.isArray(payload.opened) ? payload.opened : []
  } catch {
    error.value = t('routes.error_loading')
  } finally {
    loading.value = false
  }
}

// Charge la géométrie complète puis remonte l'itinéraire au parent.
async function selectRoute(r: RouteSummary) {
  if (loadingToken.value) return
  loadingToken.value = r.share_token
  error.value = null
  try {
    const res = await fetch(`/api/routes/shared/${r.share_token}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    emit('load', data.route || data)
  } catch {
    error.value = t('routes.error_routing')
    loadingToken.value = null
  }
}

onMounted(fetchRoutes)
</script>

<template>
  <div class="nav-picker-backdrop" @click.self="$emit('close')">
    <div class="nav-picker shadow" role="dialog" aria-modal="true">
      <div class="nav-picker-header">
        <h2 class="nav-picker-title">{{ t('routes.load_route') }}</h2>
        <button type="button" class="nav-picker-close" :aria-label="t('routes.cancel')" @click="$emit('close')">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>

      <div class="nav-picker-body">
        <div class="nav-picker-section">{{ t('routes.my_routes') }}</div>

        <!-- Anonyme : pas d'itinéraires sauvegardés → invite à se connecter. -->
        <div v-if="!loggedIn" class="nav-picker-empty">
          {{ t('routes.login_to_load') }}
        </div>
        <div v-else-if="loading" class="nav-picker-empty">
          <i class="fa-solid fa-spinner fa-spin me-2" aria-hidden="true"></i>{{ t('routes.gps_waiting') }}
        </div>
        <div v-else-if="error" class="nav-picker-empty text-danger">{{ error }}</div>
        <div v-else-if="routes.length === 0" class="nav-picker-empty">{{ t('routes.no_routes') }}</div>
        <ul v-else class="nav-picker-list">
          <li v-for="r in routes" :key="r.id">
            <button
              type="button"
              class="nav-picker-item"
              :disabled="loadingToken != null"
              @click="selectRoute(r)"
            >
              <i
                class="fa-solid nav-picker-item-icon"
                :class="loadingToken === r.share_token ? 'fa-spinner fa-spin' : sportIcon(r.activity)"
                aria-hidden="true"
              ></i>
              <!-- Vignette du tracé (comme dans la liste des itinéraires), quand
                   l'aperçu par segments de pente est disponible. -->
              <span v-if="r.preview_segments && r.preview_segments.length" class="nav-picker-item-preview" aria-hidden="true">
                <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
                  <path
                    v-for="(s, i) in r.preview_segments"
                    :key="i"
                    :d="s.d"
                    fill="none"
                    :stroke="gradeColor(s.c)"
                    stroke-width="6"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                </svg>
              </span>
              <span class="nav-picker-item-name text-truncate">{{ r.name }}</span>
              <span class="nav-picker-item-dist">{{ formatKm(r.distance_m) }}</span>
            </button>
          </li>
        </ul>

        <!-- Itinéraires d'autres comptes ouverts via un lien partagé. Masquée tant
             qu'aucun n'a été ouvert (évite une section vide inutile). -->
        <template v-if="loggedIn && !loading && !error && openedRoutes.length > 0">
          <div class="nav-picker-section">{{ t('routes.opened_routes') }}</div>
          <ul class="nav-picker-list">
            <li v-for="r in openedRoutes" :key="r.id">
              <button
                type="button"
                class="nav-picker-item"
                :disabled="loadingToken != null"
                @click="selectRoute(r)"
              >
                <i
                  class="fa-solid nav-picker-item-icon"
                  :class="loadingToken === r.share_token ? 'fa-spinner fa-spin' : sportIcon(r.activity)"
                  aria-hidden="true"
                ></i>
                <span class="nav-picker-item-name text-truncate">{{ r.name }}</span>
                <span class="nav-picker-item-dist">{{ formatKm(r.distance_m) }}</span>
              </button>
            </li>
          </ul>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Au-dessus du tiroir de commandes (z 8) et des notifications. */
.nav-picker-backdrop {
  position: absolute; inset: 0; z-index: 12;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.45);
}
.nav-picker {
  width: min(440px, 100%);
  max-height: calc(100% - 2rem);
  margin-top: 2.5rem;
  display: flex; flex-direction: column;
  background: #fff; border-radius: 1rem; padding: 1rem 1.1rem;
  overflow: hidden;
}
.nav-picker-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.75rem;
}
.nav-picker-title { font-size: 1.15rem; font-weight: 700; margin: 0; }
.nav-picker-close {
  width: 2.2rem; height: 2.2rem; border-radius: 50%; border: none;
  background: rgba(0, 0, 0, 0.06); color: #495057; font-size: 1.1rem;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
}
.nav-picker-close:hover { background: rgba(0, 0, 0, 0.12); }

/* Zone défilante unique : les deux catégories partagent le même scroll. */
.nav-picker-body {
  flex: 1; min-height: 0; overflow-y: auto;
}
.nav-picker-section {
  margin: 1rem 0 0.4rem; font-size: 0.8rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.03em; color: #6c757d;
}
.nav-picker-body > .nav-picker-section:first-child { margin-top: 0; }
.nav-picker-empty { padding: 1rem 0.25rem; color: #6c757d; font-size: 0.95rem; }

.nav-picker-list {
  list-style: none; margin: 0; padding: 0;
}
.nav-picker-item {
  display: flex; align-items: center; gap: 0.7rem; width: 100%;
  padding: 0.75rem 0.6rem; border: none; background: transparent;
  border-radius: 0.6rem; cursor: pointer; text-align: left;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.nav-picker-item:hover { background: rgba(0, 0, 0, 0.04); }
.nav-picker-item:disabled { opacity: 0.6; cursor: default; }
.nav-picker-item-icon { width: 1.4rem; text-align: center; color: #fc4c02; font-size: 1.05rem; }
/* Vignette du tracé — même encombrement que l'icône, boîte arrondie discrète. */
.nav-picker-item-preview {
  flex-shrink: 0;
  width: 2.1rem; height: 2.1rem;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 0.4rem;
  background: rgba(0, 0, 0, 0.04);
}
.nav-picker-item-preview svg { width: 100%; height: 100%; }
.nav-picker-item-name { flex: 1; font-weight: 600; min-width: 0; }
.nav-picker-item-dist { color: #6c757d; font-size: 0.9rem; white-space: nowrap; }
</style>
