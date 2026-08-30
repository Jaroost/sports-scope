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

  # Les deux seuils sont pris à leur valeur COURANTE, celle-là même qui sert au TSS
  # et aux zones du site : manuelle si l'athlète l'a saisie, estimée sinon. L'appli
  # n'a donc jamais de zones qui contredisent celles du site.
  #
  # Le cardio a longtemps fait exception — seule une LTHR saisie à la main comptait,
  # faute d'estimation digne de ce nom au niveau de l'athlète. Depuis que la courbe
  # cardio est persistée par sortie (`peak_heartrates`), `LthrEstimator` estime le
  # seuil sur une fenêtre glissante comme le fait `FtpEstimator` pour la puissance :
  # l'exception n'a plus lieu d'être, et un cycliste qui n'a jamais rien saisi voit
  # enfin ses zones cardio au guidon.
  #
  def summary(user)
    ftp = FtpEstimator.summary(user)
    lthr = LthrEstimator.summary(user, with_history: false)

    watts = ftp.dig(:current, :watts)
    bpm = lthr.dig(:current, :bpm)

    {
      ftp: {
        watts: watts,
        source: ftp.dig(:current, :source),
        w_per_kg: ftp.dig(:current, :w_per_kg)
      },
      lthr: bpm,
      # `manual` ou `auto` — l'appli en fait la différence entre un seuil mesuré et un
      # seuil déduit. Même vocabulaire que `ftp.source`.
      lthr_source: lthr.dig(:current, :source),
      weight_kg: ftp[:weight_kg],
      # Modèle de puissance critique : CP (W) et capacité anaérobie W′ (J),
      # pour le W′ balance affiché en roulant (`WPrimeBalance` côté appli).
      # `nil` quand la courbe puissance-durée n'a pas assez de points pour
      # l'ajustement — l'appli retombe alors sur la FTP comme CP et une W′ par
      # défaut. Pris sur l'estimation `auto` (jamais sur une FTP manuelle, qui
      # n'a pas de W′ associée).
      cp: ftp.dig(:auto, :cp),
      w_prime: ftp.dig(:auto, :w_prime),
      power_zones: bounds(ZoneDistribution::POWER_ZONES, watts),
      hr_zones: bounds(ZoneDistribution::HR_ZONES, bpm)
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
