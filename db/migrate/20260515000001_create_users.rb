class CreateUsers < ActiveRecord::Migration[8.1]
  def change
    create_table :users do |t|
      t.string :keycloak_uid, null: false
      t.string :email, null: false
      t.string :display_name

      t.string :strava_uid
      t.string :strava_access_token
      t.string :strava_refresh_token
      t.datetime :strava_expires_at

      t.timestamps
    end

    add_index :users, :keycloak_uid, unique: true
    add_index :users, :email, unique: true
    add_index :users, :strava_uid, unique: true, where: "strava_uid IS NOT NULL"
  end
end
