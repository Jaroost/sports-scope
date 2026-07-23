# Extrait les localités (villes, villages, hameaux) traversées par un tracé, pour
# alimenter `routes.localities` / `strava_activities.localities` et rendre les
# itinéraires et les sorties cherchables par lieu (« mes sorties qui passent par
# Gruyères »).
#
# L'extraction est faite côté serveur, et non depuis les POI postés par le créateur
# (`routes.pois`) : ceux-ci reflètent les préférences d'affichage du profil
# (`points_of_interest`), donc un utilisateur ayant masqué les localités n'en
# enregistrerait aucune et ses itinéraires seraient introuvables. La recherche ne
# doit pas dépendre d'un réglage d'affichage.
class LocalitiesExtractor
  PLACE_TYPES = %w[city town village hamlet].freeze
  # Distance max (m) entre une localité et le tracé pour la considérer traversée.
  # Aligné sur le seuil des localités du créateur (RouteBuilder.vue, THRESHOLD_M).
  THRESHOLD_M = 2000
  # Marge (deg) ajoutée à la bbox pour ramener aussi les localités juste au-delà
  # des extrémités du tracé — sinon elles seraient coupées à la bbox alors
  # qu'elles sont dans le seuil.
  BBOX_BUFFER_DEG = 0.03
  # Le test de proximité est en O(points × localités) : on sous-échantillonne le
  # tracé (jusqu'à 10 000 points en base). À ce nombre de points, l'écart entre
  # deux points reste très inférieur au seuil de 2 km, donc le résultat est
  # inchangé.
  MAX_GEOMETRY_POINTS = 2_000
  # Garde-fou : au-delà, ce n'est plus une liste de lieux exploitable pour la
  # recherche, et on évite de stocker un jsonb qui gonfle sans borne.
  MAX_LOCALITIES = 200

  def initialize(geometry)
    @geometry = Array(geometry)
  end

  # Renvoie les noms de localités uniques, ordonnés le long du tracé. Lève les
  # erreurs de connexion à la base `osm` (catalogue pas encore importé) — le job
  # retente.
  def call
    matches.map { |name, _country, _idx| name }.uniq.first(MAX_LOCALITIES)
  end

  # Pays traversés (ISO 3166-1 alpha-2), dans l'ordre de traversée. Déduits des
  # localités retenues : le pays vient de l'extrait Geofabrik dont la localité est
  # issue (cf. deploy/osm-pois/sync.sh), OSM ne le portant pas sur les objets.
  #
  # Conséquence assumée du seuil commun : un pays n'est listé que si le tracé passe
  # à moins de THRESHOLD_M d'une de ses localités. Une incursion par un col désert,
  # sans village à 2 km, n'est donc pas comptée — préférable à l'inverse, où un
  # tracé longeant une frontière listerait le pays d'en face.
  def countries
    matches.filter_map { |_name, country, _idx| country.presence }.uniq
  end

  private

  # `[nom, pays, index du point le plus proche]` des localités traversées, ordonnées
  # le long du tracé. Une seule passe : `call` et `countries` sont appelés d'affilée
  # sur la même instance (job, backfill).
  def matches
    @matches ||= begin
      pts = usable_points
      if pts.size < 2
        []
      else
        named = localities_in_bbox(pts).filter_map do |lat, lng, name, country|
          # Les localités sans nom ne servent à rien ici : `localities` est une liste
          # de noms cherchables.
          next unless name.present?
          [ name, country, lat.to_f, lng.to_f ]
        end

        # Position le long du tracé (index du point le plus proche) → ordre de
        # traversée. Un même nom peut apparaître plusieurs fois dans OSM : les
        # doublons sont retirés par les appelants, qui gardent la première occurrence.
        named.filter_map do |name, country, lat, lng|
          idx, dist = nearest_point(pts, lat, lng)
          next if dist > THRESHOLD_M
          [ name, country, idx ]
        end.sort_by(&:last)
      end
    end
  end

  # Points `[lng, lat]` exploitables, sous-échantillonnés pour le test de proximité.
  def usable_points
    pts = @geometry.filter_map do |pt|
      lng, lat = pt[0], pt[1]
      [ lng.to_f, lat.to_f ] if lng.is_a?(Numeric) && lat.is_a?(Numeric)
    end
    Route.downsample(pts, MAX_GEOMETRY_POINTS)
  end

  # `[lat, lng, name, country]` des localités du catalogue OSM dans la bbox du tracé.
  # `country` est nul pour les catalogues importés avant l'ajout de la colonne (une
  # resynchro de `poi-sync` la remplit) ou pour un extrait hors table des pays.
  def localities_in_bbox(pts)
    lats = pts.map(&:last)
    lngs = pts.map(&:first)

    scope = OsmPoi.in_bbox(
      lats.min - BBOX_BUFFER_DEG, lngs.min - BBOX_BUFFER_DEG,
      lats.max + BBOX_BUFFER_DEG, lngs.max + BBOX_BUFFER_DEG,
    ).where(category: PLACE_TYPES)

    # Catalogue importé avant l'ajout de la colonne : on continue d'extraire les
    # localités (le pays reste vide) plutôt que de faire échouer toute l'extraction
    # sur un `PG::UndefinedColumn`.
    return scope.pluck(:lat, :lng, :name).map { |lat, lng, name| [ lat, lng, name, nil ] } unless country_column?

    scope.pluck(:lat, :lng, :name, :country)
  end

  def country_column?
    OsmPoi.column_names.include?("country")
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
