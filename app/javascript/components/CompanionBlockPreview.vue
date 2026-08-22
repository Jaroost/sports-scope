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
import { computed, useId } from 'vue'
import {
  AVERAGES_SAMPLE,
  BATTERY_SAMPLE,
  BUDGET_SAMPLE,
  CLIMB_LIST_SAMPLE,
  DYNAMIC_GAUGE_PREVIEW_FRACTION,
  GAUGE_THICKNESS_SCALE,
  LAP_SUMMARY_SAMPLE,
  METRIC_TREND_HR_SAMPLE,
  METRIC_TREND_POWER_SAMPLE,
  POWER_CURVE_SAMPLE,
  RANGE_GAUGE_COLOR,
  RANGE_GAUGE_SEGMENTS,
  ROW_HEIGHT_SCALE,
  ROW_HEIGHT_WEIGHT,
  SECONDARY_SIZE_SCALE,
  blockShape,
  gaugeGradientColor,
  layoutRows,
  metricIcon,
  metricLayout,
  metricSample,
  type Block,
} from '../companionSettings'
import { colorForGrade, formatDistancePrecise } from '../routeHelpers'
import { buildDebugClimb, buildDebugRouteProfile, textColorOn } from '../navHelpers'
import { zoneColor, acwrColor } from '../composables/useTrainingPlan'

