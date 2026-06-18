class ProfilesController < ApplicationController
  before_action :require_login!

  # Bornes de validation pour les préférences numériques (cohérentes avec le front).
  RADIUS_RANGE = (200..5000)
  MIN_GRADE_RANGE = (0.0..15.0)
  MIN_GAIN_RANGE = (0..1000)
  MIN_LENGTH_RANGE = (50..5000)

  ALLOWED_MAP_STYLES = %w[cyclosm topo swisstopo liberty].freeze
  ALLOWED_UNITS = %w[metric imperial].freeze
  ALLOWED_SPORTS = %w[cycling mtb hiking].freeze

  # GET /profile — page HTML qui monte l'îlot Vue UserProfile.
  def show
  end

  # PATCH /api/profile/preferences — sauvegarde JSON des préférences.
  def update
    current_user.update!(preferences: sanitize_preferences(params[:preferences]))
    render json: { preferences: current_user.preferences_with_defaults }
  end

  private

  def sanitize_preferences(raw)
    incoming = raw.respond_to?(:to_unsafe_h) ? raw.to_unsafe_h : (raw || {})
    incoming = incoming.with_indifferent_access

    poi = incoming[:points_of_interest] || {}
    map = incoming[:map] || {}
    display = incoming[:display] || {}
    climb = incoming[:climb_detection] || {}

    {
      "points_of_interest" => {
        "show_cemeteries" => to_bool(poi[:show_cemeteries], true),
        "show_bakeries" => to_bool(poi[:show_bakeries], true),
        "show_localities" => to_bool(poi[:show_localities], false),
        "radius_m" => clamp_int(poi[:radius_m], RADIUS_RANGE, 1500),
      },
      "map" => {
        "default_style" => allowed(map[:default_style], ALLOWED_MAP_STYLES, "cyclosm"),
      },
      "display" => {
        "units" => allowed(display[:units], ALLOWED_UNITS, "metric"),
        "default_sport" => allowed(display[:default_sport], ALLOWED_SPORTS, "cycling"),
        "show_grade_colors" => to_bool(display[:show_grade_colors], true),
        "show_elevation_chart" => to_bool(display[:show_elevation_chart], true),
      },
      "climb_detection" => {
        "min_grade" => clamp_float(climb[:min_grade], MIN_GRADE_RANGE, 2),
        "min_gain_m" => clamp_int(climb[:min_gain_m], MIN_GAIN_RANGE, 60),
        "min_length_m" => clamp_int(climb[:min_length_m], MIN_LENGTH_RANGE, 500),
      },
    }
  end

  def to_bool(value, default)
    return default if value.nil?
    ActiveModel::Type::Boolean.new.cast(value)
  end

  def allowed(value, list, default)
    list.include?(value.to_s) ? value.to_s : default
  end

  def clamp_int(value, range, default)
    n = Integer(value, exception: false)
    return default if n.nil?
    n.clamp(range.min, range.max)
  end

  def clamp_float(value, range, default)
    n = Float(value, exception: false)
    return default if n.nil?
    n.clamp(range.min, range.max).round(1)
  end
end
