# Persisted copy of a user's Strava activity. Summaries are filled in bulk by
# `StravaSyncService` (cheap: ~1 API request per 200 activities); the detailed
# `streams` are fetched lazily on first view (write-through from
# `StravaController#streams`) since they cost one request each and would blow
# the Strava rate limit if fetched in bulk.
class StravaActivity < ApplicationRecord
  belongs_to :user

  validates :strava_id, presence: true, uniqueness: { scope: :user_id }
  validates :name, presence: true, length: { maximum: 255 }

  PEAK_POWER_DURATIONS = PeakPowerCurve::DURATIONS

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
    record.save!
    record
  end

  def self.attrs_from_summary(s)
    {
      name: (s['name'] || s[:name]).to_s.strip.first(255).presence || 'Strava activity',
      activity_type: (s['sport_type'] || s[:sport_type] || s['type'] || s[:type]).to_s.presence,
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

  # Write-through of the detailed streams fetched from the Strava API, then
  # recompute the peak-power curve. `streams` is the key_by_type hash returned
  # by `/activities/:id/streams`.
  def store_streams!(streams)
    self.streams = streams.is_a?(Hash) ? streams : {}
    self.peak_powers = PeakPowerCurve.compute_from(self.streams)
    save!
    self
  end

  def compute_peak_powers!
    self.peak_powers = PeakPowerCurve.compute_from(streams)
    save!(touch: false) if changed?
    peak_powers
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

  def self.latlng(v)
    return nil unless v.is_a?(Array) && v.length == 2

    lat = v[0].to_f
    lng = v[1].to_f
    return nil if lat.abs > 90 || lng.abs > 180

    [lat, lng]
  end
end
