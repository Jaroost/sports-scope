class ReplaceRoutePreviewWithSegments < ActiveRecord::Migration[8.1]
  def up
    remove_column :routes, :preview_path
    add_column :routes, :preview_segments, :jsonb

    # Backfill des itinéraires existants depuis leur géométrie déjà stockée.
    Route.reset_column_information
    Route.find_each do |route|
      segments = Route.build_preview_segments(route.geometry)
      route.update_column(:preview_segments, segments) if segments
    end
  end

  def down
    remove_column :routes, :preview_segments
    add_column :routes, :preview_path, :text
  end
end
