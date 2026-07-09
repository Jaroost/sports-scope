class Route < ApplicationRecord
  # Catégorie d'activité — pilote la vitesse moyenne d'estimation, l'icône de la
  # liste et le fond de sentiers. Le profil de routage BRouter (`profile`) lui est
  # lié mais réglable indépendamment (cf. brouter.ts / PROFILES_BY_SPORT).
  ACTIVITIES = %w[cycling mtb hiking].freeze

  belongs_to :user
  # Unguessable token for public, shareable navigation links.
  has_secure_token :share_token
  validates :name, presence: true, length: { maximum: 80 }
  validates :waypoints, presence: true
  validates :activity, inclusion: { in: ACTIVITIES }
end
