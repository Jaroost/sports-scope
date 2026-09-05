# Un intervalle « telle pièce a été montée sur le vélo, de telle date à telle
# autre » (`unmounted_at` nil = toujours montée). C'est cet intervalle explicite
# qui sert à attribuer les km des activités à la pièce (cf. PartWearService).
#
# Monter une pièce d'un type qui n'autorise pas les montages multiples
# (`PartType#allow_multiple_mounted`) referme automatiquement les autres montages
# ouverts du même type sur le vélo (cf. BikesController#mount) — sinon (pneu, roue,
# plaquette/disque de frein…) plusieurs pièces du même type peuvent rester montées
# en même temps (avant/arrière).
class PartMount < ApplicationRecord
  belongs_to :bike
  belongs_to :part

  validates :mounted_at, presence: true
  validates :unmounted_at, comparison: { greater_than: :mounted_at }, allow_nil: true
end
