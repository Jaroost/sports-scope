# Seuils et zones d'entraînement d'un cycliste, sous la forme dont l'application
# mobile a besoin pendant une sortie.
#
# Pourquoi un modèle à part plutôt que de réutiliser la page Performances : celle-ci
# renvoie l'historique, la forme, la fatigue — tout ce qu'on regarde tranquillement
# à la maison. Sur un guidon, on n'a besoin que du seuil et des bornes de zones, et
# ça doit partir vite. `TrainingLoad.summary` recalcule CTL/ATL sur tout
# l'historique : hors de question au démarrage d'une navigation.
#
# Les bornes sont renvoyées en valeurs absolues (watts, bpm) et non en fractions :
# l'appli n'a alors ni seuil ni arithmétique à retenir, et une zone affichée ne peut
# pas diverger de celle du site.
module RiderProfile
  module_function

  def summary(user)
    ftp = FtpEstimator.summary(user)
    athlete = user.preferences_with_defaults["athlete"] || {}

    watts = ftp.dig(:current, :watts)
    lthr = athlete["lthr_manual"]

    {
      ftp: {
        watts: watts,
        source: ftp.dig(:current, :source),
        w_per_kg: ftp.dig(:current, :w_per_kg)
      },
      lthr: lthr,
      weight_kg: ftp[:weight_kg],
      power_zones: bounds(ZoneDistribution::POWER_ZONES, watts),
      hr_zones: bounds(ZoneDistribution::HR_ZONES, lthr)
    }
  end

  # Convertit les bornes fractionnaires des zones en valeurs absolues. La borne
  # haute d'une zone est la borne basse de la suivante ; la dernière est ouverte
  # (`hi: nil`).
  #
  # Sans seuil, on renvoie une liste vide plutôt que des zones calculées sur une
  # valeur inventée : l'appli affiche « FTP inconnue », ce qui est honnête, là où
  # des zones fausses induiraient l'effort en erreur.
  def bounds(zones, threshold)
    return [] unless threshold.is_a?(Numeric) && threshold.positive?

    zones.each_with_index.map do |zone, i|
      nxt = zones[i + 1]
      {
        key: zone[:key],
        lo: (threshold * zone[:lo]).round,
        hi: nxt && (threshold * nxt[:lo]).round
      }
    end
  end
end
