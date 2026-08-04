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
// pose l'appelant (`previewScale`, `companionSettings.ts`), la même vignette
// servant dans une case de grille de 3,5 rem et dans la dialogue de choix.
//
// **Elle dessine toujours tout ce que le mode suppose.** Le mode choisi est un
// ordre et non un plafond : la légende des zones, l'unité, l'icône restent
// dessinées quelle que soit la case — c'est l'appelant qui réduit l'ensemble
// pour qu'il tienne (`--cbp-em`/`tileStyle`), pas ce composant qui retire un de
// ses éléments.
import { computed } from 'vue'
import {
  AVERAGES_SAMPLE,
  BUDGET_SAMPLE,
  blockShape,
  metricSample,
  type Block,
} from '../companionSettings'
import { zoneColor, acwrColor } from '../composables/useTrainingPlan'

const props = defineProps<{
  block: Block
}>()

// Ce que ce mode dessine : les branches sont calculées une fois, dans
// `companionSettings`, parce que la dialogue de choix s'en sert aussi.
const shape = computed(() => blockShape(props.block))

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
//
// Sept paliers en puissance, cinq en cardio : ce ne sont pas les mêmes listes,
// elles viennent du site, et c'est le nombre de lignes qui décide si la légende
// tient dans la case. Une vignette qui en dessinerait cinq des deux côtés
// promettrait une légende que le téléphone retirerait.
const ZONE_SHARES = [
  { key: 'z1', share: 0.08, time: '05:48' },
  { key: 'z2', share: 0.32, time: '23:12' },
  { key: 'z3', share: 0.34, time: '24:39' },
  { key: 'z4', share: 0.18, time: '13:03' },
  { key: 'z5', share: 0.08, time: '05:48' },
]

const POWER_SHARES = [
  { key: 'z1', share: 0.12, time: '08:42' },
  { key: 'z2', share: 0.29, time: '21:01' },
  { key: 'z3', share: 0.27, time: '19:34' },
  { key: 'z4', share: 0.16, time: '11:36' },
  { key: 'z5', share: 0.09, time: '06:31' },
  { key: 'z6', share: 0.05, time: '03:37' },
  { key: 'z7', share: 0.02, time: '01:27' },
]

const sample = computed(() => metricSample(props.block.metric))

// L'aplat de zone du mode `big` comme du mode `zone` : côté appli, `MetricView`
// peint le fond dès que la mesure porte une zone, quel que soit celui des deux.
// Les deux vignettes se ressemblent donc — et l'aperçu ne ment pas là-dessus.
const metricZone = computed(() => shape.value.metricZone)
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

const zoneShares = computed(() =>
  props.block.source === 'power' ? POWER_SHARES : ZONE_SHARES,
)

// Les quatre cartes, deux par deux — c'est la mise en page du dépôt voisin
// (`AveragesCard._row`).
const averagesRows = computed(() => [
  AVERAGES_SAMPLE.slice(0, 2),
  AVERAGES_SAMPLE.slice(2, 4),
])

// Deux véhicules, dont un dans le seuil de proximité. Leur position est une part
// de la portée, comme côté appli (`RadarView.positions`) : le plus proche est le
// plus avancé sur l'axe.
const RADAR_MARKS = [
  { at: 34, close: false },
  { at: 72, close: true },
]

// ── Budget de charge ────────────────────────────────────────────────────────
//
// Contrairement aux couleurs des zones d'intensité, celles de la fraîcheur (TSB) et
// du risque (ACWR) **viennent d'ici** : ce sont celles de la page Performances, et
// c'est le dépôt voisin qui les recopie. Le sens n'est pas inversé pour autant — le
// vert dit « c'est le bon endroit », l'orange « attention », le rouge « stop ».
const budgetWeek = computed(() => shape.value.budgetWeek)

// La barre du jour se mesure en TSS, de zéro au plafond de fatigue : c'est ce qui
// donne son sens à la zone grise (« le restant »). En mode semaine, l'échelle est
// le plus grand du prévu et de la cible — sinon un dépassement sortirait de la
// case sans qu'on le voie.
const budgetSegments = computed(() => {
  const { day, week } = BUDGET_SAMPLE
  if (budgetWeek.value) {
    const scale = Math.max(week.target, week.done + week.planned)
    return {
      scale,
      done: week.done,
      live: week.planned,
      liveColor: '#fd7e14',
      mark: week.target as number | null,
      cap: null as number | null,
    }
  }
  const total = day.done + day.ride
  const cap = day.max
  const scale = Math.max(cap, total, 1)
  return {
    scale,
    done: day.done,
    live: day.ride,
    // Toujours orange : c'est « une activité est en cours », pas un verdict sur
    // son ampleur — le dépassement se lit sur le curseur et le rouge.
    liveColor: '#fd7e14',
    mark: null as number | null,
    cap,
  }
})

