# Unified read access across the two heterogeneous activity tables
# (`strava_activities` + `imported_activities`) *without* merging them into one
# table. Builds a `UNION ALL` selecting a caller-chosen set of columns plus a
# synthetic `source` ('strava' | 'imported') and a common `external_id`
# (`strava_id` or `id`), so cross-activity aggregations are written once here
# rather than duplicated as hand-rolled SQL at each call site.
#
# Per-row derivations (peak-power, training metrics) live in `Activityable`.
module UserActivities
  module_function

  # Physical id column per source, exposed uniformly as `external_id::text`.
  SOURCES = {
    'imported' => { table: 'imported_activities', id_column: 'id' },
    'strava'   => { table: 'strava_activities',   id_column: 'strava_id' }
  }.freeze

  # SQL fragment: `UNION ALL` of both tables for `user_id`, each row carrying
  # `source`, `external_id`, and the requested `columns`. `columns` entries are
  # raw SQL expressions valid in BOTH tables (e.g. "started_at",
  # "(peak_powers->>'1200')::float AS avg_watts"). Meant to be embedded as a
  # subquery: `SELECT ... FROM (#{union_sql(...)}) rows`.
  #
  # `user_id` is quoted; no bind placeholders are emitted so the fragment
  # composes freely with an outer query.
  def union_sql(user_id:, columns:)
    quoted_uid = connection.quote(user_id)
    SOURCES.map do |source, cfg|
      selected = (
        ["#{connection.quote(source)} AS source",
         "#{cfg[:id_column]}::text AS external_id"] + Array(columns).map(&:to_s)
      ).join(', ')
      "SELECT #{selected} FROM #{cfg[:table]} WHERE user_id = #{quoted_uid}"
    end.join(' UNION ALL ')
  end

  # Run `sql` (already-safe: caller built it via #union_sql and #quote) and
  # return the rows as an array of hashes.
  def select_all(sql, name = 'UserActivities')
    connection.exec_query(sql, name).to_a
  end

  # Empreinte des activités d'un utilisateur, servant de version de cache pour les
  # analyses calculées à la lecture (charge d'entraînement, FTP, records). Change
  # dès qu'une activité est créée, modifiée (streams/NP → `updated_at` bumpé) ou
  # supprimée (le `count` baisse). Une seule requête agrégée par table.
  def data_version(user_id)
    [StravaActivity, ImportedActivity].map do |klass|
      rel = klass.where(user_id: user_id)
      agg = rel.pick(Arel.sql('COUNT(*), MAX(updated_at)'))
      "#{agg&.first || 0}:#{agg&.last&.to_f || 0}"
    end.join('|')
  end

  def quote(value)
    connection.quote(value)
  end

  def connection
    ActiveRecord::Base.connection
  end
end
