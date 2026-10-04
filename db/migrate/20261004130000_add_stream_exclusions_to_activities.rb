class AddStreamExclusionsToActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :stream_exclusions, :jsonb, default: {}, null: false
    add_column :imported_activities, :stream_exclusions, :jsonb, default: {}, null: false
  end
end
