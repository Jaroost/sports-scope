# Seuils estimés SUR UNE SORTIE (page d'analyse d'activité) : ce que cette sortie,
# à elle seule, prouve de la FTP (puissance) et du LTHR (cardio) — mis en regard
# des seuils de référence de l'athlète, ceux qui servent au TSS et aux zones.
#
# L'intérêt est la comparaison : « ce que j'ai sorti aujourd'hui » vs « ce sur quoi
# l'app calcule ma charge ». Une sortie tranquille donne des valeurs basses, c'est
# normal et le front le dit — ces estimations ne mettent JAMAIS à jour les seuils
# de l'athlète, qui restent l'affaire de `FtpEstimator` (fenêtre glissante) et des
# préférences (valeur manuelle).
module ActivityThresholds
  module_function

  # `peak_powers` = la courbe persistée de la sortie ({ "1200" => watts, … }),
  # `streams` = ses flux bruts (pour la FC), `activity_type` = le type Strava.
  # Renvoie toujours un Hash — chaque estimation vaut nil si la sortie ne porte pas
  # de quoi la calculer.
  def for_activity(user, peak_powers:, streams:, activity_type: nil)
    weight = FtpEstimator.weight_kg(user)
    ftp = cycling?(activity_type) ? FtpEstimator.estimate_activity(peak_powers) : nil
    # W/kg de la FTP estimée — le repère qui se compare d'un athlète à l'autre.
    # nil sans poids renseigné (préférences athlète).
    ftp = ftp.merge(w_per_kg: FtpEstimator.w_per_kg(ftp[:watts], weight)) if ftp

    {
      ftp: ftp,
      lthr: LthrEstimator.estimate_from_streams(streams),
      reference: reference_for(user).merge(weight_kg: weight)
    }
  end

  # Seuils de référence de l'athlète, tels qu'utilisés pour le TSS et les zones.
  # Vient du même cache que le tableau de charge d'entraînement (clé partagée) :
  # en pratique l'entrée est déjà chaude quand on ouvre une activité.
  def reference_for(user)
    thresholds = TrainingLoad.summary(user)[:thresholds] || {}
    {
      ftp: thresholds[:ftp_current],
      lthr: thresholds[:lthr],
      lthr_source: thresholds[:lthr_source]
    }
  end

  # La FTP est une notion cyclisme : on ne l'estime pas sur une course à pied, même
  # quand un capteur (Stryd) fournit des watts. Même regroupement de sports que la
  # page performance. Un type inconnu (activité non synchronisée) laisse passer :
  # sans courbe de puissance l'estimation sera nil de toute façon.
  def cycling?(activity_type)
    return true if activity_type.blank?

    PerformanceRecords.sport_category(activity_type) == 'cycling'
  end
end
