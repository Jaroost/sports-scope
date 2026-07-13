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

  # Ratio charge aiguë / chronique (ACWR) : fenêtres de moyenne du TSS quotidien.
  ACWR_ACUTE_DAYS = 7
  ACWR_CHRONIC_DAYS = 28

  # Fenêtre (jours) de la répartition du temps par zone d'intensité : ~6 semaines,
  # comme la FTP, pour refléter l'entraînement RÉCENT et non l'historique complet.
  ZONE_WINDOW_DAYS = 42

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
      current: current.merge(form_zone: form_zone(current[:tsb]), acwr_zone: acwr_zone(current[:acwr])),
      series: series,
      zones: zone_distribution(user, ftp_at: ftp_at, lthr: lthr_info[:value]),
      coverage: {
        power: coverage['power'], hr: coverage['hr'],
        estimated: coverage['estimated'], total: coverage.values.sum
      },
      thresholds: {
        ftp_current: ftp_at.call(Time.zone.today),
        lthr: lthr_info[:value],
        lthr_source: lthr_info[:source],
        lthr_auto: lthr_info[:auto],
        typical_speed_kmh: typical_cycling_speed(rows),
        longest_ride_min: longest_recent_ride_min(rows)
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
    loads = []
    series = []
    (from..to).each do |day|
      tss = daily[day] || 0.0
      loads << tss
      ctl += (tss - ctl) * k_ctl
      atl += (tss - atl) * k_atl
      series << {
        date: day.iso8601, tss: tss.round(1),
        ctl: ctl.round(1), atl: atl.round(1), tsb: (ctl - atl).round(1),
        acwr: acwr_at(loads)
      }
    end
    series
  end

  # Ratio charge aiguë / chronique (rolling) : moyenne du TSS quotidien sur 7 j sur la
  # moyenne sur 28 j (jours de repos = 0 inclus). nil tant qu'on n'a pas 28 j
  # d'historique (artefact de démarrage) ou si la charge chronique est nulle.
  # `loads` = TSS quotidiens dans l'ordre chronologique, jusqu'au jour courant.
  def acwr_at(loads)
    return nil if loads.length < ACWR_CHRONIC_DAYS

    acute = loads.last(ACWR_ACUTE_DAYS).sum / ACWR_ACUTE_DAYS.to_f
    chronic = loads.last(ACWR_CHRONIC_DAYS).sum / ACWR_CHRONIC_DAYS.to_f
    return nil unless chronic.positive?

    (acute / chronic).round(2)
  end

  # Zone de risque de l'ACWR (« sweet spot » 0,8–1,3). Clés interprétées côté front.
  def acwr_zone(acwr)
    return nil if acwr.nil?
    return 'detraining' if acwr < 0.8
    return 'optimal' if acwr <= 1.3
    return 'caution' if acwr <= 1.5

    'high_risk'
  end

  # ── Répartition du temps par zone d'intensité (FC & puissance), 6 dernières
  # semaines. FC : un seul seuil courant (LTHR) → on cumule les histogrammes puis on
  # classe une fois. Puissance : la FTP varie dans le temps → on classe chaque sortie
  # avec la FTP de sa date, puis on cumule les secondes par zone. Vélo uniquement pour
  # la puissance. Renvoie nil pour un canal sans données ou sans seuil. ─────────────
  def zone_distribution(user, ftp_at:, lthr:)
    cutoff = ZONE_WINDOW_DAYS.days.ago.to_date
    hr_hist = Hash.new(0.0)
    power_zone_secs = Hash.new(0.0)

    zone_rows(user, cutoff).each do |a|
      ZoneDistribution.merge_zone_seconds(hr_hist, a[:hr_histogram])
      next unless PerformanceRecords.sport_category(a[:activity_type]) == 'cycling'

      ZoneDistribution.merge_zone_seconds(
        power_zone_secs,
        ZoneDistribution.bucketize(a[:power_histogram], ftp_at.call(a[:date]),
                                   ZoneDistribution::POWER_ZONES, ZoneDistribution::POWER_BUCKET)
      )
    end

    hr_zone_secs = ZoneDistribution.bucketize(hr_hist, lthr, ZoneDistribution::HR_ZONES, ZoneDistribution::HR_BUCKET)
    {
      window_days: ZONE_WINDOW_DAYS,
      hr: ZoneDistribution.present(hr_zone_secs, ZoneDistribution::HR_ZONES),
      power: ZoneDistribution.present(power_zone_secs, ZoneDistribution::POWER_ZONES)
    }
  end

  # Activités récentes (les 2 sources) réduites à ce qu'il faut pour les zones :
  # date, type, et les deux histogrammes pré-calculés. On `select` explicitement pour
  # ne PAS charger la colonne `streams` (volumineuse).
  def zone_rows(user, cutoff)
    cols = %i[started_at activity_type hr_histogram power_histogram]
    strava = user.strava_activities.where(started_at: cutoff..).select(cols)
    imported = user.imported_activities.where(started_at: cutoff..).select(cols)
    (strava.to_a + imported.to_a).filter_map do |a|
      date = a.started_at&.to_date
      next unless date

      { date: date, activity_type: a.activity_type,
        hr_histogram: a.hr_histogram || {}, power_histogram: a.power_histogram || {} }
    end
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

  # Plus longue sortie vélo récente (min, ~90 derniers jours) — repère de durabilité
  # pour juger si une grosse distance visée est atteignable. nil sans data.
  def longest_recent_ride_min(rows)
    cutoff = 90.days.ago.to_date
    durations = rows.filter_map do |r|
      next unless PerformanceRecords.sport_category(r['activity_type']) == 'cycling'

      date = parse_date(r['started_at'])
      next unless date && date >= cutoff

      secs = r['moving_time_s'].to_i
      secs if secs.positive?
    end
    return nil if durations.empty?

    (durations.max / 60.0).round
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
    { current: nil, series: [], zones: nil, coverage: { power: 0, hr: 0, estimated: 0, total: 0 }, thresholds: {} }
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
