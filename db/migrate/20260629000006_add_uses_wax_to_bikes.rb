class AddUsesWaxToBikes < ActiveRecord::Migration[8.1]
  # Permet d'indiquer qu'un vélo n'a pas de chaîne cirée : on n'affiche alors pas de
  # barre de progression pour ce vélo (ni sur le tableau de bord, ni sur /chains).
  def change
    add_column :bikes, :uses_wax, :boolean, null: false, default: true
  end
end
