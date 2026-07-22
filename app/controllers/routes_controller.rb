class RoutesController < ApplicationController
  # `shared` is public (token-based) so a shared navigation link works without
  # an account. Every other action stays scoped to the signed-in owner.
  before_action :require_login!, except: %i[shared export_gpx_shared preview_shared]

  DEFAULT_PER_PAGE = 20
  MAX_PER_PAGE = 200
  # Plafond de tracés renvoyés à la carte d'ensemble — même raison que côté
  # activités : au-delà, le rendu MapLibre devient lourd.
  MAX_MAP_ROUTES = 500
  MAX_WAYPOINTS = 500
  MAX_GEOMETRY_POINTS = 10_000
  MAX_NAME_LEN = 80
  # Profils de routage BRouter acceptés — union du catalogue front (brouter.ts /
  # PROFILES_BY_SPORT). Le profil enregistré pilote le tracé BRouter au rechargement.
  ALLOWED_PROFILES = %w[trekking fastbike fastbike-lowtraffic shortest gravel hiking-mountain].freeze
  ALLOWED_ACTIVITIES = Route::ACTIVITIES
  # Repères posés à la main (cf. routeMarkers.ts côté front) — types acceptés et
  # libellé GPX associé (repli quand l'utilisateur n'a pas saisi de libellé).
  MARKER_KINDS = %w[start finish parking].freeze
  MARKER_GPX_NAMES = { "start" => "Départ", "finish" => "Arrivée", "parking" => "Parking" }.freeze

  # GET /api/routes
  # Trois formes de réponse selon les params :
  #   - `?page=…`  : page filtrée + méta de pagination (liste des itinéraires)
  #   - `?map=1`   : tous les itinéraires du filtre (plafonnés), pour la carte d'ensemble
  #   - aucun      : historique complet, sans pagination — le sélecteur d'itinéraire
  #                  de la navigation (NavRoutePicker) liste tout d'un coup.
  def index
    return render json: routes_map_payload if params[:map].present?

    scope = filtered_routes_scope
    total = current_user.routes.count

    if params[:page].blank?
      return render json: {
        routes: scope.order(updated_at: :desc).map { |r| serialize_summary(r) },
        opened: opened_routes_summaries,
        total: total,
        filtered_total: scope.count,
      }
    end

    filtered_total = scope.count
    per_page = routes_per_page
    total_pages = filtered_total.zero? ? 0 : (filtered_total.to_f / per_page).ceil
    # Page bornée à [1, total_pages] pour éviter un offset au-delà des données.
    page = params[:page].to_i
    page = 1 if page < 1
    page = total_pages if total_pages.positive? && page > total_pages

    records = scope.order(updated_at: :desc).offset((page - 1) * per_page).limit(per_page)
    render json: {
      routes: records.map { |r| serialize_summary(r) },
      opened: opened_routes_summaries,
      total: total,
      filtered_total: filtered_total,
      page: page,
      per_page: per_page,
      total_pages: total_pages,
      # Types présents dans TOUT l'historique (pas seulement la page) — alimente
      # le menu du filtre.
      activities: current_user.routes.distinct.pluck(:activity).compact.sort,
    }
  end

  # GET /api/routes/:id
  def show
    route = current_user.routes.find_by(id: params[:id])
    return head :not_found unless route
    render json: { route: serialize_full(route) }
  end

  # GET /api/routes/shared/:token
  # Public, read-only lookup by unguessable token — powers shared navigation
  # links for signed-out recipients.
  def shared
    route = Route.find_by(share_token: params[:token])
    return head :not_found unless route
    record_open(route)
    # `owned` : le propriétaire qui ouvre son propre lien doit pouvoir repasser en
    # édition depuis la vue en lecture seule. Faux pour un visiteur non connecté.
    render json: { route: serialize_full(route).merge(owned: current_user&.id == route.user_id) }
  end

  # POST /api/routes
  def create
    attrs = sanitize_attrs(params)
    return render json: { error: "name required" }, status: :unprocessable_entity if attrs[:name].blank?
    route = current_user.routes.create!(attrs)
    render json: { route: serialize_full(route) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # PATCH /api/routes/:id
  def update
    route = current_user.routes.find_by(id: params[:id])
    return head :not_found unless route
    attrs = sanitize_attrs(params)
    # `compact` sert à ignorer les champs absents d'un PATCH partiel ; mais sur
    # avg_speed_kmh, `nil` est une valeur signifiante (« suivre le profil ») qu'il faut
    # pouvoir réécrire — on la réinjecte quand la clé était bien dans la charge utile.
    route.update!(attrs.compact.merge(attrs.slice(:avg_speed_kmh)))
    render json: { route: serialize_full(route) }
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # DELETE /api/routes/:id
  def destroy
    route = current_user.routes.find_by(id: params[:id])
    return head :not_found unless route
    route.destroy
    head :no_content
  end

  # GET /api/routes/:id/gpx
  def export_gpx
    route = current_user.routes.find_by(id: params[:id])
    return head :not_found unless route
    send_gpx(route)
  end

  # GET /api/routes/shared/:token/gpx — public, no login required
  def export_gpx_shared
    route = Route.find_by(share_token: params[:token])
    unless route
      redirect_to root_path, alert: t("routes.error_shared_not_found") and return
    end
    send_gpx(route)
  end

  # GET /api/routes/shared/:token/preview.png — public, no login required.
  # Vignette Open Graph de la page de partage : c'est un crawler (WhatsApp, Slack…)
  # qui la récupère, jamais un utilisateur connecté. Le rendu est mémoïsé sur
  # `updated_at` : une modification du tracé produit une nouvelle entrée de cache,
  # l'ancienne expire d'elle-même.
  def preview_shared
    route = Route.find_by(share_token: params[:token])
    return head :not_found unless route

    png = Rails.cache.fetch([ "route-og-preview", route.id, route.updated_at.to_i ]) do
      RoutePreviewImage.render(route)
    end
    # Pas de géométrie exploitable : l'icône de l'app fait un aperçu acceptable.
    return redirect_to "/icon.png", allow_other_host: false unless png

    expires_in 1.week, public: true
    send_data png, type: "image/png", disposition: "inline"
  end

  # POST /api/routes/:id/duplicate
  def duplicate
    src = current_user.routes.find_by(id: params[:id])
    return head :not_found unless src
    requested = params[:name].to_s.strip.first(MAX_NAME_LEN).presence
    copy_name = requested || "#{src.name} (copie)".first(MAX_NAME_LEN)
    new_route = current_user.routes.create!(
      name: copy_name,
      profile: src.profile,
      activity: src.activity,
      waypoints: src.waypoints,
      geometry: src.geometry,
      voice_hints: src.voice_hints,
      pois: src.pois,
      markers: src.markers,
      distance_m: src.distance_m,
      elevation_gain_m: src.elevation_gain_m,
      elevation_loss_m: src.elevation_loss_m,
      # La copie hérite de la vitesse propre à l'original (nil = réglage du profil).
      avg_speed_kmh: src[:avg_speed_kmh],
    )
    render json: { route: serialize_full(new_route) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  # Mémorise qu'un utilisateur connecté a ouvert l'itinéraire d'un AUTRE via un lien
  # partagé, pour l'exposer dans la catégorie « récemment ouverts » du sélecteur de
  # navigation. On ignore ses propres itinéraires (déjà listés) et les anonymes.
  # Rafraîchit `last_opened_at` à chaque réouverture (une ligne par paire user/route).
  def record_open(route)
    return unless current_user && route.user_id != current_user.id

    # Upsert atomique (ON CONFLICT sur l'index unique user/route) : évite la course
    # entre deux ouvertures simultanées, qui violerait l'unicité avec un
    # find_or_initialize + save. Écriture de tracé, on ne veut pas faire échouer la
    # requête publique si ça rate.
    now = Time.current
    OpenedRoute.upsert(
      { user_id: current_user.id, route_id: route.id, last_opened_at: now, created_at: now, updated_at: now },
      unique_by: %i[user_id route_id],
    )
  rescue StandardError => e
    Rails.logger.warn("[routes] record_open failed: #{e.message}")
  end

  # Résumés des itinéraires ouverts (les plus récents d'abord), dédupliqués des
  # itinéraires possédés au cas où l'utilisateur en serait devenu propriétaire depuis.
  def opened_routes_summaries
    current_user.opened_routes
                .where.not(route_id: current_user.routes.select(:id))
                .includes(:route)
                .order(last_opened_at: :desc)
                .filter_map { |o| serialize_summary(o.route).merge(last_opened_at: o.last_opened_at.iso8601) if o.route }
  end

  def sanitize_attrs(p)
    # Only include keys that were actually present in the payload so PATCH
    # requests with partial bodies (e.g. just `name` for an inline rename) do
    # not clobber waypoints/geometry with empty defaults.
    out = {}
    out[:name] = p[:name].to_s.strip.first(MAX_NAME_LEN).presence if p.key?(:name)
    out[:profile] = ALLOWED_PROFILES.include?(p[:profile].to_s) ? p[:profile] : "trekking" if p.key?(:profile)
    out[:activity] = ALLOWED_ACTIVITIES.include?(p[:activity].to_s) ? p[:activity] : "cycling" if p.key?(:activity)
    out[:waypoints] = clean_waypoints(p[:waypoints]) if p.key?(:waypoints)
    out[:geometry] = clean_geometry(p[:geometry]) if p.key?(:geometry)
    out[:voice_hints] = clean_voice_hints(p[:voice_hints]) if p.key?(:voice_hints)
    out[:pois] = clean_pois(p[:pois]) if p.key?(:pois)
    out[:markers] = clean_markers(p[:markers]) if p.key?(:markers)
    out[:distance_m] = p[:distance_m].to_f.then { |v| v.positive? ? v : nil } if p.key?(:distance_m)
    out[:elevation_gain_m] = p[:elevation_gain_m].to_f.then { |v| v.positive? ? v : nil } if p.key?(:elevation_gain_m)
    out[:elevation_loss_m] = p[:elevation_loss_m].to_f.then { |v| v.positive? ? v : nil } if p.key?(:elevation_loss_m)
    # Vitesse retenue par le créateur pour CET itinéraire (peut différer de son profil).
    # Hors bornes → nil, c'est-à-dire « retomber sur le réglage du profil ».
    out[:avg_speed_kmh] = p[:avg_speed_kmh].to_f.then { |v| Route::SPEED_RANGE.cover?(v) ? v : nil } if p.key?(:avg_speed_kmh)
    out
  end

  def clean_waypoints(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_WAYPOINTS).map do |w|
      h = w.respond_to?(:to_unsafe_h) ? w.to_unsafe_h : w
      lat = h["lat"] || h[:lat]
      lng = h["lng"] || h[:lng]
      next nil unless lat.is_a?(Numeric) && lng.is_a?(Numeric)
      next nil if lat.abs > 90 || lng.abs > 180
      wp = { "lat" => lat.to_f, "lng" => lng.to_f }
      wp["free"] = true if h["free"] || h[:free]
      wp["uturn_ok"] = true if h["uturn_ok"] || h[:uturn_ok]
      wp
    end.compact
  end

  def clean_geometry(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_GEOMETRY_POINTS).map do |pt|
      next nil unless pt.is_a?(Array) && pt.length >= 2
      lng, lat, ele = pt[0], pt[1], pt[2]
      next nil unless lng.is_a?(Numeric) && lat.is_a?(Numeric)
      next nil if lat.abs > 90 || lng.abs > 180
      [lng.to_f, lat.to_f, ele.is_a?(Numeric) ? ele.to_f : nil]
    end.compact
  end

  MAX_VOICE_HINTS = 2_000
  MAX_POIS = 2_000
  MAX_MARKERS = 50

  def clean_voice_hints(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_VOICE_HINTS).map do |h|
      hh = h.respond_to?(:to_unsafe_h) ? h.to_unsafe_h : h
      next nil unless hh.is_a?(Hash)
      lng = hh["lng"] || hh[:lng]
      lat = hh["lat"] || hh[:lat]
      cmd = hh["cmd"] || hh[:cmd]
      angle = hh["angle"] || hh[:angle]
      exit_number = hh["exit_number"] || hh[:exit_number]
      next nil unless lng.is_a?(Numeric) && lat.is_a?(Numeric)
      next nil if lat.abs > 90 || lng.abs > 180
      { "lng" => lng.to_f, "lat" => lat.to_f, "cmd" => cmd.to_i, "angle" => angle.to_f, "exit_number" => exit_number.to_i }
    end.compact
  end

  def clean_pois(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_POIS).filter_map do |item|
      h = item.respond_to?(:to_unsafe_h) ? item.to_unsafe_h : item
      next unless h.is_a?(Hash)
      name = (h["name"] || h[:name]).to_s.strip.first(100)
      type = (h["type"] || h[:type]).to_s.gsub(/[^a-zA-Z0-9_]/, "").first(50)
      lat  = h["lat"]  || h[:lat]
      lng  = h["lng"]  || h[:lng]
      next unless lat.is_a?(Numeric) && lng.is_a?(Numeric)
      next if lat.abs > 90 || lng.abs > 180
      { "name" => name, "type" => type, "lat" => lat.to_f, "lng" => lng.to_f }
    end
  end

  # Repères posés à la main : `kind` restreint (MARKER_KINDS), coordonnées bornées,
  # `label` libre optionnel. Distinct de clean_pois — ces repères ne sont jamais
  # écrasés par la recherche de POI.
  def clean_markers(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_MARKERS).filter_map do |item|
      h = item.respond_to?(:to_unsafe_h) ? item.to_unsafe_h : item
      next unless h.is_a?(Hash)
      kind = (h["kind"] || h[:kind]).to_s
      next unless MARKER_KINDS.include?(kind)
      lat = h["lat"] || h[:lat]
      lng = h["lng"] || h[:lng]
      next unless lat.is_a?(Numeric) && lng.is_a?(Numeric)
      next if lat.abs > 90 || lng.abs > 180
      marker = { "kind" => kind, "lat" => lat.to_f, "lng" => lng.to_f }
      label = (h["label"] || h[:label]).to_s.strip.first(100)
      marker["label"] = label if label.present?
      marker
    end
  end

  # Applique les filtres passés en query params. Filtrage en base pour porter sur
  # tout l'historique, pas seulement la page courante. Les bornes de date portent
  # sur `updated_at` (dernière modification), la date affichée dans la liste.
  def filtered_routes_scope
    scope = current_user.routes
    if params[:q].present?
      needle = Route.sanitize_sql_like(params[:q].to_s.first(MAX_NAME_LEN))
      # La recherche porte sur le nom ET les lieux traversés (« passe par Gruyères »).
      # `localities::text` cherche dans le rendu texte du tableau jsonb — c'est cette
      # expression exacte qui porte l'index GIN trigram (cf. migration).
      scope = scope.where(
        "routes.name ILIKE :q OR routes.localities::text ILIKE :q",
        q: "%#{needle}%",
      )
    end
    scope = scope.where(activity: params[:sport]) if params[:sport].present?
    scope = scope.where(routes: { distance_m: (params[:min_dist].to_f * 1000).. }) if params[:min_dist].present?
    scope = scope.where(routes: { distance_m: ..(params[:max_dist].to_f * 1000) }) if params[:max_dist].present?
    scope = scope.where(routes: { elevation_gain_m: params[:min_elev].to_f.. }) if params[:min_elev].present?
    scope = scope.where(routes: { elevation_gain_m: ..params[:max_elev].to_f }) if params[:max_elev].present?
    if (from = parse_date(params[:from]))
      scope = scope.where(routes: { updated_at: from.beginning_of_day.. })
    end
    if (to = parse_date(params[:to]))
      scope = scope.where(routes: { updated_at: ..to.end_of_day })
    end
    scope
  end

  # Parse une date ISO (yyyy-mm-dd) issue d'un <input type="date">. Renvoie nil si
  # vide ou invalide — le filtre est alors simplement ignoré.
  def parse_date(value)
    return nil if value.blank?

    Date.iso8601(value)
  rescue ArgumentError
    nil
  end

  def routes_per_page
    per = params[:per].to_i
    per = DEFAULT_PER_PAGE if per <= 0
    [per, MAX_PER_PAGE].min
  end

  # Carte d'ensemble : tous les itinéraires du filtre, hors pagination. Plafonné —
  # au-delà, MapLibre rame à afficher les polylignes ; on garde les plus récents.
  def routes_map_payload
    scope = filtered_routes_scope
    records = scope.order(updated_at: :desc).limit(MAX_MAP_ROUTES)
    {
      routes: records.map { |r| serialize_summary(r) },
      filtered_total: scope.count,
      max: MAX_MAP_ROUTES,
    }
  end

  def serialize_summary(route)
    {
      id: route.id,
      name: route.name,
      distance_m: route.distance_m,
      elevation_gain_m: route.elevation_gain_m,
      elevation_loss_m: route.elevation_loss_m,
      profile: route.profile,
      activity: route.activity,
      # Colonne brute, pas la valeur effective : `null` dit au front « cet itinéraire
      # suit le réglage du profil », ce qui lui permet de continuer à recalculer ses
      # estimations quand on bouge le curseur de vitesse de la liste.
      avg_speed_kmh: route[:avg_speed_kmh],
      share_token: route.share_token,
      preview_segments: route.preview_segments,
      map_polyline: route.map_polyline,
      updated_at: route.updated_at.iso8601,
    }
  end

  def serialize_full(route)
    serialize_summary(route).merge(
      waypoints: route.waypoints || [],
      geometry: route.geometry || [],
      voice_hints: route.voice_hints || [],
      pois: route.pois || [],
      markers: route.markers || [],
    )
  end

  def send_gpx(route)
    send_data build_gpx(route, step: gpx_densify_step),
              filename: "#{route.name.parameterize.presence || 'route'}.gpx",
              type: "application/gpx+xml"
  end

  # Pas de ré-échantillonnage (en mètres) pour l'export GPX, ou nil pour laisser
  # la géométrie native. Utile pour les simulateurs de position GPS (extensions
  # « location override ») qui téléportent d'un trackpoint au suivant : sans
  # points intermédiaires, les longs tronçons (surtout les segments « libres »
  # tracés en ligne droite) provoquent de gros sauts. À ne PAS activer pour un
  # export vers une montre (limite de points sur certains GPS).
  #   ?dense=1   → pas par défaut de 10 m
  #   ?step=5    → pas personnalisé (borné à [1, 1000] m)
  # Réservé aux admins (can :manage, :all) : un GPX dense est inadapté aux vraies
  # montres (limite de points), on ne l'expose donc pas au tout-venant. Pour un
  # export partagé (non connecté), current_ability n'accorde rien → toujours nil.
  def gpx_densify_step
    return nil unless can?(:manage, :all)
    return params[:step].to_f.clamp(1.0, 1000.0) if params[:step].present?
    return 10.0 if ActiveModel::Type::Boolean.new.cast(params[:dense])

    nil
  end

  # Namespace de l'extension propriétaire embarquée dans le GPX. Les apps tierces
  # (Strava, Garmin, Komoot…) ignorent les <extensions> d'un namespace inconnu,
  # donc le fichier reste un GPX 1.1 valide ailleurs ; côté Sports Scope on s'en
  # sert pour ré-importer les waypoints d'origine avec leur flag « libre ».
  GPX_NS = "https://sports.logicraft.ch/gpx/1"

  def build_gpx(route, step: nil)
    pts = Array(route.geometry)
    pts = densify_geometry(pts, step) if step
    wps = Array(route.waypoints)
    name = ERB::Util.html_escape(route.name)
    parts = []
    parts << '<?xml version="1.0" encoding="UTF-8"?>'
    parts << %(<gpx version="1.1" creator="Sports Scope" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ss="#{GPX_NS}">)
    parts << "  <metadata><name>#{name}</name></metadata>"
    # Repères posés à la main → waypoints GPX nommés. Placés avant <trk> (ordre
    # imposé par le schéma GPX 1.1 : metadata, wpt*, rte*, trk*).
    parts.concat(build_gpx_markers(route.markers))
    parts << "  <trk><name>#{name}</name><trkseg>"
    pts.each do |pt|
      lng, lat, ele = pt
      next unless lng && lat
      seg = %(    <trkpt lat="#{lat}" lon="#{lng}">)
      seg << "<ele>#{ele}</ele>" if ele
      seg << "</trkpt>"
      parts << seg
    end
    parts << "  </trkseg></trk>"
    parts.concat(build_gpx_extensions(wps))
    parts << "</gpx>"
    parts.join("\n")
  end

  # Repères posés à la main (départ / arrivée / parking) → <wpt> GPX nommés. Le nom
  # est le libellé saisi, sinon le libellé du type. `sym` reste indicatif : peu de
  # lecteurs le respectent, mais le nom passe partout (montre, Garmin, Komoot).
  def build_gpx_markers(markers)
    Array(markers).filter_map do |m|
      lat = m["lat"] || m[:lat]
      lng = m["lng"] || m[:lng]
      kind = (m["kind"] || m[:kind]).to_s
      next unless lat && lng
      label = (m["label"] || m[:label]).to_s.strip
      label = MARKER_GPX_NAMES.fetch(kind, kind) if label.empty?
      name = ERB::Util.html_escape(label)
      %(  <wpt lat="#{lat}" lon="#{lng}"><name>#{name}</name><sym>#{ERB::Util.html_escape(kind)}</sym></wpt>)
    end
  end

  # Waypoints d'origine (sommets cliqués) + flag « libre » : la trace <trkpt>
  # ci-dessus ne dit pas lesquels étaient libres, donc on les rejoue ici pour un
  # aller-retour fidèle. La géométrie n'a pas à être stockée : BRouter la
  # reconstruit à l'identique depuis les waypoints (les tronçons libres sont
  # tracés en ligne droite via le paramètre `straight`).
  def build_gpx_extensions(wps)
    rows = wps.filter_map do |w|
      lat = w["lat"] || w[:lat]
      lng = w["lng"] || w[:lng]
      next unless lat && lng
      attrs = %(lat="#{lat}" lon="#{lng}")
      attrs << ' free="true"' if w["free"] || w[:free]
      attrs << ' uturn_ok="true"' if w["uturn_ok"] || w[:uturn_ok]
      "      <ss:wp #{attrs}/>"
    end
    return [] if rows.empty?
    ["  <extensions>", "    <ss:waypoints>", *rows, "    </ss:waypoints>", "  </extensions>"]
  end

  # Ré-échantillonne la polyligne à pas ~constant (`step` mètres) par interpolation
  # linéaire. Seules lat/lng/ele sont interpolées — c'est exactement ce qu'attend un
  # simulateur de position (la position intermédiaire est bien ~sur la droite entre
  # deux points). Les points d'origine sont conservés ; on n'insère qu'entre eux.
  def densify_geometry(pts, step)
    pts = pts.select { |lng, lat, _| lng && lat }
    return pts if pts.size < 2

    out = [pts.first]
    pts.each_cons(2) do |a, b|
      d = haversine(a, b)
      n = (d / step).floor
      (1...n).each do |i|
        t = i.to_f / n
        out << lerp_point(a, b, t)
      end
      out << b
    end
    out
  end

  def lerp_point(a, b, t)
    lng = a[0] + (b[0] - a[0]) * t
    lat = a[1] + (b[1] - a[1]) * t
    ele = (a[2] && b[2]) ? a[2] + (b[2] - a[2]) * t : (a[2] || b[2])
    [lng, lat, ele]
  end

  # Distance en mètres entre deux points [lng, lat, ...].
  def haversine(a, b)
    r = 6_371_000.0
    lat1 = a[1] * Math::PI / 180
    lat2 = b[1] * Math::PI / 180
    dlat = lat2 - lat1
    dlng = (b[0] - a[0]) * Math::PI / 180
    h = Math.sin(dlat / 2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2)**2
    2 * r * Math.asin(Math.sqrt(h))
  end
end
