class AddPositionToPlannedRides < ActiveRecord::Migration[8.1]
  def change
    # Ordre choisi par l'utilisateur à l'intérieur d'un même jour : pilote l'affichage
    # ET l'appariement « réalisé » (les N premiers plans du jour, N = nb de sorties).
    # Défaut 0 : les plans existants gardent l'ordre par id tant qu'on ne les réordonne pas.
    add_column :planned_rides, :position, :integer, null: false, default: 0
  end
end
