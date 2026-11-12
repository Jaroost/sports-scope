# Envoie une activité importée à Strava puis suit le traitement jusqu'à obtenir
# l'`activity_id` (ou une erreur). Strava traite l'upload en asynchrone : on
# se ré-enfile toutes les quelques secondes plutôt que de bloquer un worker.
class StravaUploadJob < ApplicationJob
  queue_as :default

  POLL_EVERY = 5.seconds
  MAX_POLLS = 24 # ~2 min, au-delà on abandonne (« pending » reste relançable)

  def perform(activity_id, polls = 0)
    activity = ImportedActivity.find_by(id: activity_id)
    return if activity.nil? || activity.strava_upload_status.in?(%w[done duplicate])

    uploader = StravaUploader.new(activity.user)
    result = activity.strava_upload_id ? uploader.status(activity.strava_upload_id) : uploader.create(activity)
    activity.apply_strava_upload!(result)

    return unless activity.strava_upload_status == "pending"
    return activity.update!(strava_upload_status: "error", strava_upload_error: "timeout") if polls >= MAX_POLLS

    self.class.set(wait: POLL_EVERY).perform_later(activity.id, polls + 1)
  rescue StravaUploader::ApiError => e
    if e.rate_limited?
      self.class.set(wait: 15.minutes).perform_later(activity_id, polls)
    else
      activity&.update!(strava_upload_status: "error", strava_upload_error: "http_#{e.status}")
    end
  end
end
