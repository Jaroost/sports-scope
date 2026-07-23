<script setup lang="ts">
// Fond de carte imposé aux destinataires d'un lien de partage : ce que verront les
// visiteurs de la vue en lecture seule et de la page de partage. Un tracé de montagne
// se lit sur le fond topo, une sortie route sur CyclOSM, et le destinataire — souvent
// non connecté — n'a aucune préférence utile. Sans consigne (null), chacun garde le sien.
//
// Réglage de partage, pas de tracé : on l'enregistre tout de suite (PATCH ciblé) plutôt
// que d'attendre un enregistrement complet — on vient le régler juste avant d'envoyer
// le lien. D'où le fetch ici, partagé par le créateur et la liste des itinéraires.
import { ref, computed, watch } from 'vue'
import { t } from '../i18n'
import { MAP_STYLES, MAP_STYLE_GROUPS } from '../mapStyles'

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

const props = defineProps<{
  show: boolean
  routeId: number | null
  // Fond actuellement imposé (null = pas de consigne).
  styleId: string | null
  // Fond proposé quand on active l'interrupteur sans consigne préalable : celui que
  // l'appelant a sous les yeux (carte du créateur), à défaut CyclOSM.
  defaultStyleId?: string
}>()

const emit = defineEmits<{
  close: []
  saved: [{ styleId: string | null; updatedAt: string | null }]
  error: [string]
}>()

const forced = ref(false)
const draft = ref('cyclosm')
const saving = ref(false)

// Les fonds sont listés à plat plutôt que dans le dropdown habituel : la boîte de
// dialogue rogne ce qui déborde d'elle (overflow: hidden, pour ses coins arrondis),
// et le menu déroulant en sortait.
const styleGroups = computed(() =>
  MAP_STYLE_GROUPS
    .map((group) => ({ group, styles: MAP_STYLES.filter((s) => s.group === group) }))
    .filter((g) => g.styles.length > 0),
)

// À chaque ouverture on repart de l'état enregistré : la modale peut être rouverte sur
// un autre itinéraire (liste) ou après un aller-retour annulé.
watch(() => props.show, (open) => {
  if (!open) return
  forced.value = !!props.styleId
  draft.value = props.styleId || props.defaultStyleId || 'cyclosm'
})

async function save() {
  const next = forced.value ? draft.value : null
  if (!props.routeId) { emit('saved', { styleId: next, updatedAt: null }); emit('close'); return }
  saving.value = true
  try {
    const res = await fetch(`/api/routes/${props.routeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ share_map_style: next }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    emit('saved', { styleId: payload.route?.share_map_style || null, updatedAt: payload.route?.updated_at || null })
    emit('close')
  } catch (e: any) {
    emit('error', e.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-backdrop-sharestyle" @click.self="emit('close')">
      <div class="modal-dialog-sharestyle shadow-lg">
        <div class="modal-header-sharestyle">
          <strong>{{ t('routes.share_map_style') }}</strong>
          <button type="button" class="btn-close" @click="emit('close')" :aria-label="t('routes.cancel')"></button>
        </div>
        <div class="modal-body-sharestyle d-flex flex-column gap-3">
          <p class="small text-muted mb-0">{{ t('routes.share_map_style_hint') }}</p>
          <div class="form-check form-switch">
            <input id="share-map-forced" v-model="forced" type="checkbox" class="form-check-input" role="switch" />
            <label for="share-map-forced" class="form-check-label small">{{ t('routes.share_map_style_force') }}</label>
          </div>
          <div v-if="forced" class="share-style-grid">
            <template v-for="g in styleGroups" :key="g.group">
              <h6 class="share-style-group">{{ t(`strava.map_style_group_${g.group}`) }}</h6>
              <button v-for="s in g.styles" :key="s.id" type="button" class="share-style-item"
                      :class="{ active: draft === s.id }" @click="draft = s.id">
                <i :class="`fa-solid ${s.icon}`" aria-hidden="true"></i>
                <span class="text-truncate">{{ t(`strava.map_style_${s.id}`) }}</span>
              </button>
            </template>
          </div>
          <p v-else class="small text-muted mb-0">{{ t('routes.share_map_style_free') }}</p>
          <button type="button" class="btn btn-warning" @click="save" :disabled="saving">
            <span v-if="saving" class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
            <i v-else class="fa-solid fa-check me-1" aria-hidden="true"></i>
            {{ t('routes.share_map_style_save') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-backdrop-sharestyle {
  position: fixed;
  inset: 0;
  /* Au-dessus des dropdowns Bootstrap (1055) et du menu d'actions du créateur. */
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
}
.modal-dialog-sharestyle {
  width: 100%;
  max-width: 440px;
  background: var(--bs-body-bg, #fff);
  border-radius: 0.75rem;
  overflow: hidden;
}
.modal-header-sharestyle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--bs-border-color, #e5e7eb);
}
.modal-body-sharestyle { padding: 1.25rem; }

/* Choix du fond : deux colonnes, en-têtes de groupe sur toute la largeur. */
.share-style-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.4rem;
}
.share-style-group {
  grid-column: 1 / -1;
  margin: 0.35rem 0 0;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #6b7280;
}
.share-style-group:first-child { margin-top: 0; }
.share-style-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.5rem 0.6rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  background: #fff;
  color: #1f2937;
  font-size: 0.9rem;
  text-align: left;
}
.share-style-item:hover { background: #f3f4f6; }
.share-style-item.active {
  border-color: #f0ad4e;
  background: #fff8e6;
  font-weight: 600;
}
.share-style-item > i { width: 1.1rem; text-align: center; }

.modal-enter-active, .modal-leave-active { transition: opacity 0.15s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
