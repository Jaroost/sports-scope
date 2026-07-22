# Recalcule les lieux traversés (`routes.localities` / `strava_activities.localities`)
# en masse, pour la recherche par lieu.
#
# Deux usages, un seul chemin de code (`only_missing:`) :
#   - combler les trous (défaut) : itinéraires / activités jamais traités, ou dont
#     l'extraction avait échoué. Idempotent, relançable.
#   - tout recalculer (`only_missing: false`) : après un changement de couverture
#     OSM (OSM_POI_REGIONS), de seuil (LocalitiesExtractor::THRESHOLD_M) ou de
#     source de données. Les lieux déjà stockés sont réécrits.
#
# L'extraction est faite **en ligne**, pas via ExtractLocalitiesJob : depuis le
# passage au catalogue OSM local, chaque enregistrement n'est plus qu'une requête
# SQL et un calcul de proximité (quelques dizaines de ms). Enfiler des milliers de
# jobs coûterait plus cher que de les traiter, et l'adaptateur ActiveJob par défaut
# les perdrait au premier redémarrage. Les jobs restent le chemin automatique, à
# l'unité, quand un tracé change.
module LocalitiesBackfill
  module_function

  BATCH_SIZE = 100

  # Recalcule itinéraires puis activités. Renvoie
  # `{ routes: {...}, activities: {...} }` (compteurs de #routes / #activities).
  def all(user: nil, only_missing: true, limit: nil, &progress)
    {
      routes: routes(user: user, only_missing: only_missing, limit: limit, &progress),
      activities: activities(user: user, only_missing: only_missing, limit: limit, &progress),
    }
  end

  # Itinéraires. Renvoie `{ processed:, located:, failed: }` — `located` = ceux
  # pour lesquels au moins un lieu a été trouvé.
  def routes(user: nil, only_missing: true, limit: nil, &progress)
    scope = user ? user.routes : Route.all
    # `localities` est un jsonb non nul par défaut : « jamais traité » s'y lit `[]`.
    scope = scope.where("routes.localities = '[]'::jsonb") if only_missing

    process(scope, "routes", limit, progress) do |route|
      LocalitiesExtractor.new(route.geometry).call
    end
  end

  # Activités Strava. Les activités sans tracé (indoor, GPS absent) sont écartées :
  # elles n'ont aucun lieu à extraire.
  def activities(user: nil, only_missing: true, limit: nil, &progress)
    scope = user ? user.strava_activities : StravaActivity.all
    scope = scope.where("strava_activities.raw #>> '{map,summary_polyline}' <> ''")
    # Ici « jamais traité » se lit NULL — `[]` signifie « traité, aucun lieu ».
    scope = scope.where(localities: nil) if only_missing

    process(scope, "activities", limit, progress) do |activity|
      geometry = activity.map_polyline
      geometry ? LocalitiesExtractor.new(geometry).call : []
    end
  end

  # Nombre d'enregistrements que traiterait un `only_missing: true` — pour suivre
  # l'avancement sans rien modifier.
  def pending_counts(user: nil)
    {
      routes: (user ? user.routes : Route.all).where("routes.localities = '[]'::jsonb").count,
      activities: (user ? user.strava_activities : StravaActivity.all)
        .where("strava_activities.raw #>> '{map,summary_polyline}' <> ''")
        .where(localities: nil).count,
    }
  end

  # Parcourt le scope par lots et écrit le résultat de `extract`.
  #
  # update_column : pas de callbacks (sinon on ré-enfilerait le job d'extraction) et
  # pas de bump d'`updated_at` — la liste des itinéraires est triée dessus et
  # `cached_at` des activités s'y appuie ; un recalcul de fond ne doit pas faire
  # remonter un enregistrement non modifié.
  def process(scope, label, limit, progress)
    # Les identifiants sont figés d'entrée : on écrit dans `localities`, c'est-à-dire
    # dans la colonne même sur laquelle filtre `only_missing`. Paginer en direct
    # ferait glisser le curseur sous nos pieds.
    ids = scope.reorder(:id).limit(limit).pluck(:id)
    total = ids.size
    processed = located = failed = 0

    ids.each_slice(BATCH_SIZE) do |slice|
      scope.klass.where(id: slice).each do |record|
        begin
          localities = yield(record)
          record.update_column(:localities, localities)
          located += 1 if localities.any?
        rescue ActiveRecord::ConnectionNotEstablished, ActiveRecord::NoDatabaseError,
               ActiveRecord::StatementInvalid => e
          # Catalogue OSM absent ou injoignable : l'échec est systémique, pas propre
          # à cet enregistrement. Inutile de brûler le reste du lot.
          raise e.class, "catalogue OSM indisponible (#{e.message}) — #{processed}/#{total} #{label} traité(s)"
        rescue => e
          failed += 1
          Rails.logger.warn("LocalitiesBackfill(#{label}) #{record.id}: #{e.class}: #{e.message}")
        end

        processed += 1
        progress&.call(label, processed, total)
      end
    end

    { processed: processed, located: located, failed: failed }
  end
  private_class_method :process
end
