# Empreinte spatiale d'une activité : la suite des cellules d'une grille fixe que le
# tracé traverse, avec de quoi revenir aux streams (index) et chronométrer un
# passage (temps, distance) sans les relire.
#
# C'est la brique de l'analyse de segments (`SegmentMatcher`) : deux sorties qui
# empruntent le même chemin produisent la même sous-suite de cellules, quel que
# soit l'échantillonnage GPS. La comparaison se ramène alors à chercher des
# sous-suites communes — du texte, pas de la géométrie.
#
# Forme stockée (colonne `track_cells`, registre `Activityable::STREAM_DERIVATIONS`) :
#
#   { "cells"  => ["12345:6789", …]  cellules ~60 m, dans l'ordre, sans répétition consécutive
#     "i"      => [0, 14, 27, …]     index du point de stream à l'entrée de la cellule
#     "t"      => [0, 12, 25, …]     temps écoulé (s) à l'entrée
#     "d"      => [0, 58, 121, …]    distance parcourue (m) à l'entrée
#     "coarse" => ["12:6", …] }      cellules ~5 km uniques — préfiltre SQL des candidats
#
# `{}` pour une activité sans tracé (home-trainer, tapis, muscu) : elle n'entre
# jamais dans une comparaison.
module TrackFingerprint
  # Pas de la grille fine, en degrés. ~60 m en latitude, ~60 m en longitude à 47° N
  # (nos latitudes). La grille est FIXE — c'est ce qui rend les clés comparables
  # d'une activité à l'autre ; sa cellule est simplement un peu plus large en
  # longitude au sud et plus étroite au nord, sans conséquence sur l'appariement
  # (`SegmentMatcher` tolère de toute façon les cellules manquées).
  LAT_STEP = 0.00054
  LNG_STEP = 0.0008

  # Grille grossière (~6 km) servant uniquement au préfiltre des candidats. Multiple
  # EXACT (×100) de la grille fine : une cellule fine tombe alors toujours dans une
  # seule cellule grossière, et `coarsen` peut la déduire sans les coordonnées.
  COARSE_LAT_STEP = LAT_STEP * 100
  COARSE_LNG_STEP = LNG_STEP * 100

  # Garde-fou : au-delà, la trace n'est plus exploitable (GPS parti en vrille) et on
  # évite de faire enfler la colonne. 40 000 cellules ≈ 2 400 km de tracé.
  MAX_CELLS = 40_000

  module_function

  # Renvoie l'empreinte d'un hash de streams (forme key_by_type de l'API Strava /
  # de l'importeur FIT), ou `{}` si le tracé est inexploitable.
  def compute_from(streams)
    return {} unless streams.is_a?(Hash)

    latlng = stream_values(streams, 'latlng')
    return {} unless latlng.is_a?(Array) && latlng.length >= 2

    times = stream_values(streams, 'time')
    dists = stream_values(streams, 'distance')

    cells = []
    idx = []
    secs = []
    metres = []
    coarse = {}
    last_key = nil

    latlng.each_with_index do |point, i|
      lat, lng = point_coords(point)
      next if lat.nil?

      key = cell_key(lat, lng)
      next if key == last_key

      last_key = key
      cells << key
      idx << i
      secs << numeric_at(times, i).to_i
      metres << numeric_at(dists, i).to_f.round
      coarse[coarse_key(lat, lng)] = true
      break if cells.length >= MAX_CELLS
    end

    return {} if cells.length < 2

    { 'cells' => cells, 'i' => idx, 't' => secs, 'd' => metres, 'coarse' => coarse.keys }
  end

  # Découpe le chemin compris entre deux index de STREAM d'une activité :
  # `{ cells:, coarse:, distance_m: }`. C'est ce qu'on enregistre quand l'utilisateur
  # baptise un segment (`NamedSegment`) — le nom suit le terrain, pas l'activité
  # depuis laquelle il a été posé.
  def slice(fingerprint, start_idx, end_idx)
    idx = Array(fingerprint['i'])
    cells = Array(fingerprint['cells'])
    dists = Array(fingerprint['d'])
    from = idx.index { |i| i >= start_idx }
    to = idx.rindex { |i| i <= end_idx }
    return nil if from.nil? || to.nil? || to - from < 1

    { cells: cells[from..to], coarse: cells[from..to].map { |k| coarsen(k) }.uniq,
      distance_m: (dists[to].to_f - dists[from].to_f).abs.round }
  end

  # Cellule grossière contenant une cellule fine, sans repasser par les coordonnées :
  # les deux grilles sont alignées sur la même origine.
  def coarsen(key)
    lat_i, lng_i = key.split(':').map(&:to_i)
    "#{(lat_i / 100.0).floor}:#{(lng_i / 100.0).floor}"
  end

  # Clé de cellule fine. Le `floor` (et non `round`) garantit une grille alignée sur
  # l'origine, donc les mêmes bornes pour toutes les activités.
  def cell_key(lat, lng)
    "#{(lat / LAT_STEP).floor}:#{(lng / LNG_STEP).floor}"
  end

  def coarse_key(lat, lng)
    "#{(lat / COARSE_LAT_STEP).floor}:#{(lng / COARSE_LNG_STEP).floor}"
  end

  # Un point `latlng` Strava est `[lat, lng]`. On écarte les points nuls (perte de
  # signal) et le (0, 0) que certains capteurs émettent avant le premier fix.
  def point_coords(point)
    return [nil, nil] unless point.is_a?(Array) && point.length >= 2

    lat = point[0]
    lng = point[1]
    return [nil, nil] unless lat.is_a?(Numeric) && lng.is_a?(Numeric)
    return [nil, nil] if lat.zero? && lng.zero?
    return [nil, nil] unless lat.abs <= 90 && lng.abs <= 180

    [lat.to_f, lng.to_f]
  end

  def numeric_at(values, i)
    return 0 unless values.is_a?(Array)

    v = values[i]
    v.is_a?(Numeric) && v.to_f.finite? ? v : 0
  end

  # Même tolérance de forme que `PeakPowerCurve` : le stream peut être le tableau
  # brut ou le hash `{ "data" => [...] }` renvoyé par l'API.
  def stream_values(streams, key)
    raw = streams[key] || streams[key.to_sym]
    return raw if raw.is_a?(Array)
    return raw['data'] || raw[:data] if raw.is_a?(Hash)

    nil
  end
end
