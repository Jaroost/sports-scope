require Rails.root.join("lib/omni_auth/strategies/strava")

OmniAuth.config.allowed_request_methods = [:post]
OmniAuth.config.silence_get_warning = true
OmniAuth.config.logger = Rails.logger
OmniAuth.config.failure_raise_out_environments = []

KEYCLOAK_BASE_URL = ENV.fetch("KEYCLOAK_BASE_URL", "http://keycloak:8080").freeze
KEYCLOAK_REALM = ENV.fetch("KEYCLOAK_REALM", "sports-scope").freeze
APP_HOST = ENV.fetch("APP_HOST", "http://localhost:3000").freeze

Rails.application.config.middleware.use OmniAuth::Builder do
  provider :openid_connect, {
    name: :keycloak,
    scope: [:openid, :profile, :email],
    response_type: :code,
    issuer: "#{KEYCLOAK_BASE_URL}/realms/#{KEYCLOAK_REALM}",
    discovery: true,
    client_options: {
      identifier: ENV.fetch("KEYCLOAK_CLIENT_ID", "rails-app"),
      secret: ENV.fetch("RAILS_KEYCLOAK_CLIENT_SECRET"),
      redirect_uri: "#{APP_HOST}/auth/keycloak/callback",
    },
  }

  provider :strava,
           ENV["STRAVA_CLIENT_ID"],
           ENV["STRAVA_CLIENT_SECRET"],
           scope: "read,activity:read_all",
           callback_path: "/auth/strava/callback"
end
