class ProfilesController < ApplicationController
  before_action :require_login!

  # Bornes de validation pour les préférences numériques (cohérentes avec le front).
  RADIUS_RANGE = (200..5000)
  POI_ALERT_RANGE = (20..1000)
  MIN_GRADE_RANGE = (0.0..15.0)
  MIN_GAIN_RANGE = (0..1000)
  MIN_LENGTH_RANGE = (50..5000)
  GRADE_SMOOTHING_RANGE = (10..200)
  MERGE_GAP_RANGE = (0..2000)
  SPEED_RANGE = (3.0..80.0)
  NAV_ZOOM_RANGE = (14.0..40.0)
  NAV_PITCH_RANGE = (0..90)
  NAV_FPS_RANGE = (0.5..60.0)
  NAV_LINE_WIDTH_RANGE = (2..200)
  OPACITY_RANGE = (0.0..1.0)
  ROUTE_WIDTH_RANGE = (2..12)
  HEX_COLOR = /\A#[0-9a-fA-F]{6}\z/
  NAV_TURN_ALERT_RANGE = (50..500)
  NAV_TURN_HINT_RANGE = (50..500)
  NAV_TURN_URGENT_RANGE = (5..50)
  NAV_TURN_REPEAT_RANGE = (500..10000)
  NAV_TURN_REPEAT_URGENT_RANGE = (500..10000)
  NAV_TURN_NOW_RANGE = (0..50)
  NAV_TURN_GREEN_HOLD_RANGE = (0..500)
  NAV_TURN_GREEN_HOLD_S_RANGE = (2..60)
  NAV_SOUND_VOLUME_RANGE = (0..200)
  NAV_TURN_MARKER_SIZE_RANGE = (5..200)
  NAV_RADAR_CLOSE_RANGE = (10..100)
  COUNTRY_CODES_MAX = 100

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
    search = incoming[:search] || {}
    display = incoming[:display] || {}
    climb = incoming[:climb_detection] || {}
    speeds = incoming[:speeds] || {}

    {
      "points_of_interest" => {
        "show_cemeteries" => to_bool(poi[:show_cemeteries], true),
        "show_bakeries" => to_bool(poi[:show_bakeries], true),
        "show_localities" => to_bool(poi[:show_localities], false),
        "show_water" => to_bool(poi[:show_water], true),
        "show_food" => to_bool(poi[:show_food], false),
        "show_viewpoints" => to_bool(poi[:show_viewpoints], false),
        "show_toilets" => to_bool(poi[:show_toilets], false),
        "show_picnic" => to_bool(poi[:show_picnic], false),
        "radius_m" => clamp_int(poi[:radius_m], RADIUS_RANGE, 1500),
        "alert_m" => clamp_int(poi[:alert_m], POI_ALERT_RANGE, 100),
      },
      "map" => {
        "default_style" => allowed(map[:default_style], ALLOWED_MAP_STYLES, "cyclosm"),
        "overlays" => sanitize_overlays(map[:overlays]),
      },
      "navigation" => {
        "default_style" => allowed(navigation[:default_style], ALLOWED_MAP_STYLES, "swissgrau"),
        "zoom" => clamp_float(navigation[:zoom], NAV_ZOOM_RANGE, 17),
        "pitch" => clamp_int(navigation[:pitch], NAV_PITCH_RANGE, 0),
        "terrain" => to_bool(navigation[:terrain], false),
        "nav_fps" => clamp_float(navigation[:nav_fps], NAV_FPS_RANGE, 8),
        "line_width" => clamp_int(navigation[:line_width], NAV_LINE_WIDTH_RANGE, 40),
        "line_color" => hex_color(navigation[:line_color], "#7c3aed"),
        "line_opacity" => clamp_float(navigation[:line_opacity], OPACITY_RANGE, 0.8),
        "turn_alert_m" => clamp_int(navigation[:turn_alert_m], NAV_TURN_ALERT_RANGE, 100),
        "turn_hint_m" => clamp_int(navigation[:turn_hint_m], NAV_TURN_HINT_RANGE, 150),
        "turn_urgent_m" => clamp_int(navigation[:turn_urgent_m], NAV_TURN_URGENT_RANGE, 50),
        "turn_repeat_ms" => clamp_int(navigation[:turn_repeat_ms], NAV_TURN_REPEAT_RANGE, 2000),
        "turn_repeat_urgent_ms" => clamp_int(navigation[:turn_repeat_urgent_ms], NAV_TURN_REPEAT_URGENT_RANGE, 1000),
        "turn_now_m" => clamp_int(navigation[:turn_now_m], NAV_TURN_NOW_RANGE, 15),
        "turn_green_hold_m" => clamp_int(navigation[:turn_green_hold_m], NAV_TURN_GREEN_HOLD_RANGE, 100),
        "turn_green_hold_s" => clamp_int(navigation[:turn_green_hold_s], NAV_TURN_GREEN_HOLD_S_RANGE, 10),
        "sound_volume" => clamp_int(navigation[:sound_volume], NAV_SOUND_VOLUME_RANGE, 100),
        "turn_marker_size" => clamp_int(navigation[:turn_marker_size], NAV_TURN_MARKER_SIZE_RANGE, 25),
        "turn_marker_color" => hex_color(navigation[:turn_marker_color], "#f97316"),
        "turn_marker_icon_color" => hex_color(navigation[:turn_marker_icon_color], "#ffffff"),
        "show_climb_card" => to_bool(navigation[:show_climb_card], true),
        "radar_always_visible" => to_bool(navigation[:radar_always_visible], false),
        "radar_close_m" => clamp_int(navigation[:radar_close_m], NAV_RADAR_CLOSE_RANGE, 30),
      },
      "search" => {
        "country_codes" => sanitize_country_codes(search[:country_codes]),
        "worldwide_fallback" => to_bool(search[:worldwide_fallback], false),
      },
      "display" => {
        "default_sport" => allowed(display[:default_sport], ALLOWED_SPORTS, "cycling"),
        "show_grade_colors" => to_bool(display[:show_grade_colors], true),
        "show_elevation_chart" => to_bool(display[:show_elevation_chart], true),
        "route_color" => hex_color(display[:route_color], "#7c3aed"),
        "route_opacity" => clamp_float(display[:route_opacity], OPACITY_RANGE, 0.8),
        "route_width" => clamp_int(display[:route_width], ROUTE_WIDTH_RANGE, 5),
      },
      "climb_detection" => {
        "min_grade" => clamp_float(climb[:min_grade], MIN_GRADE_RANGE, 2),
        "min_gain_m" => clamp_int(climb[:min_gain_m], MIN_GAIN_RANGE, 60),
        "min_length_m" => clamp_int(climb[:min_length_m], MIN_LENGTH_RANGE, 500),
        "grade_smoothing_m" => clamp_int(climb[:grade_smoothing_m], GRADE_SMOOTHING_RANGE, 40),
        "merge_gap_m" => clamp_int(climb[:merge_gap_m], MERGE_GAP_RANGE, 350),
      },
      "speeds" => sanitize_speeds(speeds),
    }
  end

  # Garde uniquement les ids d'overlay connus, dédoublonnés et dans l'ordre reçu.
  def sanitize_overlays(value)
    return [] unless value.is_a?(Array)
    value.map(&:to_s).uniq.select { |id| ALLOWED_OVERLAYS.include?(id) }
  end

  # Codes pays (ISO 3166-1 alpha-2) de la priorisation de recherche : on conserve
  # l'ordre reçu (= priorité), normalisé en minuscules, dédoublonné, en ne gardant
  # que les codes bien formés (2 lettres) et borné en longueur. La liste peut être
  # vide (recherche directement mondiale) ; on ne réinjecte pas les défauts ici,
  # sans quoi l'utilisateur ne pourrait jamais tout retirer.
  def sanitize_country_codes(value)
    return User::DEFAULT_PREFERENCES.dig("search", "country_codes") unless value.is_a?(Array)
    value.map { |c| c.to_s.downcase }.uniq.select { |c| c.match?(/\A[a-z]{2}\z/) }.first(COUNTRY_CODES_MAX)
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

  # Couleur hexadécimale #rrggbb, normalisée en minuscules ; repli sur le défaut sinon.
  def hex_color(value, default)
    value.to_s.match?(HEX_COLOR) ? value.to_s.downcase : default
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
