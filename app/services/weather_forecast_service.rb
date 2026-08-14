# Prévision météo horaire (Open-Meteo, gratuite, sans clé) pour un point donné
# — alimente le bloc "prévisions météo" du dashboard de l'appli compagnon :
# température, vent et précipitations sur les heures qui viennent, à lire
# comme un graphique plutôt qu'un chiffre isolé.
#
# Distinct de PrecipitationForecastService : celui-ci regarde 3h à 15 min de
# pas pour répondre à « une averse arrive, dans combien de temps ? »; celui-ci
# regarde plus loin (12h à l'heure) pour donner la tendance de la sortie —
# température et vent n'ont pas besoin d'une granularité fine.
class WeatherForecastService
  FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

  # 12h à pas horaire : de quoi voir venir la tendance sur toute une sortie,
  # sans aller jusqu'à un horizon où le modèle horaire n'apporte plus rien.
  STEPS = 12

  def initialize(lat:, lng:)
    @lat = lat.to_f
    @lng = lng.to_f
  end

  # Renvoie [{ time:, temperature:, wind_speed:, precipitation: }, ...] (heures
  # UTC, °C, km/h, mm), dans l'ordre chronologique en partant de maintenant, ou
  # nil si indisponible.
  def call
    return nil unless valid_inputs?

    hourly = fetch_hourly
    return nil if hourly.nil?

    build_steps(hourly)
  rescue Faraday::Error => e
    Rails.logger.warn("[weather_forecast] fetch failed (#{@lat},#{@lng}): #{e.message}")
    nil
  end

  private

  def valid_inputs?
    @lat.between?(-90, 90) && @lng.between?(-180, 180) && !(@lat.zero? && @lng.zero?)
  end

  def fetch_hourly
    params = {
      latitude: @lat.round(4),
      longitude: @lng.round(4),
      hourly: 'temperature_2m,wind_speed_10m,precipitation',
      forecast_hours: STEPS,
      timezone: 'GMT'
    }

    response = Faraday.get(FORECAST_URL, params) { |r| r.options.timeout = 8 }
    unless response.success?
      Rails.logger.warn("[weather_forecast] GET #{FORECAST_URL} #{response.status}")
      return nil
    end

    JSON.parse(response.body)['hourly']
  end

  # Bornée à `STEPS` même si Open-Meteo en renvoyait plus : `forecast_hours`
  # n'est qu'une demande, pas une garantie côté fournisseur.
  def build_steps(hourly)
    times = hourly['time']
    temperature = hourly['temperature_2m']
    wind_speed = hourly['wind_speed_10m']
    precipitation = hourly['precipitation']
    return nil if times.blank? || temperature.blank? || wind_speed.blank? || precipitation.blank?

    times.first(STEPS).each_with_index.map do |time, i|
      {
        time: "#{time}Z",
        temperature: (temperature[i] || 0).to_f.round(1),
        wind_speed: (wind_speed[i] || 0).to_f.round(1),
        precipitation: (precipitation[i] || 0).to_f.round(2)
      }
    end
  end
end
