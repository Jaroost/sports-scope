class Route < ApplicationRecord
  belongs_to :user
  validates :name, presence: true, length: { maximum: 80 }
  validates :waypoints, presence: true
end
