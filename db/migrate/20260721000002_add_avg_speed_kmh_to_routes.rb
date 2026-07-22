class AddAvgSpeedKmhToRoutes < ActiveRecord::Migration[8.1]
  # Vitesse moyenne retenue pour l'estimation de durée de CET itinéraire. Nullable :
  # les itinéraires existants (et tout enregistrement qui ne la fournit pas) retombent
  # sur le réglage du profil pour le sport concerné, cf. Route#avg_speed_kmh.
  def change
    add_column :routes, :avg_speed_kmh, :float
  end
end
