# Agrégations « records / analyse de performance » sur l'ensemble des activités
# d'un utilisateur (les deux tables `strava_activities` + `imported_activities`,
# unifiées en lecture par `UserActivities`).
#
# Tout est calculé à partir d'UNE seule lecture des lignes de résumé (sans les
# `streams`, volumineux mais AVEC la petite courbe `peak_powers`) : les activités
# sont regroupées par catégorie de sport (`for_user` renvoie un groupe « all »
# plus un groupe par sport présent), et pour chaque groupe on calcule les records
# absolus (max d'une colonne + l'activité qui le détient), les cumuls, le
# découpage par année, les meilleures périodes et la courbe puissance-max/temps.
#
# La segmentation par sport est essentielle : un gros dénivelé à ski n'a pas la
# même valeur qu'à vélo, on ne veut donc pas mélanger leurs records.
module PerformanceRecords
  module_function

  # Colonnes de résumé chargées pour tout calculer côté Ruby (peak_powers inclus
  # pour dériver la courbe de puissance par sport sans requête supplémentaire).
  SUMMARY_COLUMNS = %w[
    name started_at activity_type distance_m moving_time_s elapsed_time_s
    total_elevation_gain max_speed average_speed max_heartrate max_watts
    average_watts max_cadence peak_powers
  ].freeze

  # Regroupement des `activity_type` Strava/FIT hétérogènes en catégories de sport
  # stables. La casse est ignorée et on cherche par mot-clé (cf. `sport_category`).
  SPORT_MATCHERS = [
    ['cycling',  %w[ride cycl bike velo vtt mtb]],
    ['running',  %w[run trail]],
    ['ski',      %w[ski snowboard splitboard]],
    ['hiking',   %w[hike walk hik marche rando]],
    ['swimming', %w[swim nage]]
  ].freeze

  # Chaque record absolu : clé i18n, colonne source, unité (pour le front).
  # Ce sont tous des maxima (« higher is better »).
  ABSOLUTE_METRICS = [
    { key: 'longest_distance',  column: 'distance_m',           unit: 'distance' },
    { key: 'longest_duration',  column: 'moving_time_s',        unit: 'duration' },
    { key: 'biggest_elevation', column: 'total_elevation_gain', unit: 'elevation' },
    { key: 'max_speed',         column: 'max_speed',            unit: 'speed' },
    { key: 'max_heartrate',     column: 'max_heartrate',        unit: 'bpm' },
    { key: 'max_power',         column: 'max_watts',            unit: 'watts' },
    { key: 'max_cadence',       column: 'max_cadence',          unit: 'rpm' }
  ].freeze

  CACHE_TTL = 12.hours

  # Payload complet consommé par la page d'analyse : un onglet « all » agrégé +
  # un groupe par sport présent, plus la liste des sports (triée par volume).
  # Mis en cache, clé versionnée par les activités (records = données brutes,
  # aucun seuil athlète en jeu) → invalidé dès qu'une sortie change.
  def for_user(user)
    key = ['performance_records', user.id, UserActivities.data_version(user.id)].join('/')
    Rails.cache.fetch(key, expires_in: CACHE_TTL) { compute_for_user(user) }
  end

  def compute_for_user(user)
    rows = summary_rows(user.id)
    groups = rows.group_by { |r| sport_category(r['activity_type']) }

    sports = groups
             .map { |key, rs| { key: key, count: rs.length } }
             .sort_by { |h| -h[:count] }

    by_sport = { 'all' => compute_group(rows) }
    groups.each { |key, rs| by_sport[key] = compute_group(rs) }

    { sports: sports, by_sport: by_sport, count: rows.length }
  end

  # Tous les indicateurs pour un sous-ensemble de lignes (un sport, ou « all »).
  def compute_group(rows)
    {
      count: rows.length,
      records: absolute_records(rows),
      totals: totals(rows),
      by_year: by_year(rows),
      best_periods: best_periods(rows),
      peak_power: peak_power_bests(rows)
    }
  end

  # Lignes de résumé de toutes les activités de l'utilisateur (une par activité).
  def summary_rows(user_id)
    union = UserActivities.union_sql(user_id: user_id, columns: SUMMARY_COLUMNS)
    UserActivities.select_all("SELECT * FROM (#{union}) rows", 'PerformanceRecords#summary_rows')
  end

  # Catégorie de sport d'un `activity_type` (mot-clé, casse ignorée). Inconnu → 'other'.
  def sport_category(activity_type)
    t = activity_type.to_s.downcase
    SPORT_MATCHERS.each do |category, keywords|
      return category if keywords.any? { |kw| t.include?(kw) }
    end
    'other'
  end

  # Pour chaque métrique, l'activité au maximum. Métriques sans donnée → absentes.
  def absolute_records(rows)
    ABSOLUTE_METRICS.filter_map do |metric|
      best = rows.max_by { |r| numeric(r[metric[:column]]) || -Float::INFINITY }
      value = best && numeric(best[metric[:column]])
      next if value.nil? || value <= 0

      { key: metric[:key], unit: metric[:unit], value: value, activity: activity_ref(best) }
    end
  end

  # Meilleure puissance moyenne par durée sur le groupe + l'activité détentrice.
  # Même forme que `PeakPowerCurve.bests_for_user` (avg_watts/source/…), dérivée
  # ici des `peak_powers` déjà chargés (aucune requête supplémentaire).
  def peak_power_bests(rows)
    out = {}
    PeakPowerCurve::DURATIONS.each do |duration|
      key = duration.to_s
      best_row = nil
      best_val = nil
      rows.each do |row|
        curve = parse_peak_powers(row['peak_powers'])
        value = curve && numeric(curve[key])
        next if value.nil? || value <= 0
        next unless best_val.nil? || value > best_val

        best_val = value
        best_row = row
      end
      next unless best_row

      out[key] = {
        avg_watts: best_val,
        name: best_row['name'],
        source: best_row['source'],
        external_id: best_row['external_id'],
        started_at: parse_time(best_row['started_at'])&.iso8601
      }
    end
    out
  end

  # Cumuls globaux du groupe.
  def totals(rows)
    {
      count: rows.length,
      distance_m: sum(rows, 'distance_m'),
      elevation: sum(rows, 'total_elevation_gain'),
      moving_time_s: sum(rows, 'moving_time_s').round
    }
  end

  # Un agrégat par année civile (décroissant), pour un mini-historique.
  def by_year(rows)
    grouped = rows.group_by { |r| year_of(r) }.reject { |y, _| y.nil? }
    grouped.map do |year, yr_rows|
      {
        year: year,
        count: yr_rows.length,
        distance_m: sum(yr_rows, 'distance_m'),
        elevation: sum(yr_rows, 'total_elevation_gain'),
        moving_time_s: sum(yr_rows, 'moving_time_s').round
      }
    end.sort_by { |h| -h[:year] }
  end

  # Meilleure année et meilleur mois pour la distance et le dénivelé cumulés.
  def best_periods(rows)
    {
      best_year_distance: best_bucket(rows, :year, 'distance_m'),
      best_month_distance: best_bucket(rows, :month, 'distance_m'),
      best_year_elevation: best_bucket(rows, :year, 'total_elevation_gain'),
      best_month_elevation: best_bucket(rows, :month, 'total_elevation_gain')
    }
  end

  # Le seau (année ou mois) au plus grand cumul de `column`.
  def best_bucket(rows, grain, column)
    grouped =
      case grain
      when :year  then rows.group_by { |r| year_of(r) }
      when :month then rows.group_by { |r| month_of(r) }
      end
    grouped = grouped.reject { |k, _| k.nil? }
    return nil if grouped.empty?

    label, bucket_rows = grouped.max_by { |_, rs| sum(rs, column) }
    total = sum(bucket_rows, column)
    return nil if total <= 0

    { label: label, value: total, count: bucket_rows.length }
  end

  # ── Helpers ────────────────────────────────────────────────────────────────

  # Descripteur d'activité pour lier vers sa page côté front.
  def activity_ref(row)
    {
      source: row['source'],
      external_id: row['external_id'],
      name: row['name'],
      type: row['activity_type'],
      started_at: parse_time(row['started_at'])&.iso8601
    }
  end

  # `peak_powers` revient de la sous-requête soit déjà désérialisé (Hash) soit en
  # texte JSON selon la détection de type du pilote — on gère les deux.
  def parse_peak_powers(value)
    return value if value.is_a?(Hash)
    return JSON.parse(value) if value.is_a?(String) && value.present?

    nil
  rescue JSON::ParserError
    nil
  end

  def sum(rows, column)
    rows.sum { |r| numeric(r[column]) || 0.0 }
  end

  def numeric(value)
    return value.to_f if value.is_a?(Numeric)
    return value.to_f if value.is_a?(String) && value.match?(/\A-?\d+(\.\d+)?\z/)

    nil
  end

  def year_of(row)
    parse_time(row['started_at'])&.year
  end

  # Étiquette « YYYY-MM » pour un regroupement mensuel triable.
  def month_of(row)
    t = parse_time(row['started_at'])
    t && format('%04d-%02d', t.year, t.month)
  end

  def parse_time(value)
    return value if value.is_a?(Time)
    return nil if value.blank?

    Time.zone.parse(value.to_s)
  rescue ArgumentError
    nil
  end
end
