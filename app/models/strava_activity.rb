# Persisted copy of a user's Strava activity. Summaries are filled in bulk by
# `StravaSyncService` (cheap: ~1 API request per 200 activities); the detailed
# `streams` are fetched lazily on first view (write-through from
# `StravaController#streams`) since they cost one request each and would blow
# the Strava rate limit if fetched in bulk.
class StravaActivity < ApplicationRecord
  include Activityable

  belongs_to :user

  validates :strava_id, presence: true, uniqueness: { scope: :user_id }
  validates :name, presence: true, length: { maximum: 255 }

  # Lieux traversés (`localities`) : extraits d'Overpass en tâche de fond quand le
  # tracé du résumé change, pour la recherche par lieu dans la liste. after_commit —
  # le job doit voir l'activité enregistrée, et ne pas partir si la transaction est
  # annulée. Conditionné au tracé et non à `raw` : une resynchro réécrit `raw` en
  # entier (kudos, description…) sans que le tracé bouge, et referait un appel
  # Overpass par activité à chaque « Tout rafraîchir ».
  after_commit :extract_localities_later, on: %i[create update], if: :saved_change_to_summary_polyline?

  # Les gear_id Strava sont préfixés par type : « b… » pour les vélos, « g… » pour
  # les chaussures. Le suivi du cirage ne concerne que les vélos — on écarte donc
  # les chaussures (sinon une sortie course créerait un faux « vélo »).
  scope :with_bike_gear, -> { where("gear_id LIKE 'b%'") }

  # Activités dont les streams n'ont jamais été récupérés (ni via consultation,
  # ni via backfill). Cible du backfill de masse.
  scope :streams_pending, -> { where(streams_fetched_at: nil) }

  # Marque la date de récupération en plus du write-through partagé (`Activityable`),
  # pour qu'une activité sans données de streams (200 vide ou 404) ne reste pas
  # indéfiniment éligible au backfill.
  def store_streams!(streams)
    self.streams_fetched_at = Time.current
    # Les streams (latlng + altitude) permettent l'aperçu SVG coloré par le
    # dénivelé — bien plus fidèle que la polyligne résumé (sans altitude) posée
    # à la synchro. On ne recule jamais vers l'aperçu plat si les streams n'ont
    # pas de tracé exploitable (activité indoor, etc.).
    self.preview_segments = self.class.preview_segments_from_streams(streams) || preview_segments
    super
  end

  # Aperçu SVG du tracé (mêmes segments `{ "c", "d" }` que `Route`) : streams
  # colorés par dénivelé si disponibles, sinon la polyligne résumé (tracé neutre).
  # Utilisé pour le (re)calcul et le backfill de migration.
  def compute_preview_segments
    self.class.preview_segments_from_streams(streams) ||
      self.class.preview_segments_from_polyline(summary_polyline)
  end

  # Polyligne encodée du résumé Strava (`map.summary_polyline`), sans altitude.
  def summary_polyline
    return nil unless raw.is_a?(Hash)

    map = raw['map'] || raw[:map]
    return nil unless map.is_a?(Hash)

    (map['summary_polyline'] || map[:summary_polyline]).presence ||
      (map['polyline'] || map[:polyline]).presence
  end

  # Tracé cartographiable `[[lng, lat], ...]` décodé du résumé Strava (même ordre
  # et même forme que `Route#map_polyline`, pour la carte d'ensemble des sorties).
  # nil si l'activité n'a pas de tracé exploitable (indoor, GPS absent…).
  def map_polyline
    encoded = summary_polyline
    return nil if encoded.blank?

    coords = self.class.decode_polyline(encoded)
    coords.size >= 2 ? coords : nil
  end

  # Vrai quand la polyligne du résumé vient de changer (création avec tracé, ou
  # tracé modifié côté Strava). Comparaison sur la polyligne extraite de `raw`
  # avant/après : c'est la seule partie de `raw` dont dépendent les lieux.
  def saved_change_to_summary_polyline?
    return false unless saved_change_to_raw?

    before, after = saved_change_to_raw
    self.class.map_summary_polyline_from(before) != self.class.map_summary_polyline_from(after)
  end

  # Idempotent upsert of one Strava activity summary (the hash returned by
  # `/athlete/activities`). Returns the (re)loaded record. Only summary fields
  # are touched — `streams`/`peak_powers` are left intact for already-synced
  # activities.
  def self.upsert_summary(user:, summary:)
    strava_id = summary['id'] || summary[:id]
    return nil if strava_id.blank?

    record = find_or_initialize_by(user: user, strava_id: strava_id)
    record.assign_attributes(attrs_from_summary(summary))
    record.raw = summary
    # Aperçu du tracé depuis la polyligne résumé (sans altitude → tracé neutre).
    # On ne touche pas à l'aperçu quand les streams sont déjà là : il est alors
    # coloré par le dénivelé (posé par `store_streams!`), bien plus fidèle.
    record.preview_segments = preview_segments_from_polyline(map_summary_polyline(summary)) if record.streams.blank?
    record.save!
    record
  end

  # Segments d'aperçu `{ "c", "d" }` construits depuis les streams (latlng +
  # altitude) : tracé coloré par pente comme un itinéraire. nil si pas de tracé.
  def self.preview_segments_from_streams(streams)
    return nil unless streams.is_a?(Hash)

    latlng = stream_data(streams, 'latlng')
    return nil unless latlng.is_a?(Array) && latlng.size >= 2

    altitude = stream_data(streams, 'altitude')
    geometry = latlng.each_with_index.map do |pair, i|
      next unless pair.is_a?(Array) && pair.size >= 2

      lat, lng = pair
      ele = altitude.is_a?(Array) ? altitude[i] : nil
      [lng, lat, ele]
    end.compact
    Route.build_preview_segments(geometry)
  end

  # Segments d'aperçu depuis une polyligne encodée Strava (pas d'altitude → tous
  # les segments sont classés « plat »). nil si polyligne vide/illisible.
  def self.preview_segments_from_polyline(encoded)
    return nil if encoded.blank?

    Route.build_preview_segments(decode_polyline(encoded))
  end

  # Décode une polyligne encodée Google (précision 1e5) en `[[lng, lat], ...]`
  # (ordre lng, lat comme la géométrie des itinéraires).
  def self.decode_polyline(encoded)
    coords = []
    index = 0
    lat = 0
    lng = 0
    len = encoded.length

    while index < len
      lat += decode_delta(encoded, index) { |i| index = i }
      lng += decode_delta(encoded, index) { |i| index = i }
      coords << [lng / 1e5, lat / 1e5]
    end
    coords
  end

  # Lit un entier zig-zag varint à partir de `start`, renvoie le delta et publie
  # l'index suivant via le bloc. Extrait pour ne pas dupliquer la boucle lat/lng.
  def self.decode_delta(encoded, start)
    shift = 0
    result = 0
    index = start
    loop do
      b = encoded[index].ord - 63
      index += 1
      result |= (b & 0x1f) << shift
      shift += 5
      break if b < 0x20
    end
    yield index
    (result & 1) == 1 ? ~(result >> 1) : (result >> 1)
  end

  # `map.summary_polyline` d'un `raw` éventuellement absent ou illisible (activité
  # créée avant le stockage de `raw`, valeur d'avant-changement nil).
  def self.map_summary_polyline_from(raw)
    raw.is_a?(Hash) ? map_summary_polyline(raw) : nil
  end

  # `map.summary_polyline` d'un résumé Strava (hash symboles ou chaînes).
  def self.map_summary_polyline(summary)
    map = summary['map'] || summary[:map]
    return nil unless map.is_a?(Hash)

    (map['summary_polyline'] || map[:summary_polyline]).presence ||
      (map['polyline'] || map[:polyline]).presence
  end

  # `streams[key]` peut être un tableau brut ou `{ "data" => [...] }` (même forme
  # que l'API streams Strava et l'importeur FIT).
  def self.stream_data(streams, key)
    raw = streams[key] || streams[key.to_sym]
    return raw if raw.is_a?(Array)
    return raw['data'] || raw[:data] if raw.is_a?(Hash)

    nil
  end

  def self.attrs_from_summary(s)
    {
      name: (s['name'] || s[:name]).to_s.strip.first(255).presence || 'Strava activity',
      activity_type: (s['sport_type'] || s[:sport_type] || s['type'] || s[:type]).to_s.presence,
      gear_id: (s['gear_id'] || s[:gear_id]).presence,
      started_at: parse_time(s['start_date'] || s[:start_date] || s['start_date_local'] || s[:start_date_local]),
      distance_m: num(s['distance'] || s[:distance]),
      moving_time_s: int(s['moving_time'] || s[:moving_time]),
      elapsed_time_s: int(s['elapsed_time'] || s[:elapsed_time]),
      total_elevation_gain: num(s['total_elevation_gain'] || s[:total_elevation_gain]),
      average_speed: num(s['average_speed'] || s[:average_speed]),
      max_speed: num(s['max_speed'] || s[:max_speed]),
      average_heartrate: num(s['average_heartrate'] || s[:average_heartrate]),
      max_heartrate: num(s['max_heartrate'] || s[:max_heartrate]),
      average_watts: num(s['average_watts'] || s[:average_watts]),
      max_watts: num(s['max_watts'] || s[:max_watts]),
      average_cadence: num(s['average_cadence'] || s[:average_cadence]),
      max_cadence: num(s['max_cadence'] || s[:max_cadence]),
      average_temp: num(s['average_temp'] || s[:average_temp]),
      start_latlng: latlng(s['start_latlng'] || s[:start_latlng]),
      end_latlng: latlng(s['end_latlng'] || s[:end_latlng])
    }
  end

  def self.parse_time(v)
    return nil if v.blank?

    Time.iso8601(v.to_s)
  rescue ArgumentError, TypeError
    nil
  end

  def self.num(v)
    return nil if v.nil? || v == ''

    f = v.to_f
    f.finite? ? f : nil
  end

  def self.int(v)
    return nil if v.nil? || v == ''

    v.to_i
  end

  def extract_localities_later
    ExtractActivityLocalitiesJob.perform_later(id)
  end

  def self.latlng(v)
    return nil unless v.is_a?(Array) && v.length == 2

    lat = v[0].to_f
    lng = v[1].to_f
    return nil if lat.abs > 90 || lng.abs > 180

    [lat, lng]
  end
end
