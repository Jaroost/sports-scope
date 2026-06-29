# Une chaîne montée (à tour de rôle) sur un vélo. Chaque chaîne a son propre seuil
# de cirage et sa propre date de dernier cirage : on cire chaîne par chaîne (avec
# une option « toutes les chaînes du vélo » côté UI).
class Chain < ApplicationRecord
  MAX_NAME_LEN = 40

  belongs_to :bike
  has_many :chain_mounts, dependent: :destroy

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }
  validates :wax_threshold_km, numericality: { greater_than: 0 }
end
