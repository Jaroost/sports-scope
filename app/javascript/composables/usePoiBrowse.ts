import { ref, computed, type Ref } from 'vue'
import { t } from '../i18n'
import { haversine } from '../routeHelpers'
import type { LngLat } from '../routeHelpers'
import { categoryForType } from '../poiCategories'
import type { NavPlace } from './useNavPois'

// Une catégorie de POI du registre (POI_CATS) — seuls ces champs sont lus ici.
interface PoiCat { key: string; icon: string; color: string; labelKey: string }

export interface UsePoiBrowseOptions {
  getMap: () => any
  // POI actuellement visibles (issus de useNavPois) et catégories du registre. Accesseur
  // (et non Ref) : lu dans un computed, il y enregistre quand même sa dépendance réactive.
  getVisiblePlaces: () => NavPlace[]
  poiCats: PoiCat[]
  openPlacePopup: (place: NavPlace) => void
  closePlacePopup: () => void
  // Suivi caméra : le parcours le débraye (following=false) pour voler de POI en POI.
  following: Ref<boolean>
  cameraUnlocked: Ref<boolean>
  // Accès paresseux à des valeurs non réactives du composant (hauteur carte, dernier fix GPS).
  getContainerH: () => number
  getLastPos: () => LngLat | null
  // Referme le tiroir de commandes pour dégager la vue pendant le parcours.
  hideControls: () => void
}

