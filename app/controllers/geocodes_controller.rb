class GeocodesController < ApplicationController
  before_action :require_login!

  # Catégories POI (`osm_pois.category`) derrière chaque clé du paramètre `types`.
  # Les clés sont celles du registre front (`key` dans poiCategories.ts), les
  # valeurs ses `serverTypes`. La classification des éléments OSM est faite à
  # l'import (deploy/osm-pois/extract.py), pas ici.
  CATEGORIES_BY_TYPE = {
    "localities" => %w[city town village hamlet],
    "cemeteries" => %w[cemetery],
    "bakeries" => %w[bakery],
    "water" => %w[water],
    "food" => %w[food],
    "viewpoints" => %w[viewpoint],
    "toilets" => %w[toilets],
    "picnic" => %w[picnic],
    "parking" => %w[parking],
  }.freeze

  DEFAULT_TYPES = %w[localities cemeteries bakeries].freeze

  # Noms par défaut pour les POI sans tag `name` (cas fréquent pour l'eau, les
  # toilettes, les aires de pique-nique). Doit rester aligné sur les catégories
  # de CATEGORIES_BY_TYPE et le registre POI côté front (poiCategories.ts).
  DEFAULT_POI_NAMES = {
    "cemetery" => "Cimetière",
    "bakery" => "Boulangerie",
    "water" => "Point d'eau",
    "food" => "Restaurant",
    "viewpoint" => "Point de vue",
    "toilets" => "Toilettes",
    "picnic" => "Aire de pique-nique",
    "parking" => "Parking",
  }.freeze

  def places
    south = params.require(:south).to_f
    west  = params.require(:west).to_f
    north = params.require(:north).to_f
    east  = params.require(:east).to_f

    # On ne renvoie que les catégories demandées par le client (pilotées par les
    # préférences du profil). Sans paramètre `types`, on retombe sur un défaut.
    types = (params[:types].presence&.split(",") || DEFAULT_TYPES)
    categories = types.flat_map { |t| CATEGORIES_BY_TYPE[t] || [] }.uniq
    return render json: [] if categories.empty?

    places = OsmPoi.in_bbox(south, west, north, east).where(category: categories)
      .pluck(:lat, :lng, :name, :category)
      .filter_map do |lat, lng, name, category|
        # `name` est NULL pour les POI OSM sans tag `name` : le libellé par défaut
        # est appliqué ici, où la catégorie a un sens métier. Une localité sans nom
        # n'a en revanche rien à afficher, elle est écartée.
        label = name.presence || DEFAULT_POI_NAMES[category]
        next unless label

        { lat: lat, lng: lng, name: label, type: category }
      end

    render json: places
  # Catalogue OSM injoignable ou pas encore importé (première synchro de `poi-sync`
  # en cours) : c'est un vrai échec de chargement (≠ « aucun lieu »). On renvoie un
  # statut non-2xx pour que le front affiche son message d'erreur + bouton
  # réessayer, sans remonter un 500 — l'absence temporaire du catalogue n'est pas
  # une erreur applicative.
  rescue ActiveRecord::StatementInvalid, ActiveRecord::ConnectionNotEstablished,
         ActiveRecord::NoDatabaseError => e
    Rails.logger.warn("GeocodesController#places: #{e.class}: #{e.message}")
    render json: { error: "places_unavailable" }, status: :bad_gateway
  rescue => e
    Rails.logger.error("GeocodesController#places: #{e.class}: #{e.message}")
    render json: [], status: :internal_server_error
  end
end
