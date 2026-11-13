# Source unique de la règle « un ami peut-il voir ça ? ». Toute action qui expose à un
# ami une sortie ou un itinéraire d'autrui passe par ici — jamais de scope maison.
#
# Sorties : visibles par les amis (amitié acceptée) quand `friends_visible` vaut true,
# ou quand il est NULL et que le propriétaire a réglé « amis » comme défaut
# (`preferences.friends.default_visibility`). `false` = privée, quoi qu'en dise le défaut.
# Une sortie `ignored` (copie Strava d'un import, écartée par l'utilisateur) n'est jamais
# montrée : elle doublonnerait la vraie.
#
# Itinéraires : visibles quand le propriétaire les a partagés explicitement (RouteShare).
module FriendVisibility
  SOURCES = { "strava" => StravaActivity, "imported" => ImportedActivity }.freeze

  module_function

  # Relation des sorties de `owner` visibles pour `viewer` ; vide si pas amis.
  def activities(model, owner, viewer)
    return model.none unless viewer&.friends_with?(owner)

    scope = model.where(user_id: owner.id)
    scope = scope.where(ignored: false) if model.column_names.include?("ignored")
    if owner.friends_default_visibility == "friends"
      scope.where(friends_visible: [true, nil])
    else
      scope.where(friends_visible: true)
    end
  end

  def activity(source, owner, viewer, id)
    model = SOURCES[source] or return nil
    activities(model, owner, viewer).find_by(id: id)
  end

  # Itinéraires de `owner` partagés avec `viewer`.
  def routes(owner, viewer)
    return Route.none unless viewer&.friends_with?(owner)

    Route.where(user_id: owner.id, id: RouteShare.where(user_id: viewer.id).select(:route_id))
  end
end
