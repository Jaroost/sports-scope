# Shared peak-power curve utilities. The algorithm is purely numeric so it
# lives outside any AR model; both `ImportedActivity` and `StravaActivity`
# store the full `streams` JSON in DB and call into here (via `Activityable`)
# to compute and persist their `peak_powers` curve.
module PeakPowerCurve
  # Standard cycling peak-power durations (seconds). Mirrors the frontend list
  # in `ActivityDetail.vue` so the values shown match the values persisted.
  DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400].freeze

  module_function

  # Returns `{ "5" => avg_watts, … }`. Skipped durations (longer than the
  # activity, or no power data) simply don't appear in the result.
  def compute_from(streams)
    mean_max(streams, 'watts')
  end

  # Δt maximal retenu entre deux échantillons : au-delà on est sur une pause /
  # coupure d'enregistrement (auto-pause, arrêt), pas sur une cadence
  # d'échantillonnage. Même garde-fou que `ZoneDistribution::MAX_GAP`, et pour la
  # même raison : sans lui, un arrêt de 9 min au milieu d'une fenêtre de 20 min
  # compte comme 0 W et dilue la moyenne — un « meilleur 20 min » qui n'a jamais
  # eu lieu. En le bornant, la fenêtre glissante se mesure en temps ROULÉ.
  MAX_GAP = 10

  # Courbe mean-max générique : pour chaque durée, la meilleure moyenne du flux
  # `key` tenue sur une fenêtre de cette longueur. `watts` en donne la courbe de
  # puissance ; `heartrate` la même chose pour la FC (cf. `LthrEstimator`).
  # Renvoie `{ "1200" => valeur, … }` — une durée absente = plus longue que la
  # sortie, ou aucune donnée exploitable.
  #
  # On intègre la grandeur dans le temps (E[i] = Σ v·Δt) puis on balaie en deux
  # pointeurs : une cadence d'échantillonnage irrégulière ou une pause ne fausse
  # donc pas la moyenne, contrairement à une moyenne d'échantillons. Chaque Δt est
  # borné à `MAX_GAP` : les pauses sont effacées de l'axe du temps (fenêtre ET
  # intégrale), la courbe est donc « en temps roulé ».
  def mean_max(streams, key, durations = DURATIONS)
    return {} unless streams.is_a?(Hash)

    times = stream_values(streams, 'time')
    values = stream_values(streams, key)
    return {} unless times.is_a?(Array) && values.is_a?(Array)

    n = [times.length, values.length].min
    return {} if n < 2

    # Temps roulé cumulé (`elapsed`) et intégrale d'énergie, sur le même Δt borné :
    # E[i] = Σ values[k]·min(Δt, MAX_GAP). Les deux doivent ignorer les mêmes secondes.
    elapsed = Array.new(n, 0.0)
    energy = Array.new(n, 0.0)
    (1...n).each do |i|
      dt = (times[i].to_f - times[i - 1].to_f).clamp(0.0, MAX_GAP.to_f)
      v  = values[i - 1]
      vv = v.is_a?(Numeric) && v.finite? ? v.to_f : 0.0
      elapsed[i] = elapsed[i - 1] + dt
      energy[i]  = energy[i - 1] + vv * dt
    end

    total_span = elapsed[n - 1]
    out = {}
    durations.each do |d|
      break if d > total_span

      best = nil
      j = 0
      (0...n).each do |i|
        j += 1 while j < n && (elapsed[j] - elapsed[i]) < d
        break if j >= n

        dt = elapsed[j] - elapsed[i]
        next if dt <= 0

        avg = (energy[j] - energy[i]) / dt
        best = avg if best.nil? || avg > best
      end
      out[d.to_s] = best.round(2) if best && best.finite? && best > 0
    end
    out
  end

  # For a user, return the best across BOTH sources (`imported_activities`
  # and `strava_activities`), keyed by duration string.
  # Each value: `{ avg_watts:, source:, external_id:, started_at: }`.
  # `exclude:` is a tuple `[source, external_id]` to leave out (so when
  # comparing a current activity it doesn't trivially tie with itself).
  def bests_for_user(user, exclude: nil)
    exclude_source, exclude_external_id = exclude
    out = {}
    DURATIONS.each do |d|
      key = d.to_s
      candidate = best_row(
        user_id: user.id,
        duration_key: key,
        exclude_source: exclude_source,
        exclude_external_id: exclude_external_id&.to_s
      )
      out[key] = candidate if candidate
    end
    out
  end

  # Nombre de places de podium (or / argent / bronze).
  PODIUM_PLACES = 3

  # Rang (1 = or, 2 = argent, 3 = bronze) de la sortie courante pour chaque durée,
  # parmi TOUTES les activités de l'utilisateur — pour décorer le tableau des
  # meilleures puissances moyennes des mêmes médailles que les « meilleurs efforts ».
  # `current` = les `peak_powers` de la sortie ({ "300" => watts, … }). Une durée
  # n'apparaît que si la sortie y est sur le podium. Ex æquo partagés (deux sorties
  # à la même puissance max sont toutes deux « or »), même sémantique que
  # `PerformanceRecords.rank_in`. `exclude` = [source, external_id] de la sortie
  # courante, retirée du décompte pour ne pas se comparer à elle-même.
  def podium_for(user, current, exclude:)
    return {} unless current.is_a?(Hash)

    exclude_source, exclude_external_id = exclude
    out = {}
    DURATIONS.each do |d|
      key = d.to_s
      value = current[key] || current[key.to_sym]
      value = value.to_f if value.is_a?(Numeric) || (value.is_a?(String) && value.present?)
      next unless value.is_a?(Float) && value.positive?

      rank = better_count(
        user_id: user.id, duration_key: key, value: value,
        exclude_source: exclude_source, exclude_external_id: exclude_external_id&.to_s
      ) + 1
      out[key] = rank if rank <= PODIUM_PLACES
    end
    out
  end

  # Combien d'AUTRES activités battent strictement `value` sur cette durée (sert au
  # rang du podium). Exclut la sortie courante par (source, external_id).
  def better_count(user_id:, duration_key:, value:, exclude_source:, exclude_external_id:)
    key = UserActivities.quote(duration_key)
    union = UserActivities.union_sql(
      user_id: user_id,
      columns: ["(peak_powers->>#{key})::float AS avg_watts"]
    )
    sql = <<~SQL.squish
      SELECT COUNT(*) AS n
        FROM (#{union}) rows
       WHERE avg_watts IS NOT NULL
         AND avg_watts > #{value.to_f}
         AND NOT (source = #{UserActivities.quote(exclude_source.to_s)}
                  AND external_id = #{UserActivities.quote(exclude_external_id.to_s)})
    SQL
    UserActivities.select_all(sql, 'PeakPowerCurve#better_count').first['n'].to_i
  end

  # Pull the single best row across both source tables for a given duration.
  # Returns nil when no row has that duration. The `UNION ALL` over the two
  # heterogeneous tables is built by `UserActivities`.
  def best_row(user_id:, duration_key:, exclude_source:, exclude_external_id:)
    key = UserActivities.quote(duration_key)
    union = UserActivities.union_sql(
      user_id: user_id,
      columns: ['started_at', "(peak_powers->>#{key})::float AS avg_watts"]
    )
    sql = <<~SQL.squish
      SELECT source, external_id, started_at, avg_watts
        FROM (#{union}) rows
       WHERE avg_watts IS NOT NULL
         AND NOT (source = #{UserActivities.quote(exclude_source.to_s)}
                  AND external_id = #{UserActivities.quote(exclude_external_id.to_s)})
       ORDER BY avg_watts DESC
       LIMIT 1
    SQL
    row = UserActivities.select_all(sql, 'PeakPowerCurve#best_row').first
    return nil unless row

    {
      avg_watts: row['avg_watts'],
      source: row['source'],
      external_id: row['external_id'],
      started_at: row['started_at']&.iso8601
    }
  end

  # `streams[key]` can be either a plain array or `{ "data" => [...] }`
  # (the FIT importer wraps each stream in a `data` envelope; the Strava
  # streams API returns the same shape).
  def stream_values(streams, key)
    raw = streams[key] || streams[key.to_sym]
    return raw if raw.is_a?(Array)
    return raw['data'] || raw[:data] if raw.is_a?(Hash)

    nil
  end
end
