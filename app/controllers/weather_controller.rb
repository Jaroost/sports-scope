# Proxy météo consommé par l'affichage d'une activité (matériel + conditions).
# Le front envoie la position de départ et l'heure (UTC) de l'activité ; on
# renvoie les conditions du créneau horaire le plus proche via WeatherService.
# La météo passée ne change pas → cache long, clé arrondie pour mutualiser les
# points proches et les activités d'une même heure.
class WeatherController < ApplicationController
  before_action :require_login!

  WEATHER_TTL = 30.days

  def show
    lat = params[:lat].to_f
    lng = params[:lng].to_f
    time = parse_time(params[:at])

    if time.nil? || (lat.zero? && lng.zero?)
      return render json: { error: 'lat, lng and at are required' }, status: :unprocessable_entity
    end

    cache_key = "weather:v1:#{lat.round(2)}:#{lng.round(2)}:#{time.utc.strftime('%Y%m%d%H')}"
    weather = Rails.cache.fetch(cache_key, expires_in: WEATHER_TTL) do
      WeatherService.new(lat: lat, lng: lng, time: time).call
    end

    return head :no_content if weather.nil?

    render json: { weather: weather }
  end

  private

  def parse_time(v)
    return nil if v.blank?

    Time.iso8601(v.to_s)
  rescue ArgumentError, TypeError
    nil
  end
end
