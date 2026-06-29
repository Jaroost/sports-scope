# Événement « telle chaîne est montée sur le vélo depuis telle date ». La chaîne
# montée d'un vélo est celle du ChainMount le plus récent ; les intervalles entre
# montages servent à n'attribuer les km qu'à la chaîne réellement montée
# (cf. ChainWearService).
class ChainMount < ApplicationRecord
  belongs_to :bike
  belongs_to :chain

  validates :mounted_at, presence: true
end
