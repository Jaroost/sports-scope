require "test_helper"

# Tests du cœur mathématique de FtpEstimator (fonctions pures, sans base de données).
# On vérifie ici l'estimation FTP proprement dite : ajustement Critical Power, choix
# de la meilleure méthode, agrégation mean-max. Le câblage ActiveRecord
# (`cycling_power_activities`, cache, préférences) n'est pas couvert par ce fichier.
class FtpEstimatorTest < ActiveSupport::TestCase
  # ── numeric : coercition tolérante utilisée partout dans le module ──────────
  test "numeric convertit nombres et chaînes numériques, rejette le reste" do
    assert_equal 42.0, FtpEstimator.numeric(42)
    assert_equal 3.5, FtpEstimator.numeric(3.5)
    assert_equal 250.0, FtpEstimator.numeric("250")
    assert_equal(-1.5, FtpEstimator.numeric("-1.5"))
    assert_nil FtpEstimator.numeric("abc")
    assert_nil FtpEstimator.numeric("250w")
    assert_nil FtpEstimator.numeric(nil)
  end

  # ── critical_power_fit : régression W(t) = CP·t + W' ────────────────────────
  test "critical_power_fit retrouve CP et W' sur des points parfaitement colinéaires" do
    cp = 250.0
    wprime = 20_000.0
    power = ->(t) { cp + wprime / t } # P(t) = CP + W'/t

    fit = FtpEstimator.critical_power_fit(
      300 => power.call(300), 600 => power.call(600), 1200 => power.call(1200)
    )

    refute_nil fit
    assert_in_delta cp, fit[:cp], 0.01
    assert_in_delta wprime, fit[:w_prime], 0.5
    assert_equal 3, fit[:points]
    assert_equal [300, 600, 1200], fit[:durations]
  end

  test "critical_power_fit exige au moins deux durées de la bande seuil" do
    assert_nil FtpEstimator.critical_power_fit(1200 => 260.0)
    assert_nil FtpEstimator.critical_power_fit(60 => 400.0, 3600 => 240.0)
  end

  test "critical_power_fit rejette une CP incohérente (≥ à la plus faible puissance)" do
    # Points non décroissants → CP calculée dépasserait min(P) : garde-fou → nil.
    assert_nil FtpEstimator.critical_power_fit(300 => 250.0, 600 => 260.0, 1200 => 270.0)
  end

  # ── estimate_from : choix de la meilleure méthode ───────────────────────────
  test "estimate_from renvoie nil sur un sous-ensemble vide" do
    assert_nil FtpEstimator.estimate_from([])
  end

  test "estimate_from retombe sur l'ancre 20 min quand c'est la seule donnée" do
    subset = [activity(peak: { "1200" => 300 })]

    est = FtpEstimator.estimate_from(subset)

    assert_equal "ftp_20min", est[:method]
    assert_equal 285, est[:watts] # 300 × 0.95
    assert_equal 300, est[:best_20min]
    assert_nil est[:cp]
  end

  test "estimate_from préfère le modèle CP quand il donne la FTP la plus haute" do
    cp = 250.0
    wprime = 5_000.0
    power = ->(t) { cp + wprime / t }
    subset = [activity(peak: {
      "300" => power.call(300), "600" => power.call(600), "1200" => power.call(1200)
    })]

    est = FtpEstimator.estimate_from(subset)

    assert_equal "cp_model", est[:method]
    assert_equal 250, est[:cp]
    assert_in_delta 242, est[:watts], 1 # 250 × 0.97
  end

  # ── mean_max_entries : agrégation par durée, activité détentrice tracée ──────
  test "mean_max_entries garde la meilleure puissance par durée et son activité" do
    weak = activity(name: "faible", peak: { "1200" => 280 })
    strong = activity(name: "forte", peak: { "1200" => 300, "300" => 400 })

    entries = FtpEstimator.mean_max_entries([weak, strong])

    assert_equal 300, entries[1200][:watts]
    assert_equal "forte", entries[1200][:activity][:name]
    assert_equal 400, entries[300][:watts]
    assert_equal "forte", entries[300][:activity][:name]
  end

  private

  def activity(peak:, name: "sortie", started_at: nil)
    { started_at: started_at, peak: peak, name: name, source: "strava", external_id: "1" }
  end
end
