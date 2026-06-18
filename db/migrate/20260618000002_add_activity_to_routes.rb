class AddActivityToRoutes < ActiveRecord::Migration[8.1]
  # Catégorie d'activité de l'itinéraire (cycling | mtb | hiking). Distincte du
  # `profile` de routage BRouter : elle pilote la vitesse moyenne d'estimation et
  # l'icône affichée dans la liste.
  def change
    add_column :routes, :activity, :string, default: "cycling", null: false
  end
end
