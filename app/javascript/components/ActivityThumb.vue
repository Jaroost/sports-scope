<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, type PropType } from 'vue'

type PhotoThumb = { id?: string; url: string; caption?: string }
type PreviewSegment = { d: string; c: number }

const props = defineProps({
  previewSegments: { type: Array as PropType<PreviewSegment[] | null>, default: null },
  // Vignettes photo servies par la liste (`photo_thumbs`) — null tant que le
  // backfill Strava n'est pas passé sur l'activité.
  photos: { type: Array as PropType<PhotoThumb[] | null>, default: null },
  // Classe FontAwesome du sport, affichée en pastille et en premier plan quand
  // l'activité n'a pas de tracé (indoor, GPS absent).
  iconClass: { type: String, required: true },
  label: { type: String, default: '' },
  // Rang dans la liste : décale le départ du défilement d'une ligne à l'autre,
  // pour que les vignettes ne basculent pas toutes en même temps.
  index: { type: Number, default: 0 },
})

// Durée d'affichage d'une vue avant de passer à la suivante. Assez long pour
// qu'on ait le temps de regarder sans que la liste clignote.
const FRAME_MS = 3200
const STAGGER_MS = 450

const hasTrack = computed(() => (props.previewSegments?.length ?? 0) > 0)
const photoList = computed(() => (props.photos ?? []).filter((p) => p?.url))
// Le tracé reste la première vue quand il existe : c'est ce qui identifie
// l'activité, la photo est un complément. Sans tracé (indoor, GPS absent), on
// n'affiche que les photos — le sport est déjà porté par la pastille d'angle.
const frameCount = computed(() => (hasTrack.value ? 1 : 0) + photoList.value.length)

const current = ref(0)
let timer: number | undefined
let startTimer: number | undefined

function tick() {
  // On ne fait pas défiler un onglet caché : inutile, et le navigateur regroupe
  // les timers, ce qui produirait un saut de plusieurs vues au retour.
  if (!document.hidden) current.value = (current.value + 1) % frameCount.value
}

onMounted(() => {
  if (frameCount.value < 2) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

  startTimer = window.setTimeout(() => {
    timer = window.setInterval(tick, FRAME_MS)
  }, (props.index % 6) * STAGGER_MS)
})

onBeforeUnmount(() => {
  if (startTimer) window.clearTimeout(startTimer)
  if (timer) window.clearInterval(timer)
})

// Couleur d'un segment selon la catégorie de pente calculée côté serveur :
// 1 = montée (rouge), 2 = descente (bleu), 0 = plat (gris neutre).
function gradeColor(cat: number) {
  if (cat === 1) return '#e0503f'
  if (cat === 2) return '#2f8fed'
  return '#9aa0a6'
}
</script>

<template>
  <span class="activity-thumb" :title="label">
    <span v-if="hasTrack" class="activity-thumb__frame" :class="{ 'is-active': current === 0 }">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <path
          v-for="(s, i) in previewSegments"
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

    <span
      v-for="(photo, i) in photoList"
      :key="photo.id || photo.url"
      class="activity-thumb__frame"
      :class="{ 'is-active': current === i + (hasTrack ? 1 : 0) }"
    >
      <img :src="photo.url" :alt="photo.caption || ''" loading="lazy" decoding="async">
    </span>

    <!-- Indicateurs : purement décoratifs (pas de clic — la vignette est dans un
         lien vers l'activité, et les cibles seraient minuscules). -->
    <span v-if="frameCount > 1" class="activity-thumb__dots" aria-hidden="true">
      <span v-for="i in frameCount" :key="i" :class="{ 'is-active': current === i - 1 }"></span>
    </span>

    <span class="activity-thumb__badge">
      <i :class="`fa-solid ${iconClass}`" aria-hidden="true"></i>
    </span>
  </span>
</template>

<style scoped>
/* Vignette du tracé : même encombrement que le badge d'activité, coin arrondi.
   Fond sombre, comme l'aperçu de la page de partage : les couleurs de pente du
   tracé ressortaient à peine sur le gris clair. */
.activity-thumb {
  position: relative;
  flex-shrink: 0;
  /* 3,25 rem : au-dessus du gabarit de la liste des itinéraires (2,75 rem), pour
     que les photos du carousel se lisent vraiment. */
  width: 3.25rem;
  height: 3.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  background:
    radial-gradient(120% 100% at 30% 15%, #5c666f 0%, #4a545c 60%, #3d464d 100%);
}

/* Les vues (tracé puis photos) sont empilées et se croisent en fondu : pas de
   décalage de mise en page quand la vignette change d'image. */
.activity-thumb__frame {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: inherit;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.5s ease;
}
.activity-thumb__frame.is-active {
  opacity: 1;
}
.activity-thumb__frame svg {
  width: 100%;
  height: 100%;
}
.activity-thumb__frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* Points indicateurs posés sur le bas de la vignette, avec un léger voile pour
   rester lisibles aussi bien sur une photo claire que sur le fond sombre. */
.activity-thumb__dots {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 2px 0;
  border-radius: 0 0 0.5rem 0.5rem;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.45), transparent);
}
.activity-thumb__dots > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.45);
  transition: background-color 0.3s ease;
}
.activity-thumb__dots > span.is-active {
  background: var(--bs-warning, #ffc107);
}

/* Pastille d'icône du type d'activité, superposée en bas à droite : conserve
   l'identification du sport quand la vignette montre une photo. */
.activity-thumb__badge {
  position: absolute;
  right: -0.25rem;
  bottom: -0.25rem;
  z-index: 2;
  width: 1.25rem;
  height: 1.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #3d464d;
  color: var(--bs-warning, #ffc107);
  font-size: 0.65rem;
  border: 1.5px solid var(--bs-body-bg, #fff);
}
</style>
