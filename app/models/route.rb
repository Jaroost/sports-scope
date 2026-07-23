class Route < ApplicationRecord
  # Catégorie d'activité — pilote la vitesse moyenne d'estimation, l'icône de la
  # liste et le fond de sentiers. Le profil de routage BRouter (`profile`) lui est
  # lié mais réglable indépendamment (cf. brouter.ts / PROFILES_BY_SPORT).
  ACTIVITIES = %w[cycling mtb hiking].freeze

  # Fonds de carte proposés à l'auteur pour son lien de partage — doit rester aligné
  # sur MAP_STYLES (app/javascript/mapStyles.ts). `nil` (aucune consigne) reste la
  # valeur par défaut : le destinataire voit alors son propre fond.
  SHARE_MAP_STYLES = %w[cyclosm topo liberty swissgrau swisstopo swissimage].freeze

  belongs_to :user
  # Traces d'ouverture par d'autres utilisateurs (via lien partagé) — purgées avec l'itinéraire.
  has_many :opened_routes, dependent: :destroy
  # Jours où cet itinéraire est prévu : un itinéraire supprimé ne doit pas laisser
  # de plan orphelin dans la semaine.
  has_many :planned_rides, dependent: :destroy
  # Unguessable token for public, shareable navigation links.
  has_secure_token :share_token
  validates :name, presence: true, length: { maximum: 80 }
  validates :waypoints, presence: true
  validates :activity, inclusion: { in: ACTIVITIES }
  validates :share_map_style, inclusion: { in: SHARE_MAP_STYLES }, allow_nil: true

  # Aperçu du tracé : polyligne SVG pré-calculée depuis la géométrie et découpée
  # en segments colorés par pente (montée / descente / plat), stockée pour éviter
  # d'envoyer les milliers de points au listing. Recalculé seulement quand la
  # géométrie change (création, édition, import GPX, duplication).
  before_save :assign_geometry_derivatives, if: :will_save_change_to_geometry?

  # Lieux traversés (`localities`) : extraits du catalogue OSM en tâche de fond à chaque
  # changement de tracé, pour la recherche par lieu dans la liste. after_commit —
  # le job doit voir la géométrie enregistrée, et ne pas partir si la transaction
  # est annulée.
  after_commit :extract_localities_later, on: %i[create update], if: :saved_change_to_geometry?

  # Côté SVG rendu : viewBox carré `0 0 100 100`. Le tracé est projeté, mis à
  # l'échelle pour tenir dans la boîte (avec marge), et centré.
  PREVIEW_SIZE = 100.0
  PREVIEW_PADDING = 6.0
  # Nombre max de points conservés dans l'aperçu (sous-échantillonnage régulier) :
  # largement suffisant pour une vignette, garde la charge utile compacte.
  PREVIEW_MAX_POINTS = 140
  # Seuil de pente (%) au-delà duquel un segment est classé montée (1) ou
  # descente (2) ; en deçà, plat (0). En dessous de 3 %, l'œil ne distingue pas
  # vraiment de dénivelé sur une vignette.
  PREVIEW_GRADE_THRESHOLD = 3.0
  # Nombre max de points de la polyligne géographique servie à la carte d'ensemble
  # (liste des itinéraires). Sous-échantillonnée + arrondie pour rester légère à
  # charger pour tous les itinéraires d'un coup, tout en restant fidèle au tracé.
  MAP_MAX_POINTS = 200

  # Polyligne géographique simplifiée `[[lng, lat], ...]` pour l'aperçu carte de la
  # liste — coords réelles (pas normalisées comme l'aperçu SVG). Retourne nil si
  # moins de 2 points exploitables.
  def self.build_map_polyline(geometry)
    pts = Array(geometry).filter_map do |pt|
      lng, lat = pt[0], pt[1]
      [lng.to_f.round(5), lat.to_f.round(5)] if lng.is_a?(Numeric) && lat.is_a?(Numeric)
    end
    return nil if pts.size < 2
    downsample(pts, MAP_MAX_POINTS)
  end

  # Découpe la géométrie `[[lng, lat, ele], ...]` en runs de pente homogène et
  # renvoie une liste de segments `{ "c" => catégorie, "d" => path SVG }` (viewBox
  # 0 0 100 100). Retourne nil si moins de 2 points exploitables. Catégories :
  # 0 = plat, 1 = montée, 2 = descente.
  def self.build_preview_segments(geometry)
    runs = preview_runs(geometry)
    return nil unless runs

    runs.map do |run|
      coords = run[:points].map { |x, y| "#{format('%.1f', x)},#{format('%.1f', y)}" }
      { "c" => run[:cat], "d" => "M#{coords.first} L#{coords.drop(1).join(' ')}" }
    end
  end

  # Runs de pente homogène en coordonnées écran numériques `[[x, y], ...]`, dans une
  # boîte `width` × `height`. Base commune de l'aperçu SVG (liste, page de partage,
  # boîte carrée) et de la vignette PNG Open Graph (cf. RoutePreviewImage, boîte
  # paysage), qui n'a que faire des chaînes de path. Retourne nil si moins de 2
  # points exploitables.
  def self.preview_runs(geometry, width: PREVIEW_SIZE, height: width, padding: PREVIEW_PADDING)
    pts = Array(geometry).filter_map do |pt|
      lng, lat, ele = pt[0], pt[1], pt[2]
      next unless lng.is_a?(Numeric) && lat.is_a?(Numeric)
      [lng.to_f, lat.to_f, (ele.is_a?(Numeric) ? ele.to_f : nil)]
    end
    return nil if pts.size < 2

    pts = downsample(pts, PREVIEW_MAX_POINTS)
    screen = project_to_screen(pts, width: width, height: height, padding: padding)

    # Catégorie de pente pour chaque segment [i, i+1].
    cats = pts.each_cons(2).map { |a, b| segment_category(a, b) }

    # Regroupe les segments consécutifs de même catégorie en runs (chaque run
    # partage son point limite avec le suivant → tracé continu, sans trou).
    runs = []
    cats.each_with_index do |cat, i|
      if runs.last && runs.last[:cat] == cat
        runs.last[:last] = i + 1
      else
        runs << { cat: cat, first: i, last: i + 1 }
      end
    end

    runs.map { |run| { cat: run[:cat], points: screen[run[:first]..run[:last]] } }
  end

  # Projette les points en coordonnées écran `[x, y]` dans la boîte `width` × `height`,
  # ratio préservé (compression cos(lat)), centré dans les deux axes, nord en haut.
  def self.project_to_screen(pts, width: PREVIEW_SIZE, height: width, padding: PREVIEW_PADDING)
    mean_lat = pts.sum { |_, lat, _| lat } / pts.size
    cos_lat = Math.cos(mean_lat * Math::PI / 180)
    proj = pts.map { |lng, lat, _| [lng * cos_lat, lat] }

    min_x, max_x = proj.map(&:first).minmax
    min_y, max_y = proj.map(&:last).minmax
    span_x = [max_x - min_x, 1e-9].max
    span_y = [max_y - min_y, 1e-9].max
    inner_w = width - 2 * padding
    inner_h = height - 2 * padding
    # L'échelle est commune aux deux axes (sinon le tracé est déformé) : c'est la
    # dimension la plus contrainte qui la fixe.
    scale = [inner_w / span_x, inner_h / span_y].min
    off_x = padding + (inner_w - span_x * scale) / 2
    off_y = padding + (inner_h - span_y * scale) / 2

    proj.map do |x, y|
      px = off_x + (x - min_x) * scale
      # SVG : l'axe y descend, donc on inverse (nord en haut).
      py = height - (off_y + (y - min_y) * scale)
      [px, py]
    end
  end

  # Classe un segment [lng, lat, ele] → [lng, lat, ele] par sa pente.
  def self.segment_category(a, b)
    ele_a, ele_b = a[2], b[2]
    return 0 if ele_a.nil? || ele_b.nil?
    dist = haversine_m(a[0], a[1], b[0], b[1])
    return 0 if dist < 1
    grade = (ele_b - ele_a) / dist * 100
    return 1 if grade > PREVIEW_GRADE_THRESHOLD
    return 2 if grade < -PREVIEW_GRADE_THRESHOLD
    0
  end

  # Distance en mètres entre deux points (lng/lat en degrés).
  def self.haversine_m(lng1, lat1, lng2, lat2)
    r = 6_371_000.0
    p1 = lat1 * Math::PI / 180
    p2 = lat2 * Math::PI / 180
    dphi = (lat2 - lat1) * Math::PI / 180
    dlambda = (lng2 - lng1) * Math::PI / 180
    h = Math.sin(dphi / 2)**2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlambda / 2)**2
    2 * r * Math.asin(Math.sqrt(h))
  end

  # Bornes de la vitesse enregistrée — mêmes que le front (speedForSport,
  # userPreferences.ts) : au-delà, la valeur ne vient pas d'un réglage sensé.
  SPEED_RANGE = (3.0..80.0)

  # Vitesse moyenne (km/h) servant à l'estimation de durée. La valeur enregistrée avec
  # l'itinéraire prime — le créateur a pu l'ajuster pour ce tracé précis, et la page de
  # partage doit annoncer ce qu'il voyait. À défaut (itinéraires d'avant la colonne),
  # on retombe sur le réglage du profil pour ce sport, miroir serveur de speedForSport().
  def avg_speed_kmh
    return self[:avg_speed_kmh].to_f if SPEED_RANGE.cover?(self[:avg_speed_kmh].to_f)
    speed = user&.preferences_with_defaults&.dig("sports", activity, "speed")
    return speed.to_f if speed.is_a?(Numeric) && SPEED_RANGE.cover?(speed.to_f)
    User::DEFAULT_PREFERENCES.dig("sports", activity, "speed").to_f
  end

  # Durée estimée (s) — miroir serveur de routeStore.estimatedSeconds (routeStore.ts).
  # Les deux formules doivent rester alignées : la page de partage et le créateur
  # affichent la même estimation pour un même itinéraire.
  def estimated_seconds
    v = avg_speed_kmh
    return 0 unless distance_m.to_f.positive? && v.positive?
    ((distance_m.to_f / 1000) / v * 3600).round
  end

  # Sous-échantillonnage régulier à au plus `max` points, dernier point conservé.
  def self.downsample(pts, max)
    return pts if pts.size <= max
    stride = (pts.size.to_f / max).ceil
    sampled = pts.each_slice(stride).map(&:first)
    sampled << pts.last unless sampled.last.equal?(pts.last)
    sampled
  end

  private

  def assign_geometry_derivatives
    self.preview_segments = self.class.build_preview_segments(geometry)
    self.map_polyline = self.class.build_map_polyline(geometry)
  end

  def extract_localities_later
    ExtractRouteLocalitiesJob.perform_later(id)
  end
end
