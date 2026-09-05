# Événement « telle pièce est montée sur le vélo depuis telle date ». La pièce
# montée d'un vélo pour un type donné est celle du PartMount le plus récent parmi
# ses pièces de ce type ; les intervalles entre montages servent à n'attribuer les
# km qu'à la pièce réellement montée (cf. PartWearService).
class PartMount < ApplicationRecord
  belongs_to :bike
  belongs_to :part

  validates :mounted_at, presence: true
end
