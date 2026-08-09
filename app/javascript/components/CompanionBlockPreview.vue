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
  CLIMB_LIST_SAMPLE,
  DYNAMIC_GAUGE_PREVIEW_FRACTION,
  LAP_SUMMARY_SAMPLE,
  RANGE_GAUGE_COLOR,
  RANGE_GAUGE_SEGMENTS,
  blockShape,
  metricSample,
  type Block,
} from '../companionSettings'
import { colorForGrade } from '../routeHelpers'
import { textColorOn } from '../navHelpers'
import { zoneColor, acwrColor } from '../composables/useTrainingPlan'

const props = defineProps<{
  block: Block
}>()

// Le fond et le texte réglés dans l'éditeur : valent pour n'importe quel
// genre de composant, contrairement aux couleurs de zone ou de pente
// ci-dessous qui restent des données et ne s'en trouvent jamais remplacées.
// `overrideInk` retombe sur un texte calculé pour rester lisible sur le fond
// choisi (`textColorOn`, même règle que `foregroundOf` côté appli) quand
// seul le fond a été réglé — jamais sur du blanc fixe qui disparaîtrait sur
// un fond clair.
const overrideBg = computed(() => props.block.color || null)
const overrideInk = computed(
  () => props.block.text_color || (overrideBg.value ? textColorOn(overrideBg.value) : null),
)
const overrideStyle = computed(() => ({
  background: overrideBg.value || undefined,
  color: overrideInk.value || undefined,
}))

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

const sample = computed(() => metricSample(props.block.metric, props.block.format))

// L'aplat de zone du mode `big` comme du mode `zone` : côté appli, `MetricView`
// peint le fond dès que la mesure porte une zone, quel que soit celui des deux.
// Les deux vignettes se ressemblent donc — et l'aperçu ne ment pas là-dessus.
const metricZone = computed(() => shape.value.metricZone)

// La pente, sur sa couleur de tranche de difficulté plutôt que sur une zone
// d'entraînement (`MetricSample.background`, mutuellement exclusif avec
// `metricZone` — même règle que `MetricReading.background` côté appli).
const metricBackground = computed(
  () => overrideBg.value || sample.value.background
    || (metricZone.value ? ZONE_COLORS[metricZone.value] : null),
)
const metricInk = computed(() => {
  if (overrideInk.value) return overrideInk.value
  if (sample.value.background) return textColorOn(sample.value.background)
  return metricZone.value && DARK_INK.has(metricZone.value) ? '#000' : '#fff'
})

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

// La jauge à plage libre : même dessin par paliers que la jauge de zones,
// mais répartis également entre `block.min` et `block.max` plutôt que sur des
// seuils réels — d'où une seule couleur au lieu d'une par palier. `null` sur
// l'un des trois (mesure sans échantillon numérique, min/max pas encore
// réglés) éteint tous les paliers plutôt que de deviner une position.
const rangeGaugeCells = computed(() => {
  const { min, max } = props.block
  const value = sample.value.numeric
  const fraction = value != null && min != null && max != null && max > min
    ? Math.min(Math.max((value - min) / (max - min), 0), 1)
    : null
  const lit = fraction == null ? -1 : Math.round(fraction * RANGE_GAUGE_SEGMENTS)
  return Array.from({ length: RANGE_GAUGE_SEGMENTS }, (_, i) => ({ lit: i < lit }))
})

// Le curseur de la jauge dynamique : une position fixe et illustrative
// (`DYNAMIC_GAUGE_PREVIEW_FRACTION`), l'éditeur n'ayant pas de sortie en
// cours pour en tirer une vraie plage.
const dynamicGaugeFraction = computed(() => DYNAMIC_GAUGE_PREVIEW_FRACTION[props.block.metric || ''] ?? 0.5)

// « Ce tour — » en préfixe côté `lap_zones`/`lap_averages` : même dessin que
// `zones`/`averages`, seul ce qu'on mesure change — depuis l'ouverture du
// tour choisi, pas depuis le départ de la sortie.
const lapScope = computed(() => (props.block.kind.startsWith('lap_') ? 'Ce tour — ' : ''))

