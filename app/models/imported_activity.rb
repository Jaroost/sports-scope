class ImportedActivity < ApplicationRecord
  belongs_to :user

  validates :name, presence: true, length: { maximum: 120 }
  validates :source, presence: true
end
