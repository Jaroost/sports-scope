# Extrait en tâche de fond les localités traversées par une activité Strava et les
# stocke dans `strava_activities.localities` (recherche par lieu). Enfilé par
# StravaActivity quand le tracé du résumé change — l'appel Overpass ne doit pas
# ralentir la synchronisation, qui enregistre des activités par lots de 200.
class ExtractActivityLocalitiesJob < ApplicationJob
  queue_as :default

  # Overpass est régulièrement saturé (429 / 504). On retente en espaçant, plutôt
  # que de laisser l'activité sans lieux jusqu'à sa prochaine synchro — un résumé
  # déjà stocké ne rechange plus, donc sans retry elle resterait introuvable à la
  # recherche (le backfill, idempotent, permet de rattraper).
  retry_on OverpassClient::Error, wait: :polynomially_longer, attempts: 5 do |job, error|
    Rails.logger.warn(
      "ExtractActivityLocalitiesJob: abandon après #{job.executions} tentatives " \
      "(strava_activity=#{job.arguments.first}) — #{error.message}",
    )
  end

  def perform(strava_activity_id)
    activity = StravaActivity.find_by(id: strava_activity_id)
    return if activity.nil?

    geometry = activity.map_polyline
    # Pas de tracé exploitable (indoor, GPS absent) : on écrit `[]` plutôt que de
    # laisser NULL, pour que l'activité sorte du périmètre du backfill.
    localities = geometry ? LocalitiesExtractor.new(geometry).call : []

    # update_column : pas de callbacks (sinon on ré-enfilerait ce job) et pas de
    # bump d'`updated_at` — `cached_at` de la liste s'appuie dessus, une extraction
    # de fond ne doit pas faire croire à une synchro Strava.
    activity.update_column(:localities, localities)
  end
end
