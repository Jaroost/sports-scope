class GeocodesController < ApplicationController
  before_action :require_login!

  def places
    south = params.require(:south).to_f
    west  = params.require(:west).to_f
    north = params.require(:north).to_f
    east  = params.require(:east).to_f
    bbox  = "#{south},#{west},#{north},#{east}"

    # On ne requête que les catégories demandées par le client (pilotées par les
    # préférences du profil). Sans paramètre `types`, on retombe sur tout par défaut.
    types = (params[:types].presence || "localities,cemeteries,bakeries").split(",")
    clauses = []
    clauses << %(node["place"~"^(city|town|village|hamlet)$"](#{bbox});) if types.include?("localities")
    if types.include?("cemeteries")
      clauses << %(node["amenity"="grave_yard"](#{bbox});)
      clauses << %(node["landuse"="cemetery"](#{bbox});)
      clauses << %(way["amenity"="grave_yard"](#{bbox});)
      clauses << %(way["landuse"="cemetery"](#{bbox});)
    end
    if types.include?("bakeries")
      clauses << %(node["shop"="bakery"](#{bbox});)
      clauses << %(way["shop"="bakery"](#{bbox});)
    end
    return render json: [] if clauses.empty?

    query = <<~OVERPASS
      [out:json][timeout:25];
      (
        #{clauses.join("\n        ")}
      );
      out center;
    OVERPASS

    uri = URI("https://overpass-api.de/api/interpreter")
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 30) do |http|
      req = Net::HTTP::Post.new(uri)
      req["User-Agent"] = "SportsScope/1.0 (#{request.host})"
      req.set_form_data("data" => query)
      http.request(req)
    end

    # Overpass injoignable / en erreur : on signale un vrai échec (≠ « aucun lieu »)
    # pour que le front affiche le message d'erreur + bouton réessayer.
    return render json: { error: "places_unavailable" }, status: :bad_gateway unless response.is_a?(Net::HTTPSuccess)

    data = JSON.parse(response.body)
    places = data["elements"].filter_map do |el|
      tags = el["tags"] || {}
      # Ways return a "center" object; nodes have lat/lon at the top level
      lat = el["lat"] || el.dig("center", "lat")
      lng = el["lon"] || el.dig("center", "lon")
      next unless lat && lng

      is_cemetery = tags["amenity"] == "grave_yard" || tags["landuse"] == "cemetery"
      is_bakery = tags["shop"] == "bakery"
      name = tags["name"] || (is_cemetery ? "Cimetière" : is_bakery ? "Boulangerie" : nil)
      next unless name

      poi_type = if is_cemetery then "cemetery"
                 elsif is_bakery then "bakery"
                 else tags["place"]
                 end
      { lat: lat, lng: lng, name: name, type: poi_type }
    end

    render json: places
  # Overpass est un service externe : tout échec réseau (timeout, connexion
  # refusée, réseau injoignable, DNS, TLS…) ou réponse illisible est un vrai
  # échec de chargement (≠ « aucun lieu »). On renvoie un statut non-2xx pour
  # que le front affiche le message d'erreur + bouton réessayer, sans remonter
  # un 500 (l'échec d'un service externe best-effort n'est pas une erreur serveur).
  # SystemCallError couvre les Errno::* (ENETUNREACH, ECONNREFUSED, EHOSTUNREACH…).
  rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError,
         OpenSSL::SSL::SSLError, JSON::ParserError => e
    Rails.logger.warn("GeocodesController#places: #{e.class}: #{e.message}")
    render json: { error: "places_unavailable" }, status: :bad_gateway
  rescue => e
    Rails.logger.error("GeocodesController#places: #{e.class}: #{e.message}")
    render json: [], status: :internal_server_error
  end
end
