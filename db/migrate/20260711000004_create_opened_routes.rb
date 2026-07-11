class CreateOpenedRoutes < ActiveRecord::Migration[8.1]
  # Trace les itinéraires d'autrui qu'un utilisateur connecté a ouverts via un lien
  # partagé (GET /api/routes/shared/:token). Sert à proposer, dans le sélecteur
  # d'itinéraire de la navigation, une catégorie « récemment ouverts » à côté de
  # « mes itinéraires ». Une seule ligne par (utilisateur, itinéraire) ; on remet
  # `last_opened_at` à jour à chaque réouverture.
  def change
    create_table :opened_routes do |t|
      t.references :user, null: false, foreign_key: true
      t.references :route, null: false, foreign_key: true
      t.datetime :last_opened_at, null: false
      t.timestamps
    end

    add_index :opened_routes, %i[user_id route_id], unique: true
    add_index :opened_routes, %i[user_id last_opened_at]
  end
end
