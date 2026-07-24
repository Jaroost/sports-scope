require "test_helper"

# Tests de la répartition du temps par zone d'intensité (FC / puissance). Tout le module est
# purement numérique (aucun accès base) : on couvre les deux étapes — condensation des
# streams en histogramme, puis regroupement en zones pour un seuil — et les helpers.
class ZoneDistributionTest < ActiveSupport::TestCase
  HR_ZONES = ZoneDistribution::HR_ZONES
  POWER_ZONES = ZoneDistribution::POWER_ZONES

  # ── histogram : condensation des streams en secondes par palier ─────────────
  test "histogram exige au moins deux échantillons" do
    assert_equal({}, ZoneDistribution.histogram({ "hr" => [150] }, "hr", 5))
    assert_equal({}, ZoneDistribution.histogram({ "hr" => 42 }, "hr", 5))
  end

  test "histogram range chaque valeur dans son palier (1 s par défaut sans time)" do
    # 100 et 104 → palier 100 ; 106 → palier 105. Sans stream time, dt = 1 s chacun.
    hist = ZoneDistribution.histogram({ "hr" => [100, 104, 106] }, "hr", 5)
    assert_equal({ "100" => 2.0, "105" => 1.0 }, hist)
  end

  test "histogram pondère par l'intervalle de temps réel" do
    times = [0, 4, 10, 11]
    hist = ZoneDistribution.histogram({ "time" => times, "watts" => [100, 100, 100, 100] }, "watts", 25)
    # dt : 4 + 6 + 1 + 1 (dernier point = 1 s) = 12 s, tous dans le palier 100.
    assert_equal({ "100" => 12.0 }, hist)
  end

  test "histogram borne les pauses à MAX_GAP (10 s)" do
    hist = ZoneDistribution.histogram({ "time" => [0, 100], "watts" => [200, 200] }, "watts", 25)
    # 1er intervalle 100 s ramené à 10 s ; dernier point 1 s → 11 s au palier 200.
    assert_equal({ "200" => 11.0 }, hist)
  end

  test "histogram ignore les valeurs nulles, négatives ou non numériques" do
    hist = ZoneDistribution.histogram({ "hr" => [nil, 0, -5, 150] }, "hr", 25)
    assert_equal({ "150" => 1.0 }, hist)
  end

  # ── sample_dt : Δt attribué à chaque échantillon ────────────────────────────
  test "sample_dt : dernier point et absence de time valent 1 s" do
    assert_equal 1.0, ZoneDistribution.sample_dt([0, 5], 1, 2)   # i = n-1
    assert_equal 1.0, ZoneDistribution.sample_dt(nil, 0, 2)      # pas de time
  end

  test "sample_dt : intervalle réel, borné à MAX_GAP, nul si non croissant" do
    assert_equal 5.0, ZoneDistribution.sample_dt([0, 5, 6], 0, 3)
    assert_equal 10.0, ZoneDistribution.sample_dt([0, 100], 0, 2) # 100 s → clampé à 10
    assert_equal 0.0, ZoneDistribution.sample_dt([10, 5], 0, 2)   # temps qui recule
  end

  # ── bucketize : regroupement d'un histogramme en zones ──────────────────────
  test "bucketize classe chaque palier par son point milieu / seuil" do
    hist = { "0" => 10, "100" => 20, "200" => 30 }
    # FTP = 200 W, paliers de 25 W → milieux 12.5 / 112.5 / 212.5 → frac 0.06 / 0.56 / 1.06.
    zones = ZoneDistribution.bucketize(hist, 200, POWER_ZONES, 25)
    assert_equal({ "z1" => 10.0, "z2" => 20.0, "z5" => 30.0 }, zones)
  end

  test "bucketize renvoie {} sans seuil valide" do
    assert_equal({}, ZoneDistribution.bucketize({ "100" => 5 }, 0, POWER_ZONES, 25))
    assert_equal({}, ZoneDistribution.bucketize({ "100" => 5 }, nil, POWER_ZONES, 25))
  end

  # ── zone_key : zone contenant une fraction du seuil ─────────────────────────
  test "zone_key : borne basse incluse, repli z1, dernière zone ouverte" do
    assert_equal "z1", ZoneDistribution.zone_key(0.5, HR_ZONES)
    assert_equal "z2", ZoneDistribution.zone_key(0.81, HR_ZONES)  # borne basse incluse
    assert_equal "z4", ZoneDistribution.zone_key(0.95, HR_ZONES)
    assert_equal "z5", ZoneDistribution.zone_key(2.0, HR_ZONES)   # au-delà → dernière zone
    assert_equal "z1", ZoneDistribution.zone_key(-1.0, HR_ZONES)  # repli
  end

  # ── merge_zone_seconds : cumul de plusieurs sorties ─────────────────────────
  test "merge_zone_seconds additionne zone par zone" do
    into = { "z1" => 10.0 }
    result = ZoneDistribution.merge_zone_seconds(into, { "z1" => 5.0, "z2" => 3.0 })
    assert_equal({ "z1" => 15.0, "z2" => 3.0 }, result)
    assert_same into, result   # mutation en place
  end

  # ── present : mise en forme pour le front ───────────────────────────────────
  test "present liste toutes les zones (0 inclus) avec pourcentages" do
    out = ZoneDistribution.present({ "z1" => 30.0, "z2" => 10.0 }, HR_ZONES)

    assert_equal 40, out[:total_seconds]
    assert_equal 5, out[:zones].length   # z1..z5, y compris les zones vides
    assert_equal({ zone: "z1", seconds: 30, pct: 75.0 }, out[:zones][0])
    assert_equal({ zone: "z2", seconds: 10, pct: 25.0 }, out[:zones][1])
    assert_equal({ zone: "z3", seconds: 0, pct: 0.0 }, out[:zones][2])
  end

  test "present renvoie nil quand le total est nul" do
    assert_nil ZoneDistribution.present({}, HR_ZONES)
    assert_nil ZoneDistribution.present({ "z1" => 0.0 }, HR_ZONES)
  end

  # ── Enchaînement complet : streams → histogramme → zones → présentation ─────
  test "le pipeline complet répartit le temps sur les bonnes zones" do
    # 3 s à 100 W puis 2 s à 200 W (FTP 200) → z2 puis z5.
    streams = { "time" => [0, 1, 2, 3, 4], "watts" => [100, 100, 100, 200, 200] }
    hist = ZoneDistribution.histogram(streams, "watts", 25)
    zones = ZoneDistribution.bucketize(hist, 200, POWER_ZONES, 25)
    out = ZoneDistribution.present(zones, POWER_ZONES)

    z2 = out[:zones].find { |z| z[:zone] == "z2" }
    z5 = out[:zones].find { |z| z[:zone] == "z5" }
    assert_equal 3, z2[:seconds]
    assert_equal 2, z5[:seconds]
    assert_equal 5, out[:total_seconds]
  end
end
