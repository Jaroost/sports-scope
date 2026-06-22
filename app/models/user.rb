class User < ApplicationRecord
  # Préférences par défaut du créateur d'itinéraire. Sert à la fois de valeurs
  # initiales et de schéma de référence (clés autorisées + types) pour assainir
  # les payloads entrants — cf. ProfilesController.
  DEFAULT_PREFERENCES = {
    "points_of_interest" => {
      "show_cemeteries" => true,
      "show_bakeries" => true,
      "show_localities" => false,
      "show_water" => true,
      "show_food" => false,
      "show_viewpoints" => false,
      "show_toilets" => false,
      "show_picnic" => false,
      "radius_m" => 1500,
    },
    "map" => {
      "default_style" => "cyclosm",
      "overlays" => [],   # couches transparentes actives (SuisseMobile/swisstopo)
    },
    # Navigation guidée (mode GPS) — réglages propres, indépendants du créateur :
    # fond de carte, zoom et inclinaison (pitch) de la caméra qui suit le coureur.
    "navigation" => {
      "default_style" => "swissgrau",
      "zoom" => 19.5,      # zoom de la caméra de suivi
      "pitch" => 0,        # inclinaison 3D (0 = vue du dessus, 70 = très rasante) — 0 par défaut pour économiser la batterie
      "terrain" => false,  # relief 3D (terrain MNT) sous le tracé
      "nav_fps" => 8,      # fréquence de la boucle d'animation (0.5–60 fps)
      "line_width" => 40,  # largeur (px) du tracé sur la carte de navigation
      "line_color" => "#7c3aed",  # couleur du tracé restant sur la carte de navigation
      "line_opacity" => 0.8,      # opacité (0–1) du tracé sur la carte de navigation
      "turn_alert_m" => 100,   # distance (m) à laquelle l'annonce sonore se déclenche
      "turn_hint_m" => 150,    # distance (m) à laquelle l'indicateur visuel apparaît
      "turn_urgent_m" => 50,   # distance (m) à laquelle la card passe en orange
      "turn_repeat_ms" => 2000, # intervalle (ms) entre deux répétitions du son de virage
      "turn_marker_size" => 40, # rayon (px) des pastilles orange de changement de direction
      "turn_marker_color" => "#f97316",      # couleur de la pastille de changement de direction
      "turn_marker_icon_color" => "#ffffff", # couleur de la flèche / du numéro de sortie dans la pastille
      "radar_always_visible" => false, # afficher l'overlay radar en permanence (sinon seulement en présence d'un véhicule)
      "radar_close_m" => 30, # distance (m) sous laquelle le radar passe en alerte rapprochée (rouge + bip insistant)
    },
    "display" => {
      "default_sport" => "cycling",   # cycling | mtb | hiking
      "show_grade_colors" => true,
      "show_elevation_chart" => true,
      "route_color" => "#7c3aed",     # couleur du tracé dans le créateur (hors mode pente)
      "route_opacity" => 0.8,         # opacité (0–1) du tracé dans le créateur (tous modes)
      "route_width" => 5,             # épaisseur (px) du tracé dans le créateur
    },
    # Vitesse moyenne (km/h) par catégorie d'activité, utilisée pour estimer le
    # temps de parcours d'un itinéraire (créateur + liste).
    "speeds" => {
      "cycling" => 18,
      "mtb" => 14,
      "hiking" => 4.5,
    },
    "climb_detection" => {
      "min_grade" => 2,        # pente moyenne minimale (%)
      "min_gain_m" => 60,      # dénivelé positif minimal (m)
      "min_length_m" => 500,   # longueur minimale (m)
      # Fenêtre horizontale (m) de lissage de la pente : l'altitude est quantifiée au
      # mètre, sans lissage la pente entre sommets voisins devient aberrante (cf. front).
      "grade_smoothing_m" => 40,
    },
  }.freeze

  has_many :chart_layouts, dependent: :destroy
  has_many :routes, dependent: :destroy
  has_many :imported_activities, dependent: :destroy
  has_many :strava_activity_peak_powers, dependent: :destroy

  validates :keycloak_uid, presence: true, uniqueness: true
  validates :email, presence: true, uniqueness: true

  def self.from_keycloak(auth)
    user = find_or_initialize_by(keycloak_uid: auth.uid)
    user.email = auth.info.email
    user.display_name = auth.info.name.presence || auth.info.email
    user.roles = roles_from_token(auth.credentials.token)
    user.save!
    user
  end

  # Extrait les rôles de realm Keycloak de l'access token JWT. Le token vient de
  # Keycloak via le flow OIDC code (TLS) ; on décode simplement le payload.
  def self.roles_from_token(access_token)
    payload = access_token.to_s.split(".")[1]
    return [] unless payload

    claims = JSON.parse(Base64.urlsafe_decode64(payload + "=" * (-payload.length % 4)))
    Array(claims.dig("realm_access", "roles"))
  rescue StandardError
    []
  end

  def attach_strava!(auth)
    update!(
      strava_uid: auth.uid,
      strava_access_token: auth.credentials.token,
      strava_refresh_token: auth.credentials.refresh_token,
      strava_expires_at: Time.at(auth.credentials.expires_at).utc
    )
  end

  # Préférences fusionnées avec les valeurs par défaut : garantit que toute clé
  # absente (utilisateur ancien, nouvelle préférence ajoutée depuis) est présente
  # côté front avec sa valeur par défaut.
  def preferences_with_defaults
    DEFAULT_PREFERENCES.each_with_object({}) do |(section, defaults), result|
      stored = preferences.is_a?(Hash) ? (preferences[section] || {}) : {}
      result[section] = defaults.merge(stored.slice(*defaults.keys))
    end
  end

  def detach_strava!
    update!(
      strava_uid: nil,
      strava_access_token: nil,
      strava_refresh_token: nil,
      strava_expires_at: nil
    )
  end

  def strava_linked?
    strava_uid.present? && strava_access_token.present?
  end

  def strava_token_expired?
    strava_expires_at.nil? || strava_expires_at <= Time.current
  end

  def refresh_strava_token!
    return strava_access_token unless strava_token_expired?

    response = Faraday.post(
      'https://www.strava.com/oauth/token',
      {
        client_id: ENV['STRAVA_CLIENT_ID'],
        client_secret: ENV['STRAVA_CLIENT_SECRET'],
        grant_type: 'refresh_token',
        refresh_token: strava_refresh_token
      }
    )
    raise "Strava token refresh failed: #{response.status}" unless response.success?

    body = JSON.parse(response.body)
    update!(
      strava_access_token: body['access_token'],
      strava_refresh_token: body['refresh_token'],
      strava_expires_at: Time.at(body['expires_at']).utc
    )
    strava_access_token
  end
end
