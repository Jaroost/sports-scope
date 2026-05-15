class StravaController < ApplicationController
  before_action :require_login!
  before_action :ensure_strava_linked!

  ACTIVITIES_TTL = 10.minutes

  def activities
    cache_key = "strava:activities:#{current_user.id}"
    Rails.cache.delete(cache_key) if params[:refresh].present?

    payload = Rails.cache.fetch(cache_key, expires_in: ACTIVITIES_TTL) do
      list = strava_get("https://www.strava.com/api/v3/athlete/activities", per_page: 10)
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

  private

  class StravaApiError < StandardError
    attr_reader :status
    def initialize(status, message)
      @status = status
      super(message)
    end
  end

  def ensure_strava_linked!
    return if current_user.strava_linked?

    render json: { error: "Strava not linked" }, status: :unprocessable_entity
  end

  def strava_get(url, params = {})
    token = current_user.refresh_strava_token!
    response = Faraday.get(url, params, { "Authorization" => "Bearer #{token}" })

    unless response.success?
      Rails.logger.warn("[strava] GET #{url} #{response.status}: #{response.body}")
      raise StravaApiError.new(response.status, "Strava API returned #{response.status}")
    end

    JSON.parse(response.body)
  end
end
