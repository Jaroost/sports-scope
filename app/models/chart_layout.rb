class ChartLayout < ApplicationRecord
  belongs_to :user
  validates :name, presence: true, length: { maximum: 60 }
  validates :name, uniqueness: { scope: :user_id }
end
