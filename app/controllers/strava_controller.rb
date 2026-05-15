class StravaController < ApplicationController
  before_action :require_login!

  def activities
    unless current_user.strava_linked?
      render json: { error: "Strava not linked" }, status: :unprocessable_entity and return
    end

    token = current_user.refresh_strava_token!
    response = Faraday.get(
      "https://www.strava.com/api/v3/athlete/activities",
      { per_page: 5 },
      { "Authorization" => "Bearer #{token}" },
    )

    if response.success?
      render json: JSON.parse(response.body)
    else
      Rails.logger.warn("[strava] API error #{response.status}: #{response.body}")
      render json: { error: "Strava API returned #{response.status}" }, status: :bad_gateway
    end
  end
end
