class RoutesController < ApplicationController
  before_action :require_login!

  MAX_WAYPOINTS = 50
  MAX_GEOMETRY_POINTS = 10_000
  MAX_NAME_LEN = 80
  ALLOWED_PROFILES = %w[cycling foot driving].freeze

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
    send_data build_gpx(route),
              filename: "#{route.name.parameterize.presence || 'route'}.gpx",
              type: "application/gpx+xml"
  end

  private

  def sanitize_attrs(p)
    {
      name: p[:name].to_s.strip.first(MAX_NAME_LEN).presence,
      profile: ALLOWED_PROFILES.include?(p[:profile].to_s) ? p[:profile] : "cycling",
      waypoints: clean_waypoints(p[:waypoints]),
      geometry: clean_geometry(p[:geometry]),
      distance_m: p[:distance_m].to_f.then { |v| v.positive? ? v : nil },
      elevation_gain_m: p[:elevation_gain_m].to_f.then { |v| v.positive? ? v : nil },
      elevation_loss_m: p[:elevation_loss_m].to_f.then { |v| v.positive? ? v : nil },
    }
  end

  def clean_waypoints(raw)
    return [] unless raw.is_a?(Array)
    raw.take(MAX_WAYPOINTS).map do |w|
      h = w.respond_to?(:to_unsafe_h) ? w.to_unsafe_h : w
      lat = h["lat"] || h[:lat]
      lng = h["lng"] || h[:lng]
      next nil unless lat.is_a?(Numeric) && lng.is_a?(Numeric)
      next nil if lat.abs > 90 || lng.abs > 180
      { "lat" => lat.to_f, "lng" => lng.to_f }
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

  def serialize_summary(route)
    {
      id: route.id,
      name: route.name,
      distance_m: route.distance_m,
      elevation_gain_m: route.elevation_gain_m,
      elevation_loss_m: route.elevation_loss_m,
      profile: route.profile,
      updated_at: route.updated_at.iso8601,
    }
  end

  def serialize_full(route)
    serialize_summary(route).merge(
      waypoints: route.waypoints || [],
      geometry: route.geometry || [],
    )
  end

  def build_gpx(route)
    pts = Array(route.geometry)
    name = ERB::Util.html_escape(route.name)
    parts = []
    parts << '<?xml version="1.0" encoding="UTF-8"?>'
    parts << '<gpx version="1.1" creator="Sports Scope" xmlns="http://www.topografix.com/GPX/1/1">'
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
    parts << "</gpx>"
    parts.join("\n")
  end
end
