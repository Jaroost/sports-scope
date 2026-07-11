<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { type PropType } from 'vue'
import { t } from '../i18n'
import { pickPhotoUrl, type PhotoLike } from '../activityHelpers'

const props = defineProps({
  photos: { type: Array as PropType<PhotoLike[]>, required: true },
  // v-model:lightbox-index — null = closed, integer = index of open photo.
  // Lives in the parent so the map's photo markers can also pop the lightbox.
  lightboxIndex: { type: Number, default: null },
  // v-model:collapsed — persisted by the parent (localStorage).
  collapsed: { type: Boolean, default: false },
  // Onglet photos actif ? Le composant reste monté hors onglet (pour que la
  // lightbox ouverte depuis la carte marche partout) ; seule la grille est
  // masquée quand `active` est faux.
  active: { type: Boolean, default: true },
})
const emit = defineEmits(['update:lightboxIndex', 'update:collapsed'])

const openIndex = computed({
  get: () => props.lightboxIndex,
  set: (v) => emit('update:lightboxIndex', v),
})

function toggleCollapsed() {
  emit('update:collapsed', !props.collapsed)
}

// Arrow keys + Esc for the lightbox. Bound globally because the lightbox is
// Teleport'd to <body> and the user expects the keyboard to work no matter
// where focus currently sits.
function onLightboxKey(ev) {
  if (openIndex.value === null) return
  if (ev.key === 'Escape') {
    openIndex.value = null
  } else if (ev.key === 'ArrowLeft' && openIndex.value > 0) {
    openIndex.value = openIndex.value - 1
  } else if (ev.key === 'ArrowRight' && openIndex.value < props.photos.length - 1) {
    openIndex.value = openIndex.value + 1
  }
}

onMounted(() => window.addEventListener('keydown', onLightboxKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onLightboxKey))
</script>

<template>
  <div v-if="active && photos.length > 0" class="card mt-3 mb-3 shadow-sm border-0">
    <div class="card-header activity-card-header d-flex align-items-center gap-2">
      <i class="fa-solid fa-images text-warning" aria-hidden="true"></i>
      <h3 class="h6 mb-0 flex-grow-1">{{ t('strava.photo_gallery') }} ({{ photos.length }})</h3>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
        :title="collapsed ? t('strava.layout.show_chart') : t('strava.layout.hide_chart')"
        :aria-pressed="collapsed"
        @click="toggleCollapsed"
      >
        <i :class="collapsed ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" aria-hidden="true"></i>
      </button>
    </div>
    <div v-if="!collapsed" class="card-body">
      <div class="photo-gallery">
        <button
          v-for="(photo, idx) in photos"
          :key="photo.unique_id || photo.id || idx"
          type="button"
          class="photo-thumb"
          :title="photo.caption || ''"
          @click="openIndex = idx"
        >
          <img :src="pickPhotoUrl(photo, 256)" :alt="photo.caption || ''" loading="lazy">
          <span v-if="photo.caption" class="photo-thumb-caption">{{ photo.caption }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Lightbox modal — Teleport'd to body to escape any overflow/z-index
       set by parent cards. -->
  <Teleport to="body">
    <div
      v-if="openIndex !== null && photos[openIndex]"
      class="photo-lightbox"
      @click.self="openIndex = null"
    >
      <button
        type="button"
        class="photo-lightbox-btn photo-lightbox-close"
        :title="t('strava.close')"
        :aria-label="t('strava.close')"
        @click="openIndex = null"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
      <button
        v-if="openIndex > 0"
        type="button"
        class="photo-lightbox-btn photo-lightbox-prev"
        :title="t('strava.previous')"
        :aria-label="t('strava.previous')"
        @click="openIndex = openIndex - 1"
      >
        <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
      </button>
      <button
        v-if="openIndex < photos.length - 1"
        type="button"
        class="photo-lightbox-btn photo-lightbox-next"
        :title="t('strava.next')"
        :aria-label="t('strava.next')"
        @click="openIndex = openIndex + 1"
      >
        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
      <img
        :src="pickPhotoUrl(photos[openIndex], 2048)"
        :alt="photos[openIndex].caption || ''"
        class="photo-lightbox-img"
      />
      <div v-if="photos[openIndex].caption" class="photo-lightbox-caption">
        {{ photos[openIndex].caption }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.photo-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.5rem;
}
.photo-thumb {
  position: relative;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  border-radius: 0.4rem;
  overflow: hidden;
  aspect-ratio: 4 / 3;
  box-shadow: 0 2px 6px -2px rgba(0, 0, 0, 0.2);
  transition: box-shadow 0.15s ease;
}
.photo-thumb:hover { box-shadow: 0 6px 14px -3px rgba(0, 0, 0, 0.35); }
.photo-thumb img {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
  transition: transform 0.15s ease;
}
.photo-thumb:hover img { transform: scale(1.04); }
.photo-thumb-caption {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 0.3rem 0.5rem;
  font-size: 0.72rem;
  color: #fff;
  background: linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.3) 70%, transparent 100%);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

<style>
/* Lightbox lives under Teleport to body — keep its styles global so they
   survive the move. */
.photo-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1080;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
.photo-lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.6);
}
.photo-lightbox-btn {
  position: absolute;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: 0;
  border-radius: 50%;
  width: 44px;
  height: 44px;
  font-size: 1.2rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease, transform 0.12s ease;
}
.photo-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.35);
  transform: scale(1.06);
}
.photo-lightbox-close { top: 1rem; right: 1rem; }
.photo-lightbox-prev  { left: 1rem;  top: 50%; transform: translateY(-50%); }
.photo-lightbox-next  { right: 1rem; top: 50%; transform: translateY(-50%); }
.photo-lightbox-prev:hover { transform: translateY(-50%) scale(1.06); }
.photo-lightbox-next:hover { transform: translateY(-50%) scale(1.06); }
.photo-lightbox-caption {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  max-width: 70vw;
  text-align: center;
  font-size: 0.9rem;
}
</style>
