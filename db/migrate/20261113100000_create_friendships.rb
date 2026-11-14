class CreateFriendships < ActiveRecord::Migration[8.1]
  def change
    # Amitié mutuelle : une ligne par paire, créée « pending » par le demandeur,
    # passée « accepted » par le destinataire.
    create_table :friendships do |t|
      t.references :requester, null: false, foreign_key: { to_table: :users }
      t.references :addressee, null: false, foreign_key: { to_table: :users }
      t.string :status, null: false, default: "pending"
      t.datetime :accepted_at
      t.timestamps
    end
    # Une seule ligne par paire non ordonnée (A→B et B→A sont la même amitié).
    add_index :friendships, "LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)",
              unique: true, name: "index_friendships_on_unordered_pair"

    # Itinéraire partagé explicitement à un ami.
    create_table :route_shares do |t|
      t.references :route, null: false, foreign_key: true
      t.references :user, null: false, foreign_key: true
      t.timestamps
    end
    add_index :route_shares, %i[route_id user_id], unique: true

    # Lien d'invitation personnel.
    add_column :users, :friend_invite_token, :string
    add_index :users, :friend_invite_token, unique: true

    # Visibilité par sortie : NULL = suit `preferences.friends.default_visibility`,
    # true = partagée avec les amis, false = privée.
    add_column :strava_activities, :friends_visible, :boolean
    add_column :imported_activities, :friends_visible, :boolean
  end
end
