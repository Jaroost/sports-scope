# Distance « nouvelle » d'une sortie : la part du tracé qui passe sur des cellules
# (grille fixe de `TrackFingerprint`, ~60 m) que l'utilisateur n'avait jamais traversées
# lors d'une sortie ANTÉRIEURE du même sport.
#
# Règles :
#   • les sports ne se mélangent pas : on compare par catégorie
#     (`PerformanceRecords.sport_category`) — une route déjà courue reste nouvelle à vélo ;
#   • les deux tables d'activités (Strava + FIT importé) forment un seul historique ;
#   • une cellule est « connue » si elle, ou l'une de ses 8 voisines, a été traversée
#     avant : sans cette tolérance, 30 m de dérive GPS suffiraient à rendre « nouvelle »
#     une route déjà faite. Corollaire assumé : une route parallèle à moins de ~100 m
#     d'une ancienne compte comme connue ;
#   • à l'intérieur d'une même sortie, une cellule déjà traversée ne compte qu'une fois
#     (aller-retour sur un chemin neuf = un seul sens, pas de double compte aux bords
#     de cellule) ;
#   • la distance d'une cellule est celle parcourue entre son entrée et l'entrée de la
#     suivante (`d` de l'empreinte) ; la dernière cellule (< 60 m) ne compte pas.
#
# Le résultat dépend de l'ORDRE de l'historique : ajouter une sortie ancienne change
# celles qui la suivent. D'où un calcul global par utilisateur (une passe chronologique,
# `call`), et non un incrémental par activité.
class ExploredDistance
  # Clé entière d'une cellule `"lat_i:lng_i"`. Décalages > amplitude des indices
  # (lat ±167 000, lng ±225 000) ; le pas de ligne laisse la place aux voisines (±1)
  # sans retenue, donc voisine = clé ± 1 ou ± ROW.
  LNG_SPAN = 2_000_000
  LAT_OFFSET = 400_000
  LNG_OFFSET = 1_000_000
  NEIGHBOURS = [-1, 0, 1].product([-1, 0, 1]).map { |dlat, dlng| dlat * LNG_SPAN + dlng }.freeze

  # Lots d'activités dont on charge l'empreinte d'un coup (chaque empreinte pèse
  # plusieurs centaines de Ko sur une longue sortie).
  BATCH_SIZE = 25

  def self.call(user)
    new(user).call
  end

  # Programme un recalcul de fond, regroupé : un lot de streams récupérés d'affilée
  # ne déclenche qu'une passe, pas une par activité.
  def self.schedule(user_id)
    Rails.cache.fetch("explored_distance:scheduled:#{user_id}", expires_in: 2.minutes) do
      ComputeExploredDistanceJob.set(wait: 2.minutes).perform_later(user_id)
      true
    end
  end

  def initialize(user)
    @user = user
  end

  # Renvoie le nombre d'activités dont la valeur a changé.
  def call
    changed = 0
    visited = Hash.new { |h, k| h[k] = Set.new } # catégorie de sport => clés de cellules

    ordered_refs.each_slice(BATCH_SIZE) do |refs|
      fingerprints = load_fingerprints(refs)
      refs.each do |ref|
        fp = fingerprints[[ref[:klass], ref[:id]]]
        next unless fp

        value = process(fp[:cells], fp[:d], visited[ref[:sport]])
        changed += 1 if store(ref, value)
      end
    end
    changed
  end

  private

  # Activités à tracé, toutes tables confondues, en ordre chronologique.
  def ordered_refs
    refs = [StravaActivity, ImportedActivity].flat_map do |klass|
      klass.where(user_id: @user.id).where.not(started_at: nil).where.not(track_cells: {})
           .pluck(:id, :started_at, :activity_type, :new_distance_m).map do |id, at, type, current|
        { klass: klass, id: id, at: at, sport: PerformanceRecords.sport_category(type), current: current }
      end
    end
    refs.sort_by { |r| [r[:at], r[:klass].name, r[:id]] }
  end

  # `cells` et `d` seulement : on n'a pas besoin du reste de l'empreinte (index,
  # temps, grille grossière), ce qui divise nettement la mémoire.
  def load_fingerprints(refs)
    refs.group_by { |r| r[:klass] }.each_with_object({}) do |(klass, group), out|
      klass.where(id: group.map { |r| r[:id] })
           .pluck(:id, Arel.sql("track_cells -> 'cells'"), Arel.sql("track_cells -> 'd'")).each do |id, cells, d|
        out[[klass, id]] = { cells: cells, d: d }
      end
    end
  end

  # Distance nouvelle (m) de la sortie ; ajoute ses cellules à `visited` ensuite
  # (jamais pendant : sinon chaque cellule serait voisine de la précédente).
  def process(cells, dists, visited)
    cells = parse(cells)
    dists = parse(dists)
    own = Set.new
    total = 0.0

    cells.each_with_index do |key_str, i|
      key = encode(key_str)
      next if key.nil?

      fresh = !own.include?(key) && NEIGHBOURS.none? { |n| visited.include?(key + n) }
      own << key
      next unless fresh && dists[i + 1] && dists[i]

      total += [dists[i + 1].to_f - dists[i].to_f, 0].max
    end

    visited.merge(own)
    total.round
  end

  # La colonne jsonb arrive soit déjà décodée, soit en texte selon le type renvoyé par
  # `pluck` sur une expression.
  def parse(value)
    value.is_a?(String) ? JSON.parse(value) : Array(value)
  end

  def encode(key_str)
    lat_i, lng_i = key_str.split(':')
    return nil if lat_i.nil? || lng_i.nil?

    ((lat_i.to_i + LAT_OFFSET) * LNG_SPAN) + lng_i.to_i + LNG_OFFSET
  end

  # `update_column` : pas de callbacks et surtout pas de bump d'`updated_at`, qui
  # invaliderait les caches FTP / records / charge (`UserActivities.data_version`) pour
  # une valeur qui n'y entre pas.
  def store(ref, value)
    return false if ref[:current] == value

    ref[:klass].where(id: ref[:id]).update_all(new_distance_m: value)
    true
  end
end
