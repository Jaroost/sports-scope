class Poi < ApplicationRecord
  # Catégories de POI — recopiées du registre front `app/javascript/poiCategories.ts`
  # (mêmes clés que celles utilisées par GeocodesController pour les clauses Overpass).
  CATEGORIES = %w[cemeteries bakeries water food viewpoints picnic toilets localities].freeze
  # Provenance : « custom » = posé à la main dans le créateur ; « overpass » = épinglé
  # depuis un POI découvert sur Overpass.
  SOURCES = %w[custom overpass].freeze
  MAX_NAME_LEN = 80

  belongs_to :user

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }
  validates :category, inclusion: { in: CATEGORIES }
  validates :source, inclusion: { in: SOURCES }
  validates :lat, presence: true, numericality: { greater_than_or_equal_to: -90, less_than_or_equal_to: 90 }
  validates :lng, presence: true, numericality: { greater_than_or_equal_to: -180, less_than_or_equal_to: 180 }
end