const budgetDoneFraction = computed(() =>
  Math.min(budgetSegments.value.done / budgetSegments.value.scale, 1),
)
const budgetLiveFraction = computed(() =>
  Math.min(budgetSegments.value.live / budgetSegments.value.scale, 1 - budgetDoneFraction.value),
)
const budgetCapFraction = computed(() =>
  budgetSegments.value.cap != null
    ? Math.min(budgetSegments.value.cap / budgetSegments.value.scale, 1)
    : null,
)
const budgetMarkFraction = computed(() =>
  budgetSegments.value.mark != null
    ? Math.min(budgetSegments.value.mark / budgetSegments.value.scale, 1)
    : null,
)
// Au-delà du plafond, plus de zone grise : la queue de la barre passe au rouge,
// avec un curseur qui marque où était le plafond.
const budgetExceeded = computed(
  () =>
    budgetSegments.value.cap != null &&
    budgetSegments.value.done + budgetSegments.value.live > budgetSegments.value.cap,
)

const budgetFigure = computed(() => {
  const { day, week } = BUDGET_SAMPLE
  return budgetWeek.value
    ? `${week.done} / ${week.target}`
    : `${day.done + day.ride} / ${day.target}`
})

// Le second chiffre de la ligne : le plafond de fatigue du jour, ou ce qu'il reste à
// placer dans la semaine. Il tient sur la même ligne que le principal, à droite.
const budgetAside = computed(() =>
  budgetWeek.value ? `reste ${BUDGET_SAMPLE.week.remaining}` : `max ${BUDGET_SAMPLE.day.max}`,
)

