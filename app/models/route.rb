class Route < ApplicationRecord
  # Catégorie d'activité — pilote la vitesse moyenne d'estimation et l'icône de la
  # liste. Distincte du `profile` de routage BRouter.
  ACTIVITIES = %w[cycling mtb hiking].freeze

  belongs_to :user
  # Unguessable token for public, shareable navigation links.
  has_secure_token :share_token
  validates :name, presence: true, length: { maximum: 80 }
  validates :waypoints, presence: true
  validates :activity, inclusion: { in: ACTIVITIES }
end
