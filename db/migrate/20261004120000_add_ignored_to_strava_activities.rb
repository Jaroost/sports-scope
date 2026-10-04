class AddIgnoredToStravaActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :ignored, :boolean, default: false, null: false
  end
end
