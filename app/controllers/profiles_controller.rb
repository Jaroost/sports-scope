class ProfilesController < ApplicationController
  before_action :require_login!

  # Bornes de validation pour les préférences numériques (cohérentes avec le front).
  RADIUS_RANGE = (200..5000)
  MIN_GRADE_RANGE = (0.0..15.0)
  MIN_GAIN_RANGE = (0..1000)
  MIN_LENGTH_RANGE = (50..5000)
  GRADE_SMOOTHING_RANGE = (10..200)
  SPEED_RANGE = (3.0..80.0)
  NAV_ZOOM_RANGE = (14.0..40.0)
  NAV_PITCH_RANGE = (0..90)

  ALLOWED_MAP_STYLES = %w[cyclosm topo swisstopo swissgrau swissimage liberty].freeze
  ALLOWED_OVERLAYS = %w[veloland mountainbikeland wanderland wanderwege].freeze
  ALLOWED_SPORTS = %w[cycling mtb hiking].freeze

  # Vitesses moyennes par défaut (km/h), miroir de User::DEFAULT_PREFERENCES.
  DEFAULT_SPEEDS = { "cycling" => 18, "mtb" => 14, "hiking" => 4.5 }.freeze

  # GET /profile — page HTML qui monte l'îlot Vue UserProfile.
  def show
  end

  # DELETE /profile/strava — délie le compte Strava de l'utilisateur courant.
  def unlink_strava
    current_user.detach_strava!
    redirect_to profile_path, notice: t("profile.strava.unlinked")
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
    navigation = incoming[:navigation] || {}
    display = incoming[:display] || {}
    climb = incoming[:climb_detection] || {}
    speeds = incoming[:speeds] || {}

    {
      "points_of_interest" => {
        "show_cemeteries" => to_bool(poi[:show_cemeteries], true),
        "show_bakeries" => to_bool(poi[:show_bakeries], true),
        "show_localities" => to_bool(poi[:show_localities], false),
        "radius_m" => clamp_int(poi[:radius_m], RADIUS_RANGE, 1500),
      },
      "map" => {
        "default_style" => allowed(map[:default_style], ALLOWED_MAP_STYLES, "cyclosm"),
        "overlays" => sanitize_overlays(map[:overlays]),
      },
      "navigation" => {
        "default_style" => allowed(navigation[:default_style], ALLOWED_MAP_STYLES, "cyclosm"),
        "zoom" => clamp_float(navigation[:zoom], NAV_ZOOM_RANGE, 19.5),
        "pitch" => clamp_int(navigation[:pitch], NAV_PITCH_RANGE, 60),
        "terrain" => to_bool(navigation[:terrain], false),
      },
      "display" => {
        "default_sport" => allowed(display[:default_sport], ALLOWED_SPORTS, "cycling"),
        "show_grade_colors" => to_bool(display[:show_grade_colors], true),
        "show_elevation_chart" => to_bool(display[:show_elevation_chart], true),
      },
      "climb_detection" => {
        "min_grade" => clamp_float(climb[:min_grade], MIN_GRADE_RANGE, 2),
        "min_gain_m" => clamp_int(climb[:min_gain_m], MIN_GAIN_RANGE, 60),
        "min_length_m" => clamp_int(climb[:min_length_m], MIN_LENGTH_RANGE, 500),
        "grade_smoothing_m" => clamp_int(climb[:grade_smoothing_m], GRADE_SMOOTHING_RANGE, 40),
      },
      "speeds" => sanitize_speeds(speeds),
    }
  end

  # Garde uniquement les ids d'overlay connus, dédoublonnés et dans l'ordre reçu.
  def sanitize_overlays(value)
    return [] unless value.is_a?(Array)
    value.map(&:to_s).uniq.select { |id| ALLOWED_OVERLAYS.include?(id) }
  end

  def sanitize_speeds(speeds)
    DEFAULT_SPEEDS.each_with_object({}) do |(sport, default), out|
      out[sport] = clamp_float(speeds[sport], SPEED_RANGE, default)
    end
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
