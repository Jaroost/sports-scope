# Enfile l'extraction des lieux (`routes.localities`) pour les itinéraires qui n'en
# ont pas encore — typiquement ceux créés avant l'ajout de la recherche par lieu.
# Chaque itinéraire = un appel Overpass, on passe donc par le job (retries + espacement)
# plutôt que d'extraire en ligne.
module RouteLocalitiesBackfill
  module_function

  # Renvoie le nombre d'itinéraires enfilés. Idempotent : ne reprend que ceux dont
  # `localities` est encore vide, donc relançable sans re-taper Overpass pour les
  # itinéraires déjà traités.
  def run!
    scope = Route.where("routes.localities = '[]'::jsonb")
    scope.find_each { |route| ExtractRouteLocalitiesJob.perform_later(route.id) }
    scope.count
  end
end
