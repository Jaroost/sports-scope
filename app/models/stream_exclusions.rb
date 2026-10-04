# Données de capteur que l'utilisateur écarte d'une activité (capteur défaillant,
# collage, pic aberrant). Les streams bruts restent intacts en base : l'exclusion est
# un masque, posé à la lecture et avant chaque dérivation (NP, courbes, histogrammes),
# si bien qu'on peut la lever sans re-télécharger quoi que ce soit.
#
# Forme stockée (`stream_exclusions`) :
#   { "channels" => ["watts"],                               # canal écarté en entier
#     "ranges"   => [{ "from" => 120.0, "to" => 340.0,       # plage en secondes (stream `time`)
#                      "channels" => ["heartrate"] }] }      # absent = tous les canaux capteur
#
# Un canal écarté en entier disparaît des streams servis (le front ne le dessine pas,
# comme un capteur absent) ; une plage met ses échantillons à nil sans toucher à la
# longueur des tableaux — les index de sélection du front restent valides.
module StreamExclusions
  module_function

  # Canaux de capteur masquables. Le GPS / l'altitude / la distance / le temps ne le
  # sont pas : ils structurent l'activité (axes, carte, segments).
  CHANNELS = %w[heartrate watts cadence temp velocity_smooth].freeze
  MAX_RANGES = 50

  # Colonnes de résumé (Strava / FIT) que dément un canal écarté.
  SUMMARY_FIELDS = {
    'heartrate' => %i[average_heartrate max_heartrate],
    'watts' => %i[average_watts max_watts normalized_power],
    'cadence' => %i[average_cadence max_cadence],
    'temp' => %i[average_temp],
    'velocity_smooth' => %i[average_speed max_speed]
  }.freeze

  # Assainit un document venu du client : seule liste blanche, rien n'est recopié tel quel.
  def sanitize(input)
    input = input.respond_to?(:to_unsafe_h) ? input.to_unsafe_h : input
    return {} unless input.is_a?(Hash)

    input = input.with_indifferent_access
    channels = clean_channels(input[:channels])
    ranges = Array(input[:ranges]).filter_map { |r| clean_range(r) }.first(MAX_RANGES)
    out = {}
    out['channels'] = channels if channels.any?
    out['ranges'] = ranges if ranges.any?
    out
  end

  def channels(exclusions)
    return [] unless exclusions.is_a?(Hash)

    clean_channels(exclusions['channels'] || exclusions[:channels])
  end

  def any?(exclusions)
    exclusions.is_a?(Hash) && (exclusions['channels'].present? || exclusions['ranges'].present?)
  end

  # Copie des streams avec les exclusions appliquées. Renvoie `streams` tel quel
  # quand il n'y a rien à masquer (cas courant : aucune copie de 30 000 points).
  def apply(streams, exclusions)
    return streams unless streams.is_a?(Hash) && any?(exclusions)

    dropped = channels(exclusions)
    out = streams.reject { |key, _| dropped.include?(key.to_s) }
    ranges = Array(exclusions['ranges'])
    return out if ranges.empty?

    times = PeakPowerCurve.stream_values(out, 'time')
    return out unless times.is_a?(Array)

    ranges.each do |range|
      from = range['from'].to_f
      to = range['to'].to_f
      clean_channels(range['channels'].presence || CHANNELS).each do |channel|
        next unless out.key?(channel)

        out[channel] = mask(out[channel], times, from, to)
      end
    end
    out
  end

  # Le complément de `apply` : uniquement ce qui a été masqué, pour que le front puisse
  # le dessiner en fantôme. Un canal écarté en entier ressort complet ; pour une plage,
  # seuls ses échantillons subsistent (nil ailleurs, même longueur que le flux).
  def ignored(streams, exclusions)
    return {} unless streams.is_a?(Hash) && any?(exclusions)

    out = {}
    channels(exclusions).each do |channel|
      stream = streams[channel]
      out[channel] = stream if stream
    end

    times = PeakPowerCurve.stream_values(streams, 'time')
    return out unless times.is_a?(Array)

    Array(exclusions['ranges']).each do |range|
      from = range['from'].to_f
      to = range['to'].to_f
      clean_channels(range['channels'].presence || CHANNELS).each do |channel|
        next if out[channel] && channels(exclusions).include?(channel)

        stream = streams[channel]
        next unless stream

        kept = keep_only(stream, times, from, to)
        out[channel] = out[channel] ? union(out[channel], kept) : kept
      end
    end
    out
  end

  # Inverse de `mask` : ne garde que les échantillons dont le temps est dans [from, to].
  def keep_only(stream, times, from, to)
    data = stream.is_a?(Hash) ? stream['data'] : stream
    return stream unless data.is_a?(Array)

    kept = data.each_with_index.map do |v, i|
      t = times[i]
      t.is_a?(Numeric) && t >= from && t <= to ? v : nil
    end
    stream.is_a?(Hash) ? stream.merge('data' => kept) : kept
  end

  # Fusion de deux flux filtrés de même longueur : première valeur non nulle.
  def union(a, b)
    da = a.is_a?(Hash) ? a['data'] : a
    db = b.is_a?(Hash) ? b['data'] : b
    merged = da.each_with_index.map { |v, i| v.nil? ? db[i] : v }
    a.is_a?(Hash) ? a.merge('data' => merged) : merged
  end

  # Met à nil les échantillons dont le temps tombe dans [from, to], en gardant
  # l'enveloppe (`{ "data" => [...] }` ou tableau brut) du stream.
  def mask(stream, times, from, to)
    data = stream.is_a?(Hash) ? stream['data'] : stream
    return stream unless data.is_a?(Array)

    masked = data.each_with_index.map do |v, i|
      t = times[i]
      t.is_a?(Numeric) && t >= from && t <= to ? nil : v
    end
    stream.is_a?(Hash) ? stream.merge('data' => masked) : masked
  end

  def clean_channels(list)
    Array(list).map(&:to_s).select { |c| CHANNELS.include?(c) }.uniq
  end

  def clean_range(range)
    return nil unless range.respond_to?(:[]) && !range.is_a?(String)

    range = range.with_indifferent_access if range.is_a?(Hash)
    return nil unless range.is_a?(Hash)

    from = Float(range[:from], exception: false)
    to = Float(range[:to], exception: false)
    return nil unless from&.finite? && to&.finite?

    from, to = to, from if from > to
    out = { 'from' => from.round(1), 'to' => to.round(1) }
    channels = clean_channels(range[:channels])
    out['channels'] = channels if channels.any? && channels.size < CHANNELS.size
    out
  end
end
