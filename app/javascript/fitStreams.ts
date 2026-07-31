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
