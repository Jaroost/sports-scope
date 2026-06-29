# Calcule l'usure des chaînes d'un vélo : combien de km chaque chaîne a parcourus
# depuis son dernier cirage. Lecture seule, recalculé à la demande.
#
# Rotation : une seule chaîne est montée à la fois. On reconstruit les intervalles
# de montage depuis `chain_mounts` (triés) et on n'attribue à une chaîne que les km
# des sorties tombant dans SES intervalles ET après son dernier cirage.
#
# Activités d'un vélo :
# - sorties Strava dont le `gear_id` correspond au vélo ;
# - pour le vélo « par défaut » : en plus, les sorties Strava sans gear + les imports
#   .fit (filtrés sur les types « vélo » pour ne pas compter la course à pied, etc.).
class ChainWearService
  # Un type contenant l'un de ces mots n'est PAS du vélo (course, marche, nage…).
  # Tout le reste — y compris un type vide (un .fit sans type) — est considéré vélo.
  NON_RIDE_TYPE_RE = /run|walk|hik|swim|marche|course|nage|ski|row/i

  def initialize(bike)
    @bike = bike
    @activities = load_activities # [[started_at, distance_m], ...] triées par date
    @mounts = bike.chain_mounts.order(:mounted_at, :id).to_a
  end

  # km parcourus par cette chaîne depuis son dernier cirage (arrondi à 0,1 km).
  def km_since_wax(chain)
    floor = chain.last_waxed_at
    total = 0.0
    segments_for(chain.id).each do |start_at, end_at|
      from = [start_at, floor].compact.max
      @activities.each do |started_at, distance_m|
        next if started_at < from
        next if end_at && started_at >= end_at

        total += distance_m
      end
    end
    (total / 1000.0).round(1)
  end

  def progress_percent(chain)
    threshold = chain.wax_threshold_km.to_i
    return 0 if threshold.zero?

    ((km_since_wax(chain) / threshold) * 100).round
  end

  def mounted_chain_id
    @mounts.last&.chain_id
  end

  private

  # Intervalles [mounted_at, next_mount_at) pendant lesquels `chain_id` était montée
  # (le dernier segment est ouvert : end_at = nil).
  def segments_for(chain_id)
    @mounts.each_with_index.filter_map do |mount, i|
      next unless mount.chain_id == chain_id

      [mount.mounted_at, @mounts[i + 1]&.mounted_at]
    end
  end

  def load_activities
    rows = []
    if @bike.strava_gear_id.present?
      rows += @bike.user.strava_activities.where(gear_id: @bike.strava_gear_id)
                   .pluck(:started_at, :distance_m)
    end
    if @bike.is_default?
      rows += ride_rows(@bike.user.strava_activities.where(gear_id: nil))
      rows += ride_rows(@bike.user.imported_activities)
    end
    rows.reject { |started_at, distance_m| started_at.nil? || distance_m.nil? }
        .sort_by(&:first)
  end

  # Sorties « vélo » d'un scope, en [started_at, distance_m].
  def ride_rows(scope)
    scope.pluck(:activity_type, :started_at, :distance_m).filter_map do |type, started_at, distance_m|
      next if NON_RIDE_TYPE_RE.match?(type.to_s)

      [started_at, distance_m]
    end
  end
end
