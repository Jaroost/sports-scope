import { describe, it, expect } from 'vitest'
import {
  occupancy, maxSpan, fitCells, gridSideOf, blockChoices, blockFor, isChoiceOf, metricSample,
  canHideBehindMenu, phoneCell, PHONE_GRID, DEFAULT_METRIC_LAYOUT,
  type Catalog, type Cell, type Page,
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
  activities: ['cycling', 'mtb', 'hiking'],
  max_band_metrics: 4,
  max_grid_side: 6,
  icons: ['fa-solid fa-heart'],
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

    // `metric` n'a plus de mode : sa disposition se compose librement
    // (`layout`), pas choisie parmi quelques formes figées — voir
    // `DEFAULT_METRIC_LAYOUT`.
    const metric = blockFor({ kind: 'metric' }, { metric: 'speed', source: 'power' })

    expect(metric).toEqual({ kind: 'metric', metric: 'speed', layout: DEFAULT_METRIC_LAYOUT })
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

describe('la grille du vrai téléphone', () => {
  it('le repli est le téléphone ordinaire, pas une taille inventée', () => {
    // Recopié dans `CompanionViewport::DEFAULT` côté serveur : les deux doivent
    // dire la même chose, sans quoi l'aperçu s'y tromperait.
    expect(PHONE_GRID).toEqual({ width: 328, height: 598 })
    expect(phoneCell(2, 2)).toEqual(phoneCell(2, 2, 1, 1, PHONE_GRID))
  })
})
