# Proxy Open-Meteo pour le bloc "prévisions météo" du dashboard de l'appli
# compagnon — température, vent et précipitations à l'heure pour la position
# GPS courante. Public, comme PrecipitationForecastController : l'appli
# Flutter n'a pas de cookie hors WebView, et la position transmise en query
# n'est pas une donnée de compte à protéger par une session qu'elle n'a de
# toute façon pas.
class WeatherForecastController < ApplicationController
  before_action :skip_session, only: :show

  # Plus large que PrecipitationForecastController (5 min) : la donnée est
  # horaire, pas du nowcast à 15 min, elle n'a pas besoin d'être rafraîchie
  # aussi souvent.
  CACHE_TTL = 15.minutes

  def show
    lat = params[:lat].to_f
    lng = params[:lng].to_f

    # Arrondie à 2 décimales (~1 km), même raisonnement que
    # PrecipitationForecastController : regrouper sous la même clé de cache
    # les cyclistes proches plutôt que refaire l'appel à chaque position exacte.
    cache_key = "weather_forecast:v1:#{lat.round(2)}:#{lng.round(2)}"
    steps = Rails.cache.fetch(cache_key, expires_in: CACHE_TTL) do
      WeatherForecastService.new(lat: lat, lng: lng).call
    end

    return head :no_content if steps.nil?

    expires_in CACHE_TTL, public: true
    render json: { steps: steps }
  end

  private

  def skip_session
    request.session_options[:skip] = true
  end
end
