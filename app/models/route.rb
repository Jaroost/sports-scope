class Route < ApplicationRecord
  # Catégorie d'activité — pilote la vitesse moyenne d'estimation, l'icône de la
  # liste et le fond de sentiers. Le profil de routage BRouter (`profile`) lui est
  # lié mais réglable indépendamment (cf. brouter.ts / PROFILES_BY_SPORT).
  ACTIVITIES = %w[cycling mtb hiking].freeze

  belongs_to :user
  # Unguessable token for public, shareable navigation links.
  has_secure_token :share_token
  validates :name, presence: true, length: { maximum: 80 }
  validates :waypoints, presence: true
  validates :activity, inclusion: { in: ACTIVITIES }

  # Aperçu du tracé : chemin SVG normalisé pré-calculé depuis la géométrie, stocké
  # pour éviter d'envoyer les milliers de points au listing. Recalculé seulement
  # quand la géométrie change (création, édition, import GPX, duplication).
  before_save :assign_preview_path, if: :will_save_change_to_geometry?

  # Côté SVG rendu : viewBox carré `0 0 100 100`. Le tracé est projeté, mis à
  # l'échelle pour tenir dans la boîte (avec marge), et centré.
  PREVIEW_SIZE = 100.0
  PREVIEW_PADDING = 6.0
  # Nombre max de points conservés dans l'aperçu (sous-échantillonnage régulier) :
  # largement suffisant pour une vignette, garde la chaîne `d` sous ~1-2 Ko.
  PREVIEW_MAX_POINTS = 140

  # Construit le `d` d'un <path> SVG (viewBox 0 0 100 100) depuis une géométrie
  # `[[lng, lat, ele], ...]`. Retourne nil si moins de 2 points exploitables.
  def self.build_preview_path(geometry)
    pts = Array(geometry).filter_map do |pt|
      lng, lat = pt[0], pt[1]
      [lng.to_f, lat.to_f] if lng.is_a?(Numeric) && lat.is_a?(Numeric)
    end
    return nil if pts.size < 2

    pts = downsample(pts, PREVIEW_MAX_POINTS)

    # Projection équirectangulaire : on compresse la longitude par cos(lat_moyen)
    # pour conserver un ratio visuellement correct à cette latitude.
    mean_lat = pts.sum { |_, lat| lat } / pts.size
    cos_lat = Math.cos(mean_lat * Math::PI / 180)
    proj = pts.map { |lng, lat| [lng * cos_lat, lat] }

    xs = proj.map(&:first)
    ys = proj.map(&:last)
    min_x, max_x = xs.minmax
    min_y, max_y = ys.minmax
    span_x = max_x - min_x
    span_y = max_y - min_y
    inner = PREVIEW_SIZE - 2 * PREVIEW_PADDING
    scale = inner / [span_x, span_y, 1e-9].max
    off_x = PREVIEW_PADDING + (inner - span_x * scale) / 2
    off_y = PREVIEW_PADDING + (inner - span_y * scale) / 2

    coords = proj.map do |x, y|
      px = off_x + (x - min_x) * scale
      # SVG : l'axe y descend, donc on inverse (nord en haut).
      py = PREVIEW_SIZE - (off_y + (y - min_y) * scale)
      "#{format('%.1f', px)},#{format('%.1f', py)}"
    end
    "M#{coords.first} L#{coords.drop(1).join(' ')}"
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

  def assign_preview_path
    self.preview_path = self.class.build_preview_path(geometry)
  end
end
