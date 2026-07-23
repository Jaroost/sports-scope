# Formatage des chiffres de la page de partage (pages#route_summary). Ces valeurs
# sont rendues côté serveur — elles partent aussi dans `og:description`, lu par les
# messageries — d'où des formats courts et sans dépendance au JS.
module RouteSummaryHelper
  # Lieux traversés affichés en toutes lettres sur la page ; au-delà on ne compte plus
  # que le reste (un 120 km traverse facilement une centaine de hameaux).
  MAX_LOCALITIES = 12
  # Idem pour `og:description`, où la place est bien plus comptée : les messageries
  # tronquent l'aperçu autour de 150 caractères.
  DESCRIPTION_LOCALITIES = 4

  # Jeton de version du lien de partage. Les messageries (WhatsApp, Signal, Slack,
  # iMessage) mettent l'aperçu en cache sur l'URL seule et ne la recrawlent jamais :
  # sans ce paramètre, un itinéraire renommé garderait son ancien titre dans tous les
  # aperçus déjà générés. Le suffixer d'`updated_at` donne une URL neuve à chaque
  # modification, donc un aperçu regénéré, sans invalider les anciens liens (le
  # paramètre est ignoré par le routeur).
  def summary_version(route)
    route.updated_at.to_i
  end

  # Drapeau emoji d'un code ISO 3166-1 alpha-2 : deux indicateurs régionaux (U+1F1E6
  # + rang de la lettre). Même dérivation que countryFlag() côté front (countries.ts),
  # donc aucune image à servir. Chaîne vide si le code n'a pas la bonne forme.
  def summary_country_flag(code)
    normalized = code.to_s.upcase
    return "" unless normalized.match?(/\A[A-Z]{2}\z/)

    normalized.chars.map { |c| (c.ord - "A".ord + 0x1F1E6) }.pack("U*")
  end

  # Nom localisé du pays. Repli sur le code en majuscules : la table de pays de
  # l'import (deploy/osm-pois/sync.sh) couvre plus large que les traductions.
  def summary_country_name(code)
    t("countries.#{code.to_s.downcase}", default: code.to_s.upcase)
  end

  def summary_km(meters)
    return "–" unless meters.to_f.positive?
    "#{number_with_precision(meters.to_f / 1000, precision: 1, delimiter: ' ')} km"
  end

  def summary_elevation(meters)
    return "–" if meters.nil?
    "#{number_with_delimiter(meters.to_f.round, delimiter: ' ')} m"
  end

  # Durée en h/min — au-delà d'une heure les minutes seules ne parlent plus.
  def summary_duration(seconds)
    return "–" unless seconds.to_i.positive?
    total_minutes = (seconds.to_f / 60).round
    hours, minutes = total_minutes.divmod(60)
    hours.positive? ? "#{hours} h #{format('%02d', minutes)}" : "#{minutes} min"
  end

  # Profil altimétrique de l'aperçu : viewBox `0 0 100 30`, distance en abscisse (pas
  # l'index des points, qui écraserait les portions denses) et altitude en ordonnée,
  # étirée sur toute la hauteur. Retourne une liste de tronçons de pente homogène
  # `{ color:, area:, line: }` (chemins SVG), ou nil si l'itinéraire n'a pas
  # d'altitudes exploitables.
  #
  # Rendu côté serveur comme le reste de la page : pas d'îlot Vue, donc pas de Chart.js.
  PROFILE_WIDTH = 100.0
  PROFILE_HEIGHT = 30.0
  # Le tracé ne touche ni le haut ni le bas de la boîte : le trait serait rogné.
  PROFILE_PADDING = 1.5
  # Assez de points pour que les cols se voient, assez peu pour que le HTML reste léger.
  PROFILE_MAX_POINTS = 240
  # Paliers de pente (%) et couleurs — miroir de GRADE_BUCKETS (routeHelpers.ts) pour
  # que la page de partage se lise comme le graphique du créateur d'itinéraire.
  PROFILE_GRADE_BUCKETS = [
    [ -8.0, "#1e3a8a" ],
    [ -3.0, "#3b82f6" ],
    [ 3.0, "#22c55e" ],
    [ 6.0, "#eab308" ],
    [ 10.0, "#f97316" ],
    [ 15.0, "#dc2626" ],
    [ Float::INFINITY, "#7f1d1d" ],
  ].freeze
  # Repli de la fenêtre de lissage de pente, comme gradeSmoothingM() côté front.
  PROFILE_SMOOTHING_M = 40.0

  def summary_profile(route)
    pts = Array(route.geometry).filter_map do |pt|
      lng, lat, ele = pt[0], pt[1], pt[2]
      [ lng.to_f, lat.to_f, ele.to_f ] if lng.is_a?(Numeric) && lat.is_a?(Numeric) && ele.is_a?(Numeric)
    end
    return nil if pts.size < 2

    # Distance cumulée AVANT sous-échantillonnage : sinon les points supprimés
    # raccourciraient le parcours.
    cumulative = [ 0.0 ]
    pts.each_cons(2) { |a, b| cumulative << cumulative.last + Route.haversine_m(a[0], a[1], b[0], b[1]) }
    total = cumulative.last
    return nil unless total.positive?

    samples = Route.downsample(pts.each_with_index.map { |p, i| [ cumulative[i], p[2] ] }, PROFILE_MAX_POINTS)
    min_ele, max_ele = samples.map(&:last).minmax
    span = max_ele - min_ele
    inner = PROFILE_HEIGHT - 2 * PROFILE_PADDING

    coords = samples.map do |dist, ele|
      x = dist / total * PROFILE_WIDTH
      # Itinéraire parfaitement plat : on centre la ligne plutôt que de diviser par zéro.
      y = span.positive? ? PROFILE_HEIGHT - PROFILE_PADDING - (ele - min_ele) / span * inner : PROFILE_HEIGHT / 2
      [ x, y ]
    end

    colors = profile_segment_colors(samples, profile_smoothing_m(route))
    runs = profile_runs(coords, colors)
    return nil unless runs

    { runs: runs, grid: profile_grid(min_ele, max_ele, span, inner) }
  end

  # Lignes horizontales de repère, tous les 100 m d'altitude. Sur un profil très creusé,
  # 100 m donnerait une ligne tous les 3 px : on passe alors au palier supérieur plutôt
  # que de noircir la bande. Retourne les ordonnées SVG, ou [] si l'itinéraire est plat.
  PROFILE_GRID_STEPS_M = [ 100, 200, 500, 1000 ].freeze
  PROFILE_GRID_MAX_LINES = 8

  def profile_grid(min_ele, max_ele, span, inner)
    return [] unless span.positive?

    step = PROFILE_GRID_STEPS_M.find { |s| span / s <= PROFILE_GRID_MAX_LINES } || PROFILE_GRID_STEPS_M.last
    first = (min_ele / step).ceil * step
    first.step(max_ele, step).map do |ele|
      (PROFILE_HEIGHT - PROFILE_PADDING - (ele - min_ele) / span * inner).round(2)
    end
  end

  # Couleur de chaque segment [i, i+1] des points échantillonnés, d'après la pente
  # lissée sur une fenêtre horizontale — miroir de gradeForIndex (routeHelpers.ts).
  # Sans lissage, l'altitude quantifiée au mètre donne des pentes aberrantes entre
  # points voisins.
  def profile_segment_colors(samples, window_m)
    half = window_m / 2
    n = samples.size
    (0...n - 1).map do |i|
      mid = (samples[i][0] + samples[i + 1][0]) / 2
      lo = i
      lo -= 1 while lo > 0 && mid - samples[lo][0] < half
      hi = i + 1
      hi += 1 while hi < n - 1 && samples[hi][0] - mid < half
      dd = samples[hi][0] - samples[lo][0]
      grade = dd.positive? ? (samples[hi][1] - samples[lo][1]) / dd * 100 : 0.0
      PROFILE_GRADE_BUCKETS.find { |max, _| grade < max }.last
    end
  end

  # Fenêtre de lissage réglée par le propriétaire pour ce sport (miroir serveur de
  # gradeSmoothingM), de sorte que le profil partagé colore comme son créateur le voit.
  def profile_smoothing_m(route)
    v = route.user&.preferences_with_defaults&.dig("sports", route.activity, "climb_detection", "grade_smoothing_m")
    v.is_a?(Numeric) && v.to_f.positive? ? v.to_f : PROFILE_SMOOTHING_M
  end

  # Regroupe les segments consécutifs de même couleur, et rend pour chacun le
  # remplissage (jusqu'à la ligne de base) et le trait. Les tronçons se chevauchent
  # d'un cheveu : sans cela, l'anticrénelage laisse un liseré clair à chaque jointure.
  def profile_runs(coords, colors)
    return nil if colors.empty?

    runs = []
    colors.each_with_index do |color, i|
      if runs.last && runs.last[:color] == color
        runs.last[:last] = i + 1
      else
        runs << { color: color, first: i, last: i + 1 }
      end
    end

    baseline = format("%.2f", PROFILE_HEIGHT)
    runs.map do |run|
      points = coords[run[:first]..run[:last]]
      d = points.each_with_index.map do |(x, y), i|
        x += 0.05 if i == points.size - 1 && run[:last] < coords.size - 1
        "#{format('%.2f', x)},#{format('%.2f', y)}"
      end
      {
        color: run[:color],
        line: "M#{d.first} L#{d.drop(1).join(' ')}",
        area: "M#{d.first} L#{d.drop(1).join(' ')} L#{d.last.split(',').first},#{baseline} L#{d.first.split(',').first},#{baseline} Z",
      }
    end
  end

  # Résumé d'une ligne, réutilisé par `og:description` et par le texte du partage
  # natif : c'est ce que voient les destinataires avant d'ouvrir le lien.
  def summary_description(route)
    parts = [
      summary_km(route.distance_m),
      "#{t('routes.summary.elevation_gain')} #{summary_elevation(route.elevation_gain_m)}",
      "#{t('routes.summary.duration')} #{summary_duration(route.estimated_seconds)}",
    ]
    localities = Array(route.localities).first(DESCRIPTION_LOCALITIES).join(", ")
    parts << localities if localities.present?
    parts.join(" · ")
  end
end
