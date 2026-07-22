# La table `strava_activity_peak_powers` était l'ancien mécanisme de cache de la
# courbe de puissance des activités Strava, du temps où celles-ci n'étaient pas
# persistées. Depuis la table `strava_activities` (qui stocke `peak_powers`
# directement), elle n'est plus branchée nulle part : aucun caller, le classement
# des records lit désormais `strava_activities` via `UserActivities`.
class DropStravaActivityPeakPowers < ActiveRecord::Migration[8.1]
  def up
    drop_table :strava_activity_peak_powers
  end

  def down
    create_table :strava_activity_peak_powers do |t|
      t.jsonb :peak_powers, default: {}, null: false
      t.datetime :started_at
      t.string :strava_activity_id, null: false
      t.bigint :user_id, null: false
      t.timestamps
      t.index %i[user_id strava_activity_id], name: "idx_strava_peak_powers_user_activity", unique: true
      t.index :user_id
    end
  end
end
