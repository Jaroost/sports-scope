<script setup lang="ts">
// L'aperçu d'un composant du tableau de bord : ce que le téléphone en dessinera.
//
// **Pourquoi une représentation plutôt qu'un libellé** : le mode n'est pas une
// décoration, c'est ce qui décide du dessin — « Chiffre plein cadre », « Jauge »
// et « Aplat de zone » nomment trois choses qu'on ne peut pas se figurer sans
// les voir. On composait donc son tableau de bord en aveugle, et on découvrait
// le résultat au départ d'une sortie, sur un écran qu'on ne peut plus modifier.
//
// C'est un **fac-similé**, pas un rendu partagé : le tableau de bord est écrit
// en Flutter dans le dépôt voisin (`lib/ride/blocks/`), il n'y a rien à
// réutiliser ici. Ce qui est donc copié à la main, et qui doit le rester :
// le fond des cartes (#1F2226, `BlockCard.background`), la palette des zones
// (`ui/zone_colors.dart`), les couleurs radar et les libellés en dur des blocs.
// Les chiffres, eux, sont plausibles et faux — un aperçu n'a pas de capteur.
//
// Tout est en `em` : le composant se met à l'échelle par la `font-size` que lui
// pose l'appelant, la même vignette servant dans une case de grille de 3,5 rem
// et dans la dialogue de choix.
import { computed } from 'vue'
import { metricSample, type Block } from '../companionSettings'

const props = defineProps<{ block: Block }>()

// La palette de `ui/zone_colors.dart` — saturée et non teintée, c'est ce qui la
// rend lisible en plein soleil sur le fond sombre.
const ZONE_COLORS: Record<string, string> = {
  z1: '#2E6FD6',
  z2: '#2E9E4F',
  z3: '#E0C000',
  z4: '#E8760C',
  z5: '#D32F2F',
  z6: '#8E24AA',
  z7: '#5E35B1',
}

// Même règle que `foregroundOf` : le blanc disparaît sur le jaune de Z3, et
// c'est justement la zone qu'on surveille.
const DARK_INK = new Set(['z3', 'z4'])

// Le temps par zone d'une sortie ordinaire. Les parts sont arrondies pour que la
// barre et la légende racontent la même chose.
const ZONE_SHARES = [
  { key: 'z1', share: 0.08, time: '05:48' },
  { key: 'z2', share: 0.32, time: '23:12' },
  { key: 'z3', share: 0.34, time: '24:39' },
  { key: 'z4', share: 0.18, time: '13:03' },
  { key: 'z5', share: 0.08, time: '05:48' },
]

const sample = computed(() => metricSample(props.block.metric))

// L'aplat de zone du mode `big` comme du mode `zone` : côté appli, `MetricView`
// peint le fond dès que la mesure porte une zone, quel que soit celui des deux.
// Les deux vignettes se ressemblent donc — et l'aperçu ne ment pas là-dessus.
const metricZone = computed(() => sample.value.zone)
const metricBackground = computed(() =>
  metricZone.value ? ZONE_COLORS[metricZone.value] : null,
)
const metricInk = computed(() =>
  metricZone.value && DARK_INK.has(metricZone.value) ? '#000' : '#fff',
)

// La jauge : une case par zone jusqu'à celle du moment, les suivantes éteintes.
// Des paliers et pas un remplissage continu — un dégradé laisserait croire à une
// progression linéaire que les zones n'ont pas.
const gaugeCells = computed(() => {
  const index = metricZone.value ? Number(metricZone.value.slice(1)) - 1 : -1
  return [0, 1, 2, 3, 4].map((i) => ({
    lit: i <= index,
    color: ZONE_COLORS[`z${i + 1}`],
  }))
})

const zonesTitle = computed(() =>
  props.block.source === 'power' ? 'Temps par zone de puissance' : 'Temps par zone cardio',
)

