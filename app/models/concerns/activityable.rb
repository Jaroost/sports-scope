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
  # peak-power curve and the normalized power. Returns self.
  def store_streams!(streams)
    self.streams = streams.is_a?(Hash) ? streams : {}
    self.peak_powers = PeakPowerCurve.compute_from(self.streams)
    self.normalized_power = TrainingLoad.normalized_power(self.streams)
    assign_zone_histograms
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

  # Recompute the stored normalized power from `streams`. Idempotent save.
  def compute_normalized_power!
    self.normalized_power = TrainingLoad.normalized_power(streams)
    save!(touch: false) if changed?
    normalized_power
  end

  # Recompute the FC/power time-in-bucket histograms from `streams`. Idempotent
  # save; returns true when at least one histogram carries data. Used by the
  # backfill (streams stored before the histograms existed).
  def compute_zone_histograms!
    assign_zone_histograms
    save!(touch: false) if changed?
    hr_histogram.present? || power_histogram.present?
  end

  private

  def assign_zone_histograms
    self.hr_histogram = ZoneDistribution.histogram(streams, 'heartrate', ZoneDistribution::HR_BUCKET)
    self.power_histogram = ZoneDistribution.histogram(streams, 'watts', ZoneDistribution::POWER_BUCKET)
  end
end
