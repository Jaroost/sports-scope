class PagesController < ApplicationController
  # Le Web Share Target (Android) POST le .gpx sans jeton CSRF : on désactive la
  # protection pour cette seule action (le partage est une entrée publique du système).
  skip_forgery_protection only: :share_target

  def home
  end

  def dashboard
    require_login!
  end

  def routes_index
    require_login!
  end

  def route_builder
    require_login!
    @route_id = params[:id]
  end

  # Filet de sécurité du Web Share Target quand le service worker n'a pas intercepté
  # le POST (cf. config/routes.rb). On lit le .gpx partagé et on rend le créateur,
  # qui charge directement le tracé via les props sharedGpx / sharedGpxName.
  def share_target
    require_login!
    return if performed? # require_login! a pu rediriger (non connecté)

    file = params[:gpx]
    if file.respond_to?(:read)
      @shared_gpx = file.read
      @shared_gpx_name = File.basename(file.original_filename.to_s, ".*") if file.respond_to?(:original_filename)
    end
    render :route_builder
  end

  def free_navigation
    # Page de navigation unifiée : démarre en navigation libre (carte + vitesse + radar
    # + veille) et peut charger un itinéraire à la volée. Public, aucun login requis.
  end

  def route_navigation
    # No login required: navigation links are addressed by share_token and can
    # be shared with anyone.
    token = params[:token]
    unless Route.exists?(share_token: token)
      redirect_to root_path, alert: t("routes.error_shared_not_found") and return
    end
    @share_token = token
  end

  def route_view
    # No login required: read-only builder view addressed by share_token, meant
    # to be shared with anyone (signed-out recipients included).
    token = params[:token]
    unless Route.exists?(share_token: token)
      redirect_to root_path, alert: t("routes.error_shared_not_found") and return
    end
    @share_token = token
  end
end
