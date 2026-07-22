# Suit une opération de « tout télécharger » des streams Strava d'un utilisateur.
# Une ligne = un run résumable. `total` est figé à la création (nombre d'activités
# sans streams à ce moment) ; la progression se calcule en direct (total − restant)
# côté lecture, ce qui reste juste même si le process est redémarré en cours de route.
class CreateStravaBackfillRuns < ActiveRecord::Migration[8.1]
  def change
    create_table :strava_backfill_runs do |t|
      t.references :user, null: false, foreign_key: true
      t.string :status, null: false, default: "pending"
      t.integer :total, null: false, default: 0
      t.datetime :rate_limited_until
      t.string :last_error
      t.timestamps
    end
    add_index :strava_backfill_runs, %i[user_id status]
  end
end
