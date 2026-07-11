# Un run de backfill des streams Strava (« tout télécharger d'un coup »).
# Résumable par conception : la sélection des activités à traiter repose sur
# `StravaActivity#streams_pending`, donc relancer un run reprend là où il en était.
class StravaBackfillRun < ApplicationRecord
  belongs_to :user

  STATUSES = %w[pending running rate_limited completed failed].freeze
  ACTIVE_STATUSES = %w[pending running rate_limited].freeze

  validates :status, inclusion: { in: STATUSES }

  scope :active, -> { where(status: ACTIVE_STATUSES) }

  # Un run qu'on peut (ré)enfiler sans risquer de doubler un job déjà en cours :
  # pas encore démarré, échoué, ou rate-limité dont la fenêtre est écoulée (utile
  # après un redémarrage qui aurait perdu le job planifié en mémoire).
  def resumable?
    status == "pending" || status == "failed" ||
      (status == "rate_limited" && rate_limited_until.present? && rate_limited_until.past?)
  end
end
