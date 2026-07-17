class CreatePlannedRides < ActiveRecord::Migration[8.1]
  def change
    create_table :planned_rides do |t|
      t.references :user, null: false, foreign_key: true
      t.references :route, null: false, foreign_key: true
      t.date :planned_on, null: false
      t.timestamps
    end

    # Lecture principale : les plans d'une semaine donnée, pour un utilisateur.
    add_index :planned_rides, %i[user_id planned_on]

    # Un même itinéraire ne se planifie qu'une fois par jour : sans ça, un double
    # clic sur « planifier » compterait la sortie deux fois dans la barre.
    add_index :planned_rides, %i[user_id route_id planned_on], unique: true
  end
end
