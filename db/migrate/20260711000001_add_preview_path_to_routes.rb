class AddPreviewPathToRoutes < ActiveRecord::Migration[8.1]
  def up
    add_column :routes, :preview_path, :text

    # Backfill des itinéraires existants depuis leur géométrie déjà stockée.
    Route.reset_column_information
    Route.find_each do |route|
      path = Route.build_preview_path(route.geometry)
      route.update_column(:preview_path, path) if path
    end
  end

  def down
    remove_column :routes, :preview_path
  end
end
