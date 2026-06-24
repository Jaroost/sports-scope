<script setup lang="ts">
import { t } from '../i18n'
import { usePlaceSearch } from '../composables/usePlaceSearch'
import type { PlaceResult } from '../composables/usePlaceSearch'

// Boîte de recherche de lieu pour la navigation (libre ou sur itinéraire). La
// recherche est filtrée par les pays du profil (usePlaceSearch) ; sélectionner un
// résultat ne fait qu'émettre `locate` — le parent recadre la carte (il détient
// l'instance MapLibre). Aucune navigation n'est déclenchée ici.

const emit = defineEmits<{ (e: 'locate', place: PlaceResult): void }>()

const { searchQuery, searchResults, searchOpen, searching, clearSearch } = usePlaceSearch()

function pick(p: PlaceResult) {
  searchOpen.value = false
  searchQuery.value = p.display_name.split(',')[0]
  emit('locate', p)
}
</script>

<template>
  <div class="nav-search">
    <div class="input-group input-group-sm shadow">
      <span class="input-group-text bg-white">
        <i v-if="searching" class="fa-solid fa-circle-notch fa-spin"></i>
        <i v-else class="fa-solid fa-magnifying-glass"></i>
      </span>
      <input
        v-model="searchQuery"
        type="search"
        class="form-control"
        :placeholder="t('routes.search_placeholder')"
        @focus="searchOpen = searchResults.length > 0"
        @keydown.enter.prevent="searchResults[0] && pick(searchResults[0])"
      />
      <button v-if="searchQuery" type="button" class="btn btn-light" @click="clearSearch" :title="t('routes.clear')">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <ul v-if="searchOpen" class="nav-search-results shadow">
      <li v-for="p in searchResults" :key="p.place_id" @click="pick(p)" class="nav-search-result">
        <i class="fa-solid fa-location-dot text-muted me-2"></i>
        <span>{{ p.display_name }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.nav-search { width: 100%; }
.nav-search-results {
  list-style: none;
  margin: 6px 0 0;
  padding: 0.25rem 0;
  background: #fff;
  border-radius: 0.4rem;
  max-height: 260px;
  overflow-y: auto;
  font-size: 0.85rem;
}
.nav-search-result {
  padding: 0.45rem 0.7rem;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 0.3rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
.nav-search-result:last-child { border-bottom: 0; }
.nav-search-result:hover { background: rgba(124, 58, 237, 0.08); }
</style>
