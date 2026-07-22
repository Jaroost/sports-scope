# Un run de backfill des streams Strava (« tout télécharger d'un coup »).
# Résumable par conception : la sélection des activités à traiter repose sur
# `StravaActivity#streams_pending`, donc relancer un run reprend là où il en était.
class StravaBackfillRun < ApplicationRecord
  belongs_to :user

  STATUSES = %w[pending running rate_limited completed failed].freeze
  ACTIVE_STATUSES = %w[pending running rate_limited].freeze
  KINDS = %w[streams device].freeze

  validates :status, inclusion: { in: STATUSES }
  validates :kind, inclusion: { in: KINDS }

  scope :active, -> { where(status: ACTIVE_STATUSES) }
  scope :streams, -> { where(kind: "streams") }
  scope :device, -> { where(kind: "device") }

  # Un run « en cours » qui n'a pas avancé depuis un moment : son job a très
  # probablement été perdu (adapter async + reload/redémarrage qui vide le pool de
  # threads en mémoire). Un lot s'exécute en bien moins d'une minute, donc au-delà
  # de ce délai on considère la continuation perdue et le run relançable — sans
  # risquer de doubler un job réellement actif.
  STALL_AFTER = 3.minutes

  def stalled?
    status == "running" && updated_at < STALL_AFTER.ago
  end

  # Un run qu'on peut (ré)enfiler sans risquer de doubler un job déjà en cours :
  # pas encore démarré, échoué, rate-limité dont la fenêtre est écoulée, ou « en
  # cours » mais bloqué (job perdu) — utile après un redémarrage qui aurait perdu
  # le job planifié en mémoire.
  def resumable?
    status == "pending" || status == "failed" || stalled? ||
      (status == "rate_limited" && rate_limited_until.present? && rate_limited_until.past?)
  end
end
