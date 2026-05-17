class ImportedActivity < ApplicationRecord
  belongs_to :user

  validates :name, presence: true, length: { maximum: 120 }
  validates :source, presence: true

  # Re-exposed for backwards-compatible callers (controllers, rake tasks).
  PEAK_POWER_DURATIONS = PeakPowerCurve::DURATIONS

  # Recompute the peak-power curve from the activity's `streams` (time + watts)
  # and store the result in `peak_powers` as `{ "5" => 412.3, "15" => 388.0, … }`.
  def compute_peak_powers!
    self.peak_powers = PeakPowerCurve.compute_from(streams)
    save!(touch: false) if changed?
    peak_powers
  end
end
