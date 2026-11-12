class AddStravaUploadToImportedActivities < ActiveRecord::Migration[8.1]
  def change
    # Envoi d'une activité importée vers Strava (`POST /uploads`, cf. `StravaUploader`).
    change_table :imported_activities, bulk: true do |t|
      t.bigint :strava_upload_id
      t.bigint :strava_activity_id
      t.string :strava_upload_status
      t.string :strava_upload_error
      t.datetime :strava_uploaded_at
    end
    add_index :imported_activities, :strava_activity_id, where: "strava_activity_id IS NOT NULL"

    # Scopes OAuth accordés par l'utilisateur (Strava les renvoie au callback ; il peut
    # décocher `activity:write` sur l'écran d'autorisation).
    add_column :users, :strava_scope, :string
  end
end
