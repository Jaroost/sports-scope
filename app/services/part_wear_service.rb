# Calcule l'usure des pièces d'un vélo : combien de km chaque pièce a parcourus
# depuis son montage (usure totale), et — pour une chaîne — depuis son dernier
# cirage. Lecture seule, recalculé à la demande.
#
# Chaque PartMount porte désormais son propre intervalle [mounted_at, unmounted_at)
# (unmounted_at nil = toujours monté) : on n'attribue à une pièce que les km des
# sorties tombant dans SES intervalles. Plusieurs pièces d'un même type peuvent
# avoir un intervalle ouvert en même temps (cf. PartType#allow_multiple_mounted).
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

  # La pièce a-t-elle un montage actuellement ouvert (unmounted_at nil) ?
  def mounted?(part)
    @mounts.any? { |m| m.part_id == part.id && m.unmounted_at.nil? }
  end

  # Ids des pièces d'un type actuellement montées (peut en renvoyer plusieurs si
  # le type autorise les montages multiples).
  def mounted_part_ids(part_type_id)
    @mounts.select { |m| m.unmounted_at.nil? && m.part.part_type_id == part_type_id }.map(&:part_id).uniq
  end

  # Date du montage le plus récent de cette pièce (nil si jamais montée).
  def last_mounted_at(part)
    @mounts.select { |m| m.part_id == part.id }.max_by(&:mounted_at)&.mounted_at
  end

  private

  # Intervalles [mounted_at, unmounted_at) de cette pièce (unmounted_at nil = segment
  # ouvert), directement portés par ses propres part_mounts.
  def segments_for(part)
    @mounts.select { |m| m.part_id == part.id }.map { |m| [m.mounted_at, m.unmounted_at] }
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
