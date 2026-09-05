# Calcule l'usure des pièces d'un vélo : combien de km chaque pièce a parcourus
# depuis son montage (usure totale), et — pour une chaîne — depuis son dernier
# cirage. Lecture seule, recalculé à la demande.
#
# Rotation : à un instant donné, une seule pièce d'un type donné est montée. On
# reconstruit les intervalles de montage depuis `part_mounts` (triés par pièce) et
# on n'attribue à une pièce que les km des sorties tombant dans SES intervalles.
#
# Activités d'un vélo :
# - sorties Strava dont le `gear_id` correspond au vélo ;
# - pour le vélo « par défaut » : en plus, les sorties Strava sans gear + les imports
#   .fit (filtrés sur les types « vélo » pour ne pas compter la course à pied, etc.).
class PartWearService
  # Un type contenant l'un de ces mots n'est PAS du vélo (course, marche, nage…).
  # Tout le reste — y compris un type vide (un .fit sans type) — est considéré vélo.
  NON_RIDE_TYPE_RE = /run|walk|hik|swim|marche|course|nage|ski|row/i

  def initialize(bike)
    @bike = bike
    @activities = load_activities # [[started_at, distance_m], ...] triées par date
    @mounts = bike.part_mounts.includes(:part).order(:mounted_at, :id).to_a
  end

  # km parcourus par cette pièce depuis son tout premier montage (usure totale,
  # tous montages confondus — une pièce peut être démontée puis remontée plus tard).
  def km_since_mount(part)
    total = 0.0
    segments_for(part).each do |start_at, end_at|
      @activities.each do |started_at, distance_m|
        next if started_at < start_at
        next if end_at && started_at >= end_at

        total += distance_m
      end
    end
    (total / 1000.0).round(1)
  end

  # km parcourus par cette chaîne depuis son dernier cirage (arrondi à 0,1 km).
  def km_since_wax(chain)
    floor = chain.last_waxed_at
    total = 0.0
    segments_for(chain).each do |start_at, end_at|
      from = [start_at, floor].compact.max
      @activities.each do |started_at, distance_m|
        next if started_at < from
        next if end_at && started_at >= end_at

        total += distance_m
      end
    end
    (total / 1000.0).round(1)
  end

  def wear_progress_percent(part)
    threshold = part.wear_threshold_km.to_i
    return 0 if threshold.zero?

    ((km_since_mount(part) / threshold) * 100).round
  end

  def wax_progress_percent(chain)
    threshold = chain.wax_threshold_km.to_i
    return 0 if threshold.zero?

    ((km_since_wax(chain) / threshold) * 100).round
  end

  def mounted_part_id(part_type_id)
    @mounts.reverse_each do |mount|
      return mount.part_id if mount.part.part_type_id == part_type_id
    end
    nil
  end

  # Date du montage le plus récent de cette pièce (nil si jamais montée).
  def last_mounted_at(part)
    @mounts.select { |m| m.part_id == part.id }.max_by(&:mounted_at)&.mounted_at
  end

  private

  # Intervalles [mounted_at, next_mount_at) pendant lesquels `part` était monté
  # (le dernier segment est ouvert : end_at = nil). Un montage plus récent d'une
  # AUTRE pièce du même type ferme le segment en cours de `part`.
  def segments_for(part)
    same_type_mounts = @mounts.select { |m| m.part.part_type_id == part.part_type_id }
    same_type_mounts.each_with_index.filter_map do |mount, i|
      next unless mount.part_id == part.id

      [mount.mounted_at, same_type_mounts[i + 1]&.mounted_at]
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
