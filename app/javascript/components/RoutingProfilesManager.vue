<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { profilesForSport } from '../brouter'
import type { Sport } from '../userPreferences'
import { specBase } from '../routingProfile'
import { customProfilesForSport, loadRoutingProfiles } from '../routingProfiles'
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
        <button type="button" class="btn btn-outline-secondary btn-sm" @click="open(p.spec, false)">
          <i class="fa-solid fa-sliders me-1" aria-hidden="true"></i>{{ t('profile.routing.edit') }}
        </button>
      </li>
    </ul>
    <p v-else class="text-muted small">{{ t('profile.routing.none') }}</p>

    <button type="button" class="btn btn-primary btn-sm" @click="open(newSpec, true)">
      <i class="fa-solid fa-plus me-1" aria-hidden="true"></i>{{ t('profile.routing.new') }}
    </button>

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
