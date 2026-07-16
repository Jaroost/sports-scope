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
  TURN_ANOMALY_RANGE = (30..200)
  SNAP_WARN_RANGE = (10..200)
  NAV_ZOOM_RANGE = (14.0..40.0)
  NAV_PITCH_RANGE = (0..90)
  NAV_FPS_RANGE = (0.5..60.0)
  NAV_LINE_WIDTH_RANGE = (2..200)
  OPACITY_RANGE = (0.0..1.0)
  ROUTE_WIDTH_RANGE = (2..12)
  HEX_COLOR = /\A#[0-9a-fA-F]{6}\z/
  # Bornes basses volontairement courtes : à pied, un virage annoncé 50 m à l'avance
  # laisse déjà 40 secondes de marche.
  NAV_TURN_ALERT_RANGE = (20..500)
  NAV_TURN_HINT_RANGE = (20..500)
  NAV_TURN_URGENT_RANGE = (5..50)
  NAV_TURN_REPEAT_RANGE = (500..10000)
  NAV_TURN_REPEAT_URGENT_RANGE = (500..10000)
  NAV_TURN_NOW_RANGE = (0..50)
  NAV_TURN_GREEN_HOLD_RANGE = (0..500)
  NAV_TURN_GREEN_HOLD_S_RANGE = (2..60)
  NAV_SOUND_VOLUME_RANGE = (0..200)
  NAV_TURN_MARKER_SIZE_RANGE = (5..200)
  NAV_RADAR_CLOSE_RANGE = (10..100)
  NAV_AUTO_REROUTE_COOLDOWN_RANGE = (3..120)
  COUNTRY_CODES_MAX = 100
  FTP_MANUAL_RANGE = (50..600)     # watts plausibles pour une FTP saisie à la main
  WEIGHT_RANGE = (30.0..250.0)     # kg
  LTHR_MANUAL_RANGE = (100..220)   # bpm plausibles pour un seuil FC saisi à la main

  ALLOWED_MAP_STYLES = %w[cyclosm topo swisstopo swissgrau swissimage liberty].freeze
  ALLOWED_OVERLAYS = %w[veloland mountainbikeland wanderland wanderwege].freeze
  ALLOWED_SPORTS = User::SPORTS

  # Profils BRouter proposés par sport (miroir du catalogue front brouter.ts /
  # PROFILES_BY_SPORT). Un profil n'est accepté que s'il est proposé pour son sport.
  ALLOWED_ROUTE_PROFILES = {
    "cycling" => %w[trekking fastbike fastbike-lowtraffic shortest],
    "mtb" => %w[gravel trekking shortest],
    "hiking" => %w[hiking-mountain trekking shortest],
  }.freeze

  # GET /profile — page HTML qui monte l'îlot Vue UserProfile.
  def show
  end

  # DELETE /profile/strava — délie le compte Strava de l'utilisateur courant.
  def unlink_strava
    current_user.detach_strava!
    redirect_to profile_path, notice: t("profile.strava.unlinked")
  end

  # DELETE /profile/strava/activities — supprime toutes les activités Strava de
  # l'utilisateur (et ses runs de backfill de streams). Réversible : tout revient à
  # la prochaine synchronisation. N'affecte pas les imports .fit. Les analyses en
  # cache (charge, FTP, records) s'invalident seules (clé versionnée par le nombre
  # d'activités).
  def delete_strava_activities
    deleted = current_user.strava_activities.delete_all
    current_user.strava_backfill_runs.delete_all
    redirect_to profile_path, notice: t("profile.strava.activities_deleted", count: deleted)
  end

  # PATCH /api/profile/preferences — sauvegarde JSON des préférences.
  def update
    current_user.update!(preferences: sanitize_preferences(params[:preferences]))
    render json: { preferences: current_user.preferences_with_defaults }
  end

  # PATCH /api/athlete — met à jour uniquement les seuils athlète (FTP manuelle, poids),
  # en fusion dans les préférences existantes pour ne rien écraser d'autre.
  def update_athlete
    prefs = current_user.preferences.is_a?(Hash) ? current_user.preferences.deep_dup : {}
    prefs["athlete"] = sanitize_athlete(params[:athlete], current_user)
    current_user.update!(preferences: prefs)
    render json: { athlete: current_user.preferences_with_defaults["athlete"] }
  end

  private

  def sanitize_preferences(raw)
    incoming = raw.respond_to?(:to_unsafe_h) ? raw.to_unsafe_h : (raw || {})
    incoming = incoming.with_indifferent_access

    poi = incoming[:points_of_interest] || {}
    navigation = incoming[:navigation] || {}
    search = incoming[:search] || {}
    display = incoming[:display] || {}
    navbar = incoming[:navbar] || {}

    {
      "navbar" => {
        "items" => User.normalize_navbar_items(navbar[:items]),
      },
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
      "navigation" => {
        "default_style" => allowed(navigation[:default_style], ALLOWED_MAP_STYLES, "swissgrau"),
        "zoom" => clamp_float(navigation[:zoom], NAV_ZOOM_RANGE, 17),
        "pitch" => clamp_int(navigation[:pitch], NAV_PITCH_RANGE, 0),
        "terrain" => to_bool(navigation[:terrain], false),
        "nav_fps" => clamp_float(navigation[:nav_fps], NAV_FPS_RANGE, 8),
        "sound_volume" => clamp_int(navigation[:sound_volume], NAV_SOUND_VOLUME_RANGE, 100),
        "show_climb_card" => to_bool(navigation[:show_climb_card], true),
        "radar_close_m" => clamp_int(navigation[:radar_close_m], NAV_RADAR_CLOSE_RANGE, 30),
        "auto_reroute" => to_bool(navigation[:auto_reroute], true),
        "auto_reroute_cooldown_s" => clamp_int(navigation[:auto_reroute_cooldown_s], NAV_AUTO_REROUTE_COOLDOWN_RANGE, 10),
      },
      "search" => {
        "country_codes" => sanitize_country_codes(search[:country_codes]),
        "worldwide_fallback" => to_bool(search[:worldwide_fallback], false),
      },
      "display" => {
        "default_sport" => allowed(display[:default_sport], ALLOWED_SPORTS, "cycling"),
        "show_grade_colors" => to_bool(display[:show_grade_colors], true),
        "show_elevation_chart" => to_bool(display[:show_elevation_chart], true),
        "show_chain_widget" => to_bool(display[:show_chain_widget], true),
        "show_performance_widget" => to_bool(display[:show_performance_widget], true),
      },
      "sports" => sanitize_sports(incoming[:sports] || {}),
      # Le formulaire de profil (UserProfile.vue) n'envoie pas les seuils athlète :
      # sanitize_athlete retombe alors sur les valeurs déjà stockées pour ne pas les
      # effacer. Ils se modifient via PATCH /api/athlete (update_athlete).
      "athlete" => sanitize_athlete(incoming[:athlete], current_user),
    }
  end

  # Assainit les seuils athlète. Toute clé absente du payload retombe sur la valeur
  # déjà stockée (préservation). `ftp_manual_at` est (re)daté au jour du changement
  # de la FTP manuelle, préservé sinon, effacé quand on retire la valeur.
  def sanitize_athlete(raw, user)
    raw = raw.respond_to?(:to_unsafe_h) ? raw.to_unsafe_h : raw
    raw = (raw || {}).with_indifferent_access
    existing = user.preferences.is_a?(Hash) ? (user.preferences["athlete"] || {}) : {}

    ftp = raw.key?(:ftp_manual) ? clamp_int_or_nil(raw[:ftp_manual], FTP_MANUAL_RANGE) : clamp_int_or_nil(existing["ftp_manual"], FTP_MANUAL_RANGE)
    weight = raw.key?(:weight_kg) ? clamp_float_or_nil(raw[:weight_kg], WEIGHT_RANGE) : clamp_float_or_nil(existing["weight_kg"], WEIGHT_RANGE)
    lthr = raw.key?(:lthr_manual) ? clamp_int_or_nil(raw[:lthr_manual], LTHR_MANUAL_RANGE) : clamp_int_or_nil(existing["lthr_manual"], LTHR_MANUAL_RANGE)

    {
      "ftp_manual" => ftp,
      "ftp_manual_at" => manual_at(raw, existing, :ftp_manual, ftp, "ftp_manual", "ftp_manual_at"),
      "weight_kg" => weight,
      "lthr_manual" => lthr,
      "lthr_manual_at" => manual_at(raw, existing, :lthr_manual, lthr, "lthr_manual", "lthr_manual_at"),
    }
  end

  # Date de saisie d'un seuil manuel : (re)datée au jour du changement de valeur,
  # préservée si inchangée, effacée quand on retire la valeur, intacte si le payload
  # ne touche pas à ce champ (préservation lors d'un save de profil).
  def manual_at(raw, existing, key, value, value_col, at_col)
    return existing[at_col] unless raw.key?(key)
    return nil unless value

    existing[value_col].to_i != value ? Date.current.iso8601 : existing[at_col]
  end

  # Un bloc par sport connu, quoi qu'envoie le client : un sport inconnu est ignoré,
  # un sport manquant retombe entièrement sur ses défauts.
  def sanitize_sports(sports)
    User::DEFAULT_PREFERENCES["sports"].each_with_object({}) do |(sport, defaults), result|
      result[sport] = sanitize_sport(sport, sports[sport] || {}, defaults)
    end
  end

  def sanitize_sport(sport, raw, defaults)
    map = raw[:map] || {}
    route = raw[:route] || {}
    climb = raw[:climb_detection] || {}
    navigation = raw[:navigation] || {}

    {
      "speed" => clamp_float(raw[:speed], SPEED_RANGE, defaults["speed"]),
      "route_profile" => sanitize_route_profile(sport, raw[:route_profile], defaults["route_profile"]),
      "turn_anomaly_m" => clamp_int(raw[:turn_anomaly_m], TURN_ANOMALY_RANGE, defaults["turn_anomaly_m"]),
      "snap_warn_m" => clamp_int(raw[:snap_warn_m], SNAP_WARN_RANGE, defaults["snap_warn_m"]),
      "map" => {
        "default_style" => allowed(map[:default_style], ALLOWED_MAP_STYLES, defaults.dig("map", "default_style")),
        "overlays" => sanitize_overlays(map[:overlays]),
      },
      "route" => {
        "color" => hex_color(route[:color], defaults.dig("route", "color")),
        "opacity" => clamp_float(route[:opacity], OPACITY_RANGE, defaults.dig("route", "opacity")),
        "width" => clamp_int(route[:width], ROUTE_WIDTH_RANGE, defaults.dig("route", "width")),
      },
      "climb_detection" => {
        "min_grade" => clamp_float(climb[:min_grade], MIN_GRADE_RANGE, defaults.dig("climb_detection", "min_grade")),
        "min_gain_m" => clamp_int(climb[:min_gain_m], MIN_GAIN_RANGE, defaults.dig("climb_detection", "min_gain_m")),
        "min_length_m" => clamp_int(climb[:min_length_m], MIN_LENGTH_RANGE, defaults.dig("climb_detection", "min_length_m")),
        "grade_smoothing_m" => clamp_int(climb[:grade_smoothing_m], GRADE_SMOOTHING_RANGE, defaults.dig("climb_detection", "grade_smoothing_m")),
        "merge_gap_m" => clamp_int(climb[:merge_gap_m], MERGE_GAP_RANGE, defaults.dig("climb_detection", "merge_gap_m")),
      },
      "navigation" => sanitize_sport_navigation(navigation, defaults["navigation"]),
    }
  end

  def sanitize_sport_navigation(navigation, defaults)
    {
      "line_width" => clamp_int(navigation[:line_width], NAV_LINE_WIDTH_RANGE, defaults["line_width"]),
      "line_color" => hex_color(navigation[:line_color], defaults["line_color"]),
      "line_opacity" => clamp_float(navigation[:line_opacity], OPACITY_RANGE, defaults["line_opacity"]),
      "turn_marker_size" => clamp_int(navigation[:turn_marker_size], NAV_TURN_MARKER_SIZE_RANGE, defaults["turn_marker_size"]),
      "turn_marker_color" => hex_color(navigation[:turn_marker_color], defaults["turn_marker_color"]),
      "turn_marker_icon_color" => hex_color(navigation[:turn_marker_icon_color], defaults["turn_marker_icon_color"]),
      "turn_alert_m" => clamp_int(navigation[:turn_alert_m], NAV_TURN_ALERT_RANGE, defaults["turn_alert_m"]),
      "turn_hint_m" => clamp_int(navigation[:turn_hint_m], NAV_TURN_HINT_RANGE, defaults["turn_hint_m"]),
      "turn_urgent_m" => clamp_int(navigation[:turn_urgent_m], NAV_TURN_URGENT_RANGE, defaults["turn_urgent_m"]),
      "turn_now_m" => clamp_int(navigation[:turn_now_m], NAV_TURN_NOW_RANGE, defaults["turn_now_m"]),
      "turn_repeat_ms" => clamp_int(navigation[:turn_repeat_ms], NAV_TURN_REPEAT_RANGE, defaults["turn_repeat_ms"]),
      "turn_repeat_urgent_ms" => clamp_int(navigation[:turn_repeat_urgent_ms], NAV_TURN_REPEAT_URGENT_RANGE, defaults["turn_repeat_urgent_ms"]),
      "turn_green_hold_m" => clamp_int(navigation[:turn_green_hold_m], NAV_TURN_GREEN_HOLD_RANGE, defaults["turn_green_hold_m"]),
      "turn_green_hold_s" => clamp_int(navigation[:turn_green_hold_s], NAV_TURN_GREEN_HOLD_S_RANGE, defaults["turn_green_hold_s"]),
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

  # N'accepte qu'un profil proposé pour ce sport, sinon repli sur le défaut : pas de
  # combinaison incohérente type rando + profil vélo.
  def sanitize_route_profile(sport, value, default)
    value = value.to_s
    ALLOWED_ROUTE_PROFILES.fetch(sport, []).include?(value) ? value : default
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

  # Variantes préservant nil : une valeur absente/vide/invalide vaut « non renseigné »
  # (les seuils athlète sont optionnels), au lieu de retomber sur un défaut.
  def clamp_int_or_nil(value, range)
    return nil if value.nil? || value.to_s.strip.empty?
    n = Integer(value, exception: false)
    return nil if n.nil?
    n.clamp(range.min, range.max)
  end

  def clamp_float_or_nil(value, range)
    return nil if value.nil? || value.to_s.strip.empty?
    n = Float(value, exception: false)
    return nil if n.nil?
    n.clamp(range.min, range.max).round(1)
  end
end
