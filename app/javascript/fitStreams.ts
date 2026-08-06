// Trous dans les flux d'un `.fit`.
//
// Un `.fit` peut ne rien savoir d'une mesure à certaines secondes : départ à
// l'intérieur d'un bâtiment (le GPS n'a pas encore accroché), tunnel, gorge.
// Le format marque alors le champ « invalide » (`0x7FFFFFFF` pour une position)
// et fit-file-parser le rend à `undefined` — un trou, pas un zéro.
//
// On ne peut pas retirer l'échantillon : les flux à la forme Strava sont des
// tableaux parallèles indexés par la même seconde que `time`, et en sortir un
// point désalignerait tout le reste — cardio, puissance, bornes des tours.
//
// Reste à choisir ce qu'on met dans le trou. `?? 0` était le choix d'avant, et
// il est faux deux fois :
//
//   • en position, `[0, 0]` est l'île Null, au large du golfe de Guinée : la
//     trace descend de Suisse à l'équateur et remonte, sur le premier point ;
//   • en altitude, 0 m devant un départ à 1 120 m invente 1 120 m de D+ et une
//     pente absurde dans `grade_smooth`.
//
// La valeur connue la plus proche, elle, ne déplace le cycliste nulle part :
// avant son premier point GPS il est immobile là où il finira par l'accrocher,
// et dans un tunnel il reste à l'entrée jusqu'à en ressortir. La distance, elle,
// vient du compteur et n'est pas concernée.
export function fillHoles<T>(values: (T | null | undefined)[]): (T | null)[] {
  const out: (T | null)[] = values.map((v) => (v == null ? null : v))
  // Report en avant : remplit tout ce qui suit la première valeur connue.
  for (let i = 1; i < out.length; i++) {
    if (out[i] == null) out[i] = out[i - 1]
  }
  // Puis en arrière, ce qui ne laisse que la tête du tableau à combler — le cas
  // du départ sans fix, justement.
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i] == null) out[i] = out[i + 1]
  }
  return out
}

// Sauts GPS d'un `.fit` enregistré au fond d'une poche.
//
// Un trou (voir `fillHoles` ci-dessus) est un point que l'appareil sait ne pas
// avoir : le champ est marqué invalide. Un saut est pire — le GPS *croit* sa
// position, et se trompe de plusieurs dizaines à centaines de mètres d'un
// échantillon au suivant avant de revenir. Un téléphone en poche multiplie ces
// sauts (pas de vue dégagée du ciel, rebonds sur le corps) : sur une sortie de
// comparaison, un seul échantillon impliquait plus de 400 km/h.
//
// Ce nettoyage ne sert qu'à la trace *dessinée* (carte, tracé du parcours) —
// jamais à recalculer la distance ou le D+. L'appli compagnon (`ride_recorder.dart`,
// `handleFix`) filtre déjà l'accumulateur de distance à l'enregistrement : un
// plancher de déplacement contre la dérive à l'arrêt (`_minStepM`), un plafond
// de vitesse contre les sauts de récepteur (`_maxStepMps`), une précision
// minimale (`_maxAccuracyM`). C'est ce total déjà propre que porte `session.
// total_distance` / le champ `distance` de chaque `record` — recalculer une
// distance à partir de la position brute ci-dessous referait, moins bien, ce
// que l'appareil a déjà fait : sur la sortie de comparaison, la somme des
// écarts point à point donnait 13,4 km contre 11,5 km au compteur de l'appareil
// (et un tracé de référence à 7,2 km) — la position brute porte encore assez de
// bruit, même hors saut, pour gonfler une simple somme de segments sur des
// milliers d'échantillons. Seule la *position* affichée profite donc de ce
// filtre ; la distance, le D+ et tout ce qui en dépend restent sur le compteur
// de l'appareil.
//
// Vitesse horizontale au-delà de laquelle un point est un saut, pas un
// déplacement réel. Calée sur la plus rapide sortie que l'appli enregistre —
// une descente à vélo peut approcher les 90 km/h dans une bonne pente — donc
// très en dessous des sauts observés en poche. Un point qui la dépasse est
// retenu à la dernière position plausible plutôt que d'avancer : contrairement
// à la marche de calibration de l'altitude (un décalage constant qu'on corrige
// en décalant toute la suite), un saut de position n'a pas de décalage stable
// à répercuter — le tenir est la seule correction qui ne fausse pas le reste
// de la trace.
const MAX_HORIZONTAL_SPEED_MS = 25

// Au-delà de cette durée tenue sur la même position, mieux vaut accepter le
// point suivant tel quel que rester bloqué indéfiniment : le porteur a pu
// réellement s'éloigner pendant que le GPS était perdu (signal repris ailleurs
// qu'où on le retenait), et une vraie sortie ne reste jamais figée cinq minutes.
const MAX_HOLD_S = 300

// `points` doit déjà être comblé (`fillHoles`) : seuls les trous de tête/queue
// peuvent encore porter `null`, enjambés comme les trous d'altitude.
export function despikeLatLng(
  points: ([number, number] | null)[],
  time: number[],
  maxSpeedMps = MAX_HORIZONTAL_SPEED_MS
): ([number, number] | null)[] {
  const out = points.slice()
  let anchor = out.findIndex((p) => p != null)
  if (anchor === -1) return out
  for (let i = anchor + 1; i < out.length; i++) {
    const p = out[i]
    if (p == null) continue
    const dt = Math.max(1, (time[i] ?? i) - (time[anchor] ?? anchor))
    const d = haversineM(out[anchor] as [number, number], p)
    if (d / dt > maxSpeedMps && dt < MAX_HOLD_S) {
      out[i] = out[anchor]
    } else {
      anchor = i
    }
  }
  return out
}

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}
