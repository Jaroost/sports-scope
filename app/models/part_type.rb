# Catalogue des types de pièce trackables sur un vélo. Les types globaux (`key`
# renseignée, `user_id` nil) sont pré-remplis en migration (pneu, roue, pédalier,
# cassette, chaîne, frein hydraulique) et partagés par tous les utilisateurs ; leur
# libellé/icône viennent du code (BUILTIN_ICONS + i18n `parts.types.<key>`), jamais
# de `name`. Un type custom (`key` nil) appartient à un seul utilisateur, avec un
# `name` libre tapé par lui — renommer ce type se répercute sur toutes ses pièces.
class PartType < ApplicationRecord
  MAX_NAME_LEN = 40

  BUILTIN_ICONS = {
    "tire" => "fa-circle-notch",
    "wheel" => "fa-record-vinyl",
    "crankset" => "fa-gear",
    "cassette" => "fa-layer-group",
    "chain" => "fa-link",
    "hydraulic_brake" => "fa-hand"
  }.freeze
  CUSTOM_ICON = "fa-gear".freeze

  belongs_to :user, optional: true
  has_many :parts, dependent: :restrict_with_error

  validates :name, presence: true, length: { maximum: MAX_NAME_LEN }, if: -> { key.blank? }
  validates :name, uniqueness: { scope: :user_id }, if: -> { key.blank? }
  validates :default_wear_threshold_km, numericality: { greater_than: 0 }

  scope :available_for, ->(user) { where(user_id: nil).or(where(user_id: user.id)).order(:id) }

  def builtin? = key.present?

  def icon
    key.present? ? BUILTIN_ICONS.fetch(key, CUSTOM_ICON) : CUSTOM_ICON
  end
end
