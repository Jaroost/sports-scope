# Comparaison de DEUX sorties qui suivent à peu près le même chemin.
#
# - `.similar` : propose, pour une sortie, celles de l'historique qui lui ressemblent
#   (même sport, tracé qui se recouvre) — le point d'entrée de la page de détail.
# - `.call`    : aligne deux sorties sur leur portion commune (`SegmentMatcher#alignments_with`)
#   et rend de quoi les superposer : séries rééchantillonnées sur la distance de A, écart de
#   temps cumulé, chiffres de la portion et tracés.
#
# A est la référence : l'axe des abscisses est SA distance, et l'écart de temps vaut
# « temps de B − temps de A » au même point du chemin (positif = B est en retard).
class ActivityComparison
  SOURCES = %w[strava imported].freeze
  # Part minimale de l'empreinte de A (en cellules) que B doit recouvrir pour être proposée.
  MIN_SIMILARITY = 0.35
  MAX_SIMILAR = 8
  MAX_CANDIDATES = 200
  # Pas du rééchantillonnage, bornes comprises : ~400 points suffisent à tracer une courbe.
  MAX_SAMPLES = 400
  MIN_COMMON_M = 500
  CHANNELS = {
    'altitude' => 'altitude', 'speed' => 'velocity_smooth', 'heartrate' => 'heartrate',
    'power' => 'watts', 'cadence' => 'cadence'
  }.freeze
  ELEVATION_NOISE_M = 1.0

  class NotFound < StandardError; end

  Ref = Struct.new(:source, :id)

  # `"strava:123"` / `"imported:45"` → Ref, ou nil.
  def self.parse_ref(value)
    source, id = value.to_s.split(':', 2)
    return nil unless SOURCES.include?(source) && id.to_s.match?(/\A\d+\z/)

    Ref.new(source, id)
  end

  def self.find_activity(user, ref)
    record = if ref.source == 'strava'
               user.strava_activities.find_by(strava_id: ref.id)
             else
               user.imported_activities.find_by(id: ref.id)
             end
    raise NotFound unless record

    record
  end

  # Sorties ressemblant à `activity`, de la plus proche à la moins proche. La
  # ressemblance est la part des cellules de A que B traverse aussi, sans tenir compte
  # du sens : on propose aussi un aller-retour refait à l'envers, la comparaison, elle,
  # dira s'il y a une portion commune dans le même sens.
  def self.similar(user, activity)
    fp = activity.track_cells.presence
    return [] unless fp && Array(fp['coarse']).any?

    cells = Array(fp['cells']).to_set
    return [] if cells.empty?

    category = PerformanceRecords.sport_category(activity.activity_type)
    own = own_ref(activity)
    quoted = Array(fp['coarse']).map { |k| UserActivities.quote(k) }.join(',')

    rows = UserActivities::SOURCES.flat_map do |source, cfg|
      klass = source == 'strava' ? StravaActivity : ImportedActivity
      klass.where(user_id: user.id)
           .where(Arel.sql("(track_cells -> 'coarse') ?| ARRAY[#{quoted}]"))
           .order(started_at: :desc).limit(MAX_CANDIDATES)
           .pluck(cfg[:id_column], :name, :started_at, :activity_type, :distance_m, :track_cells)
           .map { |id, name, at, type, dist, tc| { source: source, id: id.to_s, name: name, started_at: at,
                                                    type: type, distance_m: dist, cells: tc } }
    end

    rows.reject { |r| [r[:source], r[:id]] == [own.source, own.id] }
        .select { |r| PerformanceRecords.sport_category(r[:type]) == category }
        .filter_map { |r|
          shared = Array(r[:cells]['cells']).to_set.count { |c| cells.include?(c) }
          ratio = shared.to_f / cells.size
          next if ratio < MIN_SIMILARITY

          { source: r[:source], id: r[:id], name: r[:name], started_at: r[:started_at]&.iso8601,
            distance_m: r[:distance_m]&.round, similarity: ratio.round(2) }
        }
        .sort_by { |r| [-r[:similarity], r[:started_at].to_s] }
        .first(MAX_SIMILAR)
  end

  def self.own_ref(activity)
    activity.is_a?(StravaActivity) ? Ref.new('strava', activity.strava_id.to_s) : Ref.new('imported', activity.id.to_s)
  end

  def self.call(user, a, b, stretch: 0)
    new(user, a, b, stretch: stretch).call
  end

  def initialize(user, a, b, stretch: 0)
    @stretch = stretch.to_i
    @user = user
    @a = a
    @b = b
  end

  def call
    aligns = SegmentMatcher.new(@user, @a).alignments_with(@b)
    return base.merge(common: nil, stretches: []) if aligns.empty?

    a_d0 = Array(@a.track_cells['d'])
    b_d0 = Array(@b.track_cells['d'])
    stretches = aligns.each_with_index.map do |al, i|
      { index: i, distance_m: (a_d0[al[:a_end]].to_f - a_d0[al[:a_start]].to_f).round,
        a_from_m: a_d0[al[:a_start]].to_f.round, b_from_m: b_d0[al[:b_start]].to_f.round }
    end
    index = @stretch.clamp(0, aligns.length - 1)
    align = aligns[index]

    a_i = Array(@a.track_cells['i'])
    b_i = Array(@b.track_cells['i'])
    a_d = Array(@a.track_cells['d'])
    b_d = Array(@b.track_cells['d'])
    a_range = [a_i[align[:a_start]].to_i, a_i[align[:a_end]].to_i]
    b_range = [b_i[align[:b_start]].to_i, b_i[align[:b_end]].to_i]
    length_a = a_d[align[:a_end]].to_f - a_d[align[:a_start]].to_f
    length_b = b_d[align[:b_end]].to_f - b_d[align[:b_start]].to_f
    return base.merge(common: nil, stretches: []) if length_a < MIN_COMMON_M || length_b < MIN_COMMON_M

    sa = series(@a, a_range)
    sb = series(@b, b_range)
    return base.merge(common: nil, stretches: []) if sa.nil? || sb.nil?

    samples = [[(length_a / 25).ceil, 2].max, MAX_SAMPLES].min
    xs = Array.new(samples) { |k| length_a * k / (samples - 1) }
    # Position de B correspondant à chaque point de A : proportionnelle le long du
    # chemin commun (les cellules ont une taille fixe, l'index suit la distance).
    b_xs = xs.map { |x| x / length_a * length_b }

    ra = resample(sa, xs)
    rb = resample(sb, b_xs)
    delta = xs.each_index.map { |k| (rb[:time][k] && ra[:time][k]) ? (rb[:time][k] - ra[:time][k]).round(1) : nil }

    {
      **base,
      stretches: stretches,
      stretch: index,
      common: {
        distance_m: length_a.round,
        distance_b_m: length_b.round,
        x: xs.map { |x| x.round },
        delta_s: delta,
        a: ra.merge(stats(sa)).transform_keys { |k| k == :time ? :time_s : k },
        b: rb.merge(stats(sb)).transform_keys { |k| k == :time ? :time_s : k },
        a_track: track(@a, a_range), b_track: track(@b, b_range)
      }
    }
  end

  private

  def base
    { a: describe(@a), b: describe(@b), a_full_track: track(@a, [nil, nil], 600), b_full_track: track(@b, [nil, nil], 600) }
  end

  def describe(act)
    ref = self.class.own_ref(act)
    { source: ref.source, id: ref.id, name: act.name, type: act.activity_type,
      started_at: act.started_at&.iso8601, distance_m: act.distance_m&.round,
      moving_time_s: act.moving_time_s, elapsed_time_s: act.elapsed_time_s,
      elevation_gain_m: act.total_elevation_gain&.round, average_speed: act.average_speed,
      average_heartrate: act.average_heartrate, average_watts: act.average_watts,
      average_cadence: act.average_cadence, normalized_power: act.normalized_power,
      max_heartrate: act.max_heartrate, max_watts: act.max_watts, max_cadence: act.max_cadence,
      ftp: ftp_of(act), weight_kg: FtpEstimator.weight_kg(@user, on: act.started_at), start_latlng: act.start_latlng, device: device_of(act), gear: gear_of(act) }
  end

  # FTP que cette sortie, à elle seule, prouve (cyclisme uniquement) : nil sans courbe de puissance.
  def ftp_of(act)
    return nil unless ActivityThresholds.cycling?(act.activity_type)

    FtpEstimator.estimate_activity(act.peak_powers)&.dig(:watts)&.round
  end

  # Matériel d'enregistrement (montre, compteur…), connu des seules activités Strava.
  def device_of(act)
    act.respond_to?(:device_name) ? act.device_name.presence : nil
  end

  # Vélo (table `bikes`) ou chaussures (cache `strava_gears`) de la sortie.
  def gear_of(act)
    gid = act.respond_to?(:gear_id) ? act.gear_id.presence : nil
    return nil unless gid

    @user.bikes.find_by(strava_gear_id: gid)&.name || @user.strava_gears.find_by(gear_id: gid)&.name
  end

  # Séries brutes (distance, temps, canaux) restreintes à la plage de stream.
  def series(act, (from, to))
    streams = act.effective_streams
    dist = TrackFingerprint.stream_values(streams, 'distance')
    time = TrackFingerprint.stream_values(streams, 'time')
    return nil unless dist.is_a?(Array) && time.is_a?(Array) && to > from

    d0 = dist[from].to_f
    t0 = time[from].to_f
    idx = (from..[to, dist.length - 1, time.length - 1].min).to_a
    out = { d: idx.map { |i| dist[i].to_f - d0 }, time: idx.map { |i| time[i].to_f - t0 } }
    CHANNELS.each do |key, stream|
      vals = TrackFingerprint.stream_values(streams, stream)
      out[key.to_sym] = vals.is_a?(Array) ? idx.map { |i| vals[i].is_a?(Numeric) ? vals[i] : nil } : nil
    end
    out
  end

  # Interpolation linéaire des séries aux distances `xs` (monotones croissantes).
  def resample(s, xs)
    result = { time: [] }
    CHANNELS.each_key { |k| result[k.to_sym] = [] }
    j = 0
    d = s[:d]
    xs.each do |x|
      j += 1 while j < d.length - 2 && d[j + 1] < x
      d0 = d[j]
      d1 = d[j + 1] || d0
      f = d1 > d0 ? ((x - d0) / (d1 - d0)).clamp(0.0, 1.0) : 0.0
      result[:time] << lerp(s[:time][j], s[:time][j + 1], f)&.round(1)
      CHANNELS.each_key do |k|
        col = s[k.to_sym]
        result[k.to_sym] << (col ? lerp(col[j], col[j + 1], f)&.round(2) : nil)
      end
    end
    result.transform_values { |v| v.all?(&:nil?) ? nil : v }.tap { |h| h[:time] ||= [] }
  end

  def lerp(a, b, f)
    return a if b.nil?
    return nil if a.nil?

    a + (b - a) * f
  end

  # Chiffres de la portion commune, tirés des séries d'origine (pas des rééchantillonnées).
  def stats(s)
    duration = s[:time].last.to_f
    distance = s[:d].last.to_f
    {
      stats: {
        duration_s: duration.round,
        average_speed: duration.positive? ? (distance / duration).round(3) : nil,
        elevation_gain_m: elevation_gain(s[:altitude]),
        average_heartrate: mean(s[:heartrate]),
        average_watts: mean(s[:power]),
        average_cadence: mean(s[:cadence]),
        max_heartrate: peak(s[:heartrate]),
        max_watts: peak(s[:power]),
        max_cadence: peak(s[:cadence])
      }
    }
  end

  def peak(values)
    nums = Array(values).grep(Numeric)
    nums.empty? ? nil : nums.max.round
  end

  def mean(values)
    nums = Array(values).grep(Numeric)
    nums.empty? ? nil : (nums.sum / nums.size).round(1)
  end

  def elevation_gain(alts)
    return nil unless alts

    gain = 0.0
    ref = nil
    alts.each do |v|
      next unless v.is_a?(Numeric)
      next ref = v if ref.nil?

      delta = v - ref
      if delta >= ELEVATION_NOISE_M
        gain += delta
        ref = v
      elsif delta <= -ELEVATION_NOISE_M
        ref = v
      end
    end
    gain.round
  end

  # Tracé de la portion commune (ou entier si `from` est nil), `[[lng, lat], …]` allégé (~300 points max).
  def track(act, (from, to), max_points = 300)
    pts = TrackFingerprint.stream_values(act.effective_streams, 'latlng')
    return [] unless pts.is_a?(Array)

    slice = (from ? pts[from..to] : pts) || []
    step = [(slice.length / max_points.to_f).ceil, 1].max
    slice.each_slice(step).filter_map { |g| g.first }.filter_map do |p|
      p.is_a?(Array) && p.length >= 2 ? [p[1], p[0]] : nil
    end
  end
end
