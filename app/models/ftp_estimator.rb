# Estimation de la FTP (Functional Threshold Power) d'un utilisateur à partir de sa
# courbe de puissance déjà persistée (`peak_powers`), pour l'analyse d'entraînement.
#
# Vélo uniquement (la FTP est une notion cyclisme) : on ne retient que les activités
# de catégorie `cycling` (cf. `PerformanceRecords.sport_category`) qui portent une
# courbe de puissance.
#
# On garde la plus haute des méthodes disponibles :
#   • modèle Critical Power multi-points — régression W(t)=CP·t+W' sur la courbe
#     puissance-durée (5/10/20 min). Robuste, et estimable SANS effort de 20 min
#     (eFTP à partir d'efforts plus courts). FTP ≈ 0,97 × CP.
#   • puissance ~60 min × 0,98 — ancre directe quand un vrai effort d'~1 h existe
#   • 95 % du meilleur 20 min — repli/garde-fou classique
# La FTP « courante » est estimée sur une fenêtre glissante de 6 semaines ; si aucun
# effort avec puissance n'y figure, on retombe sur l'estimation tous-temps (marquée
# `stale`). Une valeur manuelle (test officiel) saisie dans les préférences prime.
module FtpEstimator
  module_function

  WINDOW_DAYS = 42          # fenêtre glissante « forme récente » (6 semaines)
  FTP_20MIN_FACTOR = 0.95   # FTP ≈ 95 % du meilleur 20 min
  FTP_60MIN_FACTOR = 0.98   # FTP ≈ 98 % d'un effort soutenu d'~1 h
  CP_TO_FTP_FACTOR = 0.97   # FTP ≈ 97 % de la Critical Power (abattement conservateur)
  # Durées (s) de la bande « seuil » pour l'ajustement Critical Power : ~5–20 min,
  # là où la relation travail = CP·t + W' est la mieux vérifiée (en deçà l'anaérobie
  # domine, au-delà la fatigue/pacing courbe la relation).
  CP_FIT_DURATIONS = [300, 600, 1200].freeze

  CACHE_TTL = 12.hours
  # À incrémenter quand la FORME du payload change : sans ça, les entrées déjà en
  # cache (12 h) resserviraient sans les nouveaux champs. v2 = ajout de `contributors`.
  CACHE_VERSION = 'v2'

  # Payload complet consommé par la carte FTP du front. Mis en cache, clé versionnée
  # par les activités ET les seuils athlète (FTP manuelle/poids) → invalidé dès
  # qu'une sortie ou un réglage change.
  def summary(user)
    key = ['ftp', CACHE_VERSION, user.id, UserActivities.data_version(user.id),
           Digest::MD5.hexdigest(athlete(user).to_json)].join('/')
    Rails.cache.fetch(key, expires_in: CACHE_TTL) { compute_summary(user) }
  end

  def compute_summary(user)
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
  # strict nécessaire : identité (pour lier vers l'activité) + date + courbe
  # `peak_powers`. On `select` explicitement pour ne PAS charger la colonne
  # `streams` (volumineuse) inutile ici.
  def cycling_power_activities(user)
    strava = user.strava_activities.select(:strava_id, :name, :started_at, :activity_type, :peak_powers)
    imported = user.imported_activities.select(:id, :name, :started_at, :activity_type, :peak_powers)
    rows = strava.to_a.map { |a| [a, 'strava', a.strava_id] } +
           imported.to_a.map { |a| [a, 'imported', a.id] }
    rows.filter_map do |a, source, external_id|
      next unless PerformanceRecords.sport_category(a.activity_type) == 'cycling'
      next unless a.started_at

      curve = a.peak_powers
      next unless curve.is_a?(Hash) && curve.any?

      { started_at: a.started_at, peak: curve,
        name: a.name, source: source, external_id: external_id.to_s }
    end
  end

  # Estimation sur les activités dont la date est dans [from, to] (bornes nil = ouvertes).
  def estimate_between(acts, from, to)
    subset = acts.select do |a|
      (from.nil? || a[:started_at] >= from) && (to.nil? || a[:started_at] <= to)
    end
    estimate_from(subset)
  end

  # Cœur du calcul : meilleure des méthodes disponibles sur un sous-ensemble.
  # Renvoie nil si aucune estimation exploitable.
  def estimate_from(subset)
    return nil if subset.empty?

    entries = mean_max_entries(subset)
    curve = entries.transform_values { |e| e[:watts] }
    best20 = curve[1200]
    best60 = curve[3600]

    ftp20 = best20 && best20 * FTP_20MIN_FACTOR
    ftp60 = best60 && best60 * FTP_60MIN_FACTOR
    fit = critical_power_fit(curve)
    cp = fit && fit[:cp]
    # Garde-fou : quand un 20 min existe, la CP doit rester dans [0,85×20min ; 20min]
    # (P(t) décroît, donc CP = P(∞) < P(20min)) ; hors bornes = données bancales.
    cp = nil if cp && best20 && !cp.between?(best20 * 0.85, best20)
    ftp_cp = cp && cp * CP_TO_FTP_FACTOR # FTP dérivée de la CP (abattement conservateur)

    candidates = {
      'cp_model' => ftp_cp, 'ftp_60min' => ftp60, 'ftp_20min' => ftp20
    }.compact.select { |_, v| v.positive? }
    return nil if candidates.empty?

    method, watts = candidates.max_by { |_, v| v }
    {
      watts: watts.round,
      method: method,
      contributors: contributors(method, entries, fit),
      cp: cp&.round,
      w_prime: fit && fit[:w_prime].round,
      cp_points: fit ? fit[:points] : 0,
      ftp_20min: ftp20&.round,
      ftp_60min: ftp60&.round,
      best_20min: best20&.round,
      best_60min: best60&.round,
      best_5min: curve[300]&.round,
      samples: subset.size
    }
  end

  # Courbe puissance-durée agrégée du sous-ensemble : pour chaque durée standard, la
  # meilleure puissance atteinte, toutes sorties confondues (façon « mean-max curve »),
  # AVEC l'activité qui la détient (deux durées peuvent venir de sorties différentes).
  # Clés = durées en secondes (Integer), valeurs = { watts:, activity: }.
  def mean_max_entries(subset)
    PeakPowerCurve::DURATIONS.each_with_object({}) do |d, out|
      best = subset.filter_map do |a|
        value = numeric(a[:peak][d.to_s])
        [value, a] if value&.positive?
      end.max_by { |value, _| value }
      out[d] = { watts: best[0], activity: best[1] } if best
    end
  end

  # Clés = durées en secondes (Integer), valeurs = watts (Float).
  def mean_max_curve(subset)
    mean_max_entries(subset).transform_values { |e| e[:watts] }
  end

  # Efforts ayant réellement déterminé l'estimation, pour les afficher/lier côté front.
  # Dépend de la méthode retenue : les ancres 20/60 min reposent sur UN seul effort,
  # le modèle CP sur les 2–3 durées effectivement ajustées.
  def contributors(method, entries, fit)
    durations = case method
                when 'ftp_20min' then [1200]
                when 'ftp_60min' then [3600]
                else fit ? fit[:durations] : []
                end
    durations.filter_map do |d|
      entry = entries[d]
      next unless entry

      act = entry[:activity]
      { duration: d, watts: entry[:watts].round, name: act[:name], source: act[:source],
        external_id: act[:external_id], started_at: act[:started_at]&.iso8601 }
    end
  end

  # Modèle Critical Power multi-points, ajusté par moindres carrés sur la forme
  # linéaire en travail : W(t) = P(t)·t = CP·t + W' (pente = CP, ordonnée = W').
  # Utilise les durées de `CP_FIT_DURATIONS` présentes dans la courbe (≥ 2 requises).
  # Contrairement au modèle 2 points, un effort non maximal isolé ne fausse pas tout,
  # et l'estimation reste possible SANS effort de 20 min (eFTP via 5 / 10 min).
  def critical_power_fit(curve)
    points = CP_FIT_DURATIONS.filter_map { |d| [d, curve[d]] if curve[d]&.positive? }
    return nil if points.size < 2

    n = points.size
    sum_t  = points.sum { |t, _| t }
    sum_w  = points.sum { |t, p| p * t }
    sum_tt = points.sum { |t, _| t * t }
    sum_tw = points.sum { |t, p| t * p * t }
    denom = n * sum_tt - sum_t**2
    return nil if denom.zero?

    cp = (n * sum_tw - sum_t * sum_w) / denom
    wprime = (sum_w - cp * sum_t) / n
    return nil unless cp.positive? && wprime.positive?
    # CP = P(∞) doit rester sous la plus faible puissance ajustée (P décroît avec t).
    return nil if cp >= points.map { |_, p| p }.min

    { cp: cp, w_prime: wprime, points: n, durations: points.map { |t, _| t } }
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
      if est
        points << { date: cursor.strftime('%Y-%m'), watts: est[:watts], method: est[:method],
                    contributors: est[:contributors] }
      end
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
