# Certains types (pneu, roue, plaquette et disque de frein) peuvent avoir plusieurs
# pièces montées EN MÊME TEMPS sur un vélo (avant/arrière) — contrairement à la
# chaîne, où monter une pièce en démonte implicitement une autre du même type.
#
# Jusqu'ici, un montage était implicitement clos par le montage suivant de la MÊME
# pièce ou d'une pièce du même type (cf. l'ancien PartWearService#segments_for) : un
# seul montage ouvert par type. On rend ça explicite avec `unmounted_at`, pour
# pouvoir avoir plusieurs montages ouverts simultanément sur un même type quand
# `allow_multiple_mounted` l'autorise.
class SupportMultipleMountedParts < ActiveRecord::Migration[8.1]
  def up
    add_column :part_mounts, :unmounted_at, :datetime
    add_column :part_types, :allow_multiple_mounted, :boolean, null: false, default: false

    PartType.reset_column_information
    PartType.where(key: %w[tire wheel brake_pad brake_disc]).update_all(allow_multiple_mounted: true)

    # Backfill : referme chaque montage existant à la date du montage suivant du
    # même type sur le même vélo (comportement implicite d'avant cette migration),
    # le dernier de chaque groupe restant ouvert (unmounted_at nil).
    PartMount.reset_column_information
    PartMount.includes(:part).to_a.group_by { |m| [m.bike_id, m.part.part_type_id] }.each_value do |mounts|
      mounts.sort_by(&:mounted_at).each_cons(2) { |current, nxt| current.update_column(:unmounted_at, nxt.mounted_at) }
    end
  end

  def down
    remove_column :part_mounts, :unmounted_at
    remove_column :part_types, :allow_multiple_mounted
  end
end
