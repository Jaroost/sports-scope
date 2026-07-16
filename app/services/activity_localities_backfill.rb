# Enfile l'extraction des lieux (`strava_activities.localities`) pour les activités
# qui n'en ont pas encore — typiquement celles synchronisées avant l'ajout de la
# recherche par lieu. Chaque activité = un appel Overpass : on passe par le job
# (retries + espacement) plutôt que d'extraire en ligne.
#
# Un historique Strava complet se compte en milliers d'activités, soit autant
# d'appels à une instance Overpass publique. D'où `limit:` : le backfill se fait par
# tranches (relançable, idempotent) plutôt qu'en une rafale qui se ferait limiter.
module ActivityLocalitiesBackfill
  module_function

  DEFAULT_LIMIT = 200

  # Renvoie le nombre d'activités enfilées. Idempotent : ne reprend que celles dont
  # `localities` est NULL (jamais extrait), donc relançable jusqu'à ce qu'il renvoie
  # 0 sans re-taper Overpass pour les activités déjà traitées — y compris celles
  # dont l'extraction n'a rendu aucune localité (`[]`).
  def run!(user: nil, limit: DEFAULT_LIMIT)
    scope = pending_scope(user)
    scope = scope.limit(limit) if limit
    ids = scope.pluck(:id)
    ids.each { |id| ExtractActivityLocalitiesJob.perform_later(id) }
    ids.size
  end

  # Activités restant à traiter (sans les tranches) — pour suivre l'avancement.
  def pending_count(user: nil)
    pending_scope(user).count
  end

  def pending_scope(user)
    scope = user ? user.strava_activities : StravaActivity.all
    # Les activités sans tracé (indoor, GPS absent) n'ont aucun lieu à extraire :
    # les écarter ici évite d'enfiler des milliers de jobs qui ne feraient rien —
    # et surtout de les réenfiler à chaque tranche, `localities` restant NULL.
    scope
      .where(localities: nil)
      .where("strava_activities.raw #>> '{map,summary_polyline}' <> ''")
      .order(started_at: :desc)
  end
end
