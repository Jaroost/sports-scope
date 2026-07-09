# Regroupe sous `preferences["sports"][<sport>]` les réglages qui dépendent de la
# pratique : ils étaient jusqu'ici soit globaux (fond de carte, aspect du tracé, détection
# de cols, tracé et indicateurs de la navigation guidée, distances d'annonce de virage),
# soit éclatés dans des hashs indexés par sport (`speeds`, `turn_anomaly`, `route_profiles`).
#
# Les réglages jusqu'alors globaux sont recopiés à l'identique sur les trois sports :
# personne ne voit son comportement changer, chacun peut ensuite diverger.
#
# Seule exception : la détection de cols repart des défauts du sport. La recopier
# reviendrait à imposer à la rando des seuils pensés pour la route (2 % de pente sur
# 500 m), c'est-à-dire à faire d'un sentier de montagne un seul col interminable — et
# personne ne serait jamais allé chercher les nouveaux seuils dans son profil.
#
# Les constantes sont figées ici plutôt que lues sur User : une migration doit produire
# le même résultat quelle que soit la version du modèle au moment où on la rejoue.
class RestructurePreferencesPerSport < ActiveRecord::Migration[8.1]
  SPORTS = %w[cycling mtb hiking].freeze

  SPEEDS = { "cycling" => 18, "mtb" => 14, "hiking" => 4.5 }.freeze
  TURN_ANOMALY = { "cycling" => 100, "mtb" => 80, "hiking" => 60 }.freeze
  ROUTE_PROFILES = { "cycling" => "trekking", "mtb" => "gravel", "hiking" => "hiking-mountain" }.freeze
  MAP_STYLES = { "cycling" => "cyclosm", "mtb" => "topo", "hiking" => "topo" }.freeze

  CLIMB_DETECTION = {
    "cycling" => { "min_grade" => 3, "min_gain_m" => 50, "min_length_m" => 500, "grade_smoothing_m" => 60, "merge_gap_m" => 500 },
    "mtb" => { "min_grade" => 4, "min_gain_m" => 50, "min_length_m" => 300, "grade_smoothing_m" => 40, "merge_gap_m" => 300 },
    "hiking" => { "min_grade" => 6, "min_gain_m" => 100, "min_length_m" => 250, "grade_smoothing_m" => 30, "merge_gap_m" => 200 },
  }.freeze

  ROUTE = { "color" => "#7c3aed", "opacity" => 0.8, "width" => 5 }.freeze

  SPORT_NAV = {
    "line_width" => 40, "line_color" => "#7c3aed", "line_opacity" => 0.8,
    "turn_marker_size" => 25, "turn_marker_color" => "#f97316", "turn_marker_icon_color" => "#ffffff",
    "turn_alert_m" => 100, "turn_hint_m" => 150, "turn_urgent_m" => 50, "turn_now_m" => 15,
    "turn_repeat_ms" => 2000, "turn_repeat_urgent_ms" => 1000,
    "turn_green_hold_m" => 100, "turn_green_hold_s" => 10,
  }.freeze

  # Clés retirées du premier niveau (leur contenu part dans `sports`).
  MOVED_TOP_LEVEL = %w[map speeds turn_anomaly route_profiles climb_detection].freeze
  MOVED_DISPLAY = %w[route_color route_opacity route_width].freeze
  MOVED_NAVIGATION = SPORT_NAV.keys.freeze

  class MigrationUser < ActiveRecord::Base
    self.table_name = "users"
  end

  def up
    each_user_preferences do |prefs|
      sports = SPORTS.index_with { |sport| sport_section(prefs, sport) }

      prefs.except(*MOVED_TOP_LEVEL).merge(
        "display" => (prefs["display"] || {}).except(*MOVED_DISPLAY),
        "navigation" => (prefs["navigation"] || {}).except(*MOVED_NAVIGATION),
        "sports" => sports
      )
    end
  end

  # Repli sur les réglages du sport par défaut de l'utilisateur : c'est le seul choix
  # qui préserve son expérience courante, les autres sports étant nécessairement perdus.
  def down
    each_user_preferences do |prefs|
      sport = prefs.dig("display", "default_sport")
      sport = "cycling" unless SPORTS.include?(sport)
      sports = prefs["sports"] || {}
      current = sports[sport] || {}

      prefs.except("sports").merge(
        "map" => current["map"] || { "default_style" => MAP_STYLES[sport], "overlays" => [] },
        "climb_detection" => current["climb_detection"] || CLIMB_DETECTION[sport],
        "speeds" => SPORTS.index_with { |s| sports.dig(s, "speed") || SPEEDS[s] },
        "turn_anomaly" => SPORTS.index_with { |s| sports.dig(s, "turn_anomaly_m") || TURN_ANOMALY[s] },
        "route_profiles" => SPORTS.index_with { |s| sports.dig(s, "route_profile") || ROUTE_PROFILES[s] },
        "display" => (prefs["display"] || {}).merge(
          "route_color" => current.dig("route", "color") || ROUTE["color"],
          "route_opacity" => current.dig("route", "opacity") || ROUTE["opacity"],
          "route_width" => current.dig("route", "width") || ROUTE["width"]
        ),
        "navigation" => (prefs["navigation"] || {}).merge(current["navigation"] || SPORT_NAV)
      )
    end
  end

  private

  # Réécrit les préférences de chaque compte via le bloc. Les comptes sans préférences
  # stockées n'ont rien à migrer : les défauts du modèle les servent déjà.
  def each_user_preferences
    MigrationUser.find_each do |user|
      prefs = user.preferences
      next unless prefs.is_a?(Hash) && prefs.present?

      user.update_column(:preferences, yield(prefs))
    end
  end

  # Bloc d'un sport : ses réglages déjà propres au sport, plus les ex-réglages globaux
  # recopiés tels quels. Toute valeur absente tombe sur le défaut du sport.
  def sport_section(prefs, sport)
    display = prefs["display"] || {}
    {
      "speed" => prefs.dig("speeds", sport) || SPEEDS[sport],
      "route_profile" => prefs.dig("route_profiles", sport) || ROUTE_PROFILES[sport],
      "turn_anomaly_m" => prefs.dig("turn_anomaly", sport) || TURN_ANOMALY[sport],
      "map" => prefs["map"] || { "default_style" => MAP_STYLES[sport], "overlays" => [] },
      "route" => {
        "color" => display["route_color"] || ROUTE["color"],
        "opacity" => display["route_opacity"] || ROUTE["opacity"],
        "width" => display["route_width"] || ROUTE["width"],
      },
      "climb_detection" => CLIMB_DETECTION[sport],
      "navigation" => SPORT_NAV.merge((prefs["navigation"] || {}).slice(*MOVED_NAVIGATION)),
    }
  end
end
