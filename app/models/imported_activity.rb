class ImportedActivity < ApplicationRecord
  include Activityable

  belongs_to :user

  validates :name, presence: true, length: { maximum: 120 }
  validates :source, presence: true

  # Envoi vers Strava (cf. `StravaUploader` / `StravaUploadJob`). États : pending (en
  # cours de traitement chez Strava), done, duplicate (Strava la connaissait déjà :
  # `strava_activity_id` pointe alors sur l'existante) et error.
  def strava_uploaded?
    strava_upload_status.in?(%w[done duplicate])
  end

  # Applique une réponse de `/uploads`. Un doublon est un succès : l'activité existe.
  def apply_strava_upload!(result)
    attrs = { strava_upload_id: result["id"] || strava_upload_id }
    error = result["error"].to_s
    if result["activity_id"].present?
      attrs.merge!(strava_activity_id: result["activity_id"], strava_upload_status: "done",
                   strava_upload_error: nil, strava_uploaded_at: Time.current)
    elsif (dup = error[/duplicate of activity (\d+)/i, 1])
      attrs.merge!(strava_activity_id: dup.to_i, strava_upload_status: "duplicate",
                   strava_upload_error: nil, strava_uploaded_at: Time.current)
    elsif error.present?
      attrs.merge!(strava_upload_status: "error", strava_upload_error: error.first(255))
    else
      attrs.merge!(strava_upload_status: "pending", strava_upload_error: nil)
    end
    update!(attrs)
    ignore_strava_copy!
  end

  # L'activité envoyée revient du prochain sync comme `strava_activity` : on écarte
  # cette copie des calculs (charge, seuils, records) pour ne pas compter la sortie deux fois.
  def ignore_strava_copy!
    return unless strava_activity_id

    user.strava_activities.where(strava_id: strava_activity_id, ignored: false)
        .update_all(ignored: true, updated_at: Time.current)
  end
end
