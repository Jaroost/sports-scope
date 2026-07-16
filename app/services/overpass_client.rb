# Appel à l'API Overpass (OSM). Partagé par GeocodesController (POI affichés dans
# le créateur) et RouteLocalitiesExtractor (lieux enregistrés pour la recherche).
class OverpassClient
  # Tout échec d'Overpass : réseau (timeout, DNS, TLS, connexion refusée), réponse
  # non-2xx, ou corps illisible. Overpass est un service externe best-effort — un
  # échec n'est jamais une erreur serveur, les appelants le traduisent en
  # « indisponible » (front) ou en retry (job).
  Error = Class.new(StandardError)

  ENDPOINT = "https://overpass-api.de/api/interpreter"
  OPEN_TIMEOUT = 5
  READ_TIMEOUT = 30

  # Exécute une requête Overpass QL et renvoie ses `elements` (tableau, vide si
  # aucun résultat). Lève OverpassClient::Error en cas d'échec.
  def self.elements(overpass_ql, host: nil)
    uri = URI(ENDPOINT)
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true,
                               open_timeout: OPEN_TIMEOUT, read_timeout: READ_TIMEOUT) do |http|
      req = Net::HTTP::Post.new(uri)
      req["User-Agent"] = "SportsScope/1.0 (#{host || "sports-scope"})"
      req.set_form_data("data" => overpass_ql)
      http.request(req)
    end

    raise Error, "HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)

    Array(JSON.parse(response.body)["elements"])
  # SystemCallError couvre les Errno::* (ENETUNREACH, ECONNREFUSED, EHOSTUNREACH…).
  rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError,
         OpenSSL::SSL::SSLError, JSON::ParserError => e
    raise Error, "#{e.class}: #{e.message}"
  end
end
