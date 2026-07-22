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
    return {} unless streams.is_a?(Hash)

    times = stream_values(streams, 'time')
    watts = stream_values(streams, 'watts')
    return {} unless times.is_a?(Array) && watts.is_a?(Array)

    n = [times.length, watts.length].min
    return {} if n < 2

    # Cumulative energy (J): E[i] = Σ watts[k] * (time[k+1] - time[k])
    energy = Array.new(n, 0.0)
    (1...n).each do |i|
      dt = times[i].to_f - times[i - 1].to_f
      w  = watts[i - 1]
      wv = w.is_a?(Numeric) && w.finite? ? w.to_f : 0.0
      energy[i] = energy[i - 1] + wv * [dt, 0].max
    end

    total_span = times[n - 1].to_f - times[0].to_f
    out = {}
    DURATIONS.each do |d|
      break if d > total_span

      best = nil
      j = 0
      (0...n).each do |i|
        j += 1 while j < n && (times[j].to_f - times[i].to_f) < d
        break if j >= n

        dt = times[j].to_f - times[i].to_f
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
