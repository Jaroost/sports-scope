# Enfile l'extraction des lieux (`routes.localities`) pour les itinéraires qui n'en
# ont pas encore — typiquement ceux créés avant l'ajout de la recherche par lieu.
# Chaque itinéraire = une requête sur le catalogue OSM local, on passe par le job
# plutôt que d'extraire en ligne.
module RouteLocalitiesBackfill
  module_function

  # Renvoie le nombre d'itinéraires enfilés. Idempotent : ne reprend que ceux dont
  # `localities` est encore vide, donc relançable sans réextraire les itinéraires
  # déjà traités.
  def run!
    scope = Route.where("routes.localities = '[]'::jsonb")
    scope.find_each { |route| ExtractRouteLocalitiesJob.perform_later(route.id) }
    scope.count
  end
end
