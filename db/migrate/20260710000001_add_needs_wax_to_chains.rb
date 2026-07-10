# Permet de marquer une chaîne « à recirer » manuellement, sans attendre que les km
# parcourus atteignent son seuil. Remis à false dès que la chaîne est cirée.
class AddNeedsWaxToChains < ActiveRecord::Migration[8.1]
  def change
    add_column :chains, :needs_wax, :boolean, default: false, null: false
  end
end
