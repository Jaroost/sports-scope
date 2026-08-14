# Récupère le catalogue des frames radar RainViewer (gratuit, sans clé) — utilisé
# pour animer les précipitations passées/à venir centrées sur le cycliste dans le
# dashboard de l'appli compagnon. Même forme que WeatherService : un GET Faraday
# avec timeout, un rescue qui rend nil plutôt que de laisser planter l'appelant.
class RainviewerService
  CATALOG_URL = 'https://api.rainviewer.com/public/weather-maps.json'
  # Gardé large : ~4 frames passées suffisent à lire le mouvement avant d'enchaîner
  # sur la prévision (nowcast, gardée en entier — RainViewer n'en publie que 2-3).
  PAST_FRAMES = 4

  # Renvoie { host:, frames: [{ time:, path: }, ...] } (passé puis prévision, dans
  # l'ordre chronologique) ou nil si le catalogue est indisponible.
  def call
    body = fetch_catalog
    return nil if body.nil?

    radar = body['radar']
    return nil if radar.nil?

    past = Array(radar['past']).last(PAST_FRAMES)
    nowcast = Array(radar['nowcast'])
    frames = (past + nowcast).map { |f| { time: f['time'], path: f['path'] } }
    return nil if frames.empty?

    { host: body['host'], frames: frames }
  rescue Faraday::Error => e
    Rails.logger.warn("[rainviewer] fetch failed: #{e.message}")
    nil
  end

  private

  def fetch_catalog
    response = Faraday.get(CATALOG_URL) { |r| r.options.timeout = 8 }
    unless response.success?
      Rails.logger.warn("[rainviewer] GET #{CATALOG_URL} #{response.status}")
      return nil
    end

    JSON.parse(response.body)
  end
end
