class ApplicationController < ActionController::Base
  allow_browser versions: :modern

  before_action :set_locale
  helper_method :current_user, :user_signed_in?

  # Accès refusé par CanCanCan : JSON 403 pour l'API, redirection sinon.
  rescue_from CanCan::AccessDenied do |exception|
    respond_to do |format|
      format.json { render json: { error: exception.message }, status: :forbidden }
      format.any { redirect_to root_path, alert: t("auth.access_denied") }
    end
  end

  private

  # À utiliser en before_action sur les pages réservées aux administrateurs.
  def require_admin!
    return if current_user&.admin?

    raise CanCan::AccessDenied
  end

  def set_locale
    requested = params[:locale] || session[:locale] || http_accept_language_first
    I18n.locale = I18n.available_locales.map(&:to_s).include?(requested.to_s) ? requested.to_sym : I18n.default_locale
    session[:locale] = I18n.locale.to_s
  end

  def http_accept_language_first
    request.env["HTTP_ACCEPT_LANGUAGE"].to_s.split(",").first.to_s.split("-").first
  end

  def current_user
    @current_user ||= User.find_by(id: session[:user_id]) if session[:user_id]
  end

  def user_signed_in?
    current_user.present?
  end

  def require_login!
    return if user_signed_in?

    redirect_to root_path, alert: t("auth.login_required")
  end

  def default_url_options
    { locale: I18n.locale == I18n.default_locale ? nil : I18n.locale }
  end
end
