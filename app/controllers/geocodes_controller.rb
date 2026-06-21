class GeocodesController < ApplicationController
  before_action :require_login!

  # Noms par défaut pour les POI sans tag `name` (cas fréquent pour l'eau, les
  # toilettes, les aires de pique-nique). Doit rester aligné sur les `type`
  # renvoyés par #classify_poi et le registre POI côté front (poiCategories.ts).
  DEFAULT_POI_NAMES = {
    "cemetery" => "Cimetière",
    "bakery" => "Boulangerie",
    "water" => "Point d'eau",
    "food" => "Restaurant",
    "viewpoint" => "Point de vue",
    "toilets" => "Toilettes",
    "picnic" => "Aire de pique-nique",
  }.freeze

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
    if types.include?("water")
      clauses << %(node["amenity"="drinking_water"](#{bbox});)
      clauses << %(node["natural"="spring"]["drinking_water"="yes"](#{bbox});)
    end
    if types.include?("food")
      clauses << %(node["amenity"~"^(cafe|restaurant)$"](#{bbox});)
      clauses << %(way["amenity"~"^(cafe|restaurant)$"](#{bbox});)
    end
    if types.include?("viewpoints")
      clauses << %(node["tourism"="viewpoint"](#{bbox});)
      clauses << %(node["natural"="peak"](#{bbox});)
      clauses << %(node["natural"="saddle"](#{bbox});)
      clauses << %(node["mountain_pass"="yes"](#{bbox});)
    end
    if types.include?("toilets")
      clauses << %(node["amenity"="toilets"](#{bbox});)
      clauses << %(way["amenity"="toilets"](#{bbox});)
    end
    if types.include?("picnic")
      clauses << %(node["tourism"="picnic_site"](#{bbox});)
      clauses << %(node["leisure"="picnic_table"](#{bbox});)
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

      poi_type = classify_poi(tags)
      next unless poi_type

      name = tags["name"].presence || DEFAULT_POI_NAMES[poi_type]
      next unless name

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

  private

  # Classe un élément OSM (ses tags) dans une catégorie POI. Le `type` renvoyé doit
  # rester aligné sur les `serverTypes` du registre front (poiCategories.ts).
  # nil = élément non reconnu (ignoré). Points de vue, sommets et cols sont
  # regroupés sous "viewpoint" (une seule catégorie côté profil).
  def classify_poi(tags)
    return "cemetery" if tags["amenity"] == "grave_yard" || tags["landuse"] == "cemetery"
    return "bakery" if tags["shop"] == "bakery"
    return "water" if tags["amenity"] == "drinking_water" || tags["natural"] == "spring"
    return "food" if %w[cafe restaurant].include?(tags["amenity"])
    if tags["tourism"] == "viewpoint" || tags["natural"] == "peak" ||
       tags["natural"] == "saddle" || tags["mountain_pass"] == "yes"
      return "viewpoint"
    end
    return "toilets" if tags["amenity"] == "toilets"
    return "picnic" if tags["tourism"] == "picnic_site" || tags["leisure"] == "picnic_table"
    return tags["place"] if %w[city town village hamlet].include?(tags["place"])

    nil
  end
end
