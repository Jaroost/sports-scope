# Récupère la météo historique d'un point (lat/lng) à une date/heure donnée via
# l'API Open-Meteo (gratuite, sans clé). Strava ne fournit ni le vent ni le code
# météo — on reconstitue donc les conditions du jour à partir de la position de
# départ et de l'heure de l'activité.
#
# Deux endpoints selon l'ancienneté : l'archive n'est disponible qu'après ~5 jours,
# on bascule donc sur le forecast (avec `past_days`) pour les sorties récentes.
# Toutes les heures sont demandées en UTC (`timezone=GMT`) pour correspondre au
# `start_date` UTC de l'activité — on renvoie ensuite le créneau horaire le plus
# proche.
class WeatherService
  ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
  FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
  HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m'.freeze
  # En deçà de ce seuil l'archive n'a pas encore les données → forecast.
  RECENT_THRESHOLD = 6.days

  def initialize(lat:, lng:, time:)
    @lat = lat.to_f
    @lng = lng.to_f
    @time = time
  end

  # Renvoie un hash de conditions (ou nil si indisponible) :
  # { temperature:, humidity:, precipitation:, weather_code:, wind_speed:,
  #   wind_direction:, wind_gusts:, observed_at: }
  def call
    return nil unless valid_inputs?

    hourly = fetch_hourly
    return nil if hourly.nil?

    pick_nearest_hour(hourly)
  rescue Faraday::Error => e
    Rails.logger.warn("[weather] fetch failed (#{@lat},#{@lng}): #{e.message}")
    nil
  end

  private

  def valid_inputs?
    @time.present? && @lat.between?(-90, 90) && @lng.between?(-180, 180) &&
      !(@lat.zero? && @lng.zero?)
  end

  def recent?
    @time > RECENT_THRESHOLD.ago
  end

  def fetch_hourly
    date = @time.utc.to_date
    url, params =
      if recent?
        [FORECAST_URL, { past_days: 7, forecast_days: 1 }]
      else
        [ARCHIVE_URL, { start_date: date.iso8601, end_date: date.iso8601 }]
      end

    params = params.merge(
      latitude: @lat.round(4),
      longitude: @lng.round(4),
      hourly: HOURLY,
      timezone: 'GMT',
      wind_speed_unit: 'kmh'
    )

    response = Faraday.get(url, params) { |r| r.options.timeout = 8 }
    unless response.success?
      Rails.logger.warn("[weather] GET #{url} #{response.status}")
      return nil
    end

    body = JSON.parse(response.body)
    body['hourly']
  end

  # Les tableaux `hourly` sont alignés sur `hourly.time` (heures UTC). On choisit
  # l'index dont l'heure est la plus proche de l'heure de l'activité.
  def pick_nearest_hour(hourly)
    times = hourly['time']
    return nil if times.blank?

    target = @time.utc.to_i
    idx = times.each_index.min_by do |i|
      (Time.parse("#{times[i]}Z").to_i - target).abs
    end
    return nil if idx.nil?

    {
      temperature: hourly.dig('temperature_2m', idx),
      humidity: hourly.dig('relative_humidity_2m', idx),
      precipitation: hourly.dig('precipitation', idx),
      weather_code: hourly.dig('weather_code', idx),
      wind_speed: hourly.dig('wind_speed_10m', idx),
      wind_direction: hourly.dig('wind_direction_10m', idx),
      wind_gusts: hourly.dig('wind_gusts_10m', idx),
      observed_at: "#{times[idx]}Z"
    }
  end
end
