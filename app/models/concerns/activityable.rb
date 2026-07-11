# Shared behaviour for the two heterogeneous activity tables — `StravaActivity`
# (synced from the API) and `ImportedActivity` (uploaded FIT files). Both store
# the same `streams` jsonb shape and a pre-computed `peak_powers` curve, so the
# read-through/compute logic lives here rather than being duplicated per model.
#
# Cross-activity *queries* (aggregations spanning both tables) live in
# `UserActivities`; this concern only covers per-row derivations.
module Activityable
  extend ActiveSupport::Concern

  # Standard cycling peak-power durations (seconds). Re-exposed on each model
  # for backwards-compatible callers.
  PEAK_POWER_DURATIONS = PeakPowerCurve::DURATIONS

  # Write-through of a detailed streams hash (the key_by_type shape returned by
  # the Strava streams API / produced by the FIT importer), then recompute the
  # peak-power curve. Returns self.
  def store_streams!(streams)
    self.streams = streams.is_a?(Hash) ? streams : {}
    self.peak_powers = PeakPowerCurve.compute_from(self.streams)
    save!
    self
  end

  # Recompute the peak-power curve from the stored `streams` and persist it as
  # `{ "5" => 412.3, "15" => 388.0, … }`. No-op save when nothing changed.
  def compute_peak_powers!
    self.peak_powers = PeakPowerCurve.compute_from(streams)
    save!(touch: false) if changed?
    peak_powers
  end
end
