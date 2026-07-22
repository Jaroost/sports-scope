# Nom donné par l'utilisateur à un segment découvert par `SegmentMatcher`.
#
# Un segment n'est pas une entité stockée : il est redécouvert à chaque analyse
# d'activité, avec des bornes qui dépendent de la sortie regardée. Pour qu'un nom
# survive à ça, on enregistre le CHEMIN — la suite de cellules de la grille
# `TrackFingerprint` — et on rapproche ensuite chaque segment découvert du segment
# nommé qui couvre le même chemin. Le nom suit donc le terrain, pas une activité.
#
# La comparaison est faite sur des ENSEMBLES de cellules, sans ordre : le même
# chemin parcouru en sens inverse porte le même nom.
class NamedSegment < ApplicationRecord
  belongs_to :user

  MAX_NAME_LEN = 80
  # Part des cellules du segment nommé retrouvées dans le segment découvert (et
  # réciproquement) à partir de laquelle on considère que c'est le même chemin.
  # Assez haut pour ne pas coller un nom à une portion qui n'en partage qu'un bout,
  # assez bas pour absorber les bornes qui bougent d'une sortie à l'autre.
  MATCH_RATIO = 0.6

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }
  validate :cells_present

  # Segments nommés passant par au moins une des cellules grossières fournies.
  # Même préfiltre indexé (GIN) que les candidats de `SegmentMatcher`.
  scope :in_coarse, ->(keys) {
    return none if keys.blank?

    where(Arel.sql("coarse ?| ARRAY[#{keys.map { |k| connection.quote(k) }.join(',')}]"))
  }

  def cell_set
    @cell_set ||= Array(cells).to_set
  end

  # Recouvrement mutuel avec un ensemble de cellules : la plus faible des deux parts
  # (nommé ⊂ découvert et découvert ⊂ nommé). Prendre le minimum évite qu'un long
  # segment nommé absorbe un petit bout de chemin qui lui appartient, ou l'inverse.
  def overlap_with(other_cells)
    return 0.0 if cell_set.empty? || other_cells.empty?

    shared = other_cells.count { |c| cell_set.include?(c) }
    [shared.to_f / cell_set.size, shared.to_f / other_cells.size].min
  end

  # Le segment nommé porte le SENS DE RÉFÉRENCE : l'ordre des cellules tel qu'il a
  # été enregistré au baptême. Une suite de cellules le parcourt-elle à l'envers ?
  # On projette ses cellules sur leurs positions de référence et on regarde si la
  # suite décroît plus qu'elle ne croît — insensible aux cellules manquées et aux
  # bornes qui débordent d'un côté ou de l'autre.
  #
  # C'est ce qui rend « sens direct / sens inverse » absolu : sans nom, la seule
  # référence disponible est la sortie regardée, et elle change à chaque page.
  def reversed_for?(other_cells)
    positions = {}
    Array(cells).each_with_index { |cell, i| positions[cell] ||= i }
    seq = Array(other_cells).filter_map { |cell| positions[cell] }
    return false if seq.size < 2

    ups = 0
    downs = 0
    seq.each_cons(2) { |a, b| b > a ? ups += 1 : (downs += 1 if b < a) }
    downs > ups
  end

  private

  def cells_present
    errors.add(:cells, :blank) if Array(cells).size < 2
  end
end
