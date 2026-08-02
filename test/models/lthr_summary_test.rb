require "test_helper"

# Le câblage base de données du seuil cardiaque de l'athlète : la lecture des courbes
# `peak_heartrates` persistées, le filtre vélo, la fenêtre glissante et la priorité de
# la valeur manuelle. Le cœur mathématique, lui, est couvert par `lthr_estimator_test`
# sans base.
class LthrSummaryTest < ActiveSupport::TestCase
  def user(suffix = SecureRandom.hex(4))
    User.create!(email: "lthr-#{suffix}@example.com", keycloak_uid: "kc-lthr-#{suffix}")
  end

  def ride(owner, curve:, type: "Ride", started_at: 3.days.ago, name: "Sortie", max_hr: nil)
    ImportedActivity.create!(
      user_id: owner.id, name: name, activity_type: type, started_at: started_at,
      peak_heartrates: curve, max_heartrate: max_hr
    )
  end

  test "le seuil sort des courbes cardio persistées" do
    owner = user
    ride(owner, curve: { "1200" => 170.0 }, name: "Col", max_hr: 186)

    summary = LthrEstimator.summary(owner)

    assert_equal 167, summary.dig(:current, :bpm) # 170 × 0,98
    assert_equal "auto", summary.dig(:current, :source)
    assert_equal "lthr_20min", summary.dig(:current, :method)
    assert_equal 186, summary.dig(:auto, :max_hr)
    assert_equal "Col", summary.dig(:auto, :contributors).first[:name]
    refute summary.dig(:current, :stale)
  end

  test "sans courbe cardio, pas de seuil inventé" do
    owner = user
    ride(owner, curve: {})

    summary = LthrEstimator.summary(owner)

    assert_nil summary.dig(:current, :bpm)
    assert_nil summary.dig(:current, :source)
    assert_nil summary[:auto]
  end

  test "la course à pied ne fabrique pas un seuil de cycliste" do
    owner = user
    # Le seuil cardiaque est spécifique au sport : à pied il est typiquement 5 à
    # 10 bpm plus haut, et les zones qu'on lit au guidon sont celles du vélo.
    ride(owner, curve: { "1200" => 180.0 }, type: "Run", name: "Semi")

    assert_nil LthrEstimator.summary(owner)[:auto]
  end

  test "hors fenêtre glissante, le seuil sert quand même mais se dit périmé" do
    owner = user
    ride(owner, curve: { "1200" => 176.0 }, started_at: 100.days.ago, name: "L'hiver dernier")

    summary = LthrEstimator.summary(owner)

    # Un seuil d'il y a trois mois reste infiniment plus juste que pas de seuil.
    assert_equal 172, summary.dig(:current, :bpm)
    assert summary.dig(:current, :stale), "le front doit pouvoir dire que la valeur date"
  end

  test "une sortie récente chasse l'ancienne, même moins bonne" do
    owner = user
    ride(owner, curve: { "1200" => 176.0 }, started_at: 100.days.ago)
    ride(owner, curve: { "1200" => 160.0 }, started_at: 5.days.ago)

    summary = LthrEstimator.summary(owner)

    # La fenêtre mesure la forme du moment, pas le souvenir du meilleur jour.
    assert_equal 157, summary.dig(:current, :bpm)
    refute summary.dig(:current, :stale)
  end

  test "la valeur manuelle prime sur l'estimation" do
    owner = user
    ride(owner, curve: { "1200" => 170.0 })
    owner.update!(preferences: { "athlete" => { "lthr_manual" => 165 } })

    summary = LthrEstimator.summary(owner)

    assert_equal 165, summary.dig(:current, :bpm)
    assert_equal "manual", summary.dig(:current, :source)
    # L'estimation reste calculée : le front la montre à côté, c'est ce qui permet
    # de constater qu'une saisie ancienne ne colle plus à la forme du moment.
    assert_equal 167, summary.dig(:auto, :bpm)
    assert_equal 165, summary.dig(:manual, :bpm)
  end

  test "les sorties d'un autre compte ne comptent pas" do
    owner = user("a")
    ride(user("b"), curve: { "1200" => 180.0 })

    assert_nil LthrEstimator.summary(owner)[:auto]
  end

  # ── RiderProfile : ce que reçoit l'application mobile ───────────────────────
  test "le profil envoyé à l'appli porte le seuil estimé et ses zones" do
    owner = user
    ride(owner, curve: { "1200" => 170.0 })

    profile = RiderProfile.summary(owner)

    # Le point de tout ce chantier : sans rien avoir saisi, le cycliste a des zones
    # cardio au guidon.
    assert_equal 167, profile[:lthr]
    assert_equal "auto", profile[:lthr_source]
    assert_equal 5, profile[:hr_zones].length
    assert_equal 167, profile[:hr_zones].last[:lo], "z5 démarre au seuil"
  end

  test "le profil marque un seuil saisi à la main comme tel" do
    owner = user
    ride(owner, curve: { "1200" => 170.0 })
    owner.update!(preferences: { "athlete" => { "lthr_manual" => 165 } })

    profile = RiderProfile.summary(owner)

    assert_equal 165, profile[:lthr]
    assert_equal "manual", profile[:lthr_source]
    assert_equal 165, profile[:hr_zones].last[:lo]
  end

  test "sans rien de connu, le profil n'invente aucune zone cardio" do
    profile = RiderProfile.summary(user)

    assert_nil profile[:lthr]
    assert_nil profile[:lthr_source]
    assert_equal [], profile[:hr_zones]
  end

  # ── TrainingLoad : le rang des trois sources ────────────────────────────────
  test "TrainingLoad préfère l'estimation cardio au vieux proxy" do
    owner = user
    ride(owner, curve: { "1200" => 170.0 })
    # Le proxy grossier partirait de cette FC moyenne : 150 / 0,92 × 0,9 = 147.
    rows = [{ "average_heartrate" => 150.0 }]

    info = TrainingLoad.lthr(owner, rows)

    assert_equal 167, info[:value]
    assert_equal "lthr_20min", info[:method]
  end

  test "sans courbe cardio à vélo, TrainingLoad garde le vieux proxy" do
    owner = user
    # Le cas du coureur à pied, et celui des sorties Strava dont les streams n'ont
    # jamais été récupérés : mieux vaut un ordre de grandeur que pas de TSS.
    rows = [{ "average_heartrate" => 150.0 }]

    info = TrainingLoad.lthr(owner, rows)

    assert_equal 147, info[:value]
    assert_equal "auto", info[:source]
    assert_equal "hr_max_proxy", info[:method]
  end

  test "TrainingLoad laisse la main à la valeur manuelle" do
    owner = user
    ride(owner, curve: { "1200" => 170.0 })
    owner.update!(preferences: { "athlete" => { "lthr_manual" => 162 } })

    info = TrainingLoad.lthr(owner, [{ "average_heartrate" => 150.0 }])

    assert_equal 162, info[:value]
    assert_equal "manual", info[:source]
    assert_nil info[:method]
  end
end
