import { ref, computed, type Ref } from 'vue'
import { buildDebugClimb } from '../navHelpers'
import type { TurnHint, ClimbInfo } from '../navHelpers'
import type { Maneuver } from '../routeHelpers'
import { categoryForType } from '../poiCategories'
import { playManeuver, playPoi } from '../navAudio'
import { radarStore } from '../stores/radarStore'

// Bandeau de notification d'un POI à proximité (bas d'écran + veille).
export interface NavPoiHint { name: string; icon: string; color: string; distM: number }

// Un scénario de virage factice du panneau de débug.
export interface DebugTurnScenario {
  label: string
  state: 'far' | 'near' | 'now'
  kind: Maneuver
  direction: 'left' | 'right'
  angle: number
  distM: number
  exitNumber?: number
  follow?: TurnHint[]
}

// Scénarios de virage parcourus en boucle (un clic = scénario suivant, puis « off »).
// Couvre chaque état visuel : lointain (gris), approche (violet), urgent (orange),
// rond-point (numéro de sortie), rafale (virages enchaînés) et virage atteint (vert).
// `turnUrgentM` vient du profil du sport suivi : la distance du scénario « Urgent »
// doit tomber sous ce seuil pour déclencher le rendu orange.
export function debugTurnScenarios(turnUrgentM: number): DebugTurnScenario[] {
  return [
    { label: 'Lointain', state: 'far', kind: 'turn', direction: 'right', angle: 60, distM: 850 },
    { label: 'Approche', state: 'near', kind: 'turn', direction: 'left', angle: -70, distM: 180 },
    { label: 'Urgent', state: 'near', kind: 'sharp', direction: 'right', angle: 110, distM: Math.min(turnUrgentM, 40) },
    { label: 'Rond-point', state: 'near', kind: 'roundabout', direction: 'right', angle: 90, distM: 120, exitNumber: 2 },
    { label: 'Rafale', state: 'near', kind: 'turn', direction: 'left', angle: -80, distM: 90, follow: [
      { direction: 'right', distM: 120, kind: 'turn', angle: 85, state: 'near' },
      { direction: 'left', distM: 155, kind: 'sharp', angle: -110, state: 'near' },
    ] },
    { label: 'Maintenant', state: 'now', kind: 'turn', direction: 'left', angle: -70, distM: 0 },
  ]
}

// Le mode débug est-il actif ? Réservé aux comptes pouvant tout faire (can? :manage,
// :all → prop canDebug), ou forçable via `?debug=1` dans l'URL.
export function debugModeEnabled(canDebug: boolean | undefined, search: string): boolean {
  if (canDebug === true) return true
  try { return new URLSearchParams(search).has('debug') } catch { return false }
}

export interface UseNavDebugOptions {
  canDebug?: boolean
  /** Seuil « urgent » du sport suivi (m) — lu à chaque scénario, il suit le sport. */
  getTurnUrgentM: () => number
  hasFix: Ref<boolean>
  turnHint: Ref<TurnHint | null>
  followTurns: Ref<TurnHint[]>
  climbInfo: Ref<ClimbInfo | null>
  poiHint: Ref<NavPoiHint | null>
  soundOn: Ref<boolean>
}

