# Modèle « forme / fatigue » (Performance Management Chart) : à partir du TSS
# quotidien de toutes les activités, on dérive par moyennes mobiles exponentielles :
#   • CTL (Chronic Training Load, 42 j)  → « forme de fond » (fitness)
#   • ATL (Acute Training Load,   7 j)   → « fatigue »
#   • TSB (Training Stress Balance)      → CTL − ATL = « fraîcheur / forme du jour »
#
# Le TSS de chaque sortie est calculé en cascade (couverture complète) :
#   1. puissance : IF = NP / FTP(date), TSS = h × IF² × 100      (le plus fiable)
#   2. FC        : IF = FC_moy / LTHR,  TSS = h × IF² × 100      (repli)
#   3. estimation: IF par défaut selon le sport                  (dernier recours)
#
# NP est pré-stocké par activité (`normalized_power`) ; le TSS, lui, se calcule ici
# car il dépend de seuils modifiables (FTP variable dans le temps, LTHR). On ne
# charge donc JAMAIS les streams ici (colonnes de résumé + NP seulement).
module TrainingLoad
  module_function

  CTL_DAYS = 42
  ATL_DAYS = 7
  INTENSITY_CAP = 1.5 # borne l'IF pour éviter des TSS absurdes sur données bancales

  # Facteur d'intensité par défaut (sorties sans puissance ni FC), par sport.
  # TSS/h ≈ IF² × 100 : vélo≈49, course≈56, ski≈30, rando≈25.
  ESTIMATED_IF = {
    'cycling' => 0.70, 'running' => 0.75, 'ski' => 0.55,
    'hiking' => 0.50, 'swimming' => 0.70, 'other' => 0.60
  }.freeze

  # ── Puissance normalisée (NP) ───────────────────────────────────────────────
  # Moyenne mobile 30 s de la puissance, élevée à la puissance 4, moyennée, puis
  # racine 4e. Suppose un échantillonnage ~1 Hz (Strava/FIT). NULL si pas de watts.
  def normalized_power(streams)
    watts = PeakPowerCurve.stream_values(streams, 'watts')
    return nil unless watts.is_a?(Array) && watts.length >= 30

    clean = watts.map { |x| x.is_a?(Numeric) && x.finite? ? x.to_f : 0.0 }
    window = 30
    rolling = []
    sum = 0.0
    clean.each_with_index do |val, i|
      sum += val
      sum -= clean[i - window] if i >= window
      rolling << sum / window if i >= window - 1
    end
    return nil if rolling.empty?

    np = (rolling.sum { |r| r**4 } / rolling.length)**0.25
    np.finite? && np.positive? ? np.round(1) : nil
  end

  # ── Payload complet consommé par le front ───────────────────────────────────
  def summary(user)
    rows = load_rows(user)
    return empty_summary if rows.empty?

    ftp_at = build_ftp_resolver(user)
    lthr_info = lthr(user, rows)

    daily = Hash.new(0.0)
    daily_activities = Hash.new { |h, k| h[k] = [] }
    coverage = Hash.new(0)
    rows.each do |row|
      date = parse_date(row['started_at'])
      next unless date

      res = activity_tss(row, ftp: ftp_at.call(date), lthr: lthr_info[:value])
      next unless res

      daily[date] += res[:tss]
      coverage[res[:source]] += 1
      daily_activities[date] << {
        source: row['source'], external_id: row['external_id'],
        name: row['name'], tss: res[:tss], source_tss: res[:source]
      }
    end
    return empty_summary if daily.empty?

    series = performance_management(daily)
    attach_activities(series, daily_activities)
    current = series.last

    {
      current: current.merge(form_zone: form_zone(current[:tsb])),
      series: series,
      coverage: {
        power: coverage['power'], hr: coverage['hr'],
        estimated: coverage['estimated'], total: coverage.values.sum
      },
      thresholds: {
        ftp_current: ftp_at.call(Time.zone.today),
        lthr: lthr_info[:value],
        lthr_source: lthr_info[:source],
        lthr_auto: lthr_info[:auto],
        typical_speed_kmh: typical_cycling_speed(rows)
      }
    }
  end

  # ── TSS d'une activité (cascade puissance → FC → estimation) ─────────────────
  def activity_tss(row, ftp:, lthr:)
    secs = row['moving_time_s'].to_i
    return nil if secs <= 0

    hours = secs / 3600.0
    np = numeric(row['normalized_power'])
    if np&.positive? && ftp&.positive?
      return tss_from_if(hours, np / ftp, 'power')
    end

    hr = numeric(row['average_heartrate'])
    if hr&.positive? && lthr&.positive?
      return tss_from_if(hours, hr / lthr, 'hr')
    end

    intensity = ESTIMATED_IF[PerformanceRecords.sport_category(row['activity_type'])] || ESTIMATED_IF['other']
    tss_from_if(hours, intensity, 'estimated')
  end

  def tss_from_if(hours, intensity, source)
    intensity = intensity.clamp(0.0, INTENSITY_CAP)
    { tss: (hours * intensity**2 * 100).round(1), source: source, intensity: intensity.round(3) }
  end

  # ── Moyennes mobiles exponentielles CTL/ATL/TSB, jour par jour ───────────────
  def performance_management(daily)
    from = daily.keys.min
    to = Time.zone.today
    k_ctl = 1 - Math.exp(-1.0 / CTL_DAYS)
    k_atl = 1 - Math.exp(-1.0 / ATL_DAYS)

    ctl = 0.0
    atl = 0.0
    series = []
    (from..to).each do |day|
      tss = daily[day] || 0.0
      ctl += (tss - ctl) * k_ctl
      atl += (tss - atl) * k_atl
      series << { date: day.iso8601, tss: tss.round(1), ctl: ctl.round(1), atl: atl.round(1), tsb: (ctl - atl).round(1) }
    end
    series
  end

  # Attache à chaque point de série les activités du jour (triées par TSS décroissant),
  # pour permettre au front d'ouvrir la séance principale au clic. Jours de repos → [].
  def attach_activities(series, daily_activities)
    by_iso = daily_activities.transform_keys(&:iso8601)
    series.each do |point|
      acts = by_iso[point[:date]] || []
      point[:activities] = acts.sort_by { |a| -a[:tss] }
    end
    series
  end

  # Zone de forme (TSB) — clés interprétées côté front (couleur + libellé + aide).
  def form_zone(tsb)
    return 'very_fresh' if tsb >= 20
    return 'fresh' if tsb >= 5
    return 'neutral' if tsb >= -10
    return 'productive' if tsb >= -30

    'overreaching'
  end

  # ── Seuils ───────────────────────────────────────────────────────────────────
  # FTP effective à une date : valeur manuelle à partir de sa date de saisie, sinon
  # l'estimation auto (fenêtre glissante) du mois de l'activité, sinon l'estimation
  # tous-temps. Retourne un lambda (date -> watts|nil).
  def build_ftp_resolver(user)
    acts = FtpEstimator.cycling_power_activities(user)
    monthly = FtpEstimator.history(acts).map { |p| [Date.parse("#{p[:date]}-01"), p[:watts]] }
    alltime = FtpEstimator.estimate_between(acts, nil, nil)&.dig(:watts)
    manual = FtpEstimator.manual_ftp(user)
    manual_at = parse_date(FtpEstimator.manual_at(user))

    lambda do |date|
      return manual if manual&.positive? && manual_at && date >= manual_at

      applicable = monthly.select { |month_start, _| month_start <= date }.max_by(&:first)
      applicable&.last || alltime || (manual&.positive? ? manual : nil)
    end
  end

  # LTHR effectif (bpm) : valeur manuelle si renseignée, sinon estimation auto
  # ≈ 90 % de la FC max observée. Renvoie la source + l'auto (pour l'UI).
  def lthr(user, rows)
    manual = FtpEstimator.numeric(FtpEstimator.athlete(user)['lthr_manual'])&.round
    auto = auto_lthr(rows)
    value = manual&.positive? ? manual : auto
    { value: value, auto: auto, source: (manual&.positive? ? 'manual' : (auto ? 'auto' : nil)) }
  end

  # Vitesse « habituelle » à vélo (km/h) = médiane des vitesses moyennes des sorties
  # vélo. Sert à traduire une durée recommandée en distance approximative. nil sans data.
  def typical_cycling_speed(rows)
    speeds = rows.filter_map do |r|
      next unless PerformanceRecords.sport_category(r['activity_type']) == 'cycling'

      v = numeric(r['average_speed'])
      v if v&.positive?
    end
    return nil if speeds.empty?

    sorted = speeds.sort
    mid = sorted.length / 2
    median = sorted.length.odd? ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0
    (median * 3.6).round(1) # m/s → km/h
  end

  def auto_lthr(rows)
    max_hr = rows.filter_map { |r| numeric(r['average_heartrate']) }.max
    # `average_heartrate` sous-estime la FC max ; on approxime la FC max par le plus
    # haut des FC moyennes /0.92, puis LTHR ≈ 0,9 × FC max. Grossier mais borné.
    return nil unless max_hr&.positive?

    (max_hr / 0.92 * 0.9).round
  end

  # ── Helpers ──────────────────────────────────────────────────────────────────
  def load_rows(user)
    columns = %w[name started_at moving_time_s average_heartrate activity_type normalized_power average_speed]
    union = UserActivities.union_sql(user_id: user.id, columns: columns)
    UserActivities.select_all("SELECT * FROM (#{union}) rows", 'TrainingLoad#load_rows')
  end

  def empty_summary
    { current: nil, series: [], coverage: { power: 0, hr: 0, estimated: 0, total: 0 }, thresholds: {} }
  end

  def parse_date(value)
    return value.to_date if value.respond_to?(:to_date) && !value.is_a?(String)
    return nil if value.blank?

    Time.zone.parse(value.to_s)&.to_date
  rescue ArgumentError
    nil
  end

  def numeric(value)
    return value.to_f if value.is_a?(Numeric)
    return value.to_f if value.is_a?(String) && value.match?(/\A-?\d+(\.\d+)?\z/)

    nil
  end
end
