class CreateRoutingProfiles < ActiveRecord::Migration[8.1]
  def change
    # Profils de routage BRouter personnalisés (profil de base + surcharges de variables,
    # sérialisés en « spec », cf. RoutingProfileSpec).
    create_table :routing_profiles do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false
      t.string :spec, null: false
      t.string :sport, null: false, default: "cycling"
      t.timestamps
    end
    add_index :routing_profiles, %i[user_id name], unique: true
  end
end
