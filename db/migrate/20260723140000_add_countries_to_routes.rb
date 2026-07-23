class AddCountriesToRoutes < ActiveRecord::Migration[8.1]
  # Pays traversés (codes ISO 3166-1 alpha-2, ordonnés le long du tracé), extraits
  # en même temps que `localities` — cf. LocalitiesExtractor. `[]` = jamais extrait
  # ou aucun pays trouvé, comme pour les localités.
  def change
    add_column :routes, :countries, :jsonb, default: [], null: false
  end
end
