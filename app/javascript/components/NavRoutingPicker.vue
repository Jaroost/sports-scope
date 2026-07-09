<script setup lang="ts">
import { t } from '../i18n'
import { profilesForSport } from '../brouter'
import { routeProfileForSport } from '../userPreferences'
import type { Sport } from '../userPreferences'

// Choix de la catégorie d'activité et du profil de routage BRouter, partagé par les trois
// endroits où l'on règle un calcul d'itinéraire en navigation : le panneau de destination
// (« naviguer vers un lieu »), le tiroir de commandes et le bandeau hors-trace.
//
// Les profils sont filtrés par sport, donc changer de sport peut invalider le profil
// courant : le composant réaligne alors lui-même le profil sur le défaut du nouveau sport
// et émet le couple complet. Le parent n'a qu'un seul point d'entrée (`change`) et décide
// quoi recalculer derrière.
const props = defineProps<{
  sport: Sport
  profile: string
  disabled?: boolean
}>()

const emit = defineEmits<{ change: [payload: { sport: Sport; profile: string }] }>()

const SPORTS: Sport[] = ['cycling', 'mtb', 'hiking']

function sportIcon(s: Sport) {
  return s === 'hiking' ? 'fa-person-hiking' : s === 'mtb' ? 'fa-mountain' : 'fa-bicycle'
}

function selectSport(s: Sport) {
  if (s === props.sport) return
  emit('change', { sport: s, profile: routeProfileForSport(s) })
}

function selectProfile(p: string) {
  if (p === props.profile) return
  emit('change', { sport: props.sport, profile: p })
}
</script>

<template>
  <div class="nav-routing-picker">
    <div class="nav-routing-sports" role="group" :aria-label="t('routes.wt_sport')">
      <button
        v-for="s in SPORTS"
        :key="s"
        type="button"
        class="btn btn-sm"
        :class="sport === s ? 'btn-primary' : 'btn-outline-secondary'"
        :disabled="disabled"
        :aria-pressed="sport === s"
        :title="t(`routes.wt_sport_${s}`)"
        @click="selectSport(s)"
      >
        <i :class="`fa-solid ${sportIcon(s)}`" aria-hidden="true"></i>
        <span class="ms-1">{{ t(`routes.wt_sport_${s}`) }}</span>
      </button>
    </div>
    <select
      class="form-select form-select-sm nav-routing-profile"
      :value="profile"
      :disabled="disabled"
      :aria-label="t('routes.profile_label')"
      :title="t(`routes.brouter_profile.${profile}_desc`)"
      @change="selectProfile(($event.target as HTMLSelectElement).value)"
    >
      <option
        v-for="p in profilesForSport(sport)"
        :key="p"
        :value="p"
        :title="t(`routes.brouter_profile.${p}_desc`)"
      >
        {{ t(`routes.brouter_profile.${p}`) }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.nav-routing-picker { display: flex; flex-direction: column; gap: 0.4rem; }
.nav-routing-sports { display: flex; gap: 0.25rem; }
.nav-routing-sports .btn { flex: 1; white-space: nowrap; }
.nav-routing-profile { font-weight: 500; }
</style>
