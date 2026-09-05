# Généralise le suivi de cirage de chaîne (Chain/ChainMount) en suivi d'usure de
# n'importe quel composant (Part/PartMount), typé via un petit catalogue PartType :
# 6 types globaux pré-remplis + les types custom que chaque utilisateur peut créer.
# Voir /home/user/.claude/plans/generic-zooming-emerson.md pour le contexte complet.
class GeneralizeChainToPart < ActiveRecord::Migration[8.1]
  def up
    rename_table :chains, :parts
    rename_table :chain_mounts, :part_mounts
    rename_column :part_mounts, :chain_id, :part_id

    create_table :part_types do |t|
      t.references :user, null: true, foreign_key: true
      t.string :key
      t.string :name
      t.integer :default_wear_threshold_km, null: false
      t.timestamps
    end
    add_index :part_types, [:user_id, :name], unique: true

    execute <<~SQL
      INSERT INTO part_types (key, default_wear_threshold_km, created_at, updated_at) VALUES
        ('tire', 4000, now(), now()),
        ('wheel', 15000, now(), now()),
        ('crankset', 20000, now(), now()),
        ('cassette', 6000, now(), now()),
        ('chain', 3000, now(), now()),
        ('hydraulic_brake', 10000, now(), now());
    SQL

    add_reference :parts, :part_type, null: true, foreign_key: true
    execute "UPDATE parts SET part_type_id = (SELECT id FROM part_types WHERE key = 'chain')"
    change_column_null :parts, :part_type_id, false

    add_column :parts, :wear_threshold_km, :integer, null: false, default: 3000
    execute "UPDATE parts SET wear_threshold_km = wax_threshold_km"
  end

  def down
    remove_column :parts, :wear_threshold_km
    remove_reference :parts, :part_type, foreign_key: true
    drop_table :part_types

    rename_column :part_mounts, :part_id, :chain_id
    rename_table :part_mounts, :chain_mounts
    rename_table :parts, :chains
  end
end
