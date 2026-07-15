class StravaController < ApplicationController
  before_action :require_login!
  before_action :ensure_strava_linked!

  ACTIVITIES_TTL = 1.day
  ACTIVITIES_LIMIT = 200

  # Serves the user's activities straight from `strava_activities`. The first
  # visit (empty table) triggers a full sync; `?refresh=1` runs an incremental
  # sync to pull anything new since the last stored activity.
  def activities
    sync = current_user.strava_activities.none? ? :full : (params[:refresh].present? ? :incremental : nil)

    case sync
    when :full        then StravaSyncService.new(current_user).call(full: true)
    when :incremental then StravaSyncService.new(current_user).call
    end

    records = current_user.strava_activities.order(started_at: :desc).limit(ACTIVITIES_LIMIT)
    # TSS par sortie (charge d'entraînement) calculé en une passe, mêmes seuils que
    # la charge d'entraînement (FTP variable, LTHR).
    tss_map = TrainingLoad.tss_by_activity(current_user)
    render json: {
      cached_at: current_user.strava_activities.maximum(:updated_at)&.iso8601,
      total: current_user.strava_activities.count,
      activities: records.map { |a| summary_json(a, tss: tss_map[['strava', a.strava_id.to_s]]) }
    }
  rescue StravaSyncService::StravaApiError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # POST /strava/sync — force a (re)synchronisation of activity summaries.
  # `?full=1` re-paginates the whole history; otherwise it's incremental.
  def sync
    before = current_user.strava_activities.count
    count = StravaSyncService.new(current_user).call(full: params[:full].present?)
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
    run = current_user.strava_backfill_runs.active.order(created_at: :desc).first
    if run.nil?
      run = current_user.strava_backfill_runs.create!(
        status: 'pending',
        total: current_user.strava_activities.streams_pending.count
      )
      StravaStreamsBackfillJob.perform_later(run.id)
    elsif run.resumable?
      StravaStreamsBackfillJob.perform_later(run.id)
    end

    render json: backfill_json(run)
  end

  # GET /strava/backfill — état du run le plus récent (pour le suivi de progression).
  def backfill_status
    run = current_user.strava_backfill_runs.order(created_at: :desc).first
    return render json: backfill_json(run) if run

    render json: { run: nil, pending: current_user.strava_activities.streams_pending.count }
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

  # Sert les streams persistés quand on les a déjà récupérés, sinon tape l'API.
  # La BDD `strava_activities.streams` fait office de cache durable.
  def load_streams_for(id)
    activity = current_user.strava_activities.find_by(strava_id: id)
    return activity.streams if activity&.streams_fetched_at.present?

    StravaStreamsFetcher.new(current_user).fetch(id)
  end

  def backfill_json(run)
    pending = current_user.strava_activities.streams_pending.count
    {
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
  def summary_json(a, tss: nil)
    raw = a.raw.is_a?(Hash) ? a.raw : {}
    base = raw.present? ? raw : built_summary(a)
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