const zonesTitle = computed(() =>
  lapScope.value + (props.block.source === 'power' ? 'Temps par zone de puissance' : 'Temps par zone cardio'),
)

const averagesTitle = computed(() => `${lapScope.value}Moyennes`)

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

// ── Cols du tracé ────────────────────────────────────────────────────────────
//
// Compact ne montre qu'une ligne, celle qui compte le plus — le col en cours,
// même échantillon que le mode complet — exactement ce que dessine l'appli
// (`ClimbListCard._compact`, dépôt voisin).
const climbListCurrent = computed(() => CLIMB_LIST_SAMPLE.find((c) => c.status === 'current'))
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
      <div v-if="shape.metricGauge" class="cbp-card cbp-center" :style="overrideStyle">
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

      <!-- Jauge à plage libre : le pendant de la jauge ci-dessus pour une
           mesure sans zones d'entraînement, sur un min/max réglé dans
           l'éditeur — mêmes paliers, une seule couleur puisqu'aucun d'eux
           n'a de teinte propre. -->
      <div v-else-if="shape.metricRangeGauge" class="cbp-card cbp-center" :style="overrideStyle">
        <div class="cbp-big cbp-big--gauge">{{ sample.value }}</div>
        <div class="cbp-gauge">
          <span
            v-for="(gaugeCell, i) in rangeGaugeCells"
            :key="i"
            class="cbp-gauge-cell"
            :style="{ background: gaugeCell.lit ? RANGE_GAUGE_COLOR : 'rgba(255,255,255,0.12)' }"
          ></span>
        </div>
        <div class="cbp-unit">{{ sample.unit }}</div>
      </div>

      <!-- Jauge dynamique : le chiffre, une piste continue, l'unité — un
           remplissage jusqu'à la position réelle plutôt que des paliers,
           puisque la plage (min/max de la sortie, ou progression vers
           l'itinéraire) est une vraie progression, pas des seuils. -->
      <div v-else-if="shape.metricDynamicGauge" class="cbp-card cbp-center" :style="overrideStyle">
        <div class="cbp-big cbp-big--gauge">{{ sample.value }}</div>
        <div class="cbp-dyngauge-track">
          <span
            class="cbp-dyngauge-fill"
            :style="{ width: `${dynamicGaugeFraction * 100}%`, background: RANGE_GAUGE_COLOR }"
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

      <!-- Aplat de zone : le même aplat que le plein cadre, mais l'icône se
           pose devant le **titre** (l'unité) et non devant le chiffre — cœur
           ou éclair au même endroit que le nom qui confirme la mesure,
           avant qu'on descende lire le chiffre lui-même. -->
      <div
        v-else-if="shape.metricZoneMode"
        class="cbp-card cbp-center"
        :style="{ background: metricBackground || undefined, color: metricInk }"
      >
        <div class="cbp-zone-title">
          <i :class="sample.icon" aria-hidden="true"></i>
          <span>{{ sample.unit }}</span>
        </div>
        <div class="cbp-big cbp-big--zone">{{ sample.value }}</div>
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

    <!-- Temps par zone -- et son pendant « ce tour » (lap_zones), même dessin,
         seul le titre distingue les deux. ----------------------------------- -->
    <div v-else-if="block.kind === 'zones' || block.kind === 'lap_zones'" class="cbp-card" :style="overrideStyle">
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

    <!-- Moyennes -- et son pendant « ce tour » (lap_averages). ------------ -->
    <template v-else-if="block.kind === 'averages' || block.kind === 'lap_averages'">
      <div v-if="!shape.averagesCards" class="cbp-card" :style="overrideStyle">
        <div class="cbp-title">{{ averagesTitle }}</div>
        <div v-for="stat in AVERAGES_SAMPLE" :key="stat.name" class="cbp-line">
          {{ stat.name }} {{ stat.avg }} {{ stat.unit }} ({{ stat.min }} – {{ stat.max }})
        </div>
      </div>
      <div v-else class="cbp-stack">
        <div v-for="pair in averagesRows" :key="pair[0].name" class="cbp-row">
          <div v-for="stat in pair" :key="stat.name" class="cbp-card cbp-half" :style="overrideStyle">
            <div class="cbp-title">{{ stat.name }} ({{ stat.unit }})</div>
            <div class="cbp-stat"><span>Moyen</span><b>{{ stat.avg }}</b></div>
            <div class="cbp-stat"><span>Min</span><b>{{ stat.min }}</b></div>
            <div class="cbp-stat"><span>Max</span><b>{{ stat.max }}</b></div>
          </div>
        </div>
      </div>
    </template>

    <!-- Bilan du tour : durée, distance, D+, calories, TSS — cinq lignes,
         jamais quatre cartes moyenne/min/max comme « Moyennes » : ce n'est
         pas la même forme, donc pas une variante de la branche au-dessus. -->
    <div v-else-if="block.kind === 'lap_summary'" class="cbp-card" :style="overrideStyle">
      <div class="cbp-title">Bilan du tour</div>
      <template v-if="shape.lapSummaryCards">
        <div v-for="row in LAP_SUMMARY_SAMPLE" :key="row.label" class="cbp-stat">
          <span>{{ row.label }}</span><b>{{ row.value }}</b>
        </div>
      </template>
      <template v-else>
        <div v-for="row in LAP_SUMMARY_SAMPLE" :key="row.label" class="cbp-line">
          {{ row.label }} {{ row.value }}
        </div>
      </template>
    </div>

    <!-- Marquer un tour -----------------------------------------------------
         Clôt le tour courant d'une série et en ouvre un nouveau : un geste
         sec, pas une bascule comme l'enregistrement. -->
    <template v-else-if="block.kind === 'mark_lap'">
      <div v-if="shape.markLapCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-flag" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-flag" aria-hidden="true"></i>
          Marquer un tour
        </span>
      </div>
    </template>

    <!-- Enregistrement --------------------------------------------------- -->
    <template v-else-if="block.kind === 'recording'">
      <!-- Compact : l'icône seule, pour une cellule de grille. -->
      <div v-if="shape.recordingCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <span class="cbp-rec-dot"></span>
        </span>
      </div>
      <!-- Complet : le bouton large, à portée de pouce sur une route bosselée. -->
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
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
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
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
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-eraser" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-eraser" aria-hidden="true"></i>
          Retirer l'itinéraire
        </span>
      </div>
    </template>

    <!-- Itinéraire ----------------------------------------------------------
         Un seul bouton pour les deux gestes de « Changer d'itinéraire » et
         « Retirer l'itinéraire » : c'est l'état de la navigation qui décide
         lequel des deux il pose, côté appli (`RouteControl`, dépôt voisin).
         L'aperçu ne connaît pas cet état à la composition — il montre donc
         le geste qui pose un tracé, celui qu'on obtient hors navigation. -->
    <template v-else-if="block.kind === 'route'">
      <div v-if="shape.routeCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
          Choisir un itinéraire
        </span>
      </div>
    </template>

    <!-- État de navigation ------------------------------------------------ -->
    <div v-else-if="block.kind === 'nav_state'" class="cbp-card" :style="overrideStyle">
      <div class="cbp-title">Navigation</div>
      <div class="cbp-line">21,4 km restants</div>
      <template v-if="shape.navFull">
        <div class="cbp-line">Restant : 21,4 km · 380 m D+</div>
        <div class="cbp-line">Virage proche à 120 m (droite)</div>
      </template>
    </div>

    <!-- Radar ------------------------------------------------------------- -->
    <template v-else-if="block.kind === 'radar'">
      <!-- Un simple aplat de couleur, sans chiffre ni icône — ce qui se lit le
           plus vite du coin de l'œil, pour la case la plus petite de la
           grille. Rouge : mêmes couleurs que les autres modes du bloc,
           « proche ». Ça n'est plus la jauge de gouttière couchée. -->
      <div v-if="shape.radarGauge" class="cbp-card cbp-center" :style="overrideStyle">
        <div class="cbp-radar-square"></div>
      </div>
      <div v-else-if="shape.radarCount" class="cbp-card cbp-center" :style="overrideStyle">
        <!-- Le nombre est ici la donnée du composant, pas un rappel de l'icône
             (contrairement au mode « distance ») : même échelle que le chiffre
             plein cadre qu'il remplace. -->
        <div class="cbp-radar-head cbp-radar-head--count">
          <i class="fa-solid fa-car" aria-hidden="true"></i>
          <span>×2</span>
        </div>
      </div>
      <div v-else-if="shape.radarIcons" class="cbp-card cbp-center" :style="overrideStyle">
        <!-- Une icône par véhicule, sans chiffre — le compte se lit d'un coup
             d'œil. -->
        <div class="cbp-radar-icons">
          <i v-for="n in 2" :key="n" class="fa-solid fa-car" aria-hidden="true"></i>
        </div>
      </div>
      <div v-else-if="shape.radarCompact" class="cbp-card cbp-center" :style="overrideStyle">
        <!-- Les mêmes mètres que le mode « distance », sans l'icône ni le
             ×N : rien que le chiffre, pour la cellule qui n'a pas la hauteur
             d'en placer deux lignes. -->
        <div class="cbp-radar-distance">48 m</div>
      </div>
      <div v-else class="cbp-card cbp-center" :style="overrideStyle">
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
    <div v-else-if="block.kind === 'training_budget'" class="cbp-card" :style="overrideStyle">
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

    <!-- Sélecteur de tour ---------------------------------------------------
         La liste déroulante qui choisit le tour affiché par les autres
         composants de la page — plaçable comme eux, voir `LapSelectorBlock`
         côté appli. -->
    <div v-else-if="block.kind === 'lap_selector'" class="cbp-card cbp-selector" :style="overrideStyle">
      <span>Tour 3 (en cours)</span>
      <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
    </div>

    <!-- Cols du tracé -------------------------------------------------------
         Compact : une ligne, le col en cours. Complet : la liste, avec le
         même repère « en cours / prochain » que l'appli (route_climbs.dart,
         dépôt voisin) — plein pour le premier, en liseré pour le second. -->
    <div v-else-if="block.kind === 'climb_list'" class="cbp-card" :style="overrideStyle">
      <div class="cbp-title">Cols du tracé</div>
      <div v-if="!shape.climbListFull" class="cbp-line">
        En cours : {{ climbListCurrent?.figures }}
      </div>
      <div
        v-for="climb in CLIMB_LIST_SAMPLE"
        v-else
        :key="climb.label"
        class="cbp-climb-row"
        :class="{ 'cbp-climb-row--done': climb.status === 'done' }"
      >
        <span class="cbp-dot" :style="{ background: colorForGrade(climb.grade) }"></span>
        <div class="cbp-climb-body">
          <div class="cbp-climb-head">
            <span>{{ climb.label }}</span>
            <span
              v-if="climb.status !== 'done'"
              class="cbp-climb-chip"
              :class="{ 'cbp-climb-chip--current': climb.status === 'current' }"
            >
              {{ climb.status === 'current' ? 'EN COURS' : 'PROCHAIN' }}
            </span>
          </div>
          <div class="cbp-climb-figures">{{ climb.figures }}</div>
        </div>
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

/* En capitales : `BlockCard`/`StatCard`/`ZoneBreakdown`/`TrainingBudgetCard`
   uppercase tous leurs titres côté appli, la vignette suit. */
.cbp-title {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.95em;
  text-transform: uppercase;
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

/* Le sélecteur de tour : même fond que les autres cartes, le libellé cède la
   place au chevron plutôt que de le pousser hors de la case. */
.cbp-selector {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 0.5em;
  font-size: 1em;
}
.cbp-selector span {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-selector i {
  color: rgba(255, 255, 255, 0.7);
  flex-shrink: 0;
}

/* La liste des cols : un point de la couleur de sa pente moyenne, son
   libellé, et le repère « en cours / prochain » — même dessin que
   `ClimbListCard` côté appli. Un col déjà grimpé s'efface plutôt que de
   disparaître, on garde le compte de ce qui reste. */
.cbp-climb-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5em;
  margin-top: 0.5em;
}
.cbp-climb-row--done {
  opacity: 0.5;
}
.cbp-climb-row .cbp-dot {
  border-radius: 50%;
  margin-top: 0.35em;
}
.cbp-climb-body {
  flex: 1;
  min-width: 0;
}
.cbp-climb-head {
  display: flex;
  align-items: center;
  gap: 0.5em;
  white-space: nowrap;
  overflow: hidden;
}
.cbp-climb-head span:first-child {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-climb-chip {
  flex-shrink: 0;
  font-size: 0.75em;
  font-weight: 700;
  padding: 0.1em 0.5em;
  border-radius: 0.5em;
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: rgba(255, 255, 255, 0.8);
}
.cbp-climb-chip--current {
  background: #f97316;
  border-color: transparent;
  color: #fff;
}
.cbp-climb-figures {
  font-size: 0.9em;
  color: rgba(255, 255, 255, 0.6);
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
/* Le chiffre de l'aplat de zone garde le rythme du plein cadre, juste sous
   son titre plutôt que centré seul dans la case. */
.cbp-big--zone {
  margin-top: 0.1em;
}
/* Le titre de l'aplat de zone : l'icône devant l'unité en capitales, à même
   ligne — c'est elle qui distingue la case cardio de la case puissance, deux
   aplats de zone identiques sinon. Au-dessus du chiffre et non devant lui. */
.cbp-zone-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25em;
  font-size: 1.15em;
  font-weight: 700;
  text-transform: uppercase;
  opacity: 0.85;
  white-space: nowrap;
}
.cbp-zone-title i {
  font-size: 1.3em;
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
  text-transform: uppercase;
  white-space: nowrap;
}
.cbp-icon {
  font-size: 1.7em;
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

/* Le remplissage de la jauge dynamique : une piste continue, pas des
   paliers — la plage y est une vraie progression (min/max de la sortie, ou
   vers l'arrivée), pas des seuils entre lesquels un dégradé mentirait. Plus
   épaisse que `.cbp-gauge-cell` : c'est elle qui porte l'information ici,
   pas des paliers à côté d'un chiffre déjà lisible seul — même hauteur que
   `.cbp-bar`, les deux valant `BlockMetrics.natural.barHeight` côté appli. */
.cbp-dyngauge-track {
  position: relative;
  width: 100%;
  height: 1.6em;
  margin: 0.6em 0 0.35em;
  border-radius: 0.3em;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.cbp-dyngauge-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
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
/* Fond par défaut #1F2226 — celui de `Material(color: color ?? const
   Color(0xFF1F2226))` côté appli (`action_button.dart`/`mark_lap_block.dart`) —
   pour que la couleur réglée dans l'éditeur se voie sur le bouton lui-même,
   plutôt que sur la carte qui l'entoure et qui l'aurait alors noyé dedans. */
.cbp-action-compact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6em;
  height: 2.6em;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: #1f2226;
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
/* Mode « compte » : l'icône et le nombre sont la seule donnée du composant, à
   l'échelle du chiffre plein cadre qu'ils remplacent (contrairement au mode
   « distance », où ils ne sont qu'un rappel au-dessus du chiffre). */
.cbp-radar-head--count {
  font-size: 2.6em;
}
/* Mode « icônes » : une voiture par véhicule suivi, sans chiffre — le compte se
   lit d'un coup d'œil plutôt qu'en déchiffrant un nombre. */
.cbp-radar-icons {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0.3em;
  color: #ffa726;
  font-size: 2em;
}
/* Le carré du mode « jauge » : `BlockSurface` y dessine un simple aplat
   (`DecoratedBox`, 64×64, coins arrondis 8px) — plus une jauge, un rectangle
   coloré, mis à l'échelle de la case comme le reste du bloc. Rouge « proche »
   (`0xFFEF5350`) ici ; les autres couleurs de `_emptyState` (orange « approche »
   `0xFFFFA726`, vert « voie libre » `0xFF81C784`, gris « pas de radar ») ne sont
   pas dans l'aperçu — un aplat seul ne peut pas montrer les quatre états à la
   fois, et « proche » est celui qui justifie le mode. */
.cbp-radar-square {
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 100%;
  border-radius: 0.15em;
  background: #ef5350;
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
