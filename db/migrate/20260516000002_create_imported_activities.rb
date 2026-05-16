class CreateImportedActivities < ActiveRecord::Migration[8.1]
  def change
    create_table :imported_activities do |t|
      t.references :user, null: false, foreign_key: true
      t.string :source, null: false, default: "fit"
      t.string :filename
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
      t.jsonb :streams, null: false, default: {}
      t.timestamps
    end
    add_index :imported_activities, [:user_id, :started_at]
  end
end
