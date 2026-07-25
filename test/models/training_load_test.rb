require "test_helper"

# Tests du cœur numérique de TrainingLoad (fonctions pures, sans base de données) :
# puissance normalisée, cascade de calcul du TSS, moyennes mobiles CTL/ATL/TSB, ACWR,
# et les repères dérivés de l'historique (LTHR auto, vitesse habituelle, sortie la plus
# longue). Le câblage ActiveRecord (`load_rows`, cache, résolveur de FTP) n'est pas
# couvert par ce fichier.
class TrainingLoadTest < ActiveSupport::TestCase
  # ── normalized_power : moyenne mobile 30 s élevée à la puissance 4 ───────────
  test "normalized_power vaut la puissance constante d'une sortie régulière" do
    streams = { "watts" => Array.new(120, 200) }
    assert_equal 200.0, TrainingLoad.normalized_power(streams)
  end

  test "normalized_power exige au moins 30 échantillons de watts" do
    assert_nil TrainingLoad.normalized_power({ "watts" => Array.new(29, 200) })
    assert_nil TrainingLoad.normalized_power({ "watts" => 200 })
    assert_nil TrainingLoad.normalized_power({ "heartrate" => Array.new(60, 150) })
  end

  test "normalized_power lit aussi la forme { data: [...] } des streams Strava" do
    assert_equal 200.0, TrainingLoad.normalized_power({ "watts" => { "data" => Array.new(120, 200) } })
  end

  test "normalized_power pénalise les à-coups : NP > puissance moyenne" do
    # 60 s à 0 W puis 60 s à 400 W : moyenne 200 W, mais NP plus élevée.
    streams = { "watts" => Array.new(60, 0) + Array.new(60, 400) }
    np = TrainingLoad.normalized_power(streams)

    assert np > 200.0, "NP (#{np}) devrait dépasser la moyenne de 200 W"
    assert np <= 400.0
  end

  test "normalized_power traite les trous comme des zéros et rejette le tout-nul" do
    assert_nil TrainingLoad.normalized_power({ "watts" => Array.new(60, nil) })
    assert_nil TrainingLoad.normalized_power({ "watts" => Array.new(60, 0) })
  end

  # ── tss_from_if : TSS = h × IF² × 100, IF borné ─────────────────────────────
  test "tss_from_if : une heure au seuil vaut 100 TSS" do
    res = TrainingLoad.tss_from_if(1.0, 1.0, "power")
    assert_equal({ tss: 100.0, source: "power", intensity: 1.0 }, res)
  end

  test "tss_from_if borne l'intensité à INTENSITY_CAP" do
    res = TrainingLoad.tss_from_if(1.0, 10.0, "power")
    assert_equal 1.5, res[:intensity]
    assert_equal 225.0, res[:tss] # 1 × 1,5² × 100
  end

  # ── activity_tss : cascade puissance → FC → estimation ──────────────────────
  test "activity_tss privilégie la puissance quand NP et FTP sont disponibles" do
    row = { "moving_time_s" => 3600, "normalized_power" => 250, "average_heartrate" => 160,
            "activity_type" => "Ride" }
    res = TrainingLoad.activity_tss(row, ftp: 250, lthr: 160)

    assert_equal "power", res[:source]
    assert_equal 100.0, res[:tss]
  end

  test "activity_tss retombe sur la FC sans puissance" do
    row = { "moving_time_s" => 1800, "average_heartrate" => 160, "activity_type" => "Run" }
    res = TrainingLoad.activity_tss(row, ftp: 250, lthr: 160)

    assert_equal "hr", res[:source]
    assert_equal 50.0, res[:tss] # 0,5 h × 1² × 100
  end

  test "activity_tss retombe sur l'IF par défaut du sport sans puissance ni FC" do
    ride = TrainingLoad.activity_tss({ "moving_time_s" => 3600, "activity_type" => "Ride" },
                                     ftp: nil, lthr: nil)
    hike = TrainingLoad.activity_tss({ "moving_time_s" => 3600, "activity_type" => "Hike" },
                                     ftp: nil, lthr: nil)

    assert_equal "estimated", ride[:source]
    assert_equal 49.0, ride[:tss]  # IF 0,70
    assert_equal 25.0, hike[:tss]  # IF 0,50
  end

  test "activity_tss retombe sur l'IF 'other' pour un sport inconnu" do
    res = TrainingLoad.activity_tss({ "moving_time_s" => 3600, "activity_type" => "Yoga" },
                                    ftp: nil, lthr: nil)
    assert_equal 36.0, res[:tss] # IF 0,60
  end

  test "activity_tss ignore les seuils et valeurs non exploitables" do
    row = { "moving_time_s" => 3600, "normalized_power" => 250, "average_heartrate" => 160,
            "activity_type" => "Ride" }
    # FTP nulle → on descend d'un cran (FC) ; FTP et LTHR absents → estimation.
    assert_equal "hr", TrainingLoad.activity_tss(row, ftp: 0, lthr: 160)[:source]
    assert_equal "estimated", TrainingLoad.activity_tss(row, ftp: nil, lthr: nil)[:source]
  end

  test "activity_tss renvoie nil sans temps de déplacement" do
    assert_nil TrainingLoad.activity_tss({ "moving_time_s" => 0, "activity_type" => "Ride" },
                                         ftp: 250, lthr: 160)
    assert_nil TrainingLoad.activity_tss({ "activity_type" => "Ride" }, ftp: 250, lthr: 160)
  end

  # ── performance_management : EWMA quotidiennes CTL/ATL/TSB ──────────────────
  test "performance_management applique les EWMA au premier jour de charge" do
    series = TrainingLoad.performance_management({ Time.zone.today => 100.0 })

    assert_equal 1, series.length
    point = series.first
    assert_equal Time.zone.today.iso8601, point[:date]
    assert_equal 100.0, point[:tss]
    assert_equal 2.4, point[:ctl]   # 100 × (1 − e^(−1/42))
    assert_equal 13.3, point[:atl]  # 100 × (1 − e^(−1/7))
    assert_equal(-11.0, point[:tsb])
  end

  test "performance_management comble les jours de repos jusqu'à aujourd'hui" do
    start = Time.zone.today - 3
    series = TrainingLoad.performance_management({ start => 100.0 })

    assert_equal 4, series.length
    assert_equal [100.0, 0.0, 0.0, 0.0], series.map { |p| p[:tss] }
    # La fatigue (7 j) retombe bien plus vite que la forme de fond (42 j).
    assert_in_delta 2.2, series.last[:ctl], 0.05
    assert_in_delta 8.7, series.last[:atl], 0.05
    assert series.last[:tsb] > series.first[:tsb], "le TSB doit remonter pendant le repos"
  end

  test "performance_management laisse l'ACWR nil tant qu'il manque 28 jours" do
    series = TrainingLoad.performance_management({ (Time.zone.today - 5) => 100.0 })
    assert(series.none? { |p| p[:acwr] })
  end

  # ── acwr_at : charge aiguë (7 j) / charge chronique (28 j) ──────────────────
  test "acwr_at exige 28 jours d'historique" do
    assert_nil TrainingLoad.acwr_at(Array.new(27, 50.0))
    assert_equal 1.0, TrainingLoad.acwr_at(Array.new(28, 50.0))
  end

  test "acwr_at détecte une montée de charge récente" do
    loads = Array.new(21, 10.0) + Array.new(7, 20.0)
    # aiguë = 20 ; chronique = (21×10 + 7×20) / 28 = 12,5 → 1,6
    assert_equal 1.6, TrainingLoad.acwr_at(loads)
  end

  test "acwr_at renvoie nil si la charge chronique est nulle" do
    assert_nil TrainingLoad.acwr_at(Array.new(28, 0.0))
  end

  test "acwr_at ne regarde que les derniers jours" do
    loads = Array.new(100, 999.0) + Array.new(28, 10.0)
    assert_equal 1.0, TrainingLoad.acwr_at(loads)
  end

  # ── Zones interprétées côté front ───────────────────────────────────────────
  test "acwr_zone découpe le sweet spot 0,8–1,3" do
    assert_nil TrainingLoad.acwr_zone(nil)
    assert_equal "detraining", TrainingLoad.acwr_zone(0.79)
    assert_equal "optimal", TrainingLoad.acwr_zone(0.8)   # borne incluse
    assert_equal "optimal", TrainingLoad.acwr_zone(1.3)   # borne incluse
    assert_equal "caution", TrainingLoad.acwr_zone(1.5)   # borne incluse
    assert_equal "high_risk", TrainingLoad.acwr_zone(1.51)
  end

  test "form_zone classe le TSB de la fraîcheur au surmenage" do
    assert_equal "very_fresh", TrainingLoad.form_zone(20)
    assert_equal "fresh", TrainingLoad.form_zone(5)
    assert_equal "neutral", TrainingLoad.form_zone(0)
    assert_equal "neutral", TrainingLoad.form_zone(-10)
    assert_equal "productive", TrainingLoad.form_zone(-30)
    assert_equal "overreaching", TrainingLoad.form_zone(-31)
  end

  # ── attach_activities : séances du jour rattachées à la série ───────────────
  test "attach_activities trie les séances du jour par TSS décroissant" do
    day = Time.zone.today
    series = [{ date: day.iso8601 }, { date: (day + 1).iso8601 }]
    activities = { day => [{ name: "footing", tss: 30.0 }, { name: "intervalles", tss: 90.0 }] }

    TrainingLoad.attach_activities(series, activities)

    assert_equal ["intervalles", "footing"], series[0][:activities].map { |a| a[:name] }
    assert_equal [], series[1][:activities] # jour de repos
  end

  # ── auto_lthr : repli quand l'athlète n'a rien saisi ────────────────────────
  test "auto_lthr approxime le seuil depuis la plus haute FC moyenne" do
    rows = [{ "average_heartrate" => 140 }, { "average_heartrate" => 160 }, { "average_heartrate" => nil }]
    # 160 / 0,92 × 0,9 = 156,5 → 157
    assert_equal 157, TrainingLoad.auto_lthr(rows)
  end

  test "auto_lthr renvoie nil sans aucune FC" do
    assert_nil TrainingLoad.auto_lthr([{ "average_heartrate" => nil }, {}])
  end

  # ── Vitesse habituelle à vélo (médiane, m/s → km/h) ─────────────────────────
  test "cycling_speeds ne retient que les sorties vélo à vitesse positive" do
    rows = [
      { "activity_type" => "Ride", "average_speed" => 5.0 },
      { "activity_type" => "VirtualRide", "average_speed" => 7.0 },
      { "activity_type" => "Run", "average_speed" => 3.0 },   # pas du vélo
      { "activity_type" => "Ride", "average_speed" => 0 },    # vitesse nulle
      { "activity_type" => "Ride", "average_speed" => nil }
    ]
    assert_equal [5.0, 7.0], TrainingLoad.cycling_speeds(rows)
  end

  test "typical_cycling_speed prend la médiane et convertit en km/h" do
    odd = [5.0, 6.0, 10.0].map { |v| { "activity_type" => "Ride", "average_speed" => v } }
    even = [5.0, 7.0].map { |v| { "activity_type" => "Ride", "average_speed" => v } }

    assert_equal 21.6, TrainingLoad.typical_cycling_speed(odd)   # médiane 6,0 m/s
    assert_equal 21.6, TrainingLoad.typical_cycling_speed(even)  # médiane (5+7)/2
  end

  test "typical_cycling_speed renvoie nil sans sortie vélo" do
    assert_nil TrainingLoad.typical_cycling_speed([{ "activity_type" => "Run", "average_speed" => 3.0 }])
  end

  # ── longest_recent_ride_min : repère de durabilité (90 derniers jours) ──────
  test "longest_recent_ride_min prend la plus longue sortie vélo récente, en minutes" do
    rows = [
      { "activity_type" => "Ride", "started_at" => (Time.zone.today - 10).to_s, "moving_time_s" => 3600 },
      { "activity_type" => "Ride", "started_at" => (Time.zone.today - 20).to_s, "moving_time_s" => 7200 },
      { "activity_type" => "Run",  "started_at" => (Time.zone.today - 5).to_s,  "moving_time_s" => 10_800 }
    ]
    assert_equal 120, TrainingLoad.longest_recent_ride_min(rows)
  end

  test "longest_recent_ride_min ignore les sorties de plus de 90 jours" do
    rows = [{ "activity_type" => "Ride", "started_at" => (Time.zone.today - 120).to_s, "moving_time_s" => 7200 }]
    assert_nil TrainingLoad.longest_recent_ride_min(rows)
  end

  # ── Helpers ────────────────────────────────────────────────────────────────
  test "parse_date accepte Date, Time et chaîne ISO" do
    date = Date.new(2026, 7, 24)
    assert_equal date, TrainingLoad.parse_date(date)
    assert_equal date, TrainingLoad.parse_date(Time.zone.parse("2026-07-24 10:30:00"))
    assert_equal date, TrainingLoad.parse_date("2026-07-24T10:30:00Z")
  end

  test "parse_date renvoie nil sur vide ou illisible" do
    assert_nil TrainingLoad.parse_date(nil)
    assert_nil TrainingLoad.parse_date("")
    assert_nil TrainingLoad.parse_date("pas une date")
  end

  test "iso_time conserve l'heure, contrairement à parse_date" do
    time = Time.zone.parse("2026-07-24 10:30:00")
    assert_equal time.iso8601, TrainingLoad.iso_time(time)
    assert_equal "2026-07-24T10:30:00Z", TrainingLoad.iso_time("2026-07-24T10:30:00Z")
    assert_nil TrainingLoad.iso_time(nil)
    assert_nil TrainingLoad.iso_time("pas une date")
  end

  test "numeric convertit nombres et chaînes numériques, rejette le reste" do
    assert_equal 250.0, TrainingLoad.numeric(250)
    assert_equal 3.5, TrainingLoad.numeric("3.5")
    assert_nil TrainingLoad.numeric("250w")
    assert_nil TrainingLoad.numeric(nil)
  end

  test "empty_summary a la forme attendue par le front" do
    summary = TrainingLoad.empty_summary
    assert_nil summary[:current]
    assert_equal [], summary[:series]
    assert_equal({ power: 0, hr: 0, estimated: 0, total: 0 }, summary[:coverage])
  end
end
