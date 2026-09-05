# Une pièce montée (à tour de rôle) sur un vélo — pneu, roue, pédalier, cassette,
# chaîne, frein hydraulique, ou un type custom déclaré par l'utilisateur (cf.
# PartType). Chaque pièce a son propre seuil d'usure en km. La chaîne a en plus son
# propre suivi de cirage (seuil + date de dernier cirage) : on cire chaîne par
# chaîne (avec une option « toutes les chaînes du vélo » côté UI).
#
# `discarded_at` : la pièce est mise au rebut (usée, cassée…) sans être effacée —
# son historique de montage et ses km restent consultables. Une pièce au rebut ne
# peut plus être (re)montée (cf. PartsController#discard/#restore).
class Part < ApplicationRecord
  MAX_NAME_LEN = 40
  MAX_NOTES_LEN = 500

  belongs_to :bike
  belongs_to :part_type
  has_many :part_mounts, dependent: :destroy

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }
  validates :wear_threshold_km, numericality: { greater_than: 0 }
  validates :wax_threshold_km, numericality: { greater_than: 0 }, allow_nil: true
  validates :notes, length: { maximum: MAX_NOTES_LEN }

  def chain_part? = part_type.key == "chain"
  def discarded? = discarded_at.present?
end
