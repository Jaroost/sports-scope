import { describe, it, expect } from 'vitest'
import { fillHoles } from './fitStreams'

describe('fillHoles', () => {
  it('comble un trou en tête par la première valeur connue', () => {
    // Le cas de sports-scope-2026-07-31-1454.fit : enregistrement démarré à
    // l'intérieur, le premier `record` n'a pas de fix. Sans ça, [0, 0].
    const latlng = [null, [47.101165, 6.815351], [47.101119, 6.815297]]
    expect(fillHoles(latlng)).toEqual([
      [47.101165, 6.815351],
      [47.101165, 6.815351],
      [47.101119, 6.815297],
    ])
  })

  it('comble un trou au milieu par la dernière valeur connue', () => {
    expect(fillHoles([10, null, null, 40])).toEqual([10, 10, 10, 40])
  })

  it('comble un trou en queue', () => {
    expect(fillHoles([10, 20, null, null])).toEqual([10, 20, 20, 20])
  })

  it('ne rend jamais un zéro pour une mesure absente', () => {
    // La régression exacte : une altitude manquante devant un départ à 1 120 m
    // donnait 0 m, donc 1 120 m de D+ inventés au premier pas.
    expect(fillHoles([null, 1119.6, 1119.6])[0]).toBe(1119.6)
  })

  it('laisse intact un flux sans trou', () => {
    expect(fillHoles([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('rend un tableau entièrement nul si rien n\'est connu', () => {
    expect(fillHoles([null, null])).toEqual([null, null])
  })

  it('traite undefined comme un trou — fit-file-parser ne rend pas null', () => {
    expect(fillHoles([undefined, 5, undefined])).toEqual([5, 5, 5])
  })

  it('ne modifie pas le tableau reçu', () => {
    const source = [null, 7]
    fillHoles(source)
    expect(source).toEqual([null, 7])
  })

  it('rend un tableau vide sur un flux vide', () => {
    expect(fillHoles([])).toEqual([])
  })
})
