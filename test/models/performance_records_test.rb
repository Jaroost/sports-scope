require "test_helper"

# Tests des agrégations de PerformanceRecords qui travaillent sur des lignes déjà chargées
# (fonctions pures, sans base de données) : catégorisation des sports, records absolus,
# cumuls, découpage par année/mois, classement d'une sortie, et normalisation des filtres.
# Les entrées/sorties SQL (`summary_rows`, `for_user`, cache) ne sont pas couvertes ici.
class PerformanceRecordsTest < ActiveSupport::TestCase
  # Ligne de résumé minimale — les clés sont des chaînes, comme celles de `select_all`.
  def row(attrs = {})
    {
      "source" => "strava", "external_id" => "1", "name" => "Sortie",
      "activity_type" => "Ride", "started_at" => "2026-05-10T08:00:00Z",
      "distance_m" => 50_000, "moving_time_s" => 7200, "total_elevation_gain" => 800
    }.merge(attrs)
  end

  # ── sport_category : regroupement des activity_type hétérogènes ─────────────
  test "sport_category reconnaît chaque famille par mot-clé, casse ignorée" do
    assert_equal "cycling", PerformanceRecords.sport_category("Ride")
    assert_equal "cycling", PerformanceRecords.sport_category("MountainBikeRide")
    assert_equal "cycling", PerformanceRecords.sport_category("VTT")
    assert_equal "running", PerformanceRecords.sport_category("TrailRun")
    assert_equal "ski", PerformanceRecords.sport_category("BackcountrySki")
    assert_equal "hiking", PerformanceRecords.sport_category("Hike")
    assert_equal "swimming", PerformanceRecords.sport_category("Swim")
  end

  test "sport_category retombe sur 'other' pour un type inconnu ou vide" do
    assert_equal "other", PerformanceRecords.sport_category("Yoga")
    assert_equal "other", PerformanceRecords.sport_category(nil)
    assert_equal "other", PerformanceRecords.sport_category("")
  end

  # ── effort_sport_category : le vélo se scinde pour les efforts ──────────────
  test "effort_sport_category isole VTT et gravel du vélo de route" do
    assert_equal "mtb", PerformanceRecords.effort_sport_category("MountainBikeRide")
    assert_equal "mtb", PerformanceRecords.effort_sport_category("vtt matinal")
    assert_equal "gravel", PerformanceRecords.effort_sport_category("GravelRide")
    assert_equal "cycling", PerformanceRecords.effort_sport_category("Ride")
    assert_equal "cycling", PerformanceRecords.effort_sport_category("VirtualRide")
  end

  test "effort_sport_category laisse les autres sports inchangés" do
    assert_equal "running", PerformanceRecords.effort_sport_category("Run")
    assert_equal "ski", PerformanceRecords.effort_sport_category("AlpineSki")
    assert_equal "other", PerformanceRecords.effort_sport_category("Yoga")
  end

  # ── rank_in : rang d'une valeur dans son groupe ─────────────────────────────
  test "rank_in compte les sorties strictement supérieures" do
    rows = [row("distance_m" => 100_000), row("distance_m" => 50_000), row("distance_m" => 10_000)]

    assert_equal({ rank: 1, count: 3 }, PerformanceRecords.rank_in(rows, "distance_m", 100_000))
    assert_equal({ rank: 2, count: 3 }, PerformanceRecords.rank_in(rows, "distance_m", 50_000))
    assert_equal({ rank: 3, count: 3 }, PerformanceRecords.rank_in(rows, "distance_m", 10_000))
  end

  test "rank_in fait partager le rang aux ex æquo" do
    rows = [row("distance_m" => 100_000), row("distance_m" => 100_000)]
    assert_equal({ rank: 1, count: 2 }, PerformanceRecords.rank_in(rows, "distance_m", 100_000))
  end

  test "rank_in ignore les valeurs absentes ou nulles dans la taille du groupe" do
    rows = [row("distance_m" => 100_000), row("distance_m" => nil), row("distance_m" => 0)]
    assert_equal({ rank: 1, count: 1 }, PerformanceRecords.rank_in(rows, "distance_m", 100_000))
  end

  # ── absolute_records : max par métrique + activité détentrice ───────────────
  test "absolute_records retient l'activité au maximum de chaque métrique" do
    rows = [
      row("name" => "Longue", "distance_m" => 120_000, "total_elevation_gain" => 500),
      row("name" => "Montagneuse", "distance_m" => 60_000, "total_elevation_gain" => 3000)
    ]
    records = PerformanceRecords.absolute_records(rows).index_by { |r| r[:key] }

    assert_equal 120_000.0, records["longest_distance"][:value]
    assert_equal "Longue", records["longest_distance"][:activity][:name]
    assert_equal 3000.0, records["biggest_elevation"][:value]
    assert_equal "Montagneuse", records["biggest_elevation"][:activity][:name]
    assert_equal "distance", records["longest_distance"][:unit]
  end

  test "absolute_records omet les métriques sans donnée exploitable" do
    records = PerformanceRecords.absolute_records([row("max_watts" => nil, "max_heartrate" => 0)])
    keys = records.map { |r| r[:key] }

    refute_includes keys, "max_power"
    refute_includes keys, "max_heartrate"
    assert_includes keys, "longest_distance"
  end

  test "absolute_records renvoie [] sans aucune activité" do
    assert_equal [], PerformanceRecords.absolute_records([])
  end

  # ── totals / by_year ────────────────────────────────────────────────────────
  test "totals cumule distance, dénivelé et temps" do
    rows = [row("distance_m" => 50_000), row("distance_m" => 30_000, "moving_time_s" => 3600)]
    totals = PerformanceRecords.totals(rows)

    assert_equal 2, totals[:count]
    assert_equal 80_000.0, totals[:distance_m]
    assert_equal 1600.0, totals[:elevation]
    assert_equal 10_800, totals[:moving_time_s]
  end

  test "by_year regroupe par année civile, la plus récente d'abord" do
    rows = [
      row("started_at" => "2024-06-01T08:00:00Z", "distance_m" => 10_000),
      row("started_at" => "2026-06-01T08:00:00Z", "distance_m" => 20_000),
      row("started_at" => "2026-07-01T08:00:00Z", "distance_m" => 5_000)
    ]
    years = PerformanceRecords.by_year(rows)

    assert_equal [2026, 2024], years.map { |y| y[:year] }
    assert_equal 2, years.first[:count]
    assert_equal 25_000.0, years.first[:distance_m]
  end

  test "by_year écarte les activités sans date" do
    assert_equal [], PerformanceRecords.by_year([row("started_at" => nil)])
  end

  # ── best_bucket : meilleure année / meilleur mois ───────────────────────────
  test "best_bucket trouve l'année et le mois au plus gros cumul" do
    rows = [
      row("started_at" => "2026-05-10T08:00:00Z", "distance_m" => 40_000),
      row("started_at" => "2026-05-20T08:00:00Z", "distance_m" => 40_000),
      row("started_at" => "2026-07-01T08:00:00Z", "distance_m" => 50_000),
      row("started_at" => "2025-07-01T08:00:00Z", "distance_m" => 10_000)
    ]

    year = PerformanceRecords.best_bucket(rows, :year, "distance_m")
    assert_equal({ label: 2026, value: 130_000.0, count: 3 }, year)

    month = PerformanceRecords.best_bucket(rows, :month, "distance_m")
    assert_equal({ label: "2026-05", value: 80_000.0, count: 2 }, month)
  end

  test "best_bucket renvoie nil sans date ou sans cumul positif" do
    assert_nil PerformanceRecords.best_bucket([], :year, "distance_m")
    assert_nil PerformanceRecords.best_bucket([row("started_at" => nil)], :year, "distance_m")
    assert_nil PerformanceRecords.best_bucket([row("distance_m" => 0)], :year, "distance_m")
  end

  # ── peak_power_bests : meilleure puissance par durée sur le groupe ──────────
  test "peak_power_bests retient la meilleure valeur de chaque durée et sa sortie" do
    rows = [
      row("name" => "Sprint", "peak_powers" => { "5" => 900, "300" => 280 }),
      row("name" => "Seuil", "peak_powers" => { "5" => 700, "300" => 310 })
    ]
    bests = PerformanceRecords.peak_power_bests(rows)

    assert_equal 900.0, bests["5"][:avg_watts]
    assert_equal "Sprint", bests["5"][:name]
    assert_equal 310.0, bests["300"][:avg_watts]
    assert_equal "Seuil", bests["300"][:name]
    refute_includes bests.keys, "3600" # aucune donnée pour cette durée
  end

  test "peak_power_bests accepte les courbes en JSON texte et ignore le reste" do
    rows = [row("peak_powers" => '{"60": 420}'), row("peak_powers" => "pas du json"),
            row("peak_powers" => nil)]
    bests = PerformanceRecords.peak_power_bests(rows)

    assert_equal 420.0, bests["60"][:avg_watts]
    assert_equal 1, bests.keys.length
  end

  test "parse_peak_powers accepte Hash et JSON, rejette le reste" do
    assert_equal({ "5" => 900 }, PerformanceRecords.parse_peak_powers({ "5" => 900 }))
    assert_equal({ "5" => 900 }, PerformanceRecords.parse_peak_powers('{"5": 900}'))
    assert_nil PerformanceRecords.parse_peak_powers("{cassé")
    assert_nil PerformanceRecords.parse_peak_powers("")
    assert_nil PerformanceRecords.parse_peak_powers(nil)
  end

  # ── normalize_filters : query params → unités internes ──────────────────────
  test "normalize_filters convertit km en mètres et minutes en secondes" do
    out = PerformanceRecords.normalize_filters("min_dist" => "50", "max_dist" => "100",
                                               "min_dur" => "60", "max_dur" => "180")

    assert_equal 50_000.0, out[:min_dist]
    assert_equal 100_000.0, out[:max_dist]
    assert_equal 3600.0, out[:min_dur]
    assert_equal 10_800.0, out[:max_dur]
  end

  test "normalize_filters borne les dates sur la journée entière" do
    out = PerformanceRecords.normalize_filters("from" => "2026-05-01", "to" => "2026-05-31")

    assert_equal Time.zone.parse("2026-05-01 00:00:00"), out[:from]
    assert_equal Date.new(2026, 5, 31), out[:to].to_date
    assert_equal 23, out[:to].hour
  end

  test "normalize_filters ignore les valeurs vides" do
    out = PerformanceRecords.normalize_filters("sport" => "", "min_dist" => nil, "from" => "")
    assert_empty out
  end

  test "parse_date n'accepte que l'ISO d'un <input type=date>" do
    assert_equal Date.new(2026, 5, 1), PerformanceRecords.parse_date("2026-05-01")
    assert_nil PerformanceRecords.parse_date("01/05/2026")
    assert_nil PerformanceRecords.parse_date("")
    assert_nil PerformanceRecords.parse_date(nil)
  end

  # ── apply_filters : sélection des lignes ────────────────────────────────────
  test "apply_filters rend toutes les lignes sans filtre" do
    rows = [row, row]
    assert_equal rows, PerformanceRecords.apply_filters(rows, {})
  end

  test "apply_filters compare le sport au type exact, pas à la catégorie" do
    rows = [row("activity_type" => "Ride"), row("activity_type" => "VirtualRide")]
    kept = PerformanceRecords.apply_filters(rows, sport: "Ride")

    assert_equal 1, kept.length
    assert_equal "Ride", kept.first["activity_type"]
  end

  test "apply_filters applique les bornes numériques" do
    rows = [row("distance_m" => 10_000), row("distance_m" => 60_000), row("distance_m" => 120_000)]
    kept = PerformanceRecords.apply_filters(rows, min_dist: 50_000.0, max_dist: 100_000.0)

    assert_equal [60_000], kept.map { |r| r["distance_m"] }
  end

  test "apply_filters exclut les lignes sans valeur pour une colonne filtrée" do
    rows = [row("total_elevation_gain" => nil), row("total_elevation_gain" => 1000)]
    kept = PerformanceRecords.apply_filters(rows, min_elev: 500.0)

    assert_equal 1, kept.length
    assert_equal 1000, kept.first["total_elevation_gain"]
  end

  test "apply_filters applique les bornes de dates" do
    rows = [
      row("started_at" => "2026-04-30T23:00:00Z"),
      row("started_at" => "2026-05-15T08:00:00Z"),
      row("started_at" => "2026-06-02T08:00:00Z")
    ]
    filters = PerformanceRecords.normalize_filters("from" => "2026-05-01", "to" => "2026-05-31")
    kept = PerformanceRecords.apply_filters(rows, filters)

    assert_equal ["2026-05-15T08:00:00Z"], kept.map { |r| r["started_at"] }
  end

  test "apply_filters cumule les critères" do
    rows = [
      row("activity_type" => "Ride", "distance_m" => 120_000),
      row("activity_type" => "Ride", "distance_m" => 20_000),
      row("activity_type" => "Run", "distance_m" => 120_000)
    ]
    kept = PerformanceRecords.apply_filters(rows, sport: "Ride", min_dist: 100_000.0)

    assert_equal 1, kept.length
    assert_equal 120_000, kept.first["distance_m"]
  end

  # ── compute_group : forme du payload d'un onglet ────────────────────────────
  test "compute_group renvoie tous les blocs attendus par le front" do
    group = PerformanceRecords.compute_group([row])

    assert_equal 1, group[:count]
    assert_equal %i[count records totals by_year best_periods peak_power], group.keys
    assert_equal 50_000.0, group[:totals][:distance_m]
    assert_equal [2026], group[:by_year].map { |y| y[:year] }
  end

  test "compute_group reste cohérent sur un groupe vide" do
    group = PerformanceRecords.compute_group([])

    assert_equal 0, group[:count]
    assert_equal [], group[:records]
    assert_equal 0, group[:totals][:moving_time_s]
    assert_nil group[:best_periods][:best_year_distance]
    assert_equal({}, group[:peak_power])
  end

  # ── Helpers ────────────────────────────────────────────────────────────────
  test "numeric convertit nombres et chaînes numériques, rejette le reste" do
    assert_equal 42.0, PerformanceRecords.numeric(42)
    assert_equal 3.5, PerformanceRecords.numeric("3.5")
    assert_nil PerformanceRecords.numeric("50km")
    assert_nil PerformanceRecords.numeric(nil)
  end

  test "month_of produit une étiquette YYYY-MM triable" do
    assert_equal "2026-05", PerformanceRecords.month_of(row("started_at" => "2026-05-10T08:00:00Z"))
    assert_nil PerformanceRecords.month_of(row("started_at" => nil))
  end

  test "activity_ref décrit la sortie pour le lien côté front" do
    ref = PerformanceRecords.activity_ref(row("name" => "Col du Marchairuz"))

    assert_equal "strava", ref[:source]
    assert_equal "Col du Marchairuz", ref[:name]
    assert_equal "Ride", ref[:type]
    assert_equal "2026-05-10T08:00:00Z", ref[:started_at]
  end
end
