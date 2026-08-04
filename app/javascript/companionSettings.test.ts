import { describe, it, expect } from 'vitest'
import {
  occupancy, maxSpan, fitCells, gridSideOf, blockChoices, blockFor, blockShape, isChoiceOf, metricSample,
  averagesCardsFit, budgetContextFits, canHideBehindMenu, densityFor, legendFits, phoneCell, PHONE_GRID,
  recordingIsCompact, changeRouteIsCompact, clearRouteIsCompact, sameDrawing, zoneCount,
  type Block, type Catalog, type Cell, type Page,
} from './companionSettings'

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

// Le choix d'un composant, tel que la dialogue à vignettes le compose.

const catalog: Catalog = {
  page_kinds: ['map', 'grid', 'list'],
  blocks: { metric: ['big', 'compact'], zones: ['bar'], empty: [] },
  zone_sources: ['hr', 'power'],
  metrics: ['speed', 'power'],
  sensors: ['gps'],
  max_band_metrics: 4,
  max_grid_side: 6,
}

describe('blockChoices', () => {
  it('déplie une vignette par mode, dans l\'ordre du catalogue', () => {
    // C'est le mode qui décide du dessin : une vignette par genre ne montrerait
    // qu'un mode sur quatre, et le choix se ferait à nouveau en aveugle.
    expect(blockChoices(catalog)).toEqual([
      { kind: 'metric', mode: 'big' },
      { kind: 'metric', mode: 'compact' },
      { kind: 'zones', mode: 'bar' },
      { kind: 'empty' },
    ])
  })

  it('garde une vignette au genre sans mode', () => {
    // La case vide n'en a aucun. Sans cette entrée, le seul moyen de dire « je
    // ne mets rien ici » disparaîtrait de la dialogue.
    expect(blockChoices({ ...catalog, blocks: { empty: [] } })).toEqual([{ kind: 'empty' }])
  })
})

describe('blockFor', () => {
  it('ne garde que les clés que le genre réclame', () => {
    // Une clé morte — `metric` sur un bloc `zones` — serait retirée par
    // l'assainisseur : ce qu'on voit et ce qui part diffèreraient.
    const zones = blockFor({ kind: 'zones', mode: 'bar' }, { metric: 'speed', source: 'power' })

    expect(zones).toEqual({ kind: 'zones', mode: 'bar', source: 'power' })

    const metric = blockFor({ kind: 'metric', mode: 'big' }, { metric: 'speed', source: 'power' })

    expect(metric).toEqual({ kind: 'metric', mode: 'big', metric: 'speed' })
  })

  it('n\'écrit pas de mode pour un genre qui n\'en a pas', () => {
    expect(blockFor({ kind: 'empty' }, {})).toEqual({ kind: 'empty' })
  })
})

describe('isChoiceOf', () => {
  it('ignore le paramètre du genre', () => {
    // La mesure se règle à part, en tête du groupe : deux vignettes du même mode
    // ne diffèrent jamais que par elle, et le liseré doit rester sur celle du
    // mode courant quoi qu'on choisisse au-dessus.
    const block = { kind: 'metric', mode: 'big', metric: 'power' }

    expect(isChoiceOf(block, { kind: 'metric', mode: 'big' })).toBe(true)
    expect(isChoiceOf(block, { kind: 'metric', mode: 'compact' })).toBe(false)
  })

  it('ne désigne rien quand on ajoute un composant', () => {
    expect(isChoiceOf(null, { kind: 'metric', mode: 'big' })).toBe(false)
  })
})

describe('metricSample', () => {
  it('rend le tiret d\'une mesure inconnue de cette version', () => {
    // Et pas un chiffre inventé : c'est exactement ce que le téléphone affichera
    // d'une mesure qu'il ne sait pas lire — jamais un zéro, qui se lirait comme
    // une mesure.
    expect(metricSample('cadence_std').value).toBe('—')
    expect(metricSample(undefined).value).toBe('—')
  })

  it('ne donne de zone qu\'aux mesures qui en portent une', () => {
    // C'est elle qui colore l'aplat : une zone sur la cadence peindrait un
    // aperçu que l'appli ne dessinera jamais.
    expect(metricSample('power').zone).toBe('z3')
    expect(metricSample('cadence').zone).toBeUndefined()
  })
})