const budgetTitle = computed(() => (budgetWeek.value ? 'La semaine' : 'Aujourd\'hui'))
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
      <div v-if="shape.metricGauge" class="cbp-card cbp-center">
        <div class="cbp-big cbp-big--gauge">{{ sample.value }}</div>
        <div class="cbp-gauge">
          <span
            v-for="(gaugeCell, i) in gaugeCells"
            :key="i"
            class="cbp-gauge-cell"
            :style="{ background: gaugeCell.lit ? gaugeCell.color : 'rgba(255,255,255,0.12)' }"
          ></span>
        </div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>

      <!-- Compact : icône, valeur, unité — la mise en forme de `MetricTile`.
           L'icône part avant l'unité : elle ne fait que redire ce que l'unité
           dit déjà. -->
      <div
        v-else-if="shape.metricCompact"
        class="cbp-card cbp-center"
        :style="{ background: metricBackground || undefined, color: metricInk }"
      >
        <i class="cbp-icon" :class="sample.icon" aria-hidden="true"></i>
        <div class="cbp-mid">{{ sample.value }}</div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>

      <!-- Aplat de zone : le même aplat que le plein cadre, mais l'icône de la
           mesure se pose devant le chiffre — cœur ou éclair, à même hauteur
           que lui et non au-dessus : cardio et puissance dessinent sinon
           exactement la même case. -->
      <div
        v-else-if="shape.metricZoneMode"
        class="cbp-card cbp-center"
        :style="{ background: metricBackground || undefined, color: metricInk }"
      >
        <div class="cbp-big cbp-big--zone">
          <i class="cbp-zone-icon" :class="sample.icon" aria-hidden="true"></i>
          <span>{{ sample.value }}</span>
        </div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>

      <!-- Plein cadre : le chiffre seul, sans icône. -->
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
      <div v-if="shape.zonesBar" class="cbp-bar">
        <span
          v-for="share in zoneShares"
          :key="share.key"
          :style="{ flex: share.share, background: ZONE_COLORS[share.key] }"
        ></span>
      </div>
      <!-- Toutes les zones sont listées, y compris celles à zéro : une zone
           absente se lirait comme une zone qui n'existe pas. -->
      <div v-if="shape.zonesLegend" class="cbp-legend">
        <div
          v-for="share in zoneShares"
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
      <div v-if="!shape.averagesCards" class="cbp-card">
        <div class="cbp-title">Moyennes</div>
        <div v-for="stat in AVERAGES_SAMPLE" :key="stat.name" class="cbp-line">
          {{ stat.name }} {{ stat.avg }} {{ stat.unit }} ({{ stat.min }} – {{ stat.max }})
        </div>
      </div>
      <div v-else class="cbp-stack">
        <div v-for="pair in averagesRows" :key="pair[0].name" class="cbp-row">
          <div v-for="stat in pair" :key="stat.name" class="cbp-card cbp-half">
            <div class="cbp-title">{{ stat.name }} ({{ stat.unit }})</div>
            <div class="cbp-stat"><span>Moyen</span><b>{{ stat.avg }}</b></div>
            <div class="cbp-stat"><span>Min</span><b>{{ stat.min }}</b></div>
            <div class="cbp-stat"><span>Max</span><b>{{ stat.max }}</b></div>
          </div>
        </div>
      </div>
    </template>

    <!-- Enregistrement --------------------------------------------------- -->
    <template v-else-if="block.kind === 'recording'">
      <!-- Compact : l'icône seule, pour une cellule de grille. -->
      <div v-if="shape.recordingCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact"><span class="cbp-rec-dot"></span></span>
      </div>
      <!-- Complet : le bouton large, à portée de pouce sur une route bosselée. -->
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button">
          <span class="cbp-rec-dot"></span>
          Démarrer l'enregistrement
        </span>
      </div>
    </template>

    <!-- Changer d'itinéraire ----------------------------------------------
         Même geste que « Choisir un autre itinéraire » dans le menu ⋮ de
         l'appli, posé directement sur une page plutôt que rangé dedans. -->
    <template v-else-if="block.kind === 'change_route'">
      <div v-if="shape.changeRouteCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
          Changer d'itinéraire
        </span>
      </div>
    </template>

    <!-- Retirer l'itinéraire ------------------------------------------------
         Retire le tracé suivi sans quitter la sortie ; la carte et la
         position restent. Même geste que « Retirer l'itinéraire » dans le
         menu ⋮. -->
    <template v-else-if="block.kind === 'clear_route'">
      <div v-if="shape.clearRouteCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact">
          <i class="fa-solid fa-eraser" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button">
          <i class="fa-solid fa-eraser" aria-hidden="true"></i>
          Retirer l'itinéraire
        </span>
      </div>
    </template>

    <!-- État de navigation ------------------------------------------------ -->
    <div v-else-if="block.kind === 'nav_state'" class="cbp-card">
      <div class="cbp-title">Navigation</div>
      <div class="cbp-line">21,4 km restants</div>
      <template v-if="shape.navFull">
        <div class="cbp-line">Restant : 21,4 km · 380 m D+</div>
        <div class="cbp-line">Virage proche à 120 m (droite)</div>
      </template>
    </div>

    <!-- Radar ------------------------------------------------------------- -->
    <template v-else-if="block.kind === 'radar'">
      <!-- La jauge de la gouttière, posée dans une cellule : mêmes positions et
           mêmes couleurs que sur les bords de la carte, à un quart de tour près
           en mode couché. La proximité va **vers le haut** debout, **vers la
           droite** couchée : c'est la rotation de la jauge du bord gauche
           (`RotatedBox(quarterTurns: 1)`, dépôt voisin), et les pointes suivent
           — vers la gauche debout, vers le haut couchée. -->
      <div v-if="shape.radarGauge" class="cbp-card cbp-center">
        <div class="cbp-radar-gauge"
             :class="shape.radarVertical ? 'cbp-radar-gauge--v' : 'cbp-radar-gauge--h'">
          <span class="cbp-radar-axis"></span>
          <span v-for="mark in RADAR_MARKS" :key="mark.at" class="cbp-radar-mark"
                :class="{ 'cbp-radar-mark--close': mark.close }"
                :style="shape.radarVertical ? { bottom: `${mark.at}%` } : { left: `${mark.at}%` }"></span>
        </div>
      </div>
      <div v-else class="cbp-card cbp-center">
        <!-- L'icône part la première dans une petite case : elle redit ce que la
             couleur dit déjà, alors que le nombre de mètres ne se déduit de
             rien. -->
        <div class="cbp-radar-head">
          <i class="fa-solid fa-car" aria-hidden="true"></i>
          <span class="cbp-radar-count">×2</span>
        </div>
        <div class="cbp-radar-distance">48 m</div>
      </div>
    </template>

    <!-- Budget de charge -------------------------------------------------- -->
    <div v-else-if="block.kind === 'training_budget'" class="cbp-card">
      <div class="cbp-title cbp-budget-title">
        <i
          v-if="!budgetWeek"
          class="fa-solid fa-weight-hanging cbp-budget-title-icon"
          aria-hidden="true"
        ></i>
        <span class="cbp-budget-title-text">{{ budgetTitle }}</span>
      </div>
      <div class="cbp-budget-figures">
        <span class="cbp-budget-figure">{{ budgetFigure }}</span>
        <span class="cbp-budget-aside">{{ budgetAside }}</span>
      </div>
      <!-- Trois zones en mode jour : le fait, la sortie en cours (orange), le
           restant avant le plafond (le fond de la barre sert déjà de zone
           grise). Le repère de la cible en mode semaine, ou le franchissement
           du plafond en mode jour, se lisent au même endroit — jamais les deux
           à la fois. -->
      <div class="cbp-budget-bar">
        <span
          class="cbp-budget-seg"
          :style="{ width: `${budgetDoneFraction * 100}%`, background: 'rgba(25,135,84,0.55)' }"
        ></span>
        <span
          class="cbp-budget-seg"
          :style="{ width: `${budgetLiveFraction * 100}%`, background: budgetSegments.liveColor }"
        ></span>
        <!-- Le dépassement du plafond : la queue de la barre repeinte en rouge,
             quelle que soit la couleur en dessous. -->
        <span
          v-if="budgetExceeded"
          class="cbp-budget-over"
          :style="{ left: `${budgetCapFraction! * 100}%` }"
        ></span>
        <span
          v-if="budgetMarkFraction !== null"
          class="cbp-budget-mark"
          :style="{ left: `${budgetMarkFraction * 100}%` }"
        ></span>
        <span
          v-if="budgetExceeded"
          class="cbp-budget-mark"
          :style="{ left: `${budgetCapFraction! * 100}%` }"
        ></span>
      </div>
      <div class="cbp-budget-context">
        <template v-if="budgetWeek">
          <span class="cbp-budget-chip">{{ BUDGET_SAMPLE.week.planned }} prévus</span>
        </template>
        <template v-else>
          <span class="cbp-budget-chip">
            <i class="fa-solid fa-battery-half" aria-hidden="true"></i>
            <span class="cbp-dot" :style="{ background: zoneColor(BUDGET_SAMPLE.form.zone) }"></span>
            {{ BUDGET_SAMPLE.form.tsb }}
          </span>
          <span class="cbp-budget-chip">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <span class="cbp-dot" :style="{ background: acwrColor(BUDGET_SAMPLE.risk.zone) }"></span>
            {{ BUDGET_SAMPLE.risk.acwr.toFixed(2).replace('.', ',') }}
          </span>
        </template>
      </div>
    </div>

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