// L'icône de la ligne courante : cœur ou éclair. Les deux cartes se ressemblent
// trait pour trait, c'est elle — autant que le titre — qui les distingue.
const zonesIcon = computed(() =>
  props.block.source === 'power' ? 'fa-solid fa-bolt' : 'fa-solid fa-heart',
)

// La zone du moment, dont la ligne passe sur l'aplat de sa couleur.
const CURRENT_ZONE = 'z3'
</script>

<template>
  <div class="cbp">
    <!-- Une mesure ------------------------------------------------------- -->
    <template v-if="block.kind === 'metric'">
      <!-- Jauge : le chiffre, les paliers, l'unité. **Seulement pour une mesure
           qui a des zones** — la plage d'une jauge, ce sont elles, et sans elles
           l'appli retombe sur le chiffre plein cadre plutôt que d'inventer un
           maximum. Une vignette qui montrerait des paliers sur la cadence
           promettrait un dessin que le téléphone ne fera jamais. -->
      <div v-if="block.mode === 'gauge' && metricZone" class="cbp-card cbp-center">
        <div class="cbp-big cbp-big--gauge">{{ sample.value }}</div>
        <div class="cbp-gauge">
          <span
            v-for="(cell, i) in gaugeCells"
            :key="i"
            class="cbp-gauge-cell"
            :style="{ background: cell.lit ? cell.color : 'rgba(255,255,255,0.12)' }"
          ></span>
        </div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>

      <!-- Compact : icône, valeur, unité — la mise en forme de `MetricTile`. -->
      <div
        v-else-if="block.mode === 'compact'"
        class="cbp-card cbp-center"
        :style="{ background: metricBackground || undefined, color: metricInk }"
      >
        <i class="cbp-icon" :class="sample.icon" aria-hidden="true"></i>
        <div class="cbp-mid">{{ sample.value }}</div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>

      <!-- Plein cadre, et aplat de zone : le même dessin côté appli. -->
      <div
        v-else
        class="cbp-card cbp-center"
        :style="{ background: metricBackground || undefined, color: metricInk }"
      >
        <div class="cbp-big">{{ sample.value }}</div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>
    </template>

    <!-- Temps par zone --------------------------------------------------- -->
    <div v-else-if="block.kind === 'zones'" class="cbp-card">
      <div class="cbp-title">{{ zonesTitle }}</div>
      <div v-if="block.mode !== 'legend'" class="cbp-bar">
        <span
          v-for="share in ZONE_SHARES"
          :key="share.key"
          :style="{ flex: share.share, background: ZONE_COLORS[share.key] }"
        ></span>
      </div>
      <!-- Toutes les zones sont listées, y compris celles à zéro : une zone
           absente se lirait comme une zone qui n'existe pas. -->
      <div v-if="block.mode !== 'bar_only'" class="cbp-legend">
        <div
          v-for="share in ZONE_SHARES"
          :key="share.key"
          class="cbp-legend-row"
          :class="{ 'cbp-legend-row--current': share.key === CURRENT_ZONE }"
          :style="share.key === CURRENT_ZONE
            ? { background: ZONE_COLORS[share.key], color: DARK_INK.has(share.key) ? '#000' : '#fff' }
            : undefined"
        >
          <i
            v-if="share.key === CURRENT_ZONE"
            class="cbp-legend-icon"
            :class="zonesIcon"
            aria-hidden="true"
          ></i>
          <span v-else class="cbp-dot" :style="{ background: ZONE_COLORS[share.key] }"></span>
          <span class="cbp-legend-key">{{ share.key.toUpperCase() }}</span>
          <span class="cbp-legend-time">{{ share.time }}</span>
          <span class="cbp-legend-share">{{ Math.round(share.share * 100) }} %</span>
        </div>
      </div>
    </div>

    <!-- Moyennes --------------------------------------------------------- -->
    <template v-else-if="block.kind === 'averages'">
      <div v-if="block.mode === 'list'" class="cbp-card">
        <div class="cbp-title">Moyennes</div>
        <div class="cbp-line">141 bpm moyen</div>
        <div class="cbp-line">212 W moyen</div>
        <div class="cbp-line">Cadence 84 tr/min moyenne</div>
      </div>
      <div v-else class="cbp-stack">
        <div class="cbp-row">
          <div class="cbp-card cbp-half">
            <div class="cbp-title">Cardio</div>
            <div class="cbp-line">141 bpm moyen</div>
            <div class="cbp-line">Max 178 bpm</div>
          </div>
          <div class="cbp-card cbp-half">
            <div class="cbp-title">Puissance</div>
            <div class="cbp-line">212 W moyen</div>
            <div class="cbp-line">Normalisée 236 W</div>
          </div>
        </div>
        <div class="cbp-card">
          <div class="cbp-title">Sortie</div>
          <div class="cbp-line">Dénivelé positif 640 m</div>
        </div>
      </div>
    </template>

    <!-- Enregistrement --------------------------------------------------- -->
    <template v-else-if="block.kind === 'recording'">
      <!-- Compact : l'icône seule, pour une cellule de grille. -->
      <div v-if="block.mode === 'compact'" class="cbp-card cbp-center">
        <span class="cbp-rec-compact"><span class="cbp-rec-dot"></span></span>
      </div>
      <!-- Complet : le bouton large, à portée de pouce sur une route bosselée. -->
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-rec-button">
          <span class="cbp-rec-dot"></span>
          Démarrer l'enregistrement
        </span>
      </div>
    </template>

    <!-- État de navigation ------------------------------------------------ -->
    <div v-else-if="block.kind === 'nav_state'" class="cbp-card">
      <div class="cbp-title">Navigation</div>
      <div class="cbp-line">21,4 km restants</div>
      <template v-if="block.mode !== 'compact'">
        <div class="cbp-line">Restant : 21,4 km · 380 m D+</div>
        <div class="cbp-line">Virage proche à 120 m (droite)</div>
      </template>
    </div>

    <!-- Radar ------------------------------------------------------------- -->
    <template v-else-if="block.kind === 'radar'">
      <!-- La jauge de la gouttière, couchée : mêmes positions, mêmes couleurs
           que sur les bords de la carte. -->
      <div v-if="block.mode === 'gauge'" class="cbp-card cbp-center">
        <div class="cbp-radar-track">
          <span class="cbp-radar-mark" style="left: 34%"></span>
          <span class="cbp-radar-mark cbp-radar-mark--close" style="left: 72%"></span>
        </div>
      </div>
      <div v-else class="cbp-card cbp-center">
        <div class="cbp-radar-head">
          <i class="fa-solid fa-car" aria-hidden="true"></i>
          <span class="cbp-radar-count">×2</span>
        </div>
        <div class="cbp-radar-distance">48 m</div>
      </div>
    </template>

    <!-- Case vide : un choix de composition, et il se voit comme tel. ------ -->
    <div v-else class="cbp-empty"></div>
  </div>