const props = defineProps<{
  block: Block
  // Vrai quand l'appelant sait que ce composant est posé sur une page Tours
  // (`page.kind === 'laps'`) — le seul contexte où une mesure `metric`
  // (`block.kind === 'metric'`) lit le tour affiché plutôt que la sortie
  // entière (`LapListBody._block`, `MetricSources.forLap`, dépôt voisin).
  // Absent ailleurs : cette vignette sert aussi la dialogue de choix
  // (`CompanionBlockPicker`) avant qu'on sache sur quelle page on pose le
  // composant, et les autres pages n'ont pas de tour à montrer.
  lapScoped?: boolean
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

// Le pire pourcentage de BATTERY_SAMPLE, restreint à `block.sensor` s'il en
// vise un — même repli que côté appli (BatteryBlockView._compact) quand
// aucun appareil de l'aperçu ne porte ce capteur.
const batteryCompactSample = computed(() => {
  const pool = props.block.sensor
    ? BATTERY_SAMPLE.filter((d) => d.kind === props.block.sensor)
    : BATTERY_SAMPLE
  if (!pool.length) return null
  return pool.reduce((worst, d) => (d.percent < worst.percent ? d : worst))
})

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

// Le bloc "orage qui arrive" (`precip_forecast`) : douze pas de 15 minutes
// (3h), une averse qui monte puis retombe — de quoi montrer les trois teintes
// et une légende non vide. Mêmes seuils et couleurs que côté appli
// (`precip_forecast_block.dart`) : c'est un fac-similé, pas un rendu partagé,
// donc les deux copies doivent rester synchronisées à la main.
const PRECIP_FORECAST_SAMPLE = [0, 0, 0.05, 0.3, 1.2, 2.6, 1.8, 0.6, 0.1, 0, 0, 0]
const PRECIP_LIGHT_THRESHOLD = 0.1
const PRECIP_MODERATE_THRESHOLD = 0.5
const PRECIP_HEAVY_THRESHOLD = 2.0
const PRECIP_MAX_MM = 4.0

const precipHeadline = computed(() => {
  const idx = PRECIP_FORECAST_SAMPLE.findIndex((mm) => mm >= PRECIP_LIGHT_THRESHOLD)
  if (idx === -1) return 'Pas de pluie prévue.'
  if (idx === 0) return 'Pluie en cours.'
  return `Averse dans ${idx * 15} min.`
})

function precipBarHeight(mm: number) {
  return Math.min(1, Math.max(0.04, mm / PRECIP_MAX_MM)) * 100
}

function precipBarColor(mm: number) {
  if (mm >= PRECIP_HEAVY_THRESHOLD) return '#d32f2f'
  if (mm >= PRECIP_MODERATE_THRESHOLD) return '#e0c000'
  if (mm >= PRECIP_LIGHT_THRESHOLD) return '#2e6fd6'
  return 'rgba(255, 255, 255, 0.15)'
}

// Le bloc "prévisions météo" (`weather_forecast`) : douze heures, température
// et vent en courbes, précipitations en barres — la tendance de toute la
// sortie, là où `precip_forecast` ne répond qu'à « une averse arrive-t-elle
// bientôt ? ». Fac-similé au même titre que PRECIP_FORECAST_SAMPLE : pas de
// prévision réelle dans l'éditeur, juste de quoi montrer les trois séries.
const WEATHER_FORECAST_SAMPLE = {
  temperature: [14, 15, 16, 18, 20, 22, 22, 20, 18, 16, 15, 14],
  windSpeed: [8, 9, 10, 13, 17, 19, 16, 13, 11, 10, 9, 8],
  precipitation: [0, 0, 0, 0, 0, 0.2, 0.6, 0.3, 0, 0, 0, 0],
}

const WEATHER_CHART_WIDTH = 120
const WEATHER_CHART_HEIGHT = 60
// La hauteur pleine d'une barre, en mm sur l'heure — un cumul horaire est
// d'ordinaire plus faible qu'un pic à 15 min (`PRECIP_MAX_MM`), d'où un
// plafond plus bas.
const WEATHER_PRECIP_MAX_MM = 2.0
// Les barres ne montent que sur le tiers bas du graphique : au-dessus, c'est
// la place des courbes de température/vent, qui ont besoin de toute la
// hauteur pour rester lisibles.
const WEATHER_BAR_AREA_FRACTION = 0.35

// Une polyligne SVG normalisée sur `WEATHER_CHART_WIDTH` × `WEATHER_CHART_HEIGHT`,
// à l'échelle propre de la série (son min et son max, pas une plage partagée
// avec l'autre courbe) — température et vent n'ont pas les mêmes unités, les
// superposer sur une échelle commune n'aurait pas de sens.
function weatherLinePoints(values: number[], padding = 6) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = WEATHER_CHART_WIDTH / (values.length - 1)
  return values
    .map((v, i) => {
      const x = i * stepX
      const y = padding + (1 - (v - min) / span) * (WEATHER_CHART_HEIGHT - padding * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

const weatherTempPoints = computed(() => weatherLinePoints(WEATHER_FORECAST_SAMPLE.temperature))
const weatherWindPoints = computed(() => weatherLinePoints(WEATHER_FORECAST_SAMPLE.windSpeed))

const weatherBarStepX = WEATHER_CHART_WIDTH / WEATHER_FORECAST_SAMPLE.precipitation.length
const weatherBarWidth = weatherBarStepX * 0.7

function weatherBarX(i: number) {
  return i * weatherBarStepX + weatherBarStepX * 0.15
}

function weatherBarHeight(mm: number) {
  return Math.min(1, mm / WEATHER_PRECIP_MAX_MM) * (WEATHER_CHART_HEIGHT * WEATHER_BAR_AREA_FRACTION)
}

// Le bloc "météo" compact (`weather_compact`) : les mêmes trois séries que
// `weather_forecast`, réduites à leur valeur "maintenant" (index 0) et une
// flèche de tendance vers +6h (index 6) — pas de graphique, la case qui
// n'a la place que de trois chiffres. Mêmes seuils que côté appli
// (`weather_compact_block.dart`) : un écart sous le seuil reste "stable",
// sans quoi un bruit de mesure ferait clignoter la flèche.
const WEATHER_COMPACT_LATER_INDEX = 6
const WEATHER_COMPACT_TREND_ICON = { up: 'fa-arrow-trend-up', down: 'fa-arrow-trend-down', flat: 'fa-minus' }

function weatherCompactTrend(now: number, later: number, threshold: number): 'up' | 'down' | 'flat' {
  const delta = later - now
  if (delta > threshold) return 'up'
  if (delta < -threshold) return 'down'
  return 'flat'
}

const weatherCompactRows = computed(() => {
  const { temperature, windSpeed, precipitation } = WEATHER_FORECAST_SAMPLE
  const later = WEATHER_COMPACT_LATER_INDEX
  return [
    {
      label: 'Température',
      value: `${Math.round(temperature[0])}°C`,
      color: '#ff8a3d',
      trend: weatherCompactTrend(temperature[0], temperature[later], 1.0),
    },
    {
      label: 'Vent',
      value: `${Math.round(windSpeed[0])} km/h`,
      color: '#8fd3ff',
      trend: weatherCompactTrend(windSpeed[0], windSpeed[later], 3.0),
    },
    {
      label: 'Pluie',
      value: `${precipitation[0].toFixed(1)} mm/h`,
      color: '#2e6fd6',
      trend: weatherCompactTrend(precipitation[0], precipitation[later], 0.2),
    },
  ].map((row) => ({ ...row, icon: WEATHER_COMPACT_TREND_ICON[row.trend] }))
})

const sample = computed(() => metricSample(props.block.metric, props.block.format))
const icon = computed(() => metricIcon(props.block))

// Le repère par défaut d'une annotation de coin sans `label` — même règle
// que côté appli (`MetricView._defaultSecondaryCaption`) : déduite du
// suffixe de la clé, jamais du nom complet de la mesure, trop long pour un
// coin de carte.
function secondaryCaption(slot: { metric: string; label?: string }): string | null {
  if (slot.label) return slot.label
  if (slot.metric.endsWith('_avg')) return 'MOY'
  if (slot.metric.endsWith('_max')) return 'MAX'
  if (slot.metric.endsWith('_min')) return 'MIN'
  return null
}

// Le contenu fixe d'un bloc `clock` — pas de `MetricId` pour porter un nom ou
// une icône par défaut, contrairement à `metricSample`/`metricIcon`.
const clockSample = computed(() => ({
  name: 'Horloge',
  value: props.block.mode === 'hms' ? '14:03:07' : '14:03',
}))
const clockIcon = computed(() => props.block.icon || 'fa-regular fa-clock')

// La disposition du bloc — `layout` s'il en a un, sinon la traduction de son
// `mode` (document d'avant ce chantier) — et les rangées qu'elle occupe,
// dans l'ordre. Une rangée sans occupant n'y figure pas : elle ne prend
// aucune place, exactement ce que dessinera l'appli.
const rows = computed(() => layoutRows(metricLayout(props.block)))

// Le fond se peint dès que la mesure porte une zone, quelle que soit la
// disposition composée — côté appli, `MetricView` peint le fond de la carte
// entière, pas seulement autour du chiffre.
const metricZone = computed(() => sample.value.zone || null)

// Y a-t-il une jauge quelque part dans la disposition, et de quelle nature —
// détermine à la fois quel dessin de barre utiliser et si le chiffre prend
// la taille réduite qui lui laisse de la place (`cbp-big--gauge`), comme la
// carte de jauge d'avant ce chantier.
const gaugeKind = computed<'zone' | 'range' | 'dynamic' | null>(() => {
  if (!rows.value.some((row) => row.gauge)) return null
  if (metricZone.value) return 'zone'
  return props.block.gauge_kind === 'dynamic' ? 'dynamic' : 'range'
})

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
// progression linéaire que les zones n'ont pas. Cinq zones en dur (comme
// l'aperçu cardio le plus courant) : contrairement à l'appli, l'éditeur n'a
// pas de vrai profil de cycliste pour compter les zones de puissance (z6/z7).
const gaugeCells = computed(() => {
  const index = metricZone.value ? Number(metricZone.value.slice(1)) - 1 : -1
  return [0, 1, 2, 3, 4].map((i) => ({
    lit: i <= index,
    color: ZONE_COLORS[`z${i + 1}`],
  }))
})

// Le curseur de la jauge dynamique : une position fixe et illustrative
// (`DYNAMIC_GAUGE_PREVIEW_FRACTION`), l'éditeur n'ayant pas de sortie en
// cours pour en tirer une vraie plage.
const dynamicGaugeFraction = computed(() => DYNAMIC_GAUGE_PREVIEW_FRACTION[props.block.metric || ''] ?? 0.5)

// La forme et la couleur choisies dans l'éditeur (`gauge_fill`/
// `gauge_color_mode`, voir `CompanionBlockPicker.vue`) — repli sur le rendu
// d'avant ce réglage quand elles sont absentes, propre à la nature de la
// jauge : tronçons pour zones/plage libre, barre continue pour la dynamique ;
// automatique pour une jauge de zones, fixe sinon. Même règle que
// `MetricView` côté appli.
const gaugeFill = computed<'segments' | 'full'>(() => {
  const raw = props.block.gauge_fill
  if (raw === 'segments' || raw === 'full') return raw
  return gaugeKind.value === 'dynamic' ? 'full' : 'segments'
})
const gaugeColorMode = computed<'fixed' | 'auto'>(() => {
  const raw = props.block.gauge_color_mode
  if (raw === 'fixed' || raw === 'auto') return raw
  return gaugeKind.value === 'zone' ? 'auto' : 'fixed'
})

// Le multiplicateur de l'épaisseur naturelle — tronçons et barre continue
// s'y ajustent toutes les deux (voir `GAUGE_THICKNESS_SCALE`).
const gaugeThicknessScale = computed(() => GAUGE_THICKNESS_SCALE[props.block.gauge_thickness || 'normal'])

// La fraction 0–1 atteinte, quelle que soit la nature de la jauge — sert à la
// fois à la barre continue et au nombre de tronçons allumés d'un remplissage
// à couleur unique. `null` (mesure sans échantillon numérique, min/max pas
// réglés, ou zone du moment inconnue) éteint tout plutôt que de deviner une
// position.
const gaugeFraction = computed<number | null>(() => {
  if (gaugeKind.value === 'zone') {
    const index = metricZone.value ? Number(metricZone.value.slice(1)) - 1 : -1
    return index < 0 ? null : (index + 1) / 5
  }
  if (gaugeKind.value === 'dynamic') return dynamicGaugeFraction.value
  const { min, max } = props.block
  const value = sample.value.numeric
  return value != null && min != null && max != null && max > min
    ? Math.min(Math.max((value - min) / (max - min), 0), 1)
    : null
})

// Le rendu natif de la jauge de zones (une couleur par palier, `gaugeCells`)
// n'est gardé que tant que rien ne casse la correspondance tronçon↔zone —
// même condition que `MetricView._zoneGaugeBar` côté appli.
const useZoneLadder = computed(() => (
  gaugeKind.value === 'zone'
    && gaugeFill.value === 'segments'
    && props.block.gauge_segments == null
    && gaugeColorMode.value === 'auto'
))

// Une jauge à plage (libre ou dynamique) sans zone, en couleur `auto` : pas
// de teinte propre à s'y raccrocher (contrairement aux zones), donc un
// dégradé bleu → violet sur la position plutôt qu'un accent unique — voir
// `gaugeGradientColor`. Sert aussi bien au remplissage continu (une seule
// couleur, `gaugeColor`) qu'aux tronçons, qui en deviennent alors un ladder
// (`resolvedGaugeCells`), comme la jauge de zones l'est déjà nativement.
const useAutoGradient = computed(() => gaugeColorMode.value === 'auto' && gaugeKind.value !== 'zone')

// La couleur unique d'un remplissage qui n'est pas le ladder de zones — fixe
// (`gauge_color`, repli `RANGE_GAUGE_COLOR`), celle de la zone du moment avec
// le même repli si la mesure n'en a pas, ou le dégradé à la position
// courante pour une jauge à plage en `auto`.
const gaugeColor = computed(() => {
  const fallback = props.block.gauge_color || RANGE_GAUGE_COLOR
  if (gaugeColorMode.value === 'fixed') return fallback
  if (gaugeKind.value === 'zone') return (metricZone.value && ZONE_COLORS[metricZone.value]) || fallback
  return gaugeGradientColor(gaugeFraction.value ?? 0)
})

// Le nombre de tronçons d'un remplissage segmenté qui n'est pas le ladder de
// zones — celui réglé dans l'éditeur, sinon le repli propre à la nature de
// la jauge (même 5 zones en dur que `gaugeCells`, `RANGE_GAUGE_SEGMENTS`
// sinon).
const gaugeSegmentCount = computed(
  () => props.block.gauge_segments || (gaugeKind.value === 'zone' ? 5 : RANGE_GAUGE_SEGMENTS),
)

// Les paliers à dessiner pour la rangée-jauge quand elle n'est ni le ladder
// de zones ni une barre continue — une seule couleur pour tous les paliers
// allumés (`gaugeColor`), sauf en dégradé (`useAutoGradient`) où chaque
// palier porte sa propre couleur selon sa position, qu'il soit allumé ou
// non — un ladder bleu → violet, comme la jauge de zones en est déjà un.
const resolvedGaugeCells = computed(() => {
  const count = gaugeSegmentCount.value
  const fraction = gaugeFraction.value
  const lit = fraction == null ? -1 : Math.round(fraction * count)
  return Array.from({ length: count }, (_, i) => ({
    lit: i < lit,
    color: useAutoGradient.value ? gaugeGradientColor((i + 1) / count) : gaugeColor.value,
  }))
})

// Les paliers à dessiner pour la rangée-jauge, quelle que soit sa nature —
// pour que le template n'ait qu'une seule boucle à écrire, pas un `v-if` de
// plus par nature de jauge.
const litGaugeCells = computed(() => (useZoneLadder.value ? gaugeCells.value : resolvedGaugeCells.value))

// « Ce tour — » en préfixe côté `lap_zones`/`lap_averages` : même dessin que
// `zones`/`averages`, seul ce qu'on mesure change — depuis l'ouverture du
// tour choisi, pas depuis le départ de la sortie.
const lapScope = computed(() => (props.block.kind.startsWith('lap_') ? 'Ce tour — ' : ''))

// Une mesure ordinaire (`metric`) n'a pas de titre — sa disposition libre ne
// réserve pas forcément de case à un libellé (mode « chiffre plein cadre »,
// par exemple) — donc pas d'endroit où glisser un préfixe comme `lapScope`
// ci-dessus. Un badge posé sur la carte le dit à la place, seulement quand
// l'appelant sait qu'elle atterrit sur une page Tours (voir la doc de
// `lapScoped`) : ailleurs, une mesure `metric` reste celle de la sortie
// entière et n'a rien à annoncer.
const showLapBadge = computed(() => props.lapScoped === true && props.block.kind === 'metric')

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

// ── Profil du col ────────────────────────────────────────────────────────────
//
// Même dessin que `NavClimbCard.vue` (segments colorés, aire « déjà grimpée »
// clippée, curseur) — fac-similé au même titre que `CLIMB_LIST_SAMPLE` :
// `buildDebugClimb` synthétise un col plausible sans dépendre d'un tracé,
// déjà utilisé pour déboguer cette même carte sur la carte de navigation.
// Figé (pas un `computed`) : rien dont il dépend ne change jamais.
const climbProfileSample = buildDebugClimb()

// L'identifiant du `<clipPath>` doit être unique par instance : plusieurs
// vignettes de ce composant se montent en même temps (dialogue de choix,
// cases de grille), et un `id` en dur collisionnerait — le `url(#id)` de
// toutes les cartes suivrait alors le curseur de la première montée.
const climbProfileClipId = useId()

// ── Profil d'altitude ────────────────────────────────────────────────────────
//
// Même dessin que « Profil du col » ci-dessus, mais sur toute la sortie plutôt
// que sur un seul col — fac-similé au même titre, buildDebugRouteProfile
// synthétise un tracé plausible (vallonné, pas une montée) sans dépendre d'un
// itinéraire réel.
const altitudeProfileSample = buildDebugRouteProfile()
const altitudeProfileClipId = useId()

// ── Courbe de puissance ──────────────────────────────────────────────────────
//
// Abscisse en index régulier dans cet aperçu — un aplat plausible de onze points
// suffit à montrer la forme (sprint au-dessus du reste, plateau aux longues
// durées) sans reconstruire l'échelle logarithmique du vrai graphique
// (`PowerCurveGraph`, dépôt voisin), qui a besoin de vraies durées à espacer.
const powerCurvePoints = computed(() => {
  const watts = POWER_CURVE_SAMPLE.map((point) => point.watts)
  const min = Math.min(...watts)
  const max = Math.max(...watts)
  const span = max - min || 1
  return POWER_CURVE_SAMPLE.map((point, i) => ({
    x: (i / (POWER_CURVE_SAMPLE.length - 1)) * 100,
    y: 96 - ((point.watts - min) / span) * 88,
  }))
})
const powerCurvePolyline = computed(() => powerCurvePoints.value.map((p) => `${p.x},${p.y}`).join(' '))

// ── Tendance cardio/puissance ────────────────────────────────────────────────
//
// Même dessin que `MetricTrendGraph` (dépôt voisin,
// `ride/widgets/metric_trend_graph.dart`) : un trapèze par segment, coloré
// par la zone de son point de départ — fac-similé au même titre que le reste
// de ce fichier, `ZONE_COLORS` tient lieu de la même table côté appli
// (`zoneColorOf`). La courbe elle-même est tracée par-dessus, en liseré noir
// puis trait blanc, pour rester lisible aussi bien sur un aplat sombre (Z1
// bleu) que clair (Z3 jaune) — même parade que côté appli.
const metricTrendTitle = computed(() => (props.block.source === 'power' ? 'Tendance puissance' : 'Tendance cardio'))
const metricTrendSample = computed(() =>
  props.block.source === 'power' ? METRIC_TREND_POWER_SAMPLE : METRIC_TREND_HR_SAMPLE)

const metricTrendPoints = computed(() => {
  const sample = metricTrendSample.value
  const values = sample.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return sample.map((p, i) => ({
    x: (i / (sample.length - 1)) * 100,
    y: 96 - ((p.value - min) / span) * 88,
    zone: p.zone,
  }))
})
const metricTrendPolyline = computed(() => metricTrendPoints.value.map((p) => `${p.x},${p.y}`).join(' '))
const metricTrendSegments = computed(() => {
  const pts = metricTrendPoints.value
  const segments: { d: string; color: string }[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    segments.push({
      d: `M${pts[i].x},${pts[i].y} L${pts[i + 1].x},${pts[i + 1].y} L${pts[i + 1].x},100 L${pts[i].x},100 Z`,
      color: ZONE_COLORS[pts[i].zone],
    })
  }
  return segments
})
</script>

<template>
  <div class="cbp">
    <!-- Une mesure ------------------------------------------------------- -->
    <div
      v-if="block.kind === 'metric'"
      class="cbp-card cbp-metric"
      :style="{ background: metricBackground || undefined, color: metricInk }"
    >
      <span v-if="showLapBadge" class="cbp-lap-badge">Ce tour</span>
      <template v-for="row in rows" :key="row.row">
        <!-- La jauge est une barre pleine largeur, pas un texte : dès qu'elle
             occupe une rangée, elle en est la seule occupante (voir
             l'assainisseur), donc pas de colonnes à dessiner ici. -->
        <div v-if="row.gauge" class="cbp-metric-gauge-row">
          <div
            v-if="gaugeFill === 'full'"
            class="cbp-dyngauge-track"
            :style="{ height: `${1.6 * gaugeThicknessScale}em`, borderRadius: `${0.3 * gaugeThicknessScale}em` }"
          >
            <span
              class="cbp-dyngauge-fill"
              :style="{ width: `${(gaugeFraction ?? 0) * 100}%`, background: gaugeColor }"
            ></span>
          </div>
          <div v-else class="cbp-gauge">
            <span
              v-for="(cell, i) in litGaugeCells"
              :key="i"
              class="cbp-gauge-cell"
              :style="{
                height: `${0.6 * gaugeThicknessScale}em`,
                borderRadius: `${0.15 * gaugeThicknessScale}em`,
                background: cell.lit ? cell.color : 'rgba(255,255,255,0.12)',
              }"
            ></span>
          </div>
        </div>
        <div
          v-else
          class="cbp-metric-row"
          :style="{ flexGrow: ROW_HEIGHT_WEIGHT[row.height], fontSize: `${ROW_HEIGHT_SCALE[row.height]}em` }"
        >
          <div
            v-for="col in row.columns"
            :key="col.col"
            class="cbp-metric-col"
            :class="`cbp-metric-col--${col.col}`"
          >
            <template v-for="token in col.tokens" :key="token">
              <i v-if="token === 'icon'" class="cbp-metric-icon" :class="icon" aria-hidden="true"></i>
              <span v-else-if="token === 'label'" class="cbp-metric-label">{{ block.label?.trim() || sample.name }}</span>
              <span v-else-if="token === 'unit'" class="cbp-metric-unit">{{ sample.unit }}</span>
              <span v-else class="cbp-big" :class="{ 'cbp-big--gauge': gaugeKind }">{{ sample.value }}</span>
            </template>
            <span
              v-if="col.secondary"
              class="cbp-metric-secondary"
              :style="{ fontSize: `${SECONDARY_SIZE_SCALE[col.secondary.size || 'small']}em` }"
            >
              <span v-if="secondaryCaption(col.secondary)" class="cbp-metric-secondary-label">
                {{ secondaryCaption(col.secondary) }}
              </span>
              {{ metricSample(col.secondary.metric).value }}
            </span>
          </div>
        </div>
      </template>
    </div>

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

    <!-- Entraînement (démarrer ou retirer) -----------------------------------
         Un seul bouton pour les deux gestes de « Démarrer un entraînement »
         et « Arrêter l'entraînement » : c'est l'état de l'enregistrement qui
         décide lequel des deux il pose, côté appli (`RideRecorder.
         activeWorkout`). Même limite que `route` : l'aperçu ne connaît pas
         cet état à la composition — il montre donc le geste qui démarre un
         programme, celui qu'on obtient hors sortie enregistrée. -->
    <template v-else-if="block.kind === 'toggle_workout'">
      <div v-if="shape.toggleWorkoutCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-person-running" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-person-running" aria-hidden="true"></i>
          Choisir un entraînement
        </span>
      </div>
    </template>

    <!-- Mettre en veille ----------------------------------------------------
         Met la carte en veille depuis une page de données qui ne l'a pas
         sous les yeux : ce bouton demande le même geste qu'un appui long sur
         la carte (voile noir, rétroéclairage à 1 %), la page n'a rien de
         plus à savoir dessiner. -->
    <template v-else-if="block.kind === 'sleep'">
      <div v-if="shape.sleepCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-moon" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-moon" aria-hidden="true"></i>
          Mettre en veille
        </span>
      </div>
    </template>

    <!-- Revenir à l'accueil --------------------------------------------------
         Quitte la sortie, même geste que « Revenir à l'accueil » dans le menu
         ⋮ — celui-ci reste toujours là, ce bouton n'en est qu'un raccourci de
         plus. -->
    <template v-else-if="block.kind === 'leave_ride'">
      <div v-if="shape.leaveRideCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-house" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-house" aria-hidden="true"></i>
          Revenir à l'accueil
        </span>
      </div>
    </template>

    <!-- Sonnette --------------------------------------------------------------
         Fait sonner fort le téléphone (son + vibration), pour le retrouver
         dans un sac ou une poche — même famille de bouton que « Mettre en
         veille », sans état à montrer dans l'aperçu (l'appli l'arrête d'elle-
         même après quelques secondes). -->
    <template v-else-if="block.kind === 'bell'">
      <div v-if="shape.bellCompact" class="cbp-card cbp-center">
        <span class="cbp-action-compact" :style="overrideStyle">
          <i class="fa-solid fa-bell" aria-hidden="true"></i>
        </span>
      </div>
      <div v-else class="cbp-center cbp-plain">
        <span class="cbp-action-button" :style="overrideStyle">
          <i class="fa-solid fa-bell" aria-hidden="true"></i>
          Faire sonner
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

    <!-- Batteries -----------------------------------------------------------
         L'état des capteurs BLE connus de l'appli companion, et de la
         batterie du téléphone lui-même — une ligne par appareil en mode
         « liste », le pire pourcentage connu en un seul chiffre en mode
         « compact », même distinction que le radar. Les chiffres sont ceux
         de BATTERY_SAMPLE (voir companionSettings.ts) : plausibles et faux,
         comme le reste de cet aperçu. -->
    <template v-else-if="block.kind === 'battery'">
      <div v-if="shape.batteryCompact" class="cbp-card cbp-center" :style="overrideStyle">
        <div
          v-if="batteryCompactSample"
          class="cbp-radar-distance"
          :style="batteryCompactSample.percent <= 20 ? 'color: #EF5350' : undefined"
        >{{ batteryCompactSample.percent }} %</div>
        <div v-else class="cbp-radar-distance">—</div>
      </div>
      <div v-else class="cbp-card" :style="overrideStyle">
        <div class="cbp-title">Batteries</div>
        <div v-for="device in BATTERY_SAMPLE" :key="device.label" class="cbp-stat">
          <span>{{ device.label }}</span>
          <b :style="device.percent <= 20 ? 'color: #EF5350' : undefined">{{ device.percent }} %</b>
        </div>
      </div>
    </template>

    <!-- Précipitations ------------------------------------------------------
         Radar RainViewer centré sur la position GPS du cycliste : l'appli
         anime de vraies tuiles réseau, ici un fac-similé fixe fait à la main
         (pas de capteur ni de réseau dans l'éditeur) — mêmes teintes que
         `ZONE_COLORS` pour rester dans la palette du reste du dashboard. Le
         point central figure le cycliste, toujours au milieu puisque c'est
         la carte qui se recentre sur lui, jamais l'inverse. -->
    <div v-else-if="block.kind === 'precip_radar'" class="cbp-card cbp-precip" :style="overrideStyle">
      <div class="cbp-precip-radar">
        <span class="cbp-precip-blob cbp-precip-blob--1"></span>
        <span class="cbp-precip-blob cbp-precip-blob--2"></span>
        <span class="cbp-precip-blob cbp-precip-blob--3"></span>
        <span class="cbp-precip-rider"></span>
      </div>
    </div>

    <!-- Orage qui arrive -------------------------------------------------
         Prévision Open-Meteo à 15 minutes pour la position GPS courante : une
         frise de barres (3h) et une phrase disant si une averse arrive et
         dans combien de temps — chiffré, là où `precip_radar` ne fait que le
         montrer à l'œil. Douze pas fixes ici (pas de capteur ni de réseau
         dans l'éditeur), mêmes seuils/couleurs que côté appli. -->
    <div v-else-if="block.kind === 'precip_forecast'" class="cbp-card cbp-precip-forecast" :style="overrideStyle">
      <div class="cbp-title">Orage qui arrive</div>
      <div class="cbp-precip-headline">{{ precipHeadline }}</div>
      <div class="cbp-precip-bars">
        <span
          v-for="(mm, i) in PRECIP_FORECAST_SAMPLE"
          :key="i"
          class="cbp-precip-bar"
          :style="{ height: `${precipBarHeight(mm)}%`, background: precipBarColor(mm) }"
        ></span>
      </div>
      <div class="cbp-precip-labels">
        <span>Maintenant</span>
        <span>+3h</span>
      </div>
    </div>

    <!-- Prévisions météo ---------------------------------------------------
         Douze heures Open-Meteo pour la position GPS courante : température
         et vent en courbes (chacune sur sa propre échelle, un min/max ne
         disant rien de l'autre), précipitations en barres sur le tiers bas —
         la tendance de toute la sortie, là où `precip_forecast` ne répond
         qu'à l'averse qui approche. Un seul mode, mêmes raisons que lui :
         rien à faire varier dans l'éditeur, pas de capteur pour en tirer une
         vraie prévision. -->
    <div v-else-if="block.kind === 'weather_forecast'" class="cbp-card cbp-weather" :style="overrideStyle">
      <div class="cbp-title">Prévisions météo</div>
      <svg class="cbp-weather-chart" viewBox="0 0 120 60" preserveAspectRatio="none">
        <rect
          v-for="(mm, i) in WEATHER_FORECAST_SAMPLE.precipitation"
          :key="`bar-${i}`"
          :x="weatherBarX(i)"
          :y="60 - weatherBarHeight(mm)"
          :width="weatherBarWidth"
          :height="weatherBarHeight(mm)"
          fill="#2e6fd6"
          opacity="0.55"
        />
        <polyline :points="weatherWindPoints" fill="none" stroke="#8fd3ff" stroke-width="1.5" stroke-dasharray="3,2" />
        <polyline :points="weatherTempPoints" fill="none" stroke="#ff8a3d" stroke-width="2" />
      </svg>
      <div class="cbp-weather-labels">
        <span>Maintenant</span>
        <span>+12h</span>
      </div>
      <div class="cbp-weather-legend">
        <span class="cbp-weather-legend-item"><span class="cbp-dot" style="background: #ff8a3d"></span>Température</span>
        <span class="cbp-weather-legend-item"><span class="cbp-dot" style="background: #8fd3ff"></span>Vent</span>
        <span class="cbp-weather-legend-item"><span class="cbp-dot" style="background: #2e6fd6"></span>Précipitations</span>
      </div>
    </div>

    <!-- Météo compacte -------------------------------------------------------
         Les mêmes valeurs Open-Meteo que `weather_forecast` (maintenant et
         +6h), condensées en trois chiffres avec une flèche de tendance plutôt
         qu'un graphique — pour la case qui n'a pas la place de l'un mais peut
         encore dire trois chiffres. Un seul mode, mêmes raisons que
         `weather_forecast` : rien à faire varier dans l'éditeur, pas de
         capteur pour en tirer une vraie prévision. -->
    <div v-else-if="block.kind === 'weather_compact'" class="cbp-card cbp-weather-compact" :style="overrideStyle">
      <div class="cbp-title">Météo</div>
      <div v-for="row in weatherCompactRows" :key="row.label" class="cbp-weather-compact-row">
        <span class="cbp-dot" :style="{ background: row.color }"></span>
        <span class="cbp-weather-compact-label">{{ row.label }}</span>
        <span class="cbp-weather-compact-value">{{ row.value }}</span>
        <i :class="['fa-solid', row.icon, 'cbp-weather-compact-trend']" aria-hidden="true"></i>
      </div>
    </div>

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

    <!-- Tronçon en cours ------------------------------------------------------
         Nom + icône du jalon franchi le plus récemment (TrainingProgram
         milestones) — dérivé, rien à régler au-delà de couleur/texte, comme
         `nav_state`/`training_budget`. `upcoming` (`shape.workoutUpcoming`)
         montre le jalon suivant à la place, un aperçu plutôt que le tronçon
         en cours. -->
    <div v-else-if="block.kind === 'workout_segment'" class="cbp-card" :style="overrideStyle">
      <div class="cbp-title">{{ shape.workoutUpcoming ? 'Suivant' : 'Tronçon' }}</div>
      <div class="cbp-workout-row">
        <i class="fa-solid fa-mountain cbp-workout-icon" aria-hidden="true"></i>
        <span class="cbp-workout-figure">{{ shape.workoutUpcoming ? 'Sprint' : 'Montée' }}</span>
      </div>
    </div>

    <!-- Temps restant du tronçon ------------------------------------------- -->
    <div v-else-if="block.kind === 'workout_remaining'" class="cbp-card" :style="overrideStyle">
      <div class="cbp-title">{{ shape.workoutUpcoming ? 'Durée à venir' : 'Restant' }}</div>
      <div class="cbp-workout-row">
        <i class="fa-solid fa-stopwatch cbp-workout-icon" aria-hidden="true"></i>
        <span class="cbp-workout-figure">{{ shape.workoutUpcoming ? '2:00' : '4:32' }}</span>
      </div>
    </div>

    <!-- Tronçon en cours + temps restant --------------------------------------
         `workout_segment`/`workout_remaining` fondus : les deux lignes
         (`full`) ou une seule (`line`) plutôt qu'un choix entre les deux
         composants. -->
    <div v-else-if="block.kind === 'workout_status' && !shape.workoutStatusLine" class="cbp-card" :style="overrideStyle">
      <div class="cbp-workout-row">
        <i class="fa-solid fa-mountain cbp-workout-icon" aria-hidden="true"></i>
        <span class="cbp-workout-figure">{{ shape.workoutUpcoming ? 'Sprint' : 'Montée' }}</span>
      </div>
      <div class="cbp-workout-row">
        <i class="fa-solid fa-stopwatch cbp-workout-icon" aria-hidden="true"></i>
        <span class="cbp-workout-figure">{{ shape.workoutUpcoming ? '2:00' : '4:32' }}</span>
      </div>
    </div>
    <div v-else-if="block.kind === 'workout_status'" class="cbp-card" :style="overrideStyle">
      <div class="cbp-workout-line">
        <i class="fa-solid fa-mountain cbp-workout-icon" aria-hidden="true"></i>
        <span class="cbp-workout-line-name">{{ shape.workoutUpcoming ? 'Sprint' : 'Montée' }}</span>
        <span class="cbp-workout-line-figure">{{ shape.workoutUpcoming ? '2:00' : '4:32' }}</span>
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

    <!-- Profil du col ---------------------------------------------------
         Le graphique gradué complet du col en cours (D+ restant, pente
         colorée, curseur de progression) — même dessin que la carte de col
         dépliée sur la carte (`NavClimbCard.vue`), posable comme un bloc de
         page ordinaire plutôt que réservé à ce geste. Un seul mode, même
         raison que `weather_forecast` : rien à faire varier dans l'éditeur. -->
    <div v-else-if="block.kind === 'climb_profile'" class="cbp-card cbp-climb-profile" :style="overrideStyle">
      <div class="cbp-title">Profil du col</div>
      <div class="cbp-climb-profile-header">
        <span class="cbp-climb-profile-progress">
          <span class="cbp-climb-profile-gain">+{{ Math.round(climbProfileSample.remainingGainM) }} m</span>
          <span class="cbp-climb-profile-pct">{{ Math.round(climbProfileSample.ratio * 100) }} %</span>
        </span>
        <span class="cbp-climb-profile-aside">
          <span class="cbp-climb-profile-dist">
            {{ formatDistancePrecise(climbProfileSample.climb.lengthM * (1 - climbProfileSample.ratio)) }}
          </span>
          <span
            class="cbp-climb-profile-grade"
            :style="{ background: climbProfileSample.gradeColor, color: climbProfileSample.gradeText }"
          >
            {{ Math.round(climbProfileSample.grade) }} %
          </span>
        </span>
      </div>
      <div class="cbp-climb-profile-graph">
        <svg class="cbp-climb-profile-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath :id="climbProfileClipId">
              <rect x="0" y="0" :width="climbProfileSample.posX" height="100" />
            </clipPath>
          </defs>
          <path v-for="(seg, i) in climbProfileSample.segments" :key="i" :d="seg.d" :fill="seg.color" />
          <!-- Portion déjà grimpée : l'aire entière redessinée en gris, clippée au curseur. -->
          <path :d="climbProfileSample.areaD" fill="#9ca3af" :clip-path="`url(#${climbProfileClipId})`" />
        </svg>
        <div class="cbp-climb-profile-cursor" :style="{ left: `${climbProfileSample.posX}%` }">
          <span
            class="cbp-climb-profile-remain"
            :style="{
              top: `${climbProfileSample.topY}%`,
              height: `${Math.max(0, climbProfileSample.posY - climbProfileSample.topY)}%`,
            }"
          ></span>
          <span class="cbp-climb-profile-dot" :style="{ top: `${climbProfileSample.posY}%` }"></span>
        </div>
      </div>
    </div>

    <!-- Profil d'altitude -------------------------------------------------
         Même dessin que « Profil du col » ci-dessus, mais sur toute la sortie :
         un tracé chargé donne ce même graphique sur toute la distance, sans
         tracé l'appli le rebâtit sur la sortie déjà enregistrée. Un seul mode :
         c'est le contexte de la sortie qui choisit l'allure, pas l'éditeur. -->
    <div v-else-if="block.kind === 'altitude_profile'" class="cbp-card cbp-climb-profile" :style="overrideStyle">
      <div class="cbp-title">Profil d'altitude</div>
      <div class="cbp-climb-profile-header">
        <span class="cbp-climb-profile-progress">
          <span class="cbp-climb-profile-gain">+{{ Math.round(altitudeProfileSample.remainingGainM) }} m</span>
          <span class="cbp-climb-profile-pct">{{ Math.round(altitudeProfileSample.ratio * 100) }} %</span>
        </span>
        <span class="cbp-climb-profile-aside">
          <span class="cbp-climb-profile-dist">
            {{ formatDistancePrecise(altitudeProfileSample.climb.lengthM * (1 - altitudeProfileSample.ratio)) }}
          </span>
          <span
            class="cbp-climb-profile-grade"
            :style="{ background: altitudeProfileSample.gradeColor, color: altitudeProfileSample.gradeText }"
          >
            {{ Math.round(altitudeProfileSample.grade) }} %
          </span>
        </span>
      </div>
      <div class="cbp-climb-profile-graph">
        <svg class="cbp-climb-profile-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath :id="altitudeProfileClipId">
              <rect x="0" y="0" :width="altitudeProfileSample.posX" height="100" />
            </clipPath>
          </defs>
          <path v-for="(seg, i) in altitudeProfileSample.segments" :key="i" :d="seg.d" :fill="seg.color" />
          <!-- Portion déjà parcourue : l'aire entière redessinée en gris, clippée au curseur. -->
          <path :d="altitudeProfileSample.areaD" fill="#9ca3af" :clip-path="`url(#${altitudeProfileClipId})`" />
        </svg>
        <div class="cbp-climb-profile-cursor" :style="{ left: `${altitudeProfileSample.posX}%` }">
          <span
            class="cbp-climb-profile-remain"
            :style="{
              top: `${altitudeProfileSample.topY}%`,
              height: `${Math.max(0, altitudeProfileSample.posY - altitudeProfileSample.topY)}%`,
            }"
          ></span>
          <span class="cbp-climb-profile-dot" :style="{ top: `${altitudeProfileSample.posY}%` }"></span>
        </div>
      </div>
    </div>

    <!-- Courbe de puissance -----------------------------------------------
         La meilleure moyenne tenue depuis le départ, par durée — calculée
         par l'appli à partir de son propre capteur, jamais ici (voir
         `sanitize_block` : `power_curve` ne vérifie rien au-delà du mode
         générique). `table` une ligne par durée, `chart` la même courbe en
         graphique. -->
    <template v-else-if="block.kind === 'power_curve'">
      <div v-if="!shape.powerCurveChart" class="cbp-card" :style="overrideStyle">
        <div class="cbp-title">Courbe de puissance</div>
        <div v-for="point in POWER_CURVE_SAMPLE" :key="point.duration" class="cbp-stat">
          <span>{{ point.duration }}</span><b>{{ point.watts }} W</b>
        </div>
      </div>
      <div v-else class="cbp-card cbp-power-curve" :style="overrideStyle">
        <div class="cbp-title">Courbe de puissance</div>
        <div class="cbp-power-curve-graph">
          <svg class="cbp-power-curve-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline
              :points="powerCurvePolyline"
              fill="none"
              stroke="#ffa726"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
            <circle v-for="(p, i) in powerCurvePoints" :key="i" :cx="p.x" :cy="p.y" r="1.6" fill="#ffa726" />
          </svg>
        </div>
      </div>
    </template>

    <!-- Tendance -- cardio ou puissance dans le temps, toute la sortie ou une
         fenêtre récente (`window_s`) : même dessin dans les deux cas, seule
         la portée change, et l'éditeur n'a pas de sortie en cours pour
         montrer la différence. -------------------------------------------- -->
    <div v-else-if="block.kind === 'metric_trend'" class="cbp-card cbp-metric-trend" :style="overrideStyle">
      <div class="cbp-title">{{ metricTrendTitle }}</div>
      <div class="cbp-metric-trend-graph">
        <svg class="cbp-metric-trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path v-for="(seg, i) in metricTrendSegments" :key="i" :d="seg.d" :fill="seg.color" />
          <polyline
            :points="metricTrendPolyline"
            fill="none"
            stroke="rgba(0, 0, 0, 0.55)"
            stroke-width="3"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
          <polyline
            :points="metricTrendPolyline"
            fill="none"
            stroke="#fff"
            stroke-width="1.4"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>

    <!-- Horloge ---------------------------------------------------------
         Même grille qu'une mesure (`rows`, `layoutRows(metricLayout(block))`
         — générique, ne teste jamais `kind`, donc réutilisable telle quelle),
         mais un contenu fixe (nom, icône par défaut, heure figée) plutôt que
         `metricSample`/`metricIcon`, qui attendent une clé de `METRICS`.
         L'heure est purement illustrative — même esprit que `METRIC_SAMPLES` :
         l'éditeur n'a pas d'heure « en cours » à montrer. -->
    <div v-else-if="block.kind === 'clock'" class="cbp-card cbp-metric" :style="overrideStyle">
      <template v-for="row in rows" :key="row.row">
        <div
          class="cbp-metric-row"
          :style="{ flexGrow: ROW_HEIGHT_WEIGHT[row.height], fontSize: `${ROW_HEIGHT_SCALE[row.height]}em` }"
        >
          <div
            v-for="col in row.columns"
            :key="col.col"
            class="cbp-metric-col"
            :class="`cbp-metric-col--${col.col}`"
          >
            <template v-for="token in col.tokens" :key="token">
              <i v-if="token === 'icon'" class="cbp-metric-icon" :class="clockIcon" aria-hidden="true"></i>
              <span v-else-if="token === 'label'" class="cbp-metric-label">{{ clockSample.name }}</span>
              <span v-else-if="token === 'value'" class="cbp-big">{{ clockSample.value }}</span>
            </template>
          </div>
        </div>
      </template>
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
  position: relative;
  background: #1f2226;
  border-radius: 1em;
  padding: 0.8em;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Le badge « Ce tour » d'une mesure posée sur une page Tours — voir la doc de
   `showLapBadge`. Un coin plutôt qu'un titre : une mesure `metric` n'a pas
   forcément de rangée d'étiquette dans sa disposition, contrairement à
   `lap_zones`/`lap_averages` qui préfixent la leur (`lapScope`). */
.cbp-lap-badge {
  position: absolute;
  top: 0.35em;
  left: 0.35em;
  padding: 0.1em 0.4em;
  border-radius: 0.3em;
  background: rgba(0, 0, 0, 0.55);
  font-size: 0.6em;
  line-height: 1.3;
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
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

/* Profil du col : même convention que "Prévisions météo" — le graphique
   profite d'une case généreuse (`flex: 1`), seuls les textes gardent une
   taille fixe en `em`. Le graphique garde son propre fond clair (`#f8f9fa`)
   quel que soit le fond de la carte : les segments colorés et l'aire grise
   « déjà grimpée » en ont besoin pour rester lisibles, même dessin que
   `nav-climb-svg` (`NavClimbCard.vue`). */
.cbp-climb-profile {
  display: flex;
  flex-direction: column;
}
.cbp-climb-profile-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-top: 0.3em;
  flex-shrink: 0;
}
.cbp-climb-profile-progress {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
}
.cbp-climb-profile-gain {
  font-size: 1.3em;
  font-weight: 800;
  color: #c2410c;
}
.cbp-climb-profile-pct {
  font-size: 1em;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.6);
}
.cbp-climb-profile-aside {
  display: flex;
  align-items: center;
  gap: 0.4em;
}
.cbp-climb-profile-dist {
  font-size: 1.1em;
  font-weight: 800;
}
.cbp-climb-profile-grade {
  font-weight: 700;
  font-size: 0.9em;
  padding: 0.1em 0.4em;
  border-radius: 0.4em;
}
.cbp-climb-profile-graph {
  position: relative;
  flex: 1;
  min-height: 0;
  margin-top: 0.5em;
}
.cbp-climb-profile-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0.5em;
  background: #f8f9fa;
}
.cbp-climb-profile-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(17, 24, 39, 0.55);
  transform: translateX(-1px);
}
.cbp-climb-profile-remain {
  position: absolute;
  left: 50%;
  width: 0;
  border-left: 2px dashed #f97316;
  transform: translateX(-1px);
}
.cbp-climb-profile-dot {
  position: absolute;
  left: 50%;
  width: 0.7em;
  height: 0.7em;
  background: #111827;
  border: 2px solid #fff;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

/* Fond sombre et non clair (#f8f9fa) comme le profil d'altitude ci-dessus :
   celui-là en a besoin pour que ses segments de pente colorés restent
   lisibles, la courbe de puissance n'a qu'un trait — même fond que les
   cartes du tableau de bord (#1F2226, `BlockCard.background`), à peine
   assombri pour se distinguer d'elles. */
.cbp-power-curve {
  display: flex;
  flex-direction: column;
}
.cbp-power-curve-graph {
  position: relative;
  flex: 1;
  min-height: 0;
  margin-top: 0.5em;
}
.cbp-power-curve-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0.5em;
  background: #14161a;
}

