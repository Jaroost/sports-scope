require "test_helper"

# Estimation du seuil cardiaque d'UNE sortie. Fonctions pures : on couvre le choix
# de l'ancre (20 min / ~1 h), le plancher de vraisemblance et la lecture des streams.
class LthrEstimatorTest < ActiveSupport::TestCase
  # ── Choix de l'ancre ────────────────────────────────────────────────────────
  test "sans effort d'1 h, l'ancre est le 20 min abattu de 2 %" do
    est = LthrEstimator.estimate_from_curve({ "1200" => 170.0 })

    assert_equal "lthr_20min", est[:method]
    assert_equal 167, est[:bpm] # 170 × 0.98
    assert_equal 170, est[:best_20min]
    assert_equal [1200], est[:durations]
  end

  test "l'effort d'~1 h l'emporte quand il donne le seuil le plus haut" do
    est = LthrEstimator.estimate_from_curve({ "1200" => 165.0, "3600" => 168.0 })

    assert_equal "lthr_60min", est[:method]
    assert_equal 168, est[:bpm]
    assert_equal [3600], est[:durations]
  end

  test "le 20 min l'emporte quand la sortie d'1 h était plus calme" do
    # 175 × 0.98 = 171,5 > 150 : une heure tranquille ne rabaisse pas le seuil.
    est = LthrEstimator.estimate_from_curve({ "1200" => 175.0, "3600" => 150.0 })

    assert_equal "lthr_20min", est[:method]
    assert_equal 172, est[:bpm]
  end

  # ── Garde-fous ──────────────────────────────────────────────────────────────
  test "une sortie sous le plancher de vraisemblance ne donne pas de seuil" do
    assert_nil LthrEstimator.estimate_from_curve({ "1200" => 95.0 })
    # 101 × 0.98 = 98,98 < 100 : rejeté aussi.
    assert_nil LthrEstimator.estimate_from_curve({ "1200" => 101.0 })
  end

  test "renvoie nil sans courbe exploitable" do
    assert_nil LthrEstimator.estimate_from_curve(nil)
    assert_nil LthrEstimator.estimate_from_curve({})
    assert_nil LthrEstimator.estimate_from_curve({ "300" => 180.0 }) # hors ancres
  end

  # ── Depuis les streams ──────────────────────────────────────────────────────
  test "estimate_from_streams lit la FC et remonte la FC max instantanée" do
    times = (0..1200).to_a
    # 20 min à 160 bpm, avec une pointe isolée à 195.
    hr = Array.new(1201, 160)
    hr[600] = 195

    est = LthrEstimator.estimate_from_streams("time" => times, "heartrate" => hr)

    assert_equal "lthr_20min", est[:method]
    assert_in_delta 157, est[:bpm], 1 # ≈ 160 × 0.98
    assert_equal 195, est[:max_hr]
  end

  test "estimate_from_streams accepte l'enveloppe { data: [...] } des importateurs" do
    times = (0..1200).to_a
    est = LthrEstimator.estimate_from_streams(
      "time" => { "data" => times }, "heartrate" => { "data" => Array.new(1201, 170) }
    )

    assert_equal 167, est[:bpm]
  end

  test "estimate_from_streams renvoie nil sans flux de FC" do
    assert_nil LthrEstimator.estimate_from_streams(nil)
    assert_nil LthrEstimator.estimate_from_streams("time" => (0..1200).to_a)
    # Sortie trop courte pour la plus petite ancre (20 min).
    assert_nil LthrEstimator.estimate_from_streams(
      "time" => (0..600).to_a, "heartrate" => Array.new(601, 170)
    )
  end
end
