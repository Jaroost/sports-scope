class StravaController < ApplicationController
  before_action :require_login!
  before_action :ensure_strava_linked!

  ACTIVITIES_TTL = 1.day
  # Longueur max du terme de recherche (nom / lieu), alignée sur celle des
  # itinéraires : au-delà ce n'est plus un nom de sortie ni de localité.
  MAX_SEARCH_LEN = 80
  DEFAULT_PER_PAGE = 50
  MAX_PER_PAGE = 200
  # Plafond de tracés renvoyés à la carte d'ensemble : au-delà, le rendu MapLibre
  # de milliers de polylignes devient lourd — on garde les plus récentes du filtre.
  MAX_MAP_ACTIVITIES = 500
  # Mots-clés par catégorie de sport, repris tels quels de `PerformanceRecords` :
  # les deux pages doivent regrouper les `activity_type` de la même façon, sinon un
  # lien depuis l'analyse de performance ne retomberait pas sur les mêmes sorties.
  SPORT_CATEGORY_KEYWORDS = PerformanceRecords::SPORT_MATCHERS.to_h.freeze

  # Serves the user's activities straight from `strava_activities`. The first
  # visit (empty table) triggers a full sync; `?refresh=1` runs an incremental
  # sync to pull anything new since the last stored activity.
  def activities
    if current_user.strava_activities.none? || params[:refresh].present?
      StravaRefreshService.new(current_user).sync_summaries
    end

    return render json: activities_map_payload if params[:map].present?

    scope = filtered_activities_scope
    filtered_total = scope.count
    per_page = activities_per_page
    total_pages = filtered_total.zero? ? 0 : (filtered_total.to_f / per_page).ceil
    # Page bornée à [1, total_pages] pour éviter un offset au-delà des données.
    page = params[:page].to_i
    page = 1 if page < 1
    page = total_pages if total_pages.positive? && page > total_pages

    records = scope.order(started_at: :desc).offset((page - 1) * per_page).limit(per_page)
    # TSS par sortie (charge d'entraînement) calculé en une passe, mêmes seuils que
    # la charge d'entraînement (FTP variable, LTHR).
    tss_map = TrainingLoad.tss_by_activity(current_user)
    sport_types = current_user.strava_activities.distinct.pluck(:activity_type).compact.sort
    render json: {
      total: current_user.strava_activities.count,
      filtered_total: filtered_total,
      page: page,
      per_page: per_page,
      total_pages: total_pages,
      # Liste des types de sport présents dans TOUT l'historique (pas seulement la
      # page courante) pour alimenter le menu déroulant du filtre.
      sports: sport_types,
      # Catégories présentes dans l'historique (mêmes regroupements que la page
      # performance) — le menu du filtre propose les deux granularités.
      sport_categories: sport_types.map { |t| PerformanceRecords.sport_category(t) }.uniq.sort,
      # Matériel (vélos + chaussures) référencé par au moins une activité, pour le
      # menu du filtre. Chaque entrée porte son `type` (bike/shoe) pour le groupement.
      gears: available_gears,
      # Matériel d'enregistrement présent dans l'historique (device_name).
      devices: available_devices,
      activities: records.map { |a| summary_json(a, tss: tss_map[['strava', a.strava_id.to_s]]) }
    }
  rescue StravaSyncService::StravaApiError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # POST /strava/sync — force a (re)synchronisation of activity summaries.
  # `?full=1` re-paginates the whole history; otherwise it's incremental.
  def sync
    before = current_user.strava_activities.count
    count = StravaRefreshService.new(current_user).sync_summaries(full: params[:full].present?)
    total = current_user.strava_activities.count
    # `synced` compte aussi le ré-upsert de l'activité de chevauchement (OVERLAP) ;
    # `created` = vraies nouvelles activités (diff du total), fiable pour l'UI.
    render json: { synced: count, created: [total - before, 0].max, total: total }
  rescue StravaSyncService::StravaApiError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  def show
    id = params[:id]
    cache_key = "strava:activity:#{current_user.id}:#{id}"
    Rails.cache.delete(cache_key) if params[:refresh].present?

    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      activity = strava_get("https://www.strava.com/api/v3/activities/#{id}")
      { cached_at: Time.current.iso8601, activity: activity }
    end

    # Capture opportuniste du matériel d'enregistrement : le détail est déjà là, on
    # renseigne `device_name` pour le filtre sans coût API supplémentaire.
    capture_device_name(id, payload[:activity])

    # TSS ajouté hors cache : il dépend de seuils modifiables (FTP, LTHR) et se
    # recalcule à chaque lecture, contrairement au résumé Strava mis en cache.
    render json: with_activity_tss(payload, 'strava', id)
  rescue StravaApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
  end

  def streams
    id = params[:id]
    activity = current_user.strava_activities.find_by(strava_id: id)

    # Sert les streams persistés dès qu'on les a déjà récupérés (consultation
    # antérieure ou backfill) : la BDD est le cache. `?refresh=1` force un re-fetch.
    if params[:refresh].blank? && activity&.streams_fetched_at.present?
      return render json: { cached_at: activity.streams_fetched_at.iso8601, streams: activity.streams }
    end

    streams = StravaStreamsFetcher.new(current_user).fetch(id)
    activity&.store_streams!(streams)
    render json: { cached_at: Time.current.iso8601, streams: streams }
  rescue StravaStreamsFetcher::ApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
  end

  # GET /strava/activities/:id/peak_power_ranks
  # Mirrors `ImportedActivitiesController#peak_power_ranks`: ensures the current
  # Strava activity's streams (and thus its peak-power curve) are persisted, then
  # ranks it against the user's all-time bests across both activity sources.
  def peak_power_ranks
    id = params[:id]
    streams = load_streams_for(id)
    return head :not_found unless streams

    activity = current_user.strava_activities.find_by(strava_id: id)
    current =
      if activity
        activity.store_streams!(streams) if activity.peak_powers.blank?
        activity.peak_powers
      else
        PeakPowerCurve.compute_from(streams)
      end

    render json: {
      current: current,
      bests: PeakPowerCurve.bests_for_user(current_user, exclude: ['strava', id])
    }
  rescue StravaStreamsFetcher::ApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
  end

  # POST /strava/backfill — récupère en masse les streams manquants. Réutilise un
  # run actif s'il y en a un (idempotent) ; ne (ré)enfile un job que si rien ne
  # tourne déjà, pour ne pas dupliquer le travail.
  def backfill
    run = StravaRefreshService.new(current_user).enqueue_streams_backfill
    return render json: backfill_json(run) if run

    render json: { cached_at: strava_cached_at, run: nil, pending: 0 }
  end

  # POST /strava/refresh — « Tout rafraîchir » : résumés récents + gear + (ré)enfile
  # le téléchargement des streams manquants, en un seul appel. Renvoie l'état du run
  # de backfill (suivi de progression) + les compteurs de sync (`synced`/`created`/
  # `total`, mêmes sémantiques que #sync) pour les widgets qui affichent les nouveautés.
  def refresh
    before = current_user.strava_activities.count
    result = StravaRefreshService.new(current_user).refresh_all
    total = current_user.strava_activities.count
    body = result[:run] ? backfill_json(result[:run]) : { cached_at: strava_cached_at, run: nil, pending: 0 }
    render json: body.merge(
      synced: result[:synced],
      created: [total - before, 0].max,
      total: total,
      device_backfill: device_backfill_json(result[:device_run])
    )
  rescue StravaSyncService::StravaApiError, StravaGearSyncService::StravaApiError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # GET /strava/backfill — état du run le plus récent (pour le suivi de progression).
  def backfill_status
    run = current_user.strava_backfill_runs.streams.order(created_at: :desc).first
    return render json: backfill_json(run) if run

    render json: { cached_at: strava_cached_at, run: nil, pending: current_user.strava_activities.streams_pending.count }
  end

  def photos
    id = params[:id]
    cache_key = "strava:photos:v1:#{current_user.id}:#{id}"
    Rails.cache.delete(cache_key) if params[:refresh].present?

    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      photos = strava_get(
        "https://www.strava.com/api/v3/activities/#{id}/photos",
        size: 2048,
        photo_sources: true
      )
      { cached_at: Time.current.iso8601, photos: Array(photos) }
    end

    render json: payload
  rescue StravaApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
  end

  private

  # Applique les filtres passés en query params sur les activités de l'utilisateur.
  # Filtrage en base (colonnes indexées) pour porter sur tout l'historique, pas
  # seulement la page courante.
  def filtered_activities_scope
    scope = current_user.strava_activities
    if params[:q].present?
      needle = StravaActivity.sanitize_sql_like(params[:q].to_s.first(MAX_SEARCH_LEN))
      # `localities::text` cherche dans le rendu texte du tableau jsonb — c'est ce
      # rendu qui est indexé en trigrammes (cf. AddLocalitiesToStravaActivities).
      scope = scope.where(
        "strava_activities.name ILIKE :q OR strava_activities.localities::text ILIKE :q",
        q: "%#{needle}%"
      )
    end
    if params[:sport].present?
      scope = scope.where(activity_type: params[:sport])
    elsif params[:sport_category].present?
      scope = filter_by_sport_category(scope, params[:sport_category])
    end
    scope = scope.where(gear_id: params[:gear]) if params[:gear].present?
    scope = scope.where(device_name: params[:device]) if params[:device].present?
    scope = scope.where(strava_activities: { distance_m: params[:min_dist].to_f * 1000.. }) if params[:min_dist].present?
    scope = scope.where(strava_activities: { distance_m: ..(params[:max_dist].to_f * 1000) }) if params[:max_dist].present?
    scope = scope.where(strava_activities: { total_elevation_gain: params[:min_elev].to_f.. }) if params[:min_elev].present?
    scope = scope.where(strava_activities: { total_elevation_gain: ..params[:max_elev].to_f }) if params[:max_elev].present?
    scope = scope.where(strava_activities: { moving_time_s: (params[:min_dur].to_f * 60).. }) if params[:min_dur].present?
    scope = scope.where(strava_activities: { moving_time_s: ..(params[:max_dur].to_f * 60) }) if params[:max_dur].present?
    if (from = parse_date(params[:from]))
      scope = scope.where(strava_activities: { started_at: from.beginning_of_day.. })
    end
    if (to = parse_date(params[:to]))
      scope = scope.where(strava_activities: { started_at: ..to.end_of_day })
    end
    scope
  end

  # Filtre sur une catégorie de sport (« cycling », « running », …) plutôt que sur
  # un `activity_type` exact : mêmes mots-clés que `PerformanceRecords`, pour que la
  # liste corresponde exactement à l'onglet de sport de la page performance.
  # Le SQL reproduit `PerformanceRecords.sport_category` : mot-clé cherché dans le
  # type (casse ignorée), et « other » = aucun mot-clé d'aucune catégorie — un type
  # NULL tombe donc dans « other », comme côté Ruby.
  def filter_by_sport_category(scope, category)
    if (keywords = SPORT_CATEGORY_KEYWORDS[category])
      clauses = keywords.map { "COALESCE(strava_activities.activity_type, '') ILIKE ?" }
      scope.where(clauses.join(' OR '), *keywords.map { |kw| "%#{kw}%" })
    elsif category == 'other'
      all = SPORT_CATEGORY_KEYWORDS.values.flatten
      clauses = all.map { "COALESCE(strava_activities.activity_type, '') NOT ILIKE ?" }
      scope.where(clauses.join(' AND '), *all.map { |kw| "%#{kw}%" })
    else
      scope # catégorie inconnue : filtre ignoré
    end
  end

  # Matériel proposé au filtre : vélos (table `bikes`) et chaussures (cache
  # `strava_gears`) référencés par au moins une activité, avec leur nom lisible. Les
  # gear dont on n'a pas encore résolu le nom sont écartés pour ne pas afficher
  # d'identifiant brut ; ils apparaîtront après le prochain « Tout rafraîchir ».
  def available_gears
    bikes = gear_options(
      current_user.strava_activities.with_bike_gear.distinct.pluck(:gear_id),
      current_user.bikes.where.not(strava_gear_id: nil).pluck(:strava_gear_id, :name).to_h,
      "bike"
    )
    shoes = gear_options(
      current_user.strava_activities.with_shoe_gear.distinct.pluck(:gear_id),
      current_user.strava_gears.pluck(:gear_id, :name).to_h,
      "shoe"
    )
    bikes + shoes
  end

  def gear_options(used_ids, names, type)
    used_ids.filter_map { |id| { id: id, name: names[id], type: type } if names[id] }
            .sort_by { |g| g[:name].downcase }
  end

  # Matériel d'enregistrement proposé au filtre : les `device_name` réellement
  # présents (non NULL = vérifié, non vide = appareil déclaré), triés alphabétiquement.
  def available_devices
    current_user.strava_activities
                .where.not(device_name: [nil, ""])
                .distinct.pluck(:device_name)
                .sort_by(&:downcase)
  end

  # Persiste `device_name` depuis un payload d'activité détaillée. Best-effort :
  # l'affichage d'une activité ne doit jamais échouer à cause de cette capture.
  def capture_device_name(strava_id, detail)
    return unless detail.is_a?(Hash)

    current_user.strava_activities.find_by(strava_id: strava_id)&.store_device_name!(detail)
  rescue StandardError => e
    Rails.logger.warn("[strava-device] capture #{strava_id} failed: #{e.message}")
  end

  # Parse une date ISO (yyyy-mm-dd) issue d'un <input type="date">. Renvoie nil si
  # vide ou invalide — le filtre est alors simplement ignoré.
  def parse_date(value)
    return nil if value.blank?

    Date.iso8601(value)
  rescue ArgumentError
    nil
  end

  def activities_per_page
    per = params[:per].to_i
    per = DEFAULT_PER_PAGE if per <= 0
    [per, MAX_PER_PAGE].min
  end

  # Sert les streams persistés quand on les a déjà récupérés, sinon tape l'API.
  # La BDD `strava_activities.streams` fait office de cache durable.
  def load_streams_for(id)
    activity = current_user.strava_activities.find_by(strava_id: id)
    return activity.streams if activity&.streams_fetched_at.present?

    StravaStreamsFetcher.new(current_user).fetch(id)
  end

  # Fraîcheur du miroir local des activités Strava : dernière écriture d'une ligne,
  # soit la fin de la dernière synchro. Affiché par la carte « Tout rafraîchir »
  # (« Mis à jour à … »), à côté du bouton qui la déclenche.
  def strava_cached_at
    current_user.strava_activities.maximum(:updated_at)&.iso8601
  end

  # Progression du backfill du matériel d'enregistrement, pour le retour de « Tout
  # rafraîchir ». `pending` = activités dont le device n'a pas encore été vérifié
  # (device_name NULL). nil s'il n'y a aucun run device (rien à récupérer).
  def device_backfill_json(run)
    return nil unless run

    pending = current_user.strava_activities.device_unchecked.count
    {
      status: run.status,
      total: run.total,
      done: [run.total - pending, 0].max,
      pending: pending
    }
  end

  def backfill_json(run)
    pending = current_user.strava_activities.streams_pending.count
    {
      cached_at: strava_cached_at,
      run: {
        id: run.id,
        status: run.status,
        total: run.total,
        done: [run.total - pending, 0].max,
        pending: pending,
        rate_limited_until: run.rate_limited_until&.iso8601,
        last_error: run.last_error,
        updated_at: run.updated_at&.iso8601
      }
    }
  end

  # Serialized form consumed by the frontend. We return the stored Strava
  # summary verbatim (`raw`) so list/detail views keep full field parity with
  # the live API; older rows without `raw` fall back to a built hash.
  # Charge utile de la carte d'ensemble : toutes les activités du filtre (les plus
  # récentes, plafonnées) réduites à leur tracé + quelques champs pour la popup.
  # Les sorties sans tracé exploitable (indoor, GPS absent) sont écartées.
  def activities_map_payload
    scope = filtered_activities_scope
    records = scope.order(started_at: :desc).limit(MAX_MAP_ACTIVITIES)
    {
      activities: records.filter_map { |a| map_json(a) },
      filtered_total: scope.count,
      max: MAX_MAP_ACTIVITIES
    }
  end

  def map_json(a)
    poly = a.map_polyline
    return nil unless poly

    {
      'id' => a.strava_id,
      'name' => a.name,
      'type' => a.activity_type,
      'distance' => a.distance_m,
      'total_elevation_gain' => a.total_elevation_gain,
      'start_date_local' => a.started_at&.iso8601,
      'map_polyline' => poly
    }
  end

  def summary_json(a, tss: nil)
    raw = a.raw.is_a?(Hash) ? a.raw : {}
    base = raw.present? ? raw : built_summary(a)
    # Aperçu SVG du tracé (segments pré-calculés, colorés par le dénivelé) pour
    # la vignette de la liste — mêmes données que la liste des itinéraires.
    base = base.merge('preview_segments' => a.preview_segments)
    # TSS ajouté au vol (non persisté) : dépend de seuils modifiables, se recalcule
    # à chaque lecture. Absent si l'activité n'a pas pu être notée.
    tss ? base.merge('tss' => tss[:tss], 'tss_source' => tss[:source]) : base
  end

  # Ajoute `tss`/`tss_source` à l'activité d'un payload `{ activity: {...} }` sans
  # muter le hash mis en cache (merge = nouveaux hashes). No-op si non notable.
  def with_activity_tss(payload, source, external_id)
    tss = TrainingLoad.tss_for(current_user, source, external_id)
    return payload unless tss

    payload.merge(activity: payload[:activity].merge('tss' => tss[:tss], 'tss_source' => tss[:source]))
  end

  def built_summary(a)
    {
      'id' => a.strava_id,
      'name' => a.name,
      'type' => a.activity_type,
      'sport_type' => a.activity_type,
      'start_date' => a.started_at&.iso8601,
      'start_date_local' => a.started_at&.iso8601,
      'distance' => a.distance_m,
      'moving_time' => a.moving_time_s,
      'elapsed_time' => a.elapsed_time_s,
      'total_elevation_gain' => a.total_elevation_gain,
      'average_speed' => a.average_speed,
      'max_speed' => a.max_speed,
      'average_heartrate' => a.average_heartrate,
      'max_heartrate' => a.max_heartrate,
      'average_watts' => a.average_watts,
      'max_watts' => a.max_watts,
      'average_cadence' => a.average_cadence,
      'start_latlng' => a.start_latlng,
      'end_latlng' => a.end_latlng
    }
  end

  class StravaApiError < StandardError
    attr_reader :status

    def initialize(status, message)
      @status = status
      super(message)
    end
  end

  def ensure_strava_linked!
    return if current_user.strava_linked?

    render json: { error: 'Strava not linked' }, status: :unprocessable_entity
  end

  def strava_get(url, params = {})
    token = current_user.refresh_strava_token!
    response = Faraday.get(url, params, { 'Authorization' => "Bearer #{token}" })

    unless response.success?
      Rails.logger.warn("[strava] GET #{url} #{response.status}: #{response.body}")
      raise StravaApiError.new(response.status, "Strava API returned #{response.status}")
    end

    JSON.parse(response.body)
  end
end