// Parcours des POI de la navigation guidée : enchaîne les POI visibles, du plus proche au
// plus loin, en faisant voler la caméra sur chacun (zoom rapproché) et en affichant sa
// distance depuis la position courante. Extrait de RouteNavigation.vue.
//
// L'ordre est figé au lancement (tri par distance) : seule la distance affichée se met à
// jour en roulant, l'index ne saute pas. La caméra est détachée (following=false) le temps
// du parcours ; le bouton « Recentrer » du composant la ramène sur le coureur.
export function usePoiBrowse(opts: UsePoiBrowseOptions) {
  const {
    getMap, getVisiblePlaces, poiCats, openPlacePopup, closePlacePopup,
    following, cameraUnlocked, getContainerH, getLastPos, hideControls,
  } = opts

  // Compteur réactif incrémenté à chaque fix GPS (via bumpPosTick) : `lastPos` est non
  // réactif (gros volume, lu dans des callbacks), ce tick permet aux computed dépendants de
  // la position (distance du POI parcouru) de se recalculer en roulant.
  const posTick = ref(0)
  function bumpPosTick() { posTick.value++ }

  const poiBrowseActive = ref(false)
  const poiBrowseIndex = ref(0)
  // Liste complète des POI à parcourir (tous les POI visibles, triés par distance au
  // lancement). Le filtre par catégorie s'applique par-dessus sans retoucher cette liste,
  // pour qu'un changement de filtre ne rejoue pas le tri.
  const poiBrowseAll = ref<NavPlace[]>([])
  // Catégorie de POI parcourue (clé du registre POI) ou null = toutes les catégories.
  const poiBrowseFilter = ref<string | null>(null)
  const poiBrowseCount = computed(() => getVisiblePlaces().length)
  // Liste effectivement parcourue : la liste complète filtrée par la catégorie choisie.
  const poiBrowseList = computed(() =>
    poiBrowseFilter.value
      ? poiBrowseAll.value.filter((p) => categoryForType(p.type)?.key === poiBrowseFilter.value)
      : poiBrowseAll.value,
  )
  // Catégories présentes dans la liste, dans l'ordre du registre, avec leur nombre de POI :
  // alimente le menu déroulant de filtre du bandeau de parcours. On ne propose que les
  // catégories effectivement trouvées (filtrer sur une catégorie vide n'aurait aucun sens).
  const poiBrowseCats = computed(() => {
    const counts = new Map<string, number>()
    for (const p of poiBrowseAll.value) {
      const k = categoryForType(p.type)?.key
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return poiCats
      .filter((c) => counts.has(c.key))
      .map((c) => ({ key: c.key, icon: c.icon, color: c.color, labelKey: c.labelKey, count: counts.get(c.key)! }))
  })
  const poiBrowseCurrent = computed(() => poiBrowseList.value[poiBrowseIndex.value] ?? null)
  // Distance live (recalculée quand `lastPos` change via posTick) du POI courant à la position.
  const poiBrowseDistM = computed(() => {
    posTick.value   // dépendance : force le recalcul à chaque fix GPS
    const cur = poiBrowseCurrent.value
    const here = getLastPos()
    return cur && here ? haversine(here, [cur.lng, cur.lat]) : 0
  })
  const poiBrowseHint = computed(() => {
    const cur = poiBrowseCurrent.value
    if (!cur) return null
    const cat = categoryForType(cur.type)
    return {
      name: cur.name || t('routes.point_of_interest'),
      icon: cat?.icon ?? 'fa-location-dot',
      color: cat?.color ?? '#6b7280',
    }
  })

  function startPoiBrowse() {
    const list = [...getVisiblePlaces()]
    const here = getLastPos()
    if (here) {
      list.sort((a, b) => haversine(here, [a.lng, a.lat]) - haversine(here, [b.lng, b.lat]))
    }
    if (list.length === 0) return
    // Le parcours prend la carte et le bas de l'écran : on referme le tiroir tout de suite
    // (sans attendre l'auto-masquage) pour dégager la vue et laisser la place au bandeau de
    // parcours. Rien à masquer si la liste est vide : on n'arrive pas ici.
    hideControls()
    poiBrowseAll.value = list
    poiBrowseFilter.value = null   // on parcourt toutes les catégories par défaut
    poiBrowseIndex.value = 0
    poiBrowseActive.value = true
    focusBrowsePlace()
  }

  // Change la catégorie parcourue (null = toutes) : on repart du premier POI de la liste
  // filtrée et on recadre la caméra dessus. Le menu ne propose que des catégories présentes,
  // donc poiBrowseCurrent est normalement défini après le filtrage.
  function setPoiBrowseFilter(key: string | null) {
    poiBrowseFilter.value = key
    poiBrowseIndex.value = 0
    if (poiBrowseCurrent.value) focusBrowsePlace()
  }

  function focusBrowsePlace() {
    const place = poiBrowseCurrent.value
    const map = getMap()
    if (!place || !map) return
    // Détache la caméra : la boucle de rendu ne touchera plus la vue (cf. `tick`,
    // `if (following.value)`), seul le marqueur de position continue de bouger.
    following.value = false
    cameraUnlocked.value = true
    // La moitié basse de l'écran est occupée (bandeau de parcours, barre du bas, tiroir de
    // commandes déployé depuis le bas) : on cadre le POI au centre de la moitié HAUTE, via
    // un padding bas d'une demi-hauteur, pour le voir avec sa bulle. Le padding reste posé
    // sur la caméra, mais toute reprise du suivi le réécrit (cf. followPadding).
    const h = getContainerH() || map.getContainer()?.clientHeight || 0
    map.flyTo({
      center: [place.lng, place.lat],
      zoom: 16,
      pitch: 0,
      bearing: 0,
      duration: 700,
      padding: { top: 0, bottom: Math.round(h / 2), left: 0, right: 0 },
    })
    openPlacePopup(place)
  }

  // Suivant / précédent en boucle : depuis le dernier POI on revient au premier, et depuis
  // le premier on saute au dernier (modulo la longueur de la liste filtrée).
  function browseNext() {
    const n = poiBrowseList.value.length
    if (n === 0) return
    poiBrowseIndex.value = (poiBrowseIndex.value + 1) % n
    focusBrowsePlace()
  }

  function browsePrev() {
    const n = poiBrowseList.value.length
    if (n === 0) return
    poiBrowseIndex.value = (poiBrowseIndex.value - 1 + n) % n
    focusBrowsePlace()
  }

  function stopPoiBrowse() {
    poiBrowseActive.value = false
    closePlacePopup()
  }

  return {
    poiBrowseActive, poiBrowseIndex, poiBrowseFilter,
    poiBrowseCount, poiBrowseList, poiBrowseCats, poiBrowseDistM, poiBrowseHint,
    startPoiBrowse, setPoiBrowseFilter, browseNext, browsePrev, stopPoiBrowse,
    bumpPosTick,
  }
}
