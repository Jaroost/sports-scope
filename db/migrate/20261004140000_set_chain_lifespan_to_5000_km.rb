# La durée de vie d'une chaîne est de 5000 km. La migration qui a généralisé les
# pièces avait recopié le seuil de cirage (300 km) dans le seuil d'usure des
# chaînes existantes : on les remet à la durée de vie, sans toucher à celles dont
# le seuil d'usure a été réglé à la main (différent du seuil de cirage).
class SetChainLifespanTo5000Km < ActiveRecord::Migration[8.1]
  def up
    execute <<~SQL
      UPDATE part_types SET default_wear_threshold_km = 5000, updated_at = now()
      WHERE key = 'chain' AND user_id IS NULL;

      UPDATE parts SET wear_threshold_km = 5000, updated_at = now()
      WHERE part_type_id IN (SELECT id FROM part_types WHERE key = 'chain')
        AND wear_threshold_km = wax_threshold_km;
    SQL
  end

  def down
    raise ActiveRecord::IrreversibleMigration
  end
end
