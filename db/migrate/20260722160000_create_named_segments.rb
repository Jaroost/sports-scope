# Nom donné par l'utilisateur à un segment découvert automatiquement
# (`SegmentMatcher`). Les segments n'existent pas en base : ils sont redécouverts à
# chaque analyse d'activité. Ce qui est stocké ici, c'est donc le CHEMIN lui-même
# (la suite de cellules `TrackFingerprint` du segment) plus son nom — de sorte qu'un
# segment nommé depuis une sortie soit reconnu dans toutes les autres.
class CreateNamedSegments < ActiveRecord::Migration[8.1]
  def change
    create_table :named_segments do |t|
      t.references :user, null: false, foreign_key: true
      t.string :name, null: false
      t.jsonb :cells, default: [], null: false
      t.jsonb :coarse, default: [], null: false
      t.float :distance_m
      t.timestamps
    end

    # Préfiltre : on ne compare un segment découvert qu'aux segments nommés passés
    # dans la même zone (même rôle que l'index sur `track_cells->'coarse'`).
    add_index :named_segments, :coarse, using: :gin
  end
end
