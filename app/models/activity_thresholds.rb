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

  # Recul (mois) utilisé pour situer le seuil de référence dans une dynamique de
  # progression plutôt qu'une valeur figée — assez court pour rester lisible comme
  # « tendance récente », assez long pour ne pas être bruité par un seul mois creux.
  TREND_MONTHS = 3

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
  #
  # `ftp_trend`/`lthr_trend` : où en est le seuil COURANT face à il y a
  # `TREND_MONTHS` mois — pas une propriété de cette sortie, mais le contexte qui dit
  # si on est en phase de progression ou de plateau au moment où elle a été faite.
  def reference_for(user)
    thresholds = TrainingLoad.summary(user)[:thresholds] || {}
    {
      ftp: thresholds[:ftp_current],
      lthr: thresholds[:lthr],
      lthr_source: thresholds[:lthr_source],
      ftp_trend: trend(FtpEstimator.summary(user)[:history], :watts),
      lthr_trend: trend(LthrEstimator.summary(user, with_history: true)[:history], :bpm)
    }
  end

  # Écart entre le dernier point de la série mensuelle et celui d'il y a
  # `TREND_MONTHS` mois (ou le plus récent avant cette date, si le mois exact manque
  # à l'historique). nil sans historique assez long, ou si les deux points coïncident
  # (moins de `TREND_MONTHS` mois de données réellement estimées).
  def trend(history, key)
    return nil if history.blank? || history.size < 2

    latest = history.last
    target = (Date.parse("#{latest[:date]}-01") << TREND_MONTHS).strftime('%Y-%m')
    base = history.reverse_each.find { |p| p[:date] <= target }
    return nil unless base && base[:date] != latest[:date]

    { delta: latest[key] - base[key], months: TREND_MONTHS, from_date: base[:date] }
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
