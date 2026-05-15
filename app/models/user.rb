class User < ApplicationRecord
  has_many :chart_layouts, dependent: :destroy

  validates :keycloak_uid, presence: true, uniqueness: true
  validates :email, presence: true, uniqueness: true

  def self.from_keycloak(auth)
    user = find_or_initialize_by(keycloak_uid: auth.uid)
    user.email = auth.info.email
    user.display_name = auth.info.name.presence || auth.info.email
    user.save!
    user
  end

  def attach_strava!(auth)
    update!(
      strava_uid: auth.uid,
      strava_access_token: auth.credentials.token,
      strava_refresh_token: auth.credentials.refresh_token,
      strava_expires_at: Time.at(auth.credentials.expires_at).utc,
    )
  end

  def strava_linked?
    strava_uid.present? && strava_access_token.present?
  end

  def strava_token_expired?
    strava_expires_at.nil? || strava_expires_at <= Time.current
  end

  def refresh_strava_token!
    return strava_access_token unless strava_token_expired?

    response = Faraday.post(
      "https://www.strava.com/oauth/token",
      {
        client_id: ENV["STRAVA_CLIENT_ID"],
        client_secret: ENV["STRAVA_CLIENT_SECRET"],
        grant_type: "refresh_token",
        refresh_token: strava_refresh_token,
      },
    )
    raise "Strava token refresh failed: #{response.status}" unless response.success?

    body = JSON.parse(response.body)
    update!(
      strava_access_token: body["access_token"],
      strava_refresh_token: body["refresh_token"],
      strava_expires_at: Time.at(body["expires_at"]).utc,
    )
    strava_access_token
  end
end
