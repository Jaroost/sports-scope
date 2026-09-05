# Un vélo de l'utilisateur. Provient soit d'un gear Strava (`strava_gear_id`
# renseigné), soit créé automatiquement (« Mon vélo ») quand Strava n'est pas lié.
# Le vélo `is_default` reçoit en plus les km des imports .fit et des sorties Strava
# sans gear. Chaque vélo porte une ou plusieurs pièces en rotation par type (cf.
# Part / PartMount / PartType) — voir PartWearService pour le calcul d'usure.
class Bike < ApplicationRecord
  MAX_NAME_LEN = 80
  # Date de référence du 1er montage d'une chaîne : volontairement ancienne pour
  # que tout l'historique de km du vélo soit attribué à la chaîne d'origine.
  MOUNT_EPOCH = Time.utc(2000, 1, 1)

  belongs_to :user
  has_many :parts, dependent: :destroy
  has_many :part_mounts, dependent: :destroy

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }

  # Garantit qu'un vélo a au moins une chaîne + son montage initial.
  def ensure_chain!
    chain_type = PartType.find_by!(key: "chain")
    return if parts.exists?(part_type_id: chain_type.id)

    chain = parts.create!(name: "Chaîne 1", part_type: chain_type, wear_threshold_km: chain_type.default_wear_threshold_km)
    part_mounts.create!(part: chain, mounted_at: MOUNT_EPOCH)
    chain
  end
end
