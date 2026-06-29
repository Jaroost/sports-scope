class CreateStravaActivities < ActiveRecord::Migration[8.1]
  def change
    create_table :strava_activities do |t|
      t.references :user, null: false, foreign_key: true
      t.bigint :strava_id, null: false

      t.string :name, null: false
      t.string :activity_type
      t.datetime :started_at

      t.float :distance_m
      t.integer :moving_time_s
      t.integer :elapsed_time_s
      t.float :total_elevation_gain
      t.float :average_speed
      t.float :max_speed
      t.float :average_heartrate
      t.float :max_heartrate
      t.float :average_watts
      t.float :max_watts
      t.float :average_cadence
      t.float :max_cadence
      t.float :average_temp

      t.jsonb :start_latlng
      t.jsonb :end_latlng

      # Full Strava summary payload (so the detail/list views keep field parity
      # with the live API) plus the detailed series fetched lazily on first view.
      t.jsonb :raw, default: {}, null: false
      t.jsonb :streams, default: {}, null: false
      t.jsonb :peak_powers, default: {}, null: false

      t.timestamps
    end

    add_index :strava_activities, %i[user_id strava_id], unique: true
    add_index :strava_activities, %i[user_id started_at]
  end
end
