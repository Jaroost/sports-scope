# Seuils et zones du cycliste, pour l'application mobile.
#
# C'est la page de navigation qui appelle cette route, pas l'appli : l'appli ne
# détient aucun identifiant du site par construction (la session est un cookie du
# pot de son WebView). Elle recevrait donc une réponse anonyme si elle appelait
# elle-même, là où la page est déjà authentifiée — et son service worker met la
# réponse en cache, ce qui rend les zones disponibles hors ligne.
class RiderProfilesController < ApplicationController
  before_action :require_login!

  # GET /api/rider_profile — FTP, LTHR et bornes absolues des zones.
  def show
    render json: RiderProfile.summary(current_user)
  end
end
