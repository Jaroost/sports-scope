# Proxy du catalogue de frames radar RainViewer, consommé par le bloc "précipitations"
# du dashboard de l'appli compagnon. Public, comme CompanionController#version : l'appli
# Flutter n'a pas de cookie hors WebView, et cette réponse ne contient aucune donnée
# utilisateur — rien à protéger par une session qu'elle n'a de toute façon pas.
class RainviewerController < ApplicationController
  before_action :skip_session, only: :show

  CATALOG_TTL = 5.minutes

  def show
    catalog = Rails.cache.fetch('rainviewer:v1', expires_in: CATALOG_TTL) do
      RainviewerService.new.call
    end

    return head :no_content if catalog.nil?

    # RainViewer republie son catalogue toutes les ~10 min : `public` laisse un cache
    # HTTP partagé absorber les rafales, même raisonnement que companion#version.
    expires_in CATALOG_TTL, public: true
    render json: catalog
  end

  private

  def skip_session
    request.session_options[:skip] = true
  end
end
