class StravaController < ApplicationController
  before_action :require_login!
  before_action :ensure_strava_linked!

  ACTIVITIES_TTL = 1.day

  def activities
    cache_key = "strava:activities:#{current_user.id}"
    Rails.cache.delete(cache_key) if params[:refresh].present?

    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      list = strava_get('https://www.strava.com/api/v3/athlete/activities', per_page: 10)
      { cached_at: Time.current.iso8601, activities: list }
    end

    render json: payload
  rescue StravaApiError => e
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

    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      streams = strava_get(
        "https://www.strava.com/api/v3/activities/#{id}/streams",
        keys: STREAM_KEYS.join(','),
        key_by_type: true
      )
      { cached_at: Time.current.iso8601, streams: streams }
    end

    render json: payload
  rescue StravaApiError => e
    status = e.status == 404 ? :not_found : :bad_gateway
    render json: { error: e.message }, status: status
  end

  # GET /strava/activities/:id/peak_power_ranks
  # Mirrors `ImportedActivitiesController#peak_power_ranks` but persists the
  # current Strava activity's peak-power curve into `strava_activity_peak_powers`
  # (Strava activities themselves aren't stored — only the curve is, so we can
  # rank against the user's history).
  def peak_power_ranks
    id = params[:id]
    streams = load_streams_for(id)
    return head :not_found unless streams

    summary = load_summary_for(id)
    started_at = parse_started_at(summary)

    record = StravaActivityPeakPower.upsert_from_streams(
      user: current_user,
      strava_activity_id: id,
      started_at: started_at,
      streams: streams
    )

    render json: {
      current: record.peak_powers,
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

  def load_summary_for(id)
    cache_key = "strava:activity:#{current_user.id}:#{id}"
    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      activity = strava_get("https://www.strava.com/api/v3/activities/#{id}")
      { cached_at: Time.current.iso8601, activity: activity }
    end
    payload[:activity] || payload['activity']
  end

  def parse_started_at(summary)
    return nil unless summary.is_a?(Hash)

    raw = summary['start_date'] || summary[:start_date] ||
          summary['start_date_local'] || summary[:start_date_local]
    Time.iso8601(raw.to_s)
  rescue ArgumentError, TypeError
    nil
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
