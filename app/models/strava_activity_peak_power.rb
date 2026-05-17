# Per-user cache of Strava activities' peak-power curve. Strava activities
# themselves aren't persisted (they're fetched on demand from the API), so
# this table exists only to compare an activity's pics against the user's
# all-time bests in `PeakPowerCurve.bests_for_user`.
class StravaActivityPeakPower < ApplicationRecord
  belongs_to :user

  validates :strava_activity_id, presence: true,
                                 uniqueness: { scope: :user_id }

  # Idempotent upsert: recomputes from the provided streams hash and writes
  # the result. Returns the (re)loaded record.
  def self.upsert_from_streams(user:, strava_activity_id:, started_at:, streams:)
    peak_powers = PeakPowerCurve.compute_from(streams)
    record = find_or_initialize_by(user: user, strava_activity_id: strava_activity_id.to_s)
    record.started_at = started_at if started_at
    record.peak_powers = peak_powers
    record.save!
    record
  end
end
