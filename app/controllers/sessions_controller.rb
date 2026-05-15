class SessionsController < ApplicationController
  skip_before_action :verify_authenticity_token, only: [:create, :passthrough]

  # Fallback for OmniAuth request phase; normally OmniAuth's middleware
  # intercepts these requests before they reach this action.
  def passthrough
    raise ActionController::RoutingError.new("Not Found")
  end

  def create
    auth = request.env["omniauth.auth"]

    case auth.provider.to_s
    when "keycloak", "openid_connect"
      user = User.from_keycloak(auth)
      session[:user_id] = user.id
      session[:kc_access_token] = auth.credentials.token
      redirect_to root_path, notice: t("auth.signed_in")
    when "strava"
      unless current_user
        redirect_to root_path, alert: t("auth.login_first") and return
      end
      current_user.attach_strava!(auth)
      redirect_to root_path, notice: t("auth.strava_linked")
    else
      redirect_to root_path, alert: "Unknown provider: #{auth.provider}"
    end
  end

  def failure
    redirect_to root_path, alert: "Auth failure: #{params[:message]}"
  end

  def destroy
    session.clear
    kc_logout_url = "#{ENV.fetch('KEYCLOAK_BASE_URL', 'http://localhost:8080')}/realms/#{ENV.fetch('KEYCLOAK_REALM', 'sports-scope')}/protocol/openid-connect/logout"
    redirect_to "#{kc_logout_url}?post_logout_redirect_uri=#{CGI.escape(root_url)}&client_id=#{ENV.fetch('KEYCLOAK_CLIENT_ID', 'rails-app')}", allow_other_host: true
  end
end
