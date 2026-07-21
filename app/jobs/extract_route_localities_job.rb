# Extrait en tâche de fond les localités traversées par un itinéraire et les stocke
# dans `routes.localities` (recherche par lieu). Enfilé par Route quand la géométrie
# change — l'extraction ne doit pas ralentir la sauvegarde.
class ExtractRouteLocalitiesJob < ApplicationJob
  queue_as :default

  # Seul échec attendu : le catalogue OSM local n'est pas encore là (première
  # synchro de `poi-sync`). On retente plutôt que de laisser l'itinéraire sans
  # lieux jusqu'à sa prochaine édition. Une fois les tentatives épuisées on log :
  # sans ça, l'itinéraire reste introuvable à la recherche sans aucune trace (le
  # backfill, idempotent, permet de rattraper).
  retry_on ActiveRecord::ConnectionNotEstablished, ActiveRecord::NoDatabaseError,
           ActiveRecord::StatementInvalid,
           wait: :polynomially_longer, attempts: 5 do |job, error|
    Rails.logger.warn(
      "ExtractRouteLocalitiesJob: abandon après #{job.executions} tentatives " \
      "(route=#{job.arguments.first}) — #{error.message}",
    )
  end

  def perform(route_id)
    route = Route.find_by(id: route_id)
    return if route.nil?

    localities = LocalitiesExtractor.new(route.geometry).call

    # update_column : pas de callbacks (sinon on ré-enfilerait ce job), pas de
    # bump d'`updated_at` — la liste des itinéraires est triée dessus et une
    # extraction de fond ne doit pas faire remonter un itinéraire non modifié.
    route.update_column(:localities, localities)
  end
end
