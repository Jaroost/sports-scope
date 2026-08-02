import { describe, it, expect } from 'vitest'
import { occupancy, maxSpan, fitCells, type Cell } from './companionSettings'

// Le calcul de place dans une grille de tableau de bord.
//
// Il existe parce que l'assainisseur du serveur retire les cellules qui se
// recouvrent — et il a raison de le faire, mais s'il était le seul garde-fou,
// l'éditeur laisserait étendre une cellule par-dessus sa voisine et la voisine
// disparaîtrait à l'enregistrement. On borne donc l'étendue **avant** de la
// proposer : on ne peut pas composer ce qui sera jeté.

function cell(row: number, col: number, rowSpan = 1, colSpan = 1): Cell {
  return { row, col, row_span: rowSpan, col_span: colSpan, block: { kind: 'empty' } }
}

describe('occupancy', () => {
  it('marque toutes les cases d\'une fusion, pas seulement son origine', () => {
    const merged = cell(0, 0, 2, 3)
    const map = occupancy([merged])

    expect(map.size).toBe(6)
    expect(map.get('1:2')).toBe(merged)
    expect(map.get('2:0')).toBeUndefined()
  })
})

describe('maxSpan', () => {
  it('s\'arrête au bord de la grille', () => {
    const target = cell(0, 1)
    expect(maxSpan(target, [target], 3, 3, 'col')).toBe(2)
    expect(maxSpan(target, [target], 3, 3, 'row')).toBe(3)
  })

  it('s\'arrête avant la voisine', () => {
    // C'est tout l'objet du calcul : proposer 3 ici laisserait composer un
    // recouvrement que le serveur retirerait ensuite en silence.
    const target = cell(0, 0)
    const neighbour = cell(0, 2)

    expect(maxSpan(target, [target, neighbour], 1, 4, 'col')).toBe(2)
  })

  it('ignore la cellule elle-même', () => {
    // Elle a le droit d'occuper sa propre place : sans ça, une cellule déjà
    // fusionnée ne pourrait jamais être réduite ni ré-étendue.
    const target = cell(0, 0, 1, 2)

    expect(maxSpan(target, [target], 1, 3, 'col')).toBe(3)
  })

  it('rend 1 quand la case d\'à côté est déjà prise', () => {
    // Et pas zéro : une cellule occupe toujours au moins sa propre case. Le
    // plancher est donc 1, ce qui borne le champ à sa valeur courante — on ne
    // peut simplement pas s'étendre.
    const target = cell(0, 0)
    const neighbour = cell(0, 1)

    expect(maxSpan(target, [target, neighbour], 1, 2, 'col')).toBe(1)
  })
})

describe('fitCells', () => {
  it('rogne une étendue qui déborde plutôt que de perdre la cellule', () => {
    // Réduire une grille dans l'éditeur ne doit pas faire disparaître les
    // composants qu'on y avait posés.
    const kept = fitCells([cell(0, 0, 1, 4)], 2, 2)

    expect(kept).toHaveLength(1)
    expect(kept[0].col_span).toBe(2)
  })

  it('perd une cellule dont l\'origine sort de la grille', () => {
    // Contrairement à l'étendue, elle n'a aucune interprétation raisonnable : on
    // ne devine pas où l'utilisateur voulait la remettre. Même arbitrage que
    // l'assainisseur, pour que l'écran et l'enregistrement disent la même chose.
    const kept = fitCells([cell(0, 0), cell(3, 3)], 2, 2)

    expect(kept).toHaveLength(1)
    expect(kept[0].row).toBe(0)
  })
})
