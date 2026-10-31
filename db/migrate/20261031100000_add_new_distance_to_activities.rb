class AddNewDistanceToActivities < ActiveRecord::Migration[8.1]
  def change
    # Distance (m) parcourue sur des cellules jamais traversées auparavant, pour le même
    # sport (cf. `ExploredDistance`). NULL = pas calculée (sans tracé, ou pas encore).
    add_column :strava_activities, :new_distance_m, :float
    add_column :imported_activities, :new_distance_m, :float
    add_index :strava_activities, %i[user_id new_distance_m]
  end
end