describe('gridSideOf', () => {
  it('rend 1 pour un champ vide, jamais 0', () => {
    // C'est le bogue du doigt : pour remplacer 6 par 2 on efface d'abord, et un
    // 0 commis au passage rétrécissait la grille à rien — donc perdait toutes
    // les cellules, `fitCells` ne gardant pas une origine hors grille.
    expect(gridSideOf('')).toBe(1)
    expect(gridSideOf('0')).toBe(1)
    expect(gridSideOf('abc')).toBe(1)
    expect(gridSideOf('-3')).toBe(1)
  })

  it('garde un entier', () => {
    expect(gridSideOf('3')).toBe(3)
    // Le plafond est à l'appelant : le catalogue pour une grille, la place
    // libre pour une étendue.
    expect(gridSideOf('12')).toBe(12)
    expect(gridSideOf('2.6')).toBe(3)
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

// ── Ce que le téléphone laissera dessiner ───────────────────────────────────
//
// Ces attentes sont **les mêmes que celles de `test/block_density_test.dart`**
// dans le dépôt voisin, et c'est tout leur intérêt : l'éditeur ne doit rien
// montrer que l'appli retirerait. Quand un seuil bouge là-bas, ces tests
// tombent ici.

describe('phoneCell', () => {
  it('partage la place à parts égales, gouttières comprises', () => {
    // 3 colonnes, 2 gouttières de 8, sur les 328 px que la grille occupe.
    expect(phoneCell(3, 3).width).toBeCloseTo((328 - 16) / 3, 3)
  })

  it('rend à une fusion la gouttière qu\'elle enjambe', () => {
    // Sans quoi deux cases côte à côte et une case de deux colonnes ne
    // couvriraient pas la même largeur — même règle que `gridRectFor`.
    const single = phoneCell(3, 3).width
    expect(phoneCell(3, 3, 1, 2).width).toBeCloseTo(single * 2 + 8, 3)
  })
})

describe('densityFor', () => {
  it('suit la grille comme le fait l\'appli', () => {
    expect(densityFor(phoneCell(2, 2))).toBe('comfortable')
    expect(densityFor(phoneCell(3, 3))).toBe('normal')
    expect(densityFor(phoneCell(4, 3))).toBe('tight')
    expect(densityFor(phoneCell(6, 6))).toBe('minimal')
  })

  it('tient compte de la largeur, même dans une case haute', () => {
    // Quatre colonnes sur deux lignes : 79 px de large pour 295 de haut. C'est
    // large comme un pouce.
    expect(densityFor(phoneCell(2, 4))).toBe('minimal')
  })

  it('sans case, tout se dessine', () => {
    // La dialogue de choix et les pages qui défilent : la hauteur y est libre.
    expect(densityFor(undefined)).toBe('comfortable')
  })
})

describe('legendFits', () => {
  it('retire la légende là où l\'appli la retirera', () => {
    expect(legendFits(phoneCell(3, 3), { zones: 5, withBar: true })).toBe(false)
    expect(legendFits(phoneCell(1, 1), { zones: 5, withBar: true })).toBe(true)
  })

  it('compte les sept paliers de la puissance, pas cinq', () => {
    // Les deux listes viennent du site et n'ont pas la même longueur : une
    // vignette qui en dessinerait cinq des deux côtés promettrait une légende
    // que le téléphone retirerait.
    expect(zoneCount('power')).toBe(7)
    expect(zoneCount('hr')).toBe(5)

    const cell = phoneCell(2, 1)
    expect(legendFits(cell, { zones: 5, withBar: true })).toBe(true)
    expect(legendFits(cell, { zones: 7, withBar: true })).toBe(false)
  })

  it('refuse une case haute mais étroite', () => {
    // Une ligne de légende porte une pastille, une clé, une durée et un
    // pourcentage : c'est en largeur qu'elle sortait de sa case.
    expect(legendFits(phoneCell(1, 2), { zones: 5, withBar: true })).toBe(false)
  })
})

describe('canHideBehindMenu', () => {
  // Une page rangée derrière le menu ne passe plus sous les yeux à chaque
  // glissé : on va la chercher. Le bouton de l'éditeur s'éteint là où le
  // déplacement n'est pas permis, plutôt que d'être corrigé à l'enregistrement —
  // même règle que `maxSpan`, la limite se voit au lieu de se deviner.
  const list = (extra: Partial<Page> = {}): Page => ({
    kind: 'list', title: 'Effort', blocks: [{ kind: 'recording' }], ...extra,
  })

  it('range une page tant qu\'une autre reste au défilement', () => {
    const target = list()
    const pages = [target, list()]

    expect(canHideBehindMenu(target, pages)).toBe(true)
  })

  it('refuse de ranger la dernière page du défilement', () => {
    // Il ne resterait rien à faire défiler, donc aucune page où le menu s'ouvre,
    // donc plus rien du tout. Le serveur la repêcherait (`keep_one_swipeable`),
    // et l'éditeur montrerait entre-temps une composition qui n'existe pas.
    const target = list()
    const pages = [target, list({ menu: true })]

    expect(canHideBehindMenu(target, pages)).toBe(false)
  })

  it('la carte ne peut pas porter le menu à elle seule', () => {
    // Le piège de cette règle. La carte est bien une page du défilement, mais
    // elle ne dessine aucun en-tête — donc aucun menu : le bilan qu'on aurait
    // rangé ne serait atteignable par aucun geste.
    const target = list()
    const pages: Page[] = [{ kind: 'map' }, target]

    expect(canHideBehindMenu(target, pages)).toBe(false)
  })

  it('une page de données de plus suffit à porter le menu', () => {
    const target = list()
    const pages: Page[] = [{ kind: 'map' }, target, list({ title: 'Chiffres' })]

    expect(canHideBehindMenu(target, pages)).toBe(true)
  })

  it('ne range jamais la carte, même bien entourée', () => {
    const map: Page = { kind: 'map' }

    expect(canHideBehindMenu(map, [map, list(), list()])).toBe(false)
  })

  it('ramener au défilement est toujours permis', () => {
    // C'est le sens qui ne peut rien vider : refuser ici enfermerait une page
    // derrière le menu sans moyen de l'en sortir.
    const target = list({ menu: true })

    expect(canHideBehindMenu(target, [target])).toBe(true)
  })
})

describe('les autres replis', () => {
  it('ramène les moyennes en liste dans une case de grille', () => {
    expect(averagesCardsFit(undefined)).toBe(true)
    expect(averagesCardsFit(phoneCell(1, 1))).toBe(true)
    expect(averagesCardsFit(phoneCell(2, 2))).toBe(false)
  })

  it('réduit le bouton d\'enregistrement à son icône quand le libellé ne tient plus', () => {
    expect(recordingIsCompact(phoneCell(1, 1))).toBe(false)
    expect(recordingIsCompact(phoneCell(3, 2))).toBe(true)
  })

  it('réduit les boutons d\'itinéraire à leur icône au même seuil', () => {
    // Ce ne sont, eux aussi, que des boutons — même repli que l'enregistrement.
    expect(changeRouteIsCompact(phoneCell(1, 1))).toBe(false)
    expect(changeRouteIsCompact(phoneCell(3, 2))).toBe(true)
    expect(clearRouteIsCompact(phoneCell(1, 1))).toBe(false)
    expect(clearRouteIsCompact(phoneCell(3, 2))).toBe(true)
  })

  it('retire le contexte du budget avant son chiffre', () => {
    // La fraîcheur et le risque se lisent en diagonale : ils partent les premiers,
    // comme la légende des zones. Ce qui reste — « 62 / 85 » et sa barre — répond
    // encore à la question qu'on se pose au guidon.
    expect(budgetContextFits(undefined)).toBe(true)
    expect(budgetContextFits(phoneCell(1, 1))).toBe(true)
    expect(budgetContextFits(phoneCell(2, 2))).toBe(true)
    // Trois colonnes : deux pastilles côte à côte se marcheraient dessus.
    expect(budgetContextFits(phoneCell(3, 3))).toBe(false)
  })

  it('garde le contexte du budget dans une case large et plate', () => {
    // Une ligne de grille entière : la densité y est minimale (93 px de haut), et
    // pourtant les pastilles tiennent — c'est la largeur qui leur manquait ailleurs.
    expect(densityFor(phoneCell(6, 1))).toBe('minimal')
    expect(budgetContextFits(phoneCell(6, 1))).toBe(true)
  })
})

// Ce que la dialogue de choix compare pour dire « à cette taille, ces deux modes
// donnent le même écran ». Le fait lui-même n'est pas nouveau — c'est ce que
// l'appli dessine depuis toujours — mais il était muet : trois vignettes
// identiques se lisaient comme un bogue de l'éditeur.
describe('sameDrawing', () => {
  function same(a: Block, b: Block, cell?: ReturnType<typeof phoneCell>): boolean {
    return sameDrawing(blockShape(a, cell), blockShape(b, cell))
  }

  it('confond les modes d\'une mesure dans une case de six colonnes', () => {
    // 48 × 93 px : ni jauge, ni unité, ni icône. Il ne reste qu'un chiffre, et
    // c'est le même pour trois des quatre modes.
    const tiny = phoneCell(6, 6)
    expect(densityFor(tiny)).toBe('minimal')

    const big: Block = { kind: 'metric', mode: 'big', metric: 'heart_rate' }
    const gauge: Block = { kind: 'metric', mode: 'gauge', metric: 'heart_rate' }
    const zone: Block = { kind: 'metric', mode: 'zone', metric: 'heart_rate' }
    const compact: Block = { kind: 'metric', mode: 'compact', metric: 'heart_rate' }

    expect(same(big, gauge, tiny)).toBe(true)
    expect(same(big, zone, tiny)).toBe(true)
    // Le compact, lui, garde son chiffre plus petit : la case ne le ramène pas
    // au plein cadre.
    expect(same(big, compact, tiny)).toBe(false)
  })

  it('les distingue à nouveau dès que la case porte la jauge', () => {
    const roomy = phoneCell(2, 1)

    expect(
      same(
        { kind: 'metric', mode: 'big', metric: 'heart_rate' },
        { kind: 'metric', mode: 'gauge', metric: 'heart_rate' },
        roomy,
      ),
    ).toBe(false)
  })

  it('la jauge d\'une mesure sans zone n\'a jamais été un dessin à part', () => {
    // Sans plage, l'appli retombe sur le chiffre plein cadre : la vignette le
    // montrait déjà, elle le dit maintenant.
    expect(
      same(
        { kind: 'metric', mode: 'big', metric: 'cadence' },
        { kind: 'metric', mode: 'gauge', metric: 'cadence' },
        phoneCell(1, 1),
      ),
    ).toBe(true)
  })

  it('confond les trois répartitions quand la légende ne tient plus', () => {
    const tiny = phoneCell(6, 6)
    const bar: Block = { kind: 'zones', mode: 'bar', source: 'hr' }
    const barOnly: Block = { kind: 'zones', mode: 'bar_only', source: 'hr' }
    const legend: Block = { kind: 'zones', mode: 'legend', source: 'hr' }

    expect(same(bar, barOnly, tiny)).toBe(true)
    expect(same(bar, legend, tiny)).toBe(true)

    // Pleine page, les trois redeviennent trois dessins.
    expect(same(bar, barOnly)).toBe(false)
    expect(same(bar, legend)).toBe(false)
    expect(same(barOnly, legend)).toBe(false)
  })

  it('ne rapproche jamais deux genres différents', () => {
    const tiny = phoneCell(6, 6)
    expect(same({ kind: 'empty' }, { kind: 'recording', mode: 'compact' }, tiny)).toBe(false)
  })
})

describe('la grille du vrai téléphone', () => {
  it('remplace celle du téléphone type quand l\'appli l\'a annoncée', () => {
    // Un écran plus grand : les mêmes 3 × 3 y laissent plus de place, donc plus
    // de détail. Ce que l'éditeur montrait jusque-là était une supposition.
    const wide = { width: 400, height: 780 }

    expect(densityFor(phoneCell(3, 3))).toBe('normal')
    expect(densityFor(phoneCell(3, 3, 1, 1, wide))).toBe('comfortable')
  })

  it('un petit écran retire ce que le téléphone type gardait', () => {
    // Et dans l'autre sens : composer sur la supposition ferait promettre une
    // légende que cet écran-là ne portera pas.
    const small = { width: 300, height: 480 }

    expect(legendFits(phoneCell(2, 1), { zones: 5, withBar: true })).toBe(true)
    expect(
      legendFits(phoneCell(2, 1, 1, 1, small), { zones: 5, withBar: true }),
    ).toBe(false)
  })

  it('le repli est le téléphone ordinaire, pas une taille inventée', () => {
    // Recopié dans `CompanionViewport::DEFAULT` côté serveur : les deux doivent
    // dire la même chose, sans quoi l'avertissement et l'aperçu diffèreraient.
    expect(PHONE_GRID).toEqual({ width: 328, height: 598 })
    expect(phoneCell(2, 2)).toEqual(phoneCell(2, 2, 1, 1, PHONE_GRID))
  })
})
