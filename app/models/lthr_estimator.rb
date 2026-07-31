# Estimation du seuil cardiaque (LTHR — Lactate Threshold Heart Rate) à partir des
# courbes mean-max de FC. Pendant que `FtpEstimator` répond « quelle puissance
# cette sortie prouve », ce module répond la même chose côté cardio.
#
# Deux ancres, dans l'esprit des protocoles de terrain :
#   • FC moyenne d'un effort d'~1 h (Coggan) — la meilleure ancre quand elle existe
#   • FC moyenne du meilleur 20 min × 0,98 (Friel : le LTHR est la FC moyenne des
#     20 dernières minutes d'un contre-la-montre de 30 min, soit un poil sous la
#     moyenne d'un 20 min maximal)
# On garde la plus haute des deux : chacune est un *plancher* de ce que l'athlète
# a tenu, jamais un plafond.
#
# **Deux échelles, un seul cœur de calcul** :
#   • UNE sortie (`estimate_from_streams`) — ce que cette sortie prouve, affiché sur
#     sa page. ⚠ La valeur n'a de sens que si l'effort a été soutenu : une sortie
#     tranquille donne mécaniquement un seuil bas, et c'est au front de le dire.
#   • L'ATHLÈTE (`summary`) — le seuil de référence, agrégé sur une fenêtre glissante
#     de `WINDOW_DAYS` à partir des courbes `peak_heartrates` persistées. Prendre la
#     meilleure FC de chaque durée *toutes sorties confondues* neutralise justement
#     le biais ci-dessus : il suffit d'un effort soutenu dans la fenêtre.
# Le second n'existe que depuis que la courbe cardio est stockée par activité ; avant,
# le seuil athlète se contentait d'un proxy grossier (cf. `TrainingLoad.auto_lthr`).
module LthrEstimator
  module_function

  LTHR_20MIN_FACTOR = 0.98 # LTHR ≈ 98 % de la FC moyenne d'un 20 min maximal
  LTHR_60MIN_FACTOR = 1.0  # un effort d'~1 h se court déjà au seuil
  # Durées des ancres (s). Le 20 min est la plus courte fenêtre où la FC a fini de
  # dériver vers son palier ; en deçà on lirait surtout l'inertie cardiaque.
  DURATIONS = [1200, 3600].freeze
  # Plancher de vraisemblance : sous 100 bpm sur 20 min, c'est une sortie de
  # récupération (ou un cardio qui décroche), pas un effort au seuil.
  MIN_PLAUSIBLE_BPM = 100

  # `streams` = les flux bruts de la sortie ({ "time" =>, "heartrate" => }, chacun
  # tableau nu ou enveloppé dans `{ "data" => [...] }`). Renvoie nil sans FC
  # exploitable, sinon :
  #   { bpm:, method: 'lthr_20min'|'lthr_60min', best_20min:, best_60min:,
  #     max_hr:, durations: [durées ayant porté l'estimation] }
  def estimate_from_streams(streams)
    curve = PeakPowerCurve.mean_max(streams, 'heartrate', DURATIONS)
    estimate_from_curve(curve, max_hr: max_heartrate(streams))
  end

  # Même calcul à partir d'une courbe mean-max FC déjà calculée
  # ({ "1200" => bpm, … }) — le cœur testable, sans streams.
  def estimate_from_curve(curve, max_hr: nil)
    return nil unless curve.is_a?(Hash)

    best20 = numeric(curve['1200'] || curve[1200])
    best60 = numeric(curve['3600'] || curve[3600])

    candidates = {
      'lthr_60min' => best60 && best60 * LTHR_60MIN_FACTOR,
      'lthr_20min' => best20 && best20 * LTHR_20MIN_FACTOR
    }.compact.select { |_, v| v >= MIN_PLAUSIBLE_BPM }
    return nil if candidates.empty?

    method, bpm = candidates.max_by { |_, v| v }
    {
      bpm: bpm.round,
      method: method,
      best_20min: best20&.round,
      best_60min: best60&.round,
      max_hr: max_hr&.round,
      durations: [method == 'lthr_60min' ? 3600 : 1200]
    }
  end

  # ── Seuil de l'athlète ──────────────────────────────────────────────────────

  WINDOW_DAYS = 42 # fenêtre glissante « forme récente » (6 semaines), comme la FTP

  # Payload du seuil cardiaque de référence, même forme que `FtpEstimator.summary` :
  #
  #   { current: { bpm:, source: 'manual'|'auto'|nil, method:, stale: },
  #     auto: { bpm:, method:, best_20min:, …, contributors:, samples: } | nil,
  #     manual: { bpm:, at: } }
  #
  # Pas de cache ici, contrairement à `FtpEstimator.summary` : les deux appelants
  # sont soit déjà mis en cache (`TrainingLoad.summary`), soit rares et hors page
  # (le profil envoyé à l'appli au départ d'une navigation). Une requête indexée par
  # utilisateur, sur quelques colonnes étroites, ne mérite pas une clé de plus à
  # invalider — mesuré à 50 ms pour 750 sorties, avec le reste du calcul de charge.
  def summary(user)
    acts = hr_activities(user)
    manual = manual_lthr(user)

    recent = estimate_between(acts, WINDOW_DAYS.days.ago, nil)
    # Faute d'effort récent avec cardio, on remonte à tout l'historique : un seuil
    # d'il y a trois mois reste infiniment plus juste que pas de seuil du tout. Le
    # front le signale via `stale`.
    auto = recent || estimate_between(acts, nil, nil)

    {
      current: {
        bpm: manual&.positive? ? manual : auto&.dig(:bpm),
        source: (manual&.positive? ? 'manual' : (auto ? 'auto' : nil)),
        method: manual&.positive? ? nil : auto&.dig(:method),
        stale: manual.nil? && recent.nil? && auto.present?
      },
      auto: auto,
      manual: { bpm: manual, at: FtpEstimator.athlete(user)['lthr_manual_at'] }
    }
  end

  # Estimation sur les sorties dont la date tombe dans [from, to] (bornes nil = ouvertes).
  def estimate_between(acts, from, to)
    subset = acts.select do |a|
      (from.nil? || a[:started_at] >= from) && (to.nil? || a[:started_at] <= to)
    end
    estimate_from(subset)
  end

  # Le seuil que porte un sous-ensemble de sorties : on reconstitue une courbe
  # mean-max unique en gardant, pour chaque durée, la meilleure FC toutes sorties
  # confondues, puis on lui applique le même cœur de calcul que pour une sortie
  # seule. Les deux ancres peuvent donc venir de deux sorties différentes — c'est
  # voulu : le 20 min d'un col et l'heure d'un contre-la-montre sont deux preuves
  # indépendantes du même seuil.
  def estimate_from(subset)
    return nil if subset.empty?

    entries = mean_max_entries(subset)
    est = estimate_from_curve(
      entries.transform_values { |e| e[:bpm] },
      max_hr: subset.filter_map { |a| a[:max_hr] }.max
    )
    return nil unless est

    est.merge(contributors: contributors(est[:durations], entries), samples: subset.size)
  end

  # Pour chaque durée d'ancre, la meilleure FC moyenne du sous-ensemble ET la sortie
  # qui la détient. Clés = durées en chaînes (ce qu'attend `estimate_from_curve`).
  def mean_max_entries(subset)
    DURATIONS.each_with_object({}) do |d, out|
      best = subset.filter_map do |a|
        value = numeric(a[:curve][d.to_s])
        [value, a] if value&.positive?
      end.max_by { |value, _| value }
      out[d.to_s] = { bpm: best[0], activity: best[1] } if best
    end
  end

  # Les sorties qui ont réellement porté l'estimation, pour que le front puisse y
  # renvoyer. Un seuil dont on ne peut pas remonter à l'effort qui le prouve se
  # discute sans fin ; avec le lien, il se vérifie.
  def contributors(durations, entries)
    Array(durations).filter_map do |d|
      entry = entries[d.to_s]
      next unless entry

      act = entry[:activity]
      { duration: d, bpm: entry[:bpm].round, name: act[:name], source: act[:source],
        external_id: act[:external_id], started_at: act[:started_at]&.iso8601 }
    end
  end

  # Les sorties **vélo** portant une courbe cardio, réduites au strict nécessaire.
  #
  # Vélo seulement, alors que le LTHR sert aussi au TSS des autres sports : le seuil
  # cardiaque est spécifique au sport (en course à pied il est typiquement 5 à 10 bpm
  # plus haut, masse musculaire et impact au sol obligent), et les zones qu'on lit au
  # guidon sont celles du vélo. Un athlète sans cardio à vélo n'y perd rien : le repli
  # grossier de `TrainingLoad`, lui, reste tous sports.
  #
  # Les durées sont extraites en SQL plutôt que le JSON entier : deux flottants par
  # ligne au lieu d'un document à désérialiser.
  def hr_activities(user)
    columns = ['name', 'started_at', 'activity_type'] +
              ['max_heartrate::float AS max_hr'] +
              DURATIONS.map { |d| "(peak_heartrates->>#{UserActivities.quote(d.to_s)})::float AS hr_#{d}" }
    union = UserActivities.union_sql(user_id: user.id, columns: columns)
    rows = UserActivities.select_all(
      "SELECT * FROM (#{union}) rows WHERE started_at IS NOT NULL", 'LthrEstimator#hr_activities'
    )

    rows.filter_map do |row|
      next unless PerformanceRecords.sport_category(row['activity_type']) == 'cycling'

      curve = DURATIONS.each_with_object({}) do |d, out|
        value = numeric(row["hr_#{d}"])
        out[d.to_s] = value if value&.positive?
      end
      next if curve.empty?

      started_at = parse_time(row['started_at'])
      next unless started_at

      { started_at: started_at, curve: curve, max_hr: numeric(row['max_hr']),
        name: row['name'], source: row['source'], external_id: row['external_id'] }
    end
  end

  # Seuil saisi à la main dans les préférences athlète — il prime sur toute
  # estimation : c'est le seul qui vient d'un test, pas d'une inférence.
  def manual_lthr(user)
    numeric(FtpEstimator.athlete(user)['lthr_manual'])&.round
  end

  # `select_all` rend des chaînes pour les timestamps selon l'adaptateur ; on
  # normalise ici plutôt que de faire confiance à la forme reçue.
  def parse_time(value)
    return value if value.is_a?(Time) || value.is_a?(DateTime)

    Time.zone.parse(value.to_s)
  rescue ArgumentError
    nil
  end

  # FC max instantanée observée sur la sortie — contexte affiché à côté du seuil
  # (un seuil proche de la FC max signale un effort très soutenu).
  def max_heartrate(streams)
    values = PeakPowerCurve.stream_values(streams, 'heartrate') if streams.is_a?(Hash)
    return nil unless values.is_a?(Array)

    values.filter_map { |v| v.to_f if v.is_a?(Numeric) && v.finite? && v.positive? }.max
  end

  def numeric(value)
    return value.to_f if value.is_a?(Numeric)
    return value.to_f if value.is_a?(String) && value.match?(/\A-?\d+(\.\d+)?\z/)

    nil
  end
end
