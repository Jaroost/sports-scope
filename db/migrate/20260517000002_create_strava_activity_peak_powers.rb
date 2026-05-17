class CreateStravaActivityPeakPowers < ActiveRecord::Migration[8.1]
  def change
    create_table :strava_activity_peak_powers do |t|
      t.references :user, null: false, foreign_key: true
      # Strava activity IDs are bigints; we keep them as strings to stay
      # uniform with the `external_id` shape used in PeakPowerCurve queries
      # (which mixes integer IDs from imported_activities with Strava IDs).
      t.string :strava_activity_id, null: false
      t.datetime :started_at
      t.jsonb :peak_powers, null: false, default: {}
      t.timestamps
    end
    add_index :strava_activity_peak_powers,
              [:user_id, :strava_activity_id],
              unique: true,
              name: "idx_strava_peak_powers_user_activity"
  end
end
