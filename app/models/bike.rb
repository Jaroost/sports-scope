# Un vélo de l'utilisateur. Provient soit d'un gear Strava (`strava_gear_id`
# renseigné), soit créé automatiquement (« Mon vélo ») quand Strava n'est pas lié.
# Le vélo `is_default` reçoit en plus les km des imports .fit et des sorties Strava
# sans gear. Chaque vélo porte une ou plusieurs chaînes en rotation (cf. Chain /
# ChainMount) — voir ChainWearService pour le calcul d'usure.
class Bike < ApplicationRecord
  MAX_NAME_LEN = 80
  # Date de référence du 1er montage d'une chaîne : volontairement ancienne pour
  # que tout l'historique de km du vélo soit attribué à la chaîne d'origine.
  MOUNT_EPOCH = Time.utc(2000, 1, 1)

  belongs_to :user
  has_many :chains, dependent: :destroy
  has_many :chain_mounts, dependent: :destroy

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }

  # Chaîne actuellement montée = celle du chain_mount le plus récent.
  def mounted_chain
    chain_mounts.order(:mounted_at, :id).last&.chain || chains.order(:id).first
  end

  # Garantit qu'un vélo a au moins une chaîne + son montage initial.
  def ensure_chain!
    return if chains.exists?

    chain = chains.create!(name: "Chaîne 1")
    chain_mounts.create!(chain: chain, mounted_at: MOUNT_EPOCH)
    chain
  end
end
