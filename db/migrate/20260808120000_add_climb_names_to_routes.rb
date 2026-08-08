class AddClimbNamesToRoutes < ActiveRecord::Migration[8.1]
  # Noms donnés à la main aux cols détectés sur le tracé (par défaut celui du lieu
  # d'arrivée). Ancrés par coordonnées (comme `markers`/`voice_hints`), pas par index
  # de géométrie : les cols sont recalculés à chaque affichage et un index ne
  # survivrait pas à un recalcul du tracé.
  def change
    add_column :routes, :climb_names, :jsonb, default: [], null: false
  end
end
