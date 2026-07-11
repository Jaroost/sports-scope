class AddMapPolylineToRoutes < ActiveRecord::Migration[8.1]
  def up
    add_column :routes, :map_polyline, :jsonb

    # Backfill des itinéraires existants depuis leur géométrie déjà stockée.
    Route.reset_column_information
    Route.find_each do |route|
      polyline = Route.build_map_polyline(route.geometry)
      route.update_column(:map_polyline, polyline) if polyline
    end
  end

  def down
    remove_column :routes, :map_polyline
  end
end