/* Les deux colonnes d'une carte de moyennes : ce qu'on mesure à gauche, ce que
   ça vaut à droite. Le libellé cède la place le premier — c'est « Moyen » qu'on
   devine d'un mot tronqué, jamais un chiffre. */
.cbp-stat {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  font-size: 1.15em;
  margin-top: 0.3em;
}
.cbp-stat span {
  color: rgba(255, 255, 255, 0.7);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-stat b {
  font-weight: 400;
  white-space: nowrap;
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
/* L'icône devant le chiffre, à même ligne : c'est elle qui distingue la case
   cardio de la case puissance, deux aplats de zone identiques sinon. */
.cbp-big--zone {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.15em;
}
.cbp-zone-icon {
  font-size: 0.5em;
  opacity: 0.7;
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

/* Le vert-bleu du thème (`ColorScheme.fromSeed(Colors.teal)`) : commun à tous
   les boutons d'action du tableau de bord (enregistrement, itinéraire), pas
   seulement à l'enregistrement qui l'a introduit. */
.cbp-action-button {
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
.cbp-action-compact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6em;
  height: 2.6em;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.24);
  color: #fff;
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
/* La jauge dans une cellule.

   Aux proportions de la gouttière (72 × 144), couchées ou debout selon le mode :
   côté appli, c'est une boîte de ce format mise à l'échelle de la case
   (`BoxFit.contain`), pas un dessin qui s'étire. Une jauge étirée mettrait ses
   véhicules ailleurs qu'où ils seront.

   L'axe n'est pas centré : il reste à un peu plus du quart du bord, la part que
   prend `_axisInset` dans la largeur de la gouttière (19 sur 72) — c'est la
   vision périphérique qui lit cette jauge, et elle lit le bord de l'écran. */
.cbp-radar-gauge {
  position: relative;
}
.cbp-radar-gauge--h {
  width: 100%;
  aspect-ratio: 2 / 1;
  max-height: 100%;
}
.cbp-radar-gauge--v {
  height: 100%;
  aspect-ratio: 1 / 2;
  max-width: 100%;
}
.cbp-radar-axis {
  position: absolute;
  background: rgba(255, 255, 255, 0.13);
  border-radius: 0.1em;
}
.cbp-radar-gauge--h .cbp-radar-axis {
  left: 0;
  right: 0;
  top: 26%;
  height: 0.2em;
}
.cbp-radar-gauge--v .cbp-radar-axis {
  top: 0;
  bottom: 0;
  left: 26%;
  width: 0.2em;
}

/* Des pointes et non des ronds : une pointe est directionnelle, elle emmène le
   regard hors de l'écran — du côté où il faudra bien finir par regarder. */
.cbp-radar-mark {
  position: absolute;
  width: 0;
  height: 0;
  border: 0.45em solid transparent;
}
.cbp-radar-gauge--h .cbp-radar-mark {
  top: 26%;
  transform: translate(-50%, -50%);
  border-bottom-width: 0.7em;
  border-bottom-color: #ffa726;
  border-top-width: 0;
}
.cbp-radar-gauge--h .cbp-radar-mark--close {
  border-bottom-color: #ef5350;
}
.cbp-radar-gauge--v .cbp-radar-mark {
  left: 26%;
  transform: translate(-50%, 50%);
  border-right-width: 0.7em;
  border-right-color: #ffa726;
  border-left-width: 0;
}
.cbp-radar-gauge--v .cbp-radar-mark--close {
  border-right-color: #ef5350;
}

.cbp-empty {
  flex: 1;
  border: 1px dashed rgba(255, 255, 255, 0.25);
  border-radius: 1em;
}

/* Budget de charge : le chiffre, sa barre, son contexte. Le chiffre est plus gros
   qu'une ligne ordinaire sans aller au plein cadre — il en faut deux (le fait et la
   cible), et une barre en dessous. Même rapport que `budgetFigureHeight`.

   Les `margin-top` resserrés (0,15 / 0,2 / 0,22 em) recopient `_sectionGap` du
   dépôt voisin (`training_budget_block.dart`) : moins de hauteur empilée, c'est
   moins souvent la hauteur qui dicte l'échelle de `ScaleToFit` dans une case
   large et basse. */
.cbp-budget-title {
  display: flex;
  align-items: center;
  gap: 0.4em;
  white-space: normal;
}
.cbp-budget-title-icon {
  flex: none;
  opacity: 0.7;
  font-size: 0.9em;
}
.cbp-budget-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cbp-budget-figures {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  margin-top: 0.15em;
}
.cbp-budget-figure {
  font-size: 1.6em;
  line-height: 1.35;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.cbp-budget-aside {
  margin-left: auto;
  font-size: 0.9em;
  opacity: 0.6;
  white-space: nowrap;
}

.cbp-budget-bar {
  position: relative;
  display: flex;
  width: 95%;
  height: 0.8em;
  margin-top: 0.2em;
  border-radius: 0.4em;
  overflow: hidden;
  /* Sert de zone grise (« le restant ») en mode jour tant que le plafond n'est
     pas franchi : ce qui n'est ni fait ni en cours. */
  background: rgba(255, 255, 255, 0.12);
}
.cbp-budget-seg {
  height: 100%;
}
/* Le dépassement du plafond : la queue de la barre repeinte en rouge, quelle que
   soit la couleur en dessous — fait ou en cours. */
.cbp-budget-over {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  background: #dc3545;
}
/* Le repère — la cible en mode semaine, le plafond franchi en mode jour — posé
   PAR-DESSUS les segments : il doit se voir aussi bien quand on est encore loin
   que quand on l'a dépassé. */
.cbp-budget-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: #fff;
}

.cbp-budget-context {
  display: flex;
  gap: 0.5em;
  margin-top: 0.22em;
  font-size: 0.95em;
}
.cbp-budget-chip {
  display: flex;
  align-items: center;
  gap: 0.3em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.cbp-budget-chip i {
  opacity: 0.7;
}
</style>