/* Même fond sombre que la courbe de puissance ci-dessus : c'est lui qui rend
   les aplats de zone saturés (`ZONE_COLORS`) lisibles, même raison que le
   fond des cartes du tableau de bord (#1F2226, `BlockCard.background`). */
.cbp-metric-trend {
  display: flex;
  flex-direction: column;
}
.cbp-metric-trend-graph {
  position: relative;
  flex: 1;
  min-height: 0;
  margin-top: 0.5em;
}
.cbp-metric-trend-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0.5em;
  background: #14161a;
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

/* La disposition d'un bloc `metric` : des rangées empilées, remplissant la
   carte du haut vers le bas — pas de `cbp-center` — chacune avec sa part de
   la hauteur réelle (`flex-grow`, voir `ROW_HEIGHT_WEIGHT`) plutôt qu'un
   bloc de contenu recentré avec du vide au-dessus et en dessous ; ses
   rangées doivent aussi s'étirer sur toute la largeur pour que l'alignement
   gauche/centre/droite ait un bord réel à viser (voir `cbp-metric-row`).
   Une rangée sans occupant n'y figure pas. */
.cbp-metric {
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  text-align: center;
}
/* Le motif « barre d'outils » : gauche et droite ne prennent que la place que
   réclame leur contenu (`flex: 0 1 auto`, la valeur par défaut — elles
   peuvent encore se réduire si les trois colonnes sont chargées à la fois,
   d'où l'ellipse sur `.cbp-metric-label`/`.cbp-metric-unit`), seul le centre
   absorbe ce qu'il reste (`flex: 1 1 0`). Une seule colonne occupée récupère
   ainsi toute la largeur de la rangée plutôt qu'un tiers fixe — et touche
   vraiment le bord qu'on lui a donné, gauche ou droite, au lieu d'être
   écrasée dans un tiers trop étroit pour son texte. */
