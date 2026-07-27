require "test_helper"

# Tests de l'étage de REGROUPEMENT de SegmentMatcher : c'est lui qui décide QUELLES
# plages deviennent des segments, à partir de passages déjà appariés —
#   `cluster` / `reattach`  : la longueur des segments découverts et qui compte dedans
#   `named_ranges`          : les chemins baptisés, semés sur chaque sortie qui passe
#   `cell_range`            : un tronçon choisi à la main, ramené à la grille
#   `prune_nested`          : le même chemin ne se raconte pas deux fois
#
# Fonctions pures — ni base de données, ni empreintes réelles : l'activité courante est
# une ligne droite de cellules de 60 m, parcourue à 6 m/s, et les passages sont
# fabriqués à la main.
#
# La recherche de diagonales (`raw_runs` / `merge_runs`) et le chronométrage
# (`build_segment`) ne sont pas couverts ici.
class SegmentMatcherTest < ActiveSupport::TestCase
  CELL_M = 60
  Activity = Struct.new(:track_cells, :activity_type, :name, :started_at, :streams)

  # Empreinte d'une trace rectiligne de `n` cellules : une cellule tous les 60 m,
  # toutes les 10 s. Deux points de stream par cellule, comme dans la vraie vie — le
  # GPS échantillonne plus fin que la grille.
  def fingerprint(n)
    {
      "cells" => (0...n).map { |i| "#{i}:0" },
      "i" => (0...n).map { |i| i * 2 },
      "t" => (0...n).map { |i| i * 10 },
      "d" => (0...n).map { |i| i * CELL_M },
      "coarse" => ["0:0"]
    }
  end

  def matcher(cells = 400)
    SegmentMatcher.new(nil, Activity.new(fingerprint(cells), "Ride", "Sortie", Time.utc(2026, 7, 1), {}))
  end

  # Un passage sur [a_start, a_end] de l'activité courante. Le côté candidat est
  # calqué dessus : ces tests ne portent pas sur la projection.
  def effort(a_start, a_end, id: "1")
    SegmentMatcher::Effort.new(
      source: "strava", external_id: id, name: "Sortie #{id}", started_at: Time.utc(2026, 6, 1),
      reverse: false, a_start: a_start, a_end: a_end, b_start: a_start, b_end: a_end,
      cells: a_end - a_start + 1, fp: fingerprint(a_end + 1), own: false
    )
  end

  def spans_m(clusters)
    clusters.map { |c| (c[:a_end] - c[:a_start]) * CELL_M }
  end

  # ── cluster : ce qui fait la longueur des segments ──────────────────────────
  test "un passage qui n'effleure qu'un bout du chemin ne le rogne pas" do
    m = matcher
    # 18 km refaits par une sortie, 600 m par une autre : le régression d'origine
    # ramenait TOUT le groupe à ces 600 m.
    clusters = m.send(:cluster, [effort(0, 300), effort(100, 110, id: "2")])

    assert_equal 2, clusters.size
    assert_equal [18_000, 600], spans_m(clusters)
  end

  test "un passage qui couvre la quasi-totalité du chemin le rejoint et le rogne un peu" do
    m = matcher
    clusters = m.send(:cluster, [effort(0, 300), effort(5, 295, id: "2")])

    assert_equal 1, clusters.size
    assert_equal 17_400, spans_m(clusters).first
    assert_equal 2, clusters.first[:efforts].size
  end

  test "les rognages successifs ne descendent pas sous MIN_KEEP_RATIO de la longueur d'origine" do
    m = matcher
    # Chacun couvre tout juste les 90 % du groupe DÉJÀ rogné : sans garde-fou, l'effet
    # cliquet grignoterait le segment sans fin (0,9 × 0,9 × 0,9…).
    clusters = m.send(:cluster, [effort(0, 300), effort(30, 300, id: "2"),
                                 effort(57, 300, id: "3"), effort(81, 300, id: "4"),
                                 effort(102, 300, id: "5")])

    seed = 300 * CELL_M
    kept = spans_m(clusters).first
    assert_equal 13_140, kept
    assert_operator kept, :>=, seed * SegmentMatcher::MIN_KEEP_RATIO
    # Le cinquième passage, qui aurait fait passer sous le seuil, fonde son propre groupe.
    assert_equal 2, clusters.size
    assert_equal 4, clusters.first[:efforts].size
  end

  test "un passage trop court pour faire un segment n'en fonde pas un" do
    m = matcher
    # 300 m : sous MIN_SEGMENT_M, il forme un groupe qui sera écarté au montage.
    clusters = m.send(:cluster, [effort(0, 5)])

    assert_equal 300, spans_m(clusters).first
  end

  # ── reattach : qui compte pour quel segment ─────────────────────────────────
  test "un long passage compte aussi pour les segments courts inclus dedans" do
    m = matcher
    long = effort(0, 300)
    short = effort(100, 110, id: "2")
    ranges = [{ a_start: 0, a_end: 300, efforts: [long] },
              { a_start: 100, a_end: 110, efforts: [short] }]

    m.send(:reattach, ranges, [long, short])

    assert_equal [long], ranges.first[:efforts]
    # Qui a refait les 18 km a forcément refait les 600 m qui sont dedans.
    assert_equal [long, short], ranges.last[:efforts]
  end

  test "un passage à qui il manque un bout du segment n'y est pas chronométré" do
    m = matcher
    # Une cellule de jeu est tolérée (tremblement du GPS aux bornes), pas trois.
    assert m.send(:covers?, effort(101, 149), 100, 150)
    assert_not m.send(:covers?, effort(103, 150), 100, 150)
    assert_not m.send(:covers?, effort(100, 147), 100, 150)
  end

  # ── Tronçon choisi : index de stream → plage de cellules ───────────────────
  test "une plage choisie est ramenée aux cellules qu'elle contient" do
    m = matcher
    # La cellule k est entrée au point de stream 2k.
    assert_equal [10, 50], m.send(:cell_range, 20, 100)
    # Bornes tombant entre deux cellules : on RESSERRE — première cellule entrée après
    # le début demandé, dernière entrée avant la fin. Jamais un bout non parcouru.
    assert_equal [11, 49], m.send(:cell_range, 21, 99)
  end

  test "une plage qui ne tient pas dans le tracé est refusée" do
    m = matcher(20)

    assert_equal [nil, nil], m.send(:cell_range, 38, 39)   # une seule cellule
    assert_equal [nil, nil], m.send(:cell_range, 100, 200) # au-delà du tracé
  end

  # ── Chemins nommés semés comme plages ──────────────────────────────────────
  # Un segment nommé est un ensemble de cellules ; ici les cellules 100 à 130 de la
  # ligne droite, soit 1800 m.
  def named_segment(from, to, cells: nil)
    NamedSegment.new(name: "Montée", cells: cells || (from..to).map { |i| "#{i}:0" })
  end

  test "le chemin nommé traversé par la sortie devient une plage à part entière" do
    m = matcher
    m.instance_variable_set(:@named_segments, [named_segment(100, 130)])

    ranges = m.send(:named_ranges)

    assert_equal [{ a_start: 100, a_end: 130, efforts: [], named: true }], ranges
  end

  test "un aller-retour sur un chemin nommé donne une plage par sens" do
    # Trace qui monte jusqu'à la cellule 199 puis redescend par le même chemin.
    cells = (0...200).map { |i| "#{i}:0" }
    fp = fingerprint(200)
    fp["cells"] = cells + cells.reverse
    fp["i"] = (0...400).map { |i| i * 2 }
    fp["d"] = (0...400).map { |i| i * CELL_M }
    fp["t"] = (0...400).map { |i| i * 10 }
    m = SegmentMatcher.new(nil, Activity.new(fp, "Ride", "Sortie", Time.utc(2026, 7, 1), {}))
    m.instance_variable_set(:@named_segments, [named_segment(100, 130)])

    ranges = m.send(:named_ranges).map { |r| [r[:a_start], r[:a_end]] }

    # L'aller à sa place, le retour en miroir (cellule 130 croisée en premier).
    assert_equal [[100, 130], [269, 299]], ranges
  end

  test "un chemin nommé seulement effleuré n'est pas semé" do
    m = matcher
    # 4 cellules communes sur les 31 du chemin nommé : sous MATCH_RATIO.
    named = named_segment(0, 0, cells: (100..103).map { |i| "#{i}:0" } + (900..926).map { |i| "#{i}:0" })
    m.instance_variable_set(:@named_segments, [named])

    assert_empty m.send(:named_ranges)
  end

  test "la plage nommée prime sur la plage découverte qui décrit le même chemin" do
    m = matcher
    m.instance_variable_set(:@named_segments, [named_segment(100, 130)])
    discovered = { a_start: 98, a_end: 133, efforts: [] }   # mêmes bornes à 3 cellules près
    other = { a_start: 200, a_end: 260, efforts: [] }       # ailleurs

    ranges = m.send(:with_named_ranges, [discovered, other])

    assert_equal [[100, 130], [200, 260]], ranges.map { |r| [r[:a_start], r[:a_end]] }
    assert ranges.first[:named]
  end

  # ── prune_nested : le même chemin ne se raconte pas deux fois ───────────────
  def segment(from, to, count, **extra)
    { cell_range: [from, to], distance_m: (to - from) * CELL_M, count: count }.merge(extra)
  end

  test "un chemin baptisé est gardé même quand il est inclus dans un chemin plus long" do
    m = matcher
    # Sans le nom, ce morceau aussi fréquenté que son contenant serait écarté.
    piece = segment(50, 200, 5, named_segment_id: 7, seeded: true)
    kept = m.send(:prune_nested, [segment(0, 300, 4), piece])

    assert_equal [[0, 300], [50, 200]], kept.map { |s| s[:cell_range] }
  end

  test "le chemin baptisé ne sort qu'une fois : la plage semée prime sur la découverte" do
    m = matcher
    seeded = segment(100, 130, 5, named_segment_id: 7, seeded: true)
    discovered = segment(98, 133, 5, named_segment_id: 7)   # a hérité du même nom
    kept = m.send(:prune_nested, [discovered, seeded])

    assert_equal [[100, 130]], kept.map { |s| s[:cell_range] }
  end

  test "un morceau aussi fréquenté que le chemin qui le contient est écarté" do
    m = matcher
    kept = m.send(:prune_nested, [segment(0, 300, 4), segment(50, 200, 5)])

    assert_equal [[0, 300]], kept.map { |s| s[:cell_range] }
  end

  test "un morceau beaucoup plus fréquenté que son contenant est détaillé à part" do
    m = matcher
    kept = m.send(:prune_nested, [segment(0, 300, 4), segment(50, 60, 20)])

    assert_equal [[0, 300], [50, 60]], kept.map { |s| s[:cell_range] }
  end

  test "deux chemins qui ne font que se croiser sont gardés tous les deux" do
    m = matcher
    kept = m.send(:prune_nested, [segment(0, 300, 4), segment(280, 500, 4)])

    assert_equal 2, kept.size
  end

  test "le morceau se compare à son contenant le plus serré, pas au grand tour" do
    m = matcher
    # 50→60 est 5× plus fréquenté que le grand tour, mais pas plus que la montée
    # 40→100 qui le contient : c'est elle qui le rend redondant.
    kept = m.send(:prune_nested, [segment(0, 300, 4), segment(40, 100, 20), segment(50, 60, 20)])

    assert_equal [[0, 300], [40, 100]], kept.map { |s| s[:cell_range] }
  end
end
