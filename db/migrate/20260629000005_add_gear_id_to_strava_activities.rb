class AddGearIdToStravaActivities < ActiveRecord::Migration[8.1]
  # Le gear_id (vélo Strava) n'existait que dans `raw` (jsonb). On le normalise en
  # colonne pour pouvoir filtrer/indexer les km par vélo.
  def up
    add_column :strava_activities, :gear_id, :string
    add_index  :strava_activities, [:user_id, :gear_id]
    execute "UPDATE strava_activities SET gear_id = raw->>'gear_id' WHERE raw ? 'gear_id'"
  end

  def down
    remove_index  :strava_activities, [:user_id, :gear_id]
    remove_column :strava_activities, :gear_id
  end
end
