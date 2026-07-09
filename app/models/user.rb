class User < ApplicationRecord
  # Préférences par défaut du créateur d'itinéraire. Sert à la fois de valeurs
  # initiales et de schéma de référence (clés autorisées + types) pour assainir
  # les payloads entrants — cf. ProfilesController.
  DEFAULT_PREFERENCES = {
    # Menus de la barre de navigation : liste ordonnée (l'ordre = ordre d'affichage)
    # d'items {clé, visible}. L'utilisateur peut réordonner et masquer chaque menu
    # depuis son profil. Les clés sont validées contre NAVBAR_ITEM_KEYS ; tout menu
    # connu absent du tableau stocké est réinjecté (visible) par normalize_navbar_items,
    # de sorte qu'un menu ajouté plus tard apparaisse pour les comptes existants.
    # Chaque menu porte deux interrupteurs indépendants : `visible` (présent dans la
    # barre de navigation) et `home` (présent comme bouton sur la page d'accueil).
    "navbar" => {
      "items" => [
        { "key" => "dashboard", "visible" => true, "home" => true },
        { "key" => "routes", "visible" => true, "home" => true },
        { "key" => "new_route", "visible" => true, "home" => true },
        { "key" => "free_navigate", "visible" => true, "home" => true },
        { "key" => "chains", "visible" => true, "home" => true },
      ],
    },
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
      "alert_m" => 100,    # distance (m) à laquelle un POI proche déclenche la notification de navigation
    },
    "map" => {
      "default_style" => "cyclosm",
      "overlays" => [],   # couches transparentes actives (SuisseMobile/swisstopo)
    },
    # Navigation guidée (mode GPS) — réglages propres, indépendants du créateur :
    # fond de carte, zoom et inclinaison (pitch) de la caméra qui suit le coureur.
    "navigation" => {
      "default_style" => "swissgrau",
      "zoom" => 17,      # zoom de la caméra de suivi
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
      "turn_repeat_urgent_ms" => 1000, # intervalle (ms) entre deux répétitions du son quand le virage est proche (zone orange)
      "turn_now_m" => 15, # distance (m) avant un virage à partir de laquelle la pastille bascule en confirmation verte (« maintenant »)
      "turn_green_hold_m" => 100, # distance (m) parcourue après un virage pendant laquelle la confirmation verte (« maintenant ») reste affichée
      "turn_green_hold_s" => 10, # durée max (s) d'affichage de la confirmation verte (« maintenant ») — elle disparaît au premier des deux : distance ou temps
      "sound_volume" => 100, # volume général des alertes sonores (virages + radar), en % du volume de base
      "turn_marker_size" => 25, # rayon (px) des pastilles orange de changement de direction
      "turn_marker_color" => "#f97316",      # couleur de la pastille de changement de direction
      "turn_marker_icon_color" => "#ffffff", # couleur de la flèche / du numéro de sortie dans la pastille
      "show_climb_card" => true, # afficher le profil des cols (graphique d'altitude) pendant la navigation
      "radar_close_m" => 30, # distance (m) sous laquelle le radar passe en alerte rapprochée (rouge + bip insistant)
      "auto_reroute" => true, # recalculer automatiquement l'itinéraire dès qu'on quitte le tracé (hors-course)
      "auto_reroute_cooldown_s" => 10, # délai (s) entre deux recalculs automatiques tant qu'on reste hors-course
    },
    # Recherche de lieux (barre de recherche du créateur d'itinéraire) : liste
    # ordonnée de pays privilégiés (ISO 3166-1 alpha-2). Passée en `countrycodes`
    # à Nominatim et utilisée pour trier les résultats. Si aucun résultat dans ces
    # pays, le front retombe sur une recherche mondiale (cf. RouteBuilderMap).
    "search" => {
      "country_codes" => %w[ch fr it at de],
      "worldwide_fallback" => false, # étendre au monde entier si aucun résultat dans les pays ci-dessus
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
    # Détection d'amas de virages dans le créateur : diamètre (m) du cercle sous lequel
    # un groupe d'au moins 3 virages BRouter est signalé comme anomalie (typiquement un
    # point d'étape posé à côté de la route, qui fait crocheter le routage). Réglable par
    # sport car les sentiers (rando/VTT) enchaînent des virages serrés légitimes (lacets)
    # : un diamètre plus petit y limite les faux positifs.
    "turn_anomaly" => {
      "cycling" => 100,
      "mtb" => 80,
      "hiking" => 60,
    },
    # Profil de routage BRouter par défaut, par sport. Miroir du catalogue front
    # (brouter.ts / PROFILES_BY_SPORT) ; utilisé comme profil initial d'un nouvel
    # itinéraire du sport. Assaini contre ProfilesController::ALLOWED_ROUTE_PROFILES.
    "route_profiles" => {
      "cycling" => "trekking",
      "mtb" => "gravel",
      "hiking" => "hiking-mountain",
    },
    "climb_detection" => {
      "min_grade" => 2,        # pente moyenne minimale (%)
      "min_gain_m" => 60,      # dénivelé positif minimal (m)
      "min_length_m" => 500,   # longueur minimale (m)
      # Fenêtre horizontale (m) de lissage de la pente : l'altitude est quantifiée au
      # mètre, sans lissage la pente entre sommets voisins devient aberrante (cf. front).
      "grade_smoothing_m" => 40,
      # Écart (m) en deçà duquel deux montées consécutives sont fusionnées en un seul col.
      "merge_gap_m" => 350,
    },
  }.freeze

  # Menus de navigation configurables, dans leur ordre par défaut. Source de vérité des
  # clés autorisées : la définition (chemin, icône, libellé) vit côté vue (NavbarHelper)
  # et côté éditeur (UserProfile.vue). Ajouter un menu : une clé ici + l'entrée
  # correspondante dans NavbarHelper::NAVBAR_ITEM_DEFS et UserProfile.vue.
  NAVBAR_ITEM_KEYS = %w[dashboard routes new_route free_navigate chains].freeze

  # Assainit/normalise un tableau d'items de navbar reçu (front ou base) : ne garde que
  # les clés connues, dédoublonnées, dans l'ordre reçu, en coercant `visible` et `home`
  # en booléens ; puis réinjecte (visible + sur l'accueil) tout menu connu absent, afin
  # qu'un menu ajouté plus tard apparaisse pour les comptes existants. Retourne toujours
  # la liste complète et valide.
  def self.normalize_navbar_items(raw)
    raw = [] unless raw.is_a?(Array)
    by_key = {}
    raw.each do |item|
      next unless item.is_a?(Hash)
      key = (item["key"] || item[:key]).to_s
      next unless NAVBAR_ITEM_KEYS.include?(key) && !by_key.key?(key)
      by_key[key] = {
        "key" => key,
        "visible" => coerce_navbar_flag(item, "visible", :visible),
        "home" => coerce_navbar_flag(item, "home", :home),
      }
    end
    NAVBAR_ITEM_KEYS.each { |key| by_key[key] ||= { "key" => key, "visible" => true, "home" => true } }
    by_key.values
  end

  # Lit un drapeau booléen d'item de navbar (`visible`/`home`) en acceptant les clés
  # string ou symbole ; absent ou nil ⇒ true (le menu est actif par défaut).
  def self.coerce_navbar_flag(item, str_key, sym_key)
    value = item.key?(str_key) ? item[str_key] : item[sym_key]
    value.nil? ? true : ActiveModel::Type::Boolean.new.cast(value)
  end

  has_many :chart_layouts, dependent: :destroy
  has_many :routes, dependent: :destroy
  has_many :pois, dependent: :destroy
  has_many :imported_activities, dependent: :destroy
  has_many :strava_activities, dependent: :destroy
  has_many :bikes, dependent: :destroy
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
    end.tap do |result|
      # La navbar est une liste ordonnée (pas un simple hash de clés) : on la normalise
      # pour garantir des items valides et complets, même après l'ajout d'un nouveau menu.
      result["navbar"]["items"] = self.class.normalize_navbar_items(result.dig("navbar", "items"))
    end
  end

  # Items de navbar normalisés (ordre + visibilité) pour le rendu de la barre.
  def navbar_items
    preferences_with_defaults.dig("navbar", "items")
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
