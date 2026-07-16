# Extrait les localités (villes, villages, hameaux) traversées par un itinéraire,
# pour alimenter `routes.localities` et rendre les itinéraires cherchables par lieu
# (« mes sorties qui passent par Gruyères »).
#
# L'extraction est faite côté serveur, et non depuis les POI postés par le créateur
# (`routes.pois`) : ceux-ci reflètent les préférences d'affichage du profil
# (`points_of_interest`), donc un utilisateur ayant masqué les localités n'en
# enregistrerait aucune et ses itinéraires seraient introuvables. La recherche ne
# doit pas dépendre d'un réglage d'affichage.
class RouteLocalitiesExtractor
  PLACE_TYPES = %w[city town village hamlet].freeze
  # Distance max (m) entre une localité et le tracé pour la considérer traversée.
  # Aligné sur le seuil des localités du créateur (RouteBuilder.vue, THRESHOLD_M).
  THRESHOLD_M = 2000
  # Marge (deg) ajoutée à la bbox pour qu'Overpass renvoie aussi les localités
  # juste au-delà des extrémités du tracé — sinon elles seraient coupées à la bbox
  # alors qu'elles sont dans le seuil.
  BBOX_BUFFER_DEG = 0.03
  # Le test de proximité est en O(points × localités) : on sous-échantillonne le
  # tracé (jusqu'à 10 000 points en base). À ce nombre de points, l'écart entre
  # deux points reste très inférieur au seuil de 2 km, donc le résultat est
  # inchangé.
  MAX_GEOMETRY_POINTS = 2_000
  # Garde-fou : au-delà, ce n'est plus une liste de lieux exploitable pour la
  # recherche, et on évite de stocker un jsonb qui gonfle sans borne.
  MAX_LOCALITIES = 200

  def initialize(geometry, host: nil)
    @geometry = Array(geometry)
    @host = host
  end

  # Renvoie les noms de localités uniques, ordonnés le long du tracé. Lève
  # OverpassClient::Error si Overpass est injoignable (le job retente).
  def call
    pts = usable_points
    return [] if pts.size < 2

    elements = OverpassClient.elements(overpass_query(pts), host: @host)

    named = elements.filter_map do |el|
      tags = el["tags"] || {}
      next unless PLACE_TYPES.include?(tags["place"])
      name = tags["name"].presence
      next unless name
      lat = el["lat"] || el.dig("center", "lat")
      lng = el["lon"] || el.dig("center", "lon")
      next unless lat && lng
      [ name, lat.to_f, lng.to_f ]
    end

    # Position le long du tracé (index du point le plus proche) → ordre de
    # traversée. Un même nom peut apparaître plusieurs fois dans OSM : on garde
    # sa première occurrence.
    nearest = named.filter_map do |name, lat, lng|
      idx, dist = nearest_point(pts, lat, lng)
      next if dist > THRESHOLD_M
      [ name, idx ]
    end

    nearest.sort_by(&:last).map(&:first).uniq.first(MAX_LOCALITIES)
  end

  private

  # Points `[lng, lat]` exploitables, sous-échantillonnés pour le test de proximité.
  def usable_points
    pts = @geometry.filter_map do |pt|
      lng, lat = pt[0], pt[1]
      [ lng.to_f, lat.to_f ] if lng.is_a?(Numeric) && lat.is_a?(Numeric)
    end
    Route.downsample(pts, MAX_GEOMETRY_POINTS)
  end

  def overpass_query(pts)
    lats = pts.map(&:last)
    lngs = pts.map(&:first)
    south = lats.min - BBOX_BUFFER_DEG
    north = lats.max + BBOX_BUFFER_DEG
    west  = lngs.min - BBOX_BUFFER_DEG
    east  = lngs.max + BBOX_BUFFER_DEG
    bbox = "#{south},#{west},#{north},#{east}"

    <<~OVERPASS
      [out:json][timeout:25];
      node["place"~"^(#{PLACE_TYPES.join('|')})$"](#{bbox});
      out center;
    OVERPASS
  end

  # Index du point du tracé le plus proche de (lat, lng) et sa distance en mètres.
  # Comparaison sur les carrés en degrés (avec compression cos(lat)) pour éviter un
  # haversine par point ; seul le point retenu est mesuré précisément.
  def nearest_point(pts, lat, lng)
    cos_lat = Math.cos(lat * Math::PI / 180)
    best_idx = 0
    best_d2 = Float::INFINITY
    pts.each_with_index do |(p_lng, p_lat), i|
      d_lng = (p_lng - lng) * cos_lat
      d_lat = p_lat - lat
      d2 = d_lng * d_lng + d_lat * d_lat
      if d2 < best_d2
        best_d2 = d2
        best_idx = i
      end
    end
    [ best_idx, Route.haversine_m(pts[best_idx][0], pts[best_idx][1], lng, lat) ]
  end
end
