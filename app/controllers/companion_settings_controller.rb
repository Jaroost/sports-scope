# Les profils de sortie de l'application compagnon.
#
# **Authentifié**, contrairement à `/api/companion_version` : ce sont des données de
# compte. L'appli n'a aucun cookie côté Dart — la session vit dans le pot partagé de
# ses WebViews — donc elle appelle cette route depuis un WebView hors écran, comme
# elle le fait déjà pour le catalogue d'itinéraires (`RouteCatalogFetch`).
#
# Le `Accept: application/json` qu'elle envoie est ce qui fait répondre ici un 401
# propre plutôt qu'une redirection HTML vers Keycloak : c'est ce qui lui permet de
# distinguer « pas connecté » — la seule chose que le cycliste puisse corriger — de
# « pas de réseau ».
class CompanionSettingsController < ApplicationController
  before_action :require_login!

  # GET /api/companion_settings
  #
  # Sans cache HTTP : l'appli n'interroge qu'**une fois par lancement** et garde le
  # document sur disque, donc il n'y a aucune rafale à absorber. Un cache poserait en
  # revanche la question du profil qu'on vient de modifier et qui ne redescend pas.
  def show
    render json: CompanionSettings.for(current_user)
  end
end
