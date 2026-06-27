class RoutesController < ApplicationController
  # `shared` is public (token-based) so a shared navigation link works without
  # an account. Every other action stays scoped to the signed-in owner.
  before_action :require_login!, except: %i[shared export_gpx_shared]

  MAX_WAYPOINTS = 500
  MAX_GEOMETRY_POINTS = 10_000
  MAX_NAME_LEN = 80
  ALLOWED_PROFILES = %w[cycling foot driving].freeze
  ALLOWED_ACTIVITIES = Route::ACTIVITIES

  # GET /api/routes
  def index
    routes = current_user.routes.order(updated_at: :desc)
    render json: { routes: routes.map { |r| serialize_summary(r) } }
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
    render json: { route: serialize_full(route) }
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
    route.update!(attrs.compact)
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
      distance_m: src.distance_m,
      elevation_gain_m: src.elevation_gain_m,
      elevation_loss_m: src.elevation_loss_m,
    )
    render json: { route: serialize_full(new_route) }, status: :created
  rescue ActiveRecord::RecordInvalid => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  def sanitize_attrs(p)
    # Only include keys that were actually present in the payload so PATCH
    # requests with partial bodies (e.g. just `name` for an inline rename) do
    # not clobber waypoints/geometry with empty defaults.
    out = {}
    out[:name] = p[:name].to_s.strip.first(MAX_NAME_LEN).presence if p.key?(:name)
    out[:profile] = ALLOWED_PROFILES.include?(p[:profile].to_s) ? p[:profile] : "cycling" if p.key?(:profile)
    out[:activity] = ALLOWED_ACTIVITIES.include?(p[:activity].to_s) ? p[:activity] : "cycling" if p.key?(:activity)
    out[:waypoints] = clean_waypoints(p[:waypoints]) if p.key?(:waypoints)
    out[:geometry] = clean_geometry(p[:geometry]) if p.key?(:geometry)
    out[:voice_hints] = clean_voice_hints(p[:voice_hints]) if p.key?(:voice_hints)
    out[:pois] = clean_pois(p[:pois]) if p.key?(:pois)
    out[:distance_m] = p[:distance_m].to_f.then { |v| v.positive? ? v : nil } if p.key?(:distance_m)
    out[:elevation_gain_m] = p[:elevation_gain_m].to_f.then { |v| v.positive? ? v : nil } if p.key?(:elevation_gain_m)
    out[:elevation_loss_m] = p[:elevation_loss_m].to_f.then { |v| v.positive? ? v : nil } if p.key?(:elevation_loss_m)
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

  def serialize_summary(route)
    {
      id: route.id,
      name: route.name,
      distance_m: route.distance_m,
      elevation_gain_m: route.elevation_gain_m,
      elevation_loss_m: route.elevation_loss_m,
      profile: route.profile,
      activity: route.activity,
      share_token: route.share_token,
      updated_at: route.updated_at.iso8601,
    }
  end

  def serialize_full(route)
    serialize_summary(route).merge(
      waypoints: route.waypoints || [],
      geometry: route.geometry || [],
      voice_hints: route.voice_hints || [],
      pois: route.pois || [],
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
  GPX_NS = "https://sports-scope.app/gpx/1"

  def build_gpx(route, step: nil)
    pts = Array(route.geometry)
    pts = densify_geometry(pts, step) if step
    wps = Array(route.waypoints)
    name = ERB::Util.html_escape(route.name)
    parts = []
    parts << '<?xml version="1.0" encoding="UTF-8"?>'
    parts << %(<gpx version="1.1" creator="Sports Scope" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ss="#{GPX_NS}">)
    parts << "  <metadata><name>#{name}</name></metadata>"
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
