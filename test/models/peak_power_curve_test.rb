require "test_helper"

# Tests de l'algorithme numérique de courbe puissance-durée (mean-max). On couvre ici les
# fonctions pures — `compute_from` (le cœur) et `stream_values` (déballage des streams).
# Les méthodes `bests_for_user` / `podium_for` / `better_count` / `best_row` tapent la base
# (UserActivities) et relèvent d'un test d'intégration, non de ce fichier.
class PeakPowerCurveTest < ActiveSupport::TestCase
  # Streams au format attendu : { "time" => [...], "watts" => [...] }.
  def streams(times, watts)
    { "time" => times, "watts" => watts }
  end

  # ── Garde-fous d'entrée ─────────────────────────────────────────────────────
  test "compute_from renvoie {} sur une entrée non exploitable" do
    assert_equal({}, PeakPowerCurve.compute_from(nil))
    assert_equal({}, PeakPowerCurve.compute_from([1, 2, 3]))
    assert_equal({}, PeakPowerCurve.compute_from(streams([0, 1], nil)))
    assert_equal({}, PeakPowerCurve.compute_from(streams([0], [200]))) # n < 2
  end

  # ── Puissance constante ─────────────────────────────────────────────────────
  test "puissance constante : chaque durée ≤ à la sortie vaut cette puissance" do
    times = (0..60).to_a
    watts = Array.new(61, 200)

    curve = PeakPowerCurve.compute_from(streams(times, watts))

    # Seules les durées couvertes par la sortie (span 60 s) apparaissent.
    assert_equal({ "5" => 200.0, "15" => 200.0, "30" => 200.0, "60" => 200.0 }, curve)
  end

  # ── Profil avec pic court ───────────────────────────────────────────────────
  test "un pic court gonfle les courtes durées ; la courbe reste non croissante" do
    # 5 s à 500 W puis 100 W jusqu'à 60 s.
    times = (0..60).to_a
    watts = Array.new(61, 100)
    (0..4).each { |i| watts[i] = 500 }

    curve = PeakPowerCurve.compute_from(streams(times, watts))

    assert_equal 500.0, curve["5"]      # la fenêtre 5 s tombe pile sur le pic
    assert_in_delta 233.33, curve["15"], 0.01
    assert_in_delta 166.67, curve["30"], 0.01
    assert_in_delta 133.33, curve["60"], 0.01
    # Mean-max : plus la durée est longue, plus la puissance soutenable baisse.
    assert curve["5"] >= curve["15"]
    assert curve["15"] >= curve["30"]
    assert curve["30"] >= curve["60"]
  end

  test "des watts non numériques comptent pour 0 (aucune durée retenue)" do
    times = (0..30).to_a
    watts = Array.new(31, nil)

    assert_equal({}, PeakPowerCurve.compute_from(streams(times, watts)))
  end

  test "un échantillonnage irrégulier respecte le temps réel, pas l'index" do
    # Deux mesures espacées de 10 s : la seule durée couverte est 5 s (span 10 s).
    times = [0, 10]
    watts = [300, 300]

    curve = PeakPowerCurve.compute_from(streams(times, watts))

    # energy = 300 W × 10 s ; fenêtre 5 s → (3000)/10 = 300 sur l'unique intervalle.
    assert_equal({ "5" => 300.0 }, curve)
  end

  # ── stream_values : déballage des formats de streams ────────────────────────
  test "stream_values accepte tableau nu, enveloppe data, et clés symboles" do
    assert_equal [1, 2, 3], PeakPowerCurve.stream_values({ "watts" => [1, 2, 3] }, "watts")
    assert_equal [4, 5], PeakPowerCurve.stream_values({ "watts" => { "data" => [4, 5] } }, "watts")
    assert_equal [6, 7], PeakPowerCurve.stream_values({ watts: [6, 7] }, "watts")
    assert_nil PeakPowerCurve.stream_values({ "watts" => 42 }, "watts")
    assert_nil PeakPowerCurve.stream_values({}, "watts")
  end

  test "compute_from déballe les streams enveloppés dans { data: … }" do
    times = { "data" => (0..60).to_a }
    watts = { "data" => Array.new(61, 250) }

    curve = PeakPowerCurve.compute_from({ "time" => times, "watts" => watts })

    assert_equal 250.0, curve["60"]
  end
end
