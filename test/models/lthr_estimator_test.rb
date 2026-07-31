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

  # ── Seuil de l'athlète : agrégation sur plusieurs sorties ───────────────────
  def ride(curve, started_at: 3.days.ago, name: "Sortie", max_hr: nil)
    { started_at: started_at, curve: curve, max_hr: max_hr,
      name: name, source: "imported", external_id: "1" }
  end

  test "les deux ancres peuvent venir de deux sorties différentes" do
    # Le col donne le meilleur 20 min, le contre-la-montre la meilleure heure :
    # deux preuves indépendantes du même seuil, qu'on ne veut pas s'obliger à
    # trouver dans une seule sortie.
    est = LthrEstimator.estimate_from([
                                        ride({ "1200" => 170.0 }, name: "Col"),
                                        ride({ "3600" => 168.0 }, name: "CLM")
                                      ])

    assert_equal "lthr_60min", est[:method] # 168 > 170 × 0,98
    assert_equal 168, est[:bpm]
    assert_equal 170, est[:best_20min]
    assert_equal 168, est[:best_60min]
    assert_equal 2, est[:samples]
    assert_equal "CLM", est[:contributors].first[:name]
  end

  test "l'estimation nomme la sortie qui la porte" do
    est = LthrEstimator.estimate_from([
                                        ride({ "1200" => 175.0 }, name: "Col de la Croix"),
                                        ride({ "1200" => 150.0 }, name: "Récup")
                                      ])

    assert_equal "lthr_20min", est[:method]
    assert_equal 172, est[:bpm] # 175 × 0,98
    # Un seuil dont on ne peut pas remonter à l'effort qui le prouve se discute
    # sans fin ; avec la sortie nommée, il se vérifie.
    assert_equal 1, est[:contributors].length
    assert_equal "Col de la Croix", est[:contributors].first[:name]
    assert_equal 1200, est[:contributors].first[:duration]
    assert_equal 175, est[:contributors].first[:bpm]
  end

  test "une sortie tranquille ne rabaisse pas le seuil de l'athlète" do
    # C'est toute la différence avec l'estimation d'UNE sortie : en agrégeant, il
    # suffit d'un effort soutenu dans la fenêtre pour que le seuil soit juste.
    est = LthrEstimator.estimate_from([
                                        ride({ "1200" => 174.0 }, name: "Intervalles"),
                                        ride({ "1200" => 120.0, "3600" => 115.0 }, name: "Balade")
                                      ])

    assert_equal 171, est[:bpm] # 174 × 0,98, la balade n'y change rien
  end

  test "estimate_between ne garde que la fenêtre demandée" do
    acts = [
      ride({ "1200" => 176.0 }, started_at: 100.days.ago, name: "L'hiver dernier"),
      ride({ "1200" => 160.0 }, started_at: 5.days.ago, name: "Cette semaine")
    ]

    recent = LthrEstimator.estimate_between(acts, LthrEstimator::WINDOW_DAYS.days.ago, nil)
    all_time = LthrEstimator.estimate_between(acts, nil, nil)

    assert_equal 157, recent[:bpm] # 160 × 0,98 : la forme du moment
    assert_equal 172, all_time[:bpm] # 176 × 0,98 : le meilleur de tous les temps
  end

  test "estimate_from ne rend rien sans sortie exploitable" do
    assert_nil LthrEstimator.estimate_from([])
    # Une courbe sans ancre : la sortie existe mais aucune durée utile.
    assert_nil LthrEstimator.estimate_from([ride({ "300" => 180.0 })])
  end

  test "le plancher de vraisemblance vaut aussi pour l'agrégat" do
    assert_nil LthrEstimator.estimate_from([ride({ "1200" => 95.0 }), ride({ "1200" => 90.0 })])
  end

  # ── Historique mensuel (le graphique de la page Performances) ───────────────
  test "l'historique donne un point par mois, sur la fenêtre glissante" do
    acts = [
      ride({ "1200" => 160.0 }, started_at: 4.months.ago, name: "Reprise"),
      ride({ "1200" => 175.0 }, started_at: 2.days.ago, name: "Intervalles")
    ]

    points = LthrEstimator.history(acts)

    # Un point par mois depuis la première sortie, sauf les mois dont la fenêtre de
    # 6 semaines ne contient aucun effort.
    assert points.length >= 2
    assert_equal 157, points.first[:bpm] # 160 × 0,98, le mois de la reprise
    assert_equal 172, points.last[:bpm]  # 175 × 0,98, le mois en cours
    assert_equal Time.current.strftime("%Y-%m"), points.last[:date]
    assert_equal "Intervalles", points.last[:contributors].first[:name]
  end

  test "un trou dans l'entraînement fait redescendre la courbe" do
    # Tout l'intérêt de la fenêtre glissante : un record de janvier ne doit pas
    # tenir la courbe en l'air jusqu'à la fin des temps, sinon elle ne dirait plus
    # rien du désentraînement.
    acts = [ride({ "1200" => 175.0 }, started_at: 5.months.ago)]

    points = LthrEstimator.history(acts)

    assert_equal 172, points.first[:bpm]
    refute_equal Time.current.strftime("%Y-%m"), points.last[:date],
                 "le mois en cours n'a aucun effort : il ne doit pas porter de point"
  end

  test "sans sortie, pas d'historique" do
    assert_equal [], LthrEstimator.history([])
  end
end
