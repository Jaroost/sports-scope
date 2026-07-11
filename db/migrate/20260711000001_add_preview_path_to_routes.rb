class AddPreviewPathToRoutes < ActiveRecord::Migration[8.1]
  # Colonne introduite puis remplacée par `preview_segments` (aperçu coloré par
  # pente) dans une migration ultérieure — on se contente ici d'ajouter la
  # colonne, le backfill se fait dans la migration qui la remplace.
  def change
    add_column :routes, :preview_path, :text
  end
end