// Mode débug de la navigation (preview des overlays). Extrait de RouteNavigation.vue.
//
// Il révèle un bouton « flacon » dans le tiroir de commandes qui ouvre un panneau
// permettant d'injecter des données factices pour prévisualiser, sans GPS / col réel /
// radar Varia, les overlays clés :
//   • le radar arrière (RadarOverlay)
//   • la carte de col (climbInfo)
//   • la notification de virage (turnHint)
//   • la notification de POI (poiHint)
//
// Tant qu'une bascule est active, les mises à jour live (updateTurns / updateProgress /
// updatePoiProximity) ne réécrivent PAS l'overlay correspondant : le composant garde les
// gardes `dbgTurn` / `dbgClimb` / `dbgPoi` exposées ici, pour qu'un vrai fix GPS n'efface
// pas l'overlay pendant qu'on l'inspecte. Chaque bascule pose aussi `hasFix` : les
// overlays ne sont rendus qu'une fois le GPS accroché.
export function useNavDebug(opts: UseNavDebugOptions) {
  const { getTurnUrgentM, hasFix, turnHint, followTurns, climbInfo, poiHint, soundOn } = opts

  const debugMode = debugModeEnabled(opts.canDebug, typeof window === 'undefined' ? '' : window.location.search)
  const dbgRadar = ref(false)
  const dbgClimb = ref(false)
  const dbgTurn = ref(false)
  const dbgPoi = ref(false)
  const dbgTurnIdx = ref(0)

  // Libellé du scénario de virage débug en cours (null quand off) — passé au tiroir.
  const dbgTurnLabel = computed(() =>
    dbgTurn.value ? (debugTurnScenarios(getTurnUrgentM())[dbgTurnIdx.value]?.label ?? null) : null,
  )

  // Scénario suivant à chaque appel ; après le dernier, on éteint et on efface l'overlay.
  function cycleDebugTurn() {
    const scenarios = debugTurnScenarios(getTurnUrgentM())
    dbgTurnIdx.value = dbgTurn.value ? dbgTurnIdx.value + 1 : 0
    if (dbgTurnIdx.value >= scenarios.length) {
      dbgTurn.value = false
      turnHint.value = null
      followTurns.value = []
      return
    }
    dbgTurn.value = true
    hasFix.value = true
    const p = scenarios[dbgTurnIdx.value]
    turnHint.value = { direction: p.direction, distM: p.distM, kind: p.kind, angle: p.angle, exitNumber: p.exitNumber, state: p.state }
    followTurns.value = p.follow ?? []
    // Prévisualisation sonore : joue le bip du virage correspondant (comme en vrai).
    if (soundOn.value) playManeuver(p.kind, p.direction)
  }

  function toggleDebugClimb() {
    if (dbgClimb.value) { dbgClimb.value = false; climbInfo.value = null; return }
    dbgClimb.value = true
    hasFix.value = true
    climbInfo.value = buildDebugClimb()
  }

  // Notification POI factice : épingle un bandeau « boulangerie » à 80 m pour
  // prévisualiser le rendu (bas d'écran, et en veille via NavScreenOff) sans devoir
  // passer à portée d'un vrai POI.
  function toggleDebugPoi() {
    if (dbgPoi.value) { dbgPoi.value = false; poiHint.value = null; return }
    dbgPoi.value = true
    hasFix.value = true
    const cat = categoryForType('bakery')
    poiHint.value = {
      name: 'Boulangerie du Col',
      icon: cat?.icon ?? 'fa-location-dot',
      color: cat?.color ?? '#6b7280',
      distM: 80,
    }
    // Prévisualisation sonore : joue la ritournelle d'approche POI (comme en vrai).
    if (soundOn.value) playPoi()
  }

  // Radar factice : on passe le store en « connecté » sans Bluetooth (pas de watchdog,
  // donc les cibles persistent) et on injecte deux voitures, dont une sous le seuil
  // rapproché → bandeau rouge « Attention » + alertes sonores (via le watch existant).
  function toggleDebugRadar() {
    if (dbgRadar.value) { dbgRadar.value = false; radarStore.reset(); return }
    dbgRadar.value = true
    radarStore.status.value = 'connected'
    radarStore.setTargets([
      { id: 1, distanceM: 18, speedMps: 9 },
      { id: 2, distanceM: 72, speedMps: 6 },
    ])
  }

  return {
    debugMode, dbgRadar, dbgClimb, dbgTurn, dbgPoi, dbgTurnLabel,
    cycleDebugTurn, toggleDebugClimb, toggleDebugPoi, toggleDebugRadar,
  }
}
