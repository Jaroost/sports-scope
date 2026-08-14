# Proxy Open-Meteo pour le bloc "orage qui arrive" du dashboard de l'appli
# compagnon — prévision de précipitations à 15 minutes pour la position GPS
# courante. Public, comme RainviewerController/CompanionController#version :
# l'appli Flutter n'a pas de cookie hors WebView, et la position transmise en
# query n'est pas une donnée de compte à protéger par une session qu'elle n'a
# de toute façon pas.
class PrecipitationForecastController < ApplicationController
  before_action :skip_session, only: :show

  CACHE_TTL = 5.minutes

  def show
    lat = params[:lat].to_f
    lng = params[:lng].to_f

    # Arrondie à 2 décimales (~1 km) : assez précise pour une prévision à
    # 15 min, et regroupe sous la même clé de cache les cyclistes proches les
    # uns des autres plutôt que de refaire l'appel à chaque position exacte.
    cache_key = "precipitation_forecast:v1:#{lat.round(2)}:#{lng.round(2)}"
    steps = Rails.cache.fetch(cache_key, expires_in: CACHE_TTL) do
      PrecipitationForecastService.new(lat: lat, lng: lng).call
    end

    return head :no_content if steps.nil?

    # Open-Meteo republie ses prévisions minutely_15 toutes les ~15 min :
    # `public` laisse un cache HTTP partagé absorber les rafales, même
    # raisonnement que companion#version et RainviewerController.
    expires_in CACHE_TTL, public: true
    render json: { steps: steps }
  end

  private

  def skip_session
    request.session_options[:skip] = true
  end
end
