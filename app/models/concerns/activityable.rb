# Shared behaviour for the two heterogeneous activity tables — `StravaActivity`
# (synced from the API) and `ImportedActivity` (uploaded FIT files). Both store
# the same `streams` jsonb shape and the same set of columns *derived* from those
# streams, so the read-through/compute logic lives here rather than being
# duplicated per model.
#
# Cross-activity *queries* (aggregations spanning both tables) live in
# `UserActivities`; this concern only covers per-row derivations.
module Activityable
  extend ActiveSupport::Concern

  # Standard cycling peak-power durations (seconds). Re-exposed on each model
  # for backwards-compatible callers.
  PEAK_POWER_DURATIONS = PeakPowerCurve::DURATIONS

  # ── Registre unique des métriques dérivées des streams ──────────────────────
  # Chaque entrée = `colonne => lambda(streams)`. C'est LA source de vérité de
  # « tout ce qui se calcule à partir des streams d'une activité » : l'écriture
  # des streams (`store_streams!`) comme le recalcul en masse
  # (`ActivityDerivationsBackfill`) itèrent dessus. Ajouter une métrique dérivée
  # = ajouter UNE ligne ici (+ la colonne en base), rien d'autre à toucher.
  #
  # Ces valeurs sont des dérivés INTRINSÈQUES de la sortie (indépendants des
  # seuils modifiables de l'athlète), d'où leur stockage. Les métriques qui
  # dépendent de seuils (TSS, zones, FTP…) restent calculées à la lecture.
  STREAM_DERIVATIONS = {
    peak_powers: ->(streams) { PeakPowerCurve.compute_from(streams) },
    normalized_power: ->(streams) { TrainingLoad.normalized_power(streams) },
    hr_histogram: ->(streams) { ZoneDistribution.histogram(streams, 'heartrate', ZoneDistribution::HR_BUCKET) },
    power_histogram: ->(streams) { ZoneDistribution.histogram(streams, 'watts', ZoneDistribution::POWER_BUCKET) }
  }.freeze

  included do
    # Activités porteuses de streams détaillés (cible des recalculs dérivés).
    scope :with_streams, -> { where.not(streams: {}) }
  end

  # Write-through of a detailed streams hash (the key_by_type shape returned by
  # the Strava streams API / produced by the FIT importer), then (re)compute all
  # derived columns from the registry. Returns self.
  def store_streams!(streams)
    self.streams = streams.is_a?(Hash) ? streams : {}
    assign_derivations
    save!
    self
  end

  # Recompute every derived column from the stored `streams` and persist. No-op
  # save when nothing changed. Returns true iff at least one column changed.
  #
  # Point d'entrée unique du recalcul : utilisé pour le calcul paresseux (1ʳᵉ
  # consultation d'un import) comme pour le backfill de masse après l'ajout d'une
  # nouvelle dérivation au registre.
  def recompute_derivations!
    assign_derivations
    return false unless changed?

    save!
    true
  end

  private

  def assign_derivations
    STREAM_DERIVATIONS.each { |column, compute| self[column] = compute.call(streams) }
  end
end
