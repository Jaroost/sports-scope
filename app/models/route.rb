class Route < ApplicationRecord
  belongs_to :user
  # Unguessable token for public, shareable navigation links.
  has_secure_token :share_token
  validates :name, presence: true, length: { maximum: 80 }
  validates :waypoints, presence: true
end
