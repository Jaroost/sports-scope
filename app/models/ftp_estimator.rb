# Estimation de la FTP (Functional Threshold Power) d'un utilisateur à partir de sa
# courbe de puissance déjà persistée (`peak_powers`), pour l'analyse d'entraînement.
#
# Vélo uniquement (la FTP est une notion cyclisme) : on ne retient que les activités
# de catégorie `cycling` (cf. `PerformanceRecords.sport_category`) qui portent une
# courbe de puissance.
#
# Deux méthodes, on garde la plus haute des deux (choix produit « le meilleur des deux ») :
#   • 95 % du meilleur 20 min  (règle classique et robuste)
#   • modèle Critical Power à 2 points (5 min + 20 min) — CP ≈ FTP
# La FTP « courante » est estimée sur une fenêtre glissante de 6 semaines ; si aucun
# effort avec puissance n'y figure, on retombe sur l'estimation tous-temps (marquée
# `stale`). Une valeur manuelle (test officiel) saisie dans les préférences prime.
module FtpEstimator
  module_function

  WINDOW_DAYS = 42          # fenêtre glissante « forme récente » (6 semaines)
  FTP_20MIN_FACTOR = 0.95   # FTP ≈ 95 % du meilleur 20 min
  CP_SHORT = 300            # point court du modèle Critical Power (5 min)
  CP_LONG  = 1200           # point long du modèle Critical Power (20 min)

  # Payload complet consommé par la carte FTP du front.
  def summary(user)
    acts = cycling_power_activities(user)
    manual = manual_ftp(user)
    weight = weight_kg(user)

    recent = estimate_between(acts, WINDOW_DAYS.days.ago, nil)
    auto = recent || estimate_between(acts, nil, nil)

    current_watts = manual&.positive? ? manual : auto&.dig(:watts)
    {
      current: {
        watts: current_watts,
        source: (manual&.positive? ? 'manual' : (auto ? 'auto' : nil)),
        # auto a dû retomber sur l'historique faute d'effort récent avec puissance.
        stale: manual.nil? && recent.nil? && auto.present?,
        w_per_kg: w_per_kg(current_watts, weight)
      },
      auto: auto,
      manual: { watts: manual, at: manual_at(user) },
      weight_kg: weight,
      history: history(acts)
    }
  end

  # Activités vélo (les 2 sources) portant une courbe de puissance, réduites au
  # strict nécessaire : date + courbe `peak_powers`. On `select` explicitement pour
  # ne PAS charger la colonne `streams` (volumineuse) inutile ici.
  def cycling_power_activities(user)
    strava = user.strava_activities.select(:started_at, :activity_type, :peak_powers)
    imported = user.imported_activities.select(:started_at, :activity_type, :peak_powers)
    (strava.to_a + imported.to_a).filter_map do |a|
      next unless PerformanceRecords.sport_category(a.activity_type) == 'cycling'
      next unless a.started_at

      curve = a.peak_powers
      next unless curve.is_a?(Hash) && curve.any?

      { started_at: a.started_at, peak: curve }
    end
  end

  # Estimation sur les activités dont la date est dans [from, to] (bornes nil = ouvertes).
  def estimate_between(acts, from, to)
    subset = acts.select do |a|
      (from.nil? || a[:started_at] >= from) && (to.nil? || a[:started_at] <= to)
    end
    estimate_from(subset)
  end

  # Cœur du calcul : meilleure des deux méthodes sur un sous-ensemble d'activités.
  # Renvoie nil si aucune estimation exploitable.
  def estimate_from(subset)
    return nil if subset.empty?

    best20 = subset.filter_map { |a| numeric(a[:peak][CP_LONG.to_s]) }.max
    best5  = subset.filter_map { |a| numeric(a[:peak][CP_SHORT.to_s]) }.max

    ftp20 = best20 && best20 * FTP_20MIN_FACTOR
    cp = critical_power(best5, best20)
    # Garde-fou de plausibilité : une CP hors de [0,85×20min ; 20min] trahit des
    # données bancales (effort 5 min non maximal, etc.) — on l'écarte alors.
    cp = nil if cp && best20 && !cp.between?(best20 * 0.85, best20)

    candidates = { 'ftp_20min' => ftp20, 'cp' => cp }.compact.select { |_, v| v.positive? }
    return nil if candidates.empty?

    method, watts = candidates.max_by { |_, v| v }
    {
      watts: watts.round,
      method: method,
      ftp_20min: ftp20&.round,
      cp: cp&.round,
      best_20min: best20&.round,
      best_5min: best5&.round,
      samples: subset.size
    }
  end

  # Modèle Critical Power à 2 points : P(t) = W'/t + CP.
  # CP ≈ FTP. Exige P(court) > P(long) (sinon modèle dégénéré).
  def critical_power(p_short, p_long)
    return nil unless p_short && p_long && p_short > p_long

    wprime = (p_short - p_long) / (1.0 / CP_SHORT - 1.0 / CP_LONG)
    cp = p_short - wprime / CP_SHORT
    cp.positive? ? cp : nil
  end

  # Série mensuelle : à chaque fin de mois, estimation sur les 6 semaines précédentes.
  # Montre la progression (et le désentraînement) plutôt qu'un simple record cumulé.
  def history(acts)
    return [] if acts.empty?

    now = Time.current
    cursor = acts.map { |a| a[:started_at] }.min.beginning_of_month
    points = []
    while cursor <= now
      window_end = [cursor.end_of_month, now].min
      est = estimate_between(acts, window_end - WINDOW_DAYS.days, window_end)
      points << { date: cursor.strftime('%Y-%m'), watts: est[:watts], method: est[:method] } if est
      cursor = (cursor + 1.month).beginning_of_month
    end
    points
  end

  # ── Helpers préférences ─────────────────────────────────────────────────────
  def manual_ftp(user)
    numeric(athlete(user)['ftp_manual'])&.round
  end

  def manual_at(user)
    athlete(user)['ftp_manual_at']
  end

  def weight_kg(user)
    numeric(athlete(user)['weight_kg'])
  end

  def athlete(user)
    user.preferences_with_defaults['athlete'] || {}
  end

  def w_per_kg(watts, weight)
    return nil unless watts && weight && weight.positive?

    (watts.to_f / weight).round(2)
  end

  def numeric(value)
    return value.to_f if value.is_a?(Numeric)
    return value.to_f if value.is_a?(String) && value.match?(/\A-?\d+(\.\d+)?\z/)

    nil
  end
end