</template>

<style scoped>
/* Le fond de la sortie est noir (`RideShellPage`), les cartes s'y détachent en
   #1F2226 : c'est ce contraste-là qu'on vient juger, pas celui de la page web
   de l'éditeur. */
.cbp {
  background: #000;
  border-radius: 0.5em;
  padding: 0.5em;
  height: 100%;
  overflow: hidden;
  font-size: 0.75rem;
  line-height: 1.2;
  color: #fff;
  display: flex;
  flex-direction: column;
}

.cbp-card {
  background: #1f2226;
  border-radius: 1em;
  padding: 0.8em;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Le bouton d'enregistrement n'est pas dans une carte : il flotte sur le fond
   de la page, comme dans l'appli. */
.cbp-plain {
  flex: 1;
  min-height: 0;
}

.cbp-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.cbp-stack {
  display: flex;
  flex-direction: column;
  gap: 0.7em;
  flex: 1;
  min-height: 0;
}
.cbp-row {
  display: flex;
  gap: 0.7em;
}
.cbp-half {
  flex: 1;
  min-width: 0;
}

.cbp-title {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.95em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-line {
  font-size: 1.15em;
  margin-top: 0.3em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Le chiffre aussi grand que la case le permet — c'est ce qu'on lit à 30 km/h
   sans quitter la route des yeux. */
.cbp-big {
  font-size: 3.4em;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.cbp-big--gauge {
  font-size: 2.6em;
}
.cbp-mid {
  font-size: 1.9em;
  line-height: 1.1;
  white-space: nowrap;
}
.cbp-unit {
  font-size: 0.9em;
  opacity: 0.6;
  margin-top: 0.2em;
  white-space: nowrap;
}
.cbp-icon {
  font-size: 1.2em;
  opacity: 0.7;
  margin-bottom: 0.3em;
}

.cbp-gauge {
  display: flex;
  gap: 0.15em;
  width: 100%;
  margin: 0.6em 0 0.35em;
}
.cbp-gauge-cell {
  flex: 1;
  height: 0.6em;
  border-radius: 0.15em;
}

/* Une barre unique et non cinq jauges : ce qu'on lit est une proportion, et une
   proportion se lit dans une longueur partagée. */
.cbp-bar {
  display: flex;
  height: 1.6em;
  border-radius: 0.3em;
  overflow: hidden;
  margin-top: 0.8em;
}

.cbp-legend {
  margin-top: 0.8em;
}
.cbp-legend-row {
  display: flex;
  align-items: center;
  gap: 0.6em;
  padding: 0.25em 0.6em;
  border-radius: 0.5em;
  font-size: 1.05em;
}
.cbp-legend-icon,
.cbp-dot {
  width: 0.9em;
  height: 0.9em;
  flex: none;
  font-size: 0.9em;
}
.cbp-dot {
  border-radius: 0.2em;
}
.cbp-legend-key {
  font-weight: 600;
}
.cbp-legend-time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.cbp-legend-share {
  width: 3em;
  text-align: right;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

/* Le vert-bleu du thème (`ColorScheme.fromSeed(Colors.teal)`), et la pastille
   rouge de l'enregistrement. */
.cbp-rec-button {
  display: inline-flex;
  align-items: center;
  gap: 0.5em;
  background: #006a60;
  color: #fff;
  border-radius: 1.4em;
  padding: 0.6em 0.9em;
  font-size: 0.95em;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
}
.cbp-rec-compact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6em;
  height: 2.6em;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.24);
}
.cbp-rec-dot {
  width: 0.9em;
  height: 0.9em;
  border-radius: 50%;
  background: #f44336;
  flex: none;
}

.cbp-radar-head {
  display: flex;
  align-items: center;
  gap: 0.2em;
  color: #ffa726;
  font-size: 1.1em;
}
.cbp-radar-count {
  font-size: 0.9em;
}
.cbp-radar-distance {
  color: #ffa726;
  font-size: 2.6em;
  font-weight: 700;
  line-height: 1.1;
}
.cbp-radar-track {
  position: relative;
  width: 100%;
  height: 1em;
  border-radius: 0.5em;
  background: rgba(255, 255, 255, 0.13);
}
/* Des pointes et non des ronds : une pointe est directionnelle, elle emmène le
   regard hors de l'écran — du côté où il faudra bien finir par regarder. */
.cbp-radar-mark {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 0;
  height: 0;
  border-top: 0.45em solid transparent;
  border-bottom: 0.45em solid transparent;
  border-left: 0.7em solid #ffa726;
}
.cbp-radar-mark--close {
  border-left-color: #ef5350;
}

.cbp-empty {
  flex: 1;
  border: 1px dashed rgba(255, 255, 255, 0.25);
  border-radius: 1em;
}
</style>
