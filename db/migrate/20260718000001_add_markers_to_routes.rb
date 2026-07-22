class AddMarkersToRoutes < ActiveRecord::Migration[8.1]
  # Repères posés à la main sur l'itinéraire (départ / arrivée / parking + libellé
  # optionnel). Champ distinct de `pois`, qui est réservé aux POI Overpass
  # « importants » (eau/ravito/…) et réécrit à chaque enregistrement.
  def change
    add_column :routes, :markers, :jsonb, default: [], null: false
  end
end
