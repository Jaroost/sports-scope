require "test_helper"

# Tests de la conversion des zones en valeurs absolues (fonction pure). Le câblage
# ActiveRecord de `RiderProfile.summary` (FtpEstimator, préférences) n'est pas couvert
# par ce fichier : c'est celui de FtpEstimator, déjà testé à part.
class RiderProfileTest < ActiveSupport::TestCase
  test "les bornes de puissance sont absolues, la dernière ouverte" do
    zones = RiderProfile.bounds(ZoneDistribution::POWER_ZONES, 250)

    assert_equal 7, zones.length
    assert_equal({ key: "z1", lo: 0, hi: 138 }, zones.first)
    # z4 = seuil : 0,90 → 1,05 de la FTP.
    assert_equal({ key: "z4", lo: 225, hi: 263 }, zones[3])
    assert_equal "z7", zones.last[:key]
    assert_nil zones.last[:hi], "la dernière zone est ouverte vers le haut"
  end

  test "les bornes cardiaques suivent le seuil FC" do
    zones = RiderProfile.bounds(ZoneDistribution::HR_ZONES, 170)

    assert_equal 5, zones.length
    assert_equal 0, zones.first[:lo]
    # z5 démarre au seuil lui-même.
    assert_equal 170, zones.last[:lo]
    assert_nil zones.last[:hi]
  end

  test "la borne haute d'une zone est la borne basse de la suivante" do
    zones = RiderProfile.bounds(ZoneDistribution::POWER_ZONES, 300)

    zones.each_cons(2) do |current, following|
      assert_equal following[:lo], current[:hi],
                   "pas de trou ni de recouvrement entre #{current[:key]} et #{following[:key]}"
    end
  end

  test "sans seuil, aucune zone n'est inventée" do
    # Des zones calculées sur un seuil deviné induiraient l'effort en erreur :
    # mieux vaut que l'appli affiche « FTP inconnue ».
    assert_equal [], RiderProfile.bounds(ZoneDistribution::POWER_ZONES, nil)
    assert_equal [], RiderProfile.bounds(ZoneDistribution::HR_ZONES, 0)
    assert_equal [], RiderProfile.bounds(ZoneDistribution::POWER_ZONES, -10)
    assert_equal [], RiderProfile.bounds(ZoneDistribution::POWER_ZONES, "250")
  end

  test "les zones couvrent toute la plage sans trou" do
    zones = RiderProfile.bounds(ZoneDistribution::POWER_ZONES, 200)

    assert_equal 0, zones.first[:lo], "la première zone part de zéro"
    [10, 120, 199, 200, 350, 900].each do |watts|
      matching = zones.count { |z| watts >= z[:lo] && (z[:hi].nil? || watts < z[:hi]) }
      assert_equal 1, matching, "#{watts} W doit tomber dans exactement une zone"
    end
  end
end
