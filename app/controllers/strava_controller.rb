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
    render json: {
      cached_at: current_user.strava_activities.maximum(:updated_at)&.iso8601,
      activities: records.map { |a| summary_json(a) }
    }
  rescue StravaSyncService::StravaApiError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # POST /strava/sync — force a (re)synchronisation of activity summaries.
  # `?full=1` re-paginates the whole history; otherwise it's incremental.
  def sync
    count = StravaSyncService.new(current_user).call(full: params[:full].present?)
    render json: { synced: count, total: current_user.strava_activities.count }
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

    render json: payload
  rescue StravaApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
  end

  STREAM_KEYS = %w[time distance latlng altitude velocity_smooth heartrate cadence watts temp moving
                   grade_smooth].freeze

  def streams
    id = params[:id]
    cache_key = "strava:streams:v2:#{current_user.id}:#{id}"
    Rails.cache.delete(cache_key) if params[:refresh].present?

    fetched = false
    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      fetched = true
      streams = strava_get(
        "https://www.strava.com/api/v3/activities/#{id}/streams",
        keys: STREAM_KEYS.join(','),
        key_by_type: true
      )
      { cached_at: Time.current.iso8601, streams: streams }
    end

    # Write-through: persist the detailed series into `strava_activities` the
    # first time we actually hit the API (computes the peak-power curve too).
    persist_streams(id, payload[:streams] || payload['streams']) if fetched

    render json: payload
  rescue StravaApiError => e
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
  rescue StravaApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
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

  # Reuse the same cache keys as `#streams` and `#show` so a normal page visit
  # warms what `peak_power_ranks` later needs (no extra Strava API call when
  # streams were already fetched in this session).
  def load_streams_for(id)
    cache_key = "strava:streams:v2:#{current_user.id}:#{id}"
    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      streams = strava_get(
        "https://www.strava.com/api/v3/activities/#{id}/streams",
        keys: STREAM_KEYS.join(','),
        key_by_type: true
      )
      { cached_at: Time.current.iso8601, streams: streams }
    end
    payload[:streams] || payload['streams']
  end

  # Serialized form consumed by the frontend. We return the stored Strava
  # summary verbatim (`raw`) so list/detail views keep full field parity with
  # the live API; older rows without `raw` fall back to a built hash.
  def summary_json(a)
    raw = a.raw.is_a?(Hash) ? a.raw : {}
    return raw if raw.present?

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

  def persist_streams(id, streams)
    return unless streams.is_a?(Hash)

    activity = current_user.strava_activities.find_by(strava_id: id)
    activity&.store_streams!(streams)
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
