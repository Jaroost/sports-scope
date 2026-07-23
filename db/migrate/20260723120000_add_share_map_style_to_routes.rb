class AddShareMapStyleToRoutes < ActiveRecord::Migration[8.1]
  # Fond de carte imposé aux destinataires du lien de partage (vue en lecture seule
  # et aperçu de la page de partage). Nullable : `nil` = pas de consigne, chaque
  # visiteur voit son propre fond par défaut — comportement d'avant cette colonne,
  # donc celui des itinéraires existants.
  def change
    add_column :routes, :share_map_style, :string
  end
end
