# Ajoute 2 types de pièce globaux : plaquette de frein et disque de frein — plus
# précis que le "Frein hydraulique" existant (usures très différentes : quelques
# milliers de km pour des plaquettes, bien plus pour un disque).
class AddBrakePadAndDiscPartTypes < ActiveRecord::Migration[8.1]
  def up
    execute <<~SQL
      INSERT INTO part_types (key, default_wear_threshold_km, created_at, updated_at) VALUES
        ('brake_pad', 2500, now(), now()),
        ('brake_disc', 15000, now(), now());
    SQL
  end

  def down
    execute "DELETE FROM part_types WHERE key IN ('brake_pad', 'brake_disc') AND user_id IS NULL"
  end
end
