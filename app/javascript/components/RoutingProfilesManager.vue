<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { profilesForSport } from '../brouter'
import type { Sport } from '../userPreferences'
import { specBase } from '../routingProfile'
import { customProfilesForSport, loadRoutingProfiles, saveRoutingProfile } from '../routingProfiles'
import type { CustomRoutingProfile } from '../routingProfiles'
import RoutingProfileEditor from './RoutingProfileEditor.vue'

// Gestion des profils de routage personnalisés du sport choisi (onglet « Routage » du
// profil) : liste des profils enregistrés, création et réglage via l'éditeur modal.
const props = defineProps<{ sport: Sport }>()

onMounted(loadRoutingProfiles)

const profiles = computed(() => customProfilesForSport(props.sport))
const editorOpen = ref(false)
const editorNew = ref(false)
const editorSpec = ref('')

function open(spec: string, createNew: boolean) {
  editorSpec.value = spec
  editorNew.value = createNew
  editorOpen.value = true
}

// ── Export / import ─────────────────────────────────────────────────────────
// Fichier JSON `{ format, version, name, sport, spec }`. Le spec est tout ce qui compte : à
// l'import le serveur le revalide (profil de base, variables, valeurs) comme à n'importe
// quel enregistrement, un fichier modifié à la main ne passe donc jamais outre le catalogue.
const FORMAT = 'sports-scope-routing-profile'
const fileInput = ref<HTMLInputElement | null>(null)
const message = ref<{ kind: 'success' | 'danger'; text: string } | null>(null)
const busy = ref(false)

function exportProfile(p: CustomRoutingProfile) {
  const body = JSON.stringify({ format: FORMAT, version: 1, name: p.name, sport: p.sport, spec: p.spec }, null, 2)
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${p.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'profil'}.routing-profile.json`
  a.click()
  URL.revokeObjectURL(url)
}

// Nom libre pour ce sport (le serveur impose l'unicité par compte) : « Nom (2) », …
function freeName(base: string): string {
  const taken = new Set(customProfilesForSport(props.sport).map((p) => p.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 60 - String(i).length - 3)} (${i})`
    if (!taken.has(candidate)) return candidate
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  message.value = null
  busy.value = true
  try {
    if (file.size > 20_000) throw new Error('size')
    const data = JSON.parse(await file.text())
    if (data?.format !== FORMAT || typeof data.spec !== 'string') throw new Error('format')
    const name = freeName(String(data.name ?? '').trim().slice(0, 60) || t('profile.routing.imported_default'))
    const saved = await saveRoutingProfile(null, { name, spec: data.spec, sport: props.sport })
    message.value = { kind: 'success', text: t('profile.routing.import_ok', { name: saved.name }) }
  } catch (err: any) {
    const known = err?.message === 'size' || err?.message === 'format' || err instanceof SyntaxError
    message.value = { kind: 'danger', text: known ? t('profile.routing.import_invalid') : t('profile.routing.import_failed') }
  } finally {
    busy.value = false
  }
}

// Un nouveau profil part du premier profil proposé pour le sport.
const newSpec = computed(() => profilesForSport(props.sport)[0])
</script>

<template>
  <div>
    <p class="text-muted small">{{ t('profile.routing.help') }}</p>

    <ul v-if="profiles.length" class="list-group mb-3">
      <li v-for="p in profiles" :key="p.id" class="list-group-item d-flex align-items-center gap-2">
        <div class="flex-grow-1 min-w-0">
          <div class="fw-semibold text-truncate">{{ p.name }}</div>
          <div class="text-muted small text-truncate">{{ t(`routes.brouter_profile.${specBase(p.spec)}`) }}</div>
        </div>
        <button type="button" class="btn btn-outline-secondary btn-sm" :title="t('profile.routing.export')" :aria-label="t('profile.routing.export')" @click="exportProfile(p)">
          <i class="fa-solid fa-file-export" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-outline-secondary btn-sm" @click="open(p.spec, false)">
          <i class="fa-solid fa-sliders me-1" aria-hidden="true"></i>{{ t('profile.routing.edit') }}
        </button>
      </li>
    </ul>
    <p v-else class="text-muted small">{{ t('profile.routing.none') }}</p>

    <div class="d-flex flex-wrap gap-2">
      <button type="button" class="btn btn-primary btn-sm" @click="open(newSpec, true)">
        <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('profile.routing.new') }}
      </button>
      <button type="button" class="btn btn-outline-secondary btn-sm" :disabled="busy" @click="fileInput?.click()">
        <i class="fa-solid fa-file-import me-1" aria-hidden="true"></i>{{ t('profile.routing.import') }}
      </button>
      <input ref="fileInput" type="file" accept=".json,application/json" class="d-none" @change="onFile" />
    </div>
    <p v-if="message" :class="`small mt-2 mb-0 text-${message.kind}`" role="status">{{ message.text }}</p>

    <RoutingProfileEditor
      :show="editorOpen"
      :sport="sport"
      :spec="editorSpec"
      :create-new="editorNew"
      hide-apply
      @close="editorOpen = false"
    />
  </div>
</template>