.cbp-metric-row {
  display: flex;
  align-items: center;
  width: 100%;
  /* `flex-grow` posé en ligne (`ROW_HEIGHT_WEIGHT[row.height]`) — 1/2/4
     selon la rangée, une jauge (`.cbp-metric-gauge-row`, pas ici) gardant
     elle sa hauteur naturelle sans jamais grossir. */
}
.cbp-metric-col {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.3em;
  overflow: hidden;
}
.cbp-metric-col--left {
  justify-content: flex-start;
}
.cbp-metric-col--center {
  flex: 1 1 0;
  justify-content: center;
}
.cbp-metric-col--right {
  justify-content: flex-end;
}
.cbp-metric-icon {
  font-size: 1.4em;
  opacity: 0.7;
  flex: none;
}
.cbp-metric-label {
  font-size: 1.05em;
  font-weight: 700;
  text-transform: uppercase;
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-metric-unit {
  font-size: 0.9em;
  opacity: 0.6;
  text-transform: uppercase;
  white-space: nowrap;
}
/* Une annotation de coin reste petite à dessein : c'est un repère à côté du
   chiffre principal, pas une seconde carte dans la carte — pas d'icône ni
   d'unité, contrairement aux jetons classiques. `font-size` posé en ligne
   (`SECONDARY_SIZE_SCALE[slot.size]`) — 0.7/1.1/1.6em selon la taille réglée
   sur l'annotation, `.cbp-metric-secondary-label` suit en cascade via son
   propre `em`. */
.cbp-metric-secondary {
  font-weight: 500;
  white-space: nowrap;
}
.cbp-metric-secondary-label {
  font-size: 0.85em;
  opacity: 0.6;
  text-transform: uppercase;
  margin-right: 0.2em;
}
.cbp-metric-gauge-row {
  width: 100%;
}

.cbp-gauge {
  display: flex;
  gap: 0.15em;
  width: 100%;
}
/* `height`/`border-radius` posés en ligne (`gaugeThicknessScale` ×
   0.6em/0.15em) — voir `Block.gauge_thickness`. */
.cbp-gauge-cell {
  flex: 1;
}

/* Le remplissage de la jauge dynamique : une piste continue, pas des
   paliers — la plage y est une vraie progression (min/max de la sortie, ou
   vers l'arrivée), pas des seuils entre lesquels un dégradé mentirait. Plus
   épaisse que `.cbp-gauge-cell` à épaisseur égale : c'est elle qui porte
   l'information ici, pas des paliers à côté d'un chiffre déjà lisible seul —
   même hauteur naturelle que `.cbp-bar`, les deux valant
   `BlockMetrics.natural.barHeight` côté appli avant tout réglage
   d'épaisseur. `height`/`border-radius` posés en ligne (`gaugeThicknessScale`
   × 1.6em/0.3em) — voir `Block.gauge_thickness`. */
.cbp-dyngauge-track {
  position: relative;
  width: 100%;
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

/* Précipitations : le radar est une carte sans marge (les tuiles couvrent
   toute la case côté appli), une poignée de taches floues tenant lieu de
   précipitations, et un repère fixe au centre pour le cycliste. */
.cbp-precip {
  padding: 0;
  position: relative;
}
.cbp-precip-radar {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 1em;
  overflow: hidden;
  background: #10151c;
}
.cbp-precip-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(0.5em);
  opacity: 0.75;
}
/* #2E9E4F / #2E6FD6 / #E0C000 : mêmes teintes que ZONE_COLORS (z2/z1/z3). */
.cbp-precip-blob--1 {
  width: 60%;
  height: 60%;
  top: -10%;
  left: 5%;
  background: radial-gradient(circle, #2e9e4f, transparent 70%);
}
.cbp-precip-blob--2 {
  width: 45%;
  height: 45%;
  bottom: -8%;
  right: 0%;
  background: radial-gradient(circle, #2e6fd6, transparent 70%);
}
.cbp-precip-blob--3 {
  width: 32%;
  height: 32%;
  top: 38%;
  left: 42%;
  background: radial-gradient(circle, #e0c000, transparent 70%);
}
.cbp-precip-rider {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0.8em;
  height: 0.8em;
  margin: -0.4em;
  border-radius: 50%;
  background: #fff;
  border: 0.15em solid #000;
  box-shadow: 0 0 0 0.15em rgba(255, 255, 255, 0.5);
}

.cbp-empty {
  flex: 1;
  border: 1px dashed rgba(255, 255, 255, 0.25);
  border-radius: 1em;
}

/* Orage qui arrive : remplit toute la case, comme `precip_radar` — pas figée
   à une taille naturelle réduite comme la plupart des cartes de texte, une
   frise de barres profite d'une case généreuse (barres plus hautes, mieux
   lisibles). Seul le texte garde une taille fixe (`em`, comme le reste de la
   vignette) ; c'est la zone des barres qui s'étire (`flex: 1`), même
   convention que `precip_forecast_block.dart` côté appli. */
.cbp-precip-forecast {
  display: flex;
  flex-direction: column;
}
.cbp-precip-headline {
  font-size: 1.1em;
  font-weight: 600;
  margin-top: 0.3em;
  flex-shrink: 0;
}
.cbp-precip-bars {
  display: flex;
  align-items: flex-end;
  gap: 0.2em;
  flex: 1;
  min-height: 0;
  margin-top: 0.6em;
}
.cbp-precip-bar {
  flex: 1;
  min-width: 0;
  border-radius: 0.15em;
}
.cbp-precip-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 0.2em;
  font-size: 0.75em;
  color: rgba(255, 255, 255, 0.6);
}

/* Prévisions météo : même convention que "Orage qui arrive" juste au-dessus —
   le graphique profite d'une case généreuse (`flex: 1`), seuls les textes
   (titre, labels, légende) gardent une taille fixe en `em`. */
.cbp-weather {
  display: flex;
  flex-direction: column;
}
.cbp-weather-chart {
  flex: 1;
  min-height: 0;
  width: 100%;
  margin-top: 0.4em;
}
.cbp-weather-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 0.2em;
  font-size: 0.75em;
  color: rgba(255, 255, 255, 0.6);
}
.cbp-weather-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6em;
  margin-top: 0.3em;
  font-size: 0.7em;
  color: rgba(255, 255, 255, 0.75);
}
.cbp-weather-legend-item {
  display: flex;
  align-items: center;
  gap: 0.3em;
}
.cbp-weather-legend-item .cbp-dot {
  width: 0.6em;
  height: 0.6em;
}

/* Météo compacte : trois lignes centrées verticalement, taille naturelle —
   contrairement à "Prévisions météo" juste au-dessus, rien ici ne profite
   d'une case généreuse (pas de graphique à étirer), donc pas de `flex: 1`. */
.cbp-weather-compact {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 100%;
}
.cbp-weather-compact-row {
  display: flex;
  align-items: center;
  gap: 0.4em;
  margin-top: 0.5em;
}
.cbp-weather-compact-label {
  flex: 1;
  min-width: 0;
  font-size: 0.85em;
  color: rgba(255, 255, 255, 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-weather-compact-value {
  font-size: 1em;
  font-weight: 600;
}
.cbp-weather-compact-trend {
  font-size: 0.85em;
  color: rgba(255, 255, 255, 0.75);
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

/* Tronçon en cours / temps restant : icône + figure, même gabarit que le
   chiffre du budget de charge (`cbp-budget-figure`) mais sous un nom propre —
   ce ne sont pas les mêmes données. */
.cbp-workout-row {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin-top: 0.3em;
}
.cbp-workout-icon {
  flex: none;
  opacity: 0.85;
  font-size: 1.3em;
}
.cbp-workout-figure {
  font-size: 1.6em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

/* `workout_status` en mode `line` : icône, nom (cède la place en premier),
   temps restant — jamais tronqué. */
.cbp-workout-line {
  display: flex;
  align-items: center;
  gap: 0.5em;
}
.cbp-workout-line-name {
  flex: 1;
  min-width: 0;
  font-size: 1.3em;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cbp-workout-line-figure {
  flex: none;
  font-size: 1.3em;
  font-weight: 500;
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
