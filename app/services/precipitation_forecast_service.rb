# Prévision de précipitations à 15 minutes (Open-Meteo, gratuite, sans clé)
# pour un point donné — alimente le bloc "orage qui arrive" du dashboard de
# l'appli compagnon : dire si une averse arrive dans l'heure qui vient, et
# dans combien de temps, là où le forecast horaire classique de WeatherService
# ne voit qu'une moyenne sur soixante minutes.
class PrecipitationForecastService
  FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

  # 3h à 15 min de pas : assez pour voir un système approcher (le nowcast
  # RainViewer du bloc radar ne va pas plus loin qu'~1h), pas assez pour que
  # l'incertitude du modèle rende la fin de la série inutile.
  STEPS = 12

  def initialize(lat:, lng:)
    @lat = lat.to_f
    @lng = lng.to_f
  end

  # Renvoie [{ time:, precipitation: }, ...] (heures UTC, mm sur le quart
  # d'heure), dans l'ordre chronologique en partant de maintenant, ou nil si
  # indisponible.
  def call
    return nil unless valid_inputs?

    minutely = fetch_minutely
    return nil if minutely.nil?

    build_steps(minutely)
  rescue Faraday::Error => e
    Rails.logger.warn("[precipitation_forecast] fetch failed (#{@lat},#{@lng}): #{e.message}")
    nil
  end

  private

  def valid_inputs?
    @lat.between?(-90, 90) && @lng.between?(-180, 180) && !(@lat.zero? && @lng.zero?)
  end

  def fetch_minutely
    params = {
      latitude: @lat.round(4),
      longitude: @lng.round(4),
      minutely_15: 'precipitation',
      forecast_minutely_15: STEPS,
      timezone: 'GMT'
    }

    response = Faraday.get(FORECAST_URL, params) { |r| r.options.timeout = 8 }
    unless response.success?
      Rails.logger.warn("[precipitation_forecast] GET #{FORECAST_URL} #{response.status}")
      return nil
    end

    JSON.parse(response.body)['minutely_15']
  end

  # Bornée à `STEPS` même si Open-Meteo en renvoyait plus : `forecast_minutely_15`
  # n'est qu'une demande, pas une garantie côté fournisseur.
  def build_steps(minutely)
    times = minutely['time']
    precipitation = minutely['precipitation']
    return nil if times.blank? || precipitation.blank?

    times.first(STEPS).each_with_index.map do |time, i|
      { time: "#{time}Z", precipitation: (precipitation[i] || 0).to_f.round(2) }
    end
  end
end
