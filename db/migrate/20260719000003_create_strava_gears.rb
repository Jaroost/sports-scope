class CreateStravaGears < ActiveRecord::Migration[8.1]
  # Cache des noms de matériel Strava résolus via `/gear/:id`. Les résumés
  # d'activité ne portent que le `gear_id` : cette table donne un nom lisible au
  # menu de filtre. Réservée aux chaussures (gear « g… ») — les vélos (« b… »)
  # gardent leur table `bikes` dédiée (chaînes / cirage).
  def change
    create_table :strava_gears do |t|
      t.references :user, null: false, foreign_key: true
      t.string :gear_id, null: false
      t.string :gear_type, null: false, default: "shoe"
      t.string :name, null: false
      t.timestamps
    end
    add_index :strava_gears, %i[user_id gear_id], unique: true
  end
end
