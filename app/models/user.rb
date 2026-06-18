class User < ApplicationRecord
  # Préférences par défaut du créateur d'itinéraire. Sert à la fois de valeurs
  # initiales et de schéma de référence (clés autorisées + types) pour assainir
  # les payloads entrants — cf. ProfilesController.
  DEFAULT_PREFERENCES = {
    "points_of_interest" => {
      "show_cemeteries" => true,
      "show_bakeries" => true,
      "show_localities" => false,
      "radius_m" => 1500,
    },
    "map" => {
      "default_style" => "cyclosm",
    },
    "display" => {
      "default_sport" => "cycling",   # cycling | mtb | hiking
      "show_grade_colors" => true,
      "show_elevation_chart" => true,
    },
    "climb_detection" => {
      "min_grade" => 2,        # pente moyenne minimale (%)
      "min_gain_m" => 60,      # dénivelé positif minimal (m)
      "min_length_m" => 500,   # longueur minimale (m)
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
    user.save!
    user
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
