class CreateChainMounts < ActiveRecord::Migration[8.1]
  # Journal des montages de chaîne : un vélo n'a qu'une chaîne montée à la fois
  # (rotation). La chaîne actuellement montée = celle du chain_mount le plus récent.
  # On s'en sert pour n'attribuer les km qu'à la chaîne montée à chaque sortie.
  def change
    create_table :chain_mounts do |t|
      t.references :bike,  null: false, foreign_key: true
      t.references :chain, null: false, foreign_key: true
      t.datetime :mounted_at, null: false

      t.timestamps
    end
    add_index :chain_mounts, [:bike_id, :mounted_at]
  end
end
