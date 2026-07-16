class User < ApplicationRecord
  # Réglages par défaut d'UN sport (cf. DEFAULT_PREFERENCES["sports"]). Tout ce qui
  # dépend de la pratique vit ici : on roule vite sur route et lentement en montagne,
  # un « col » à vélo n'est pas un col à pied, et le fond de carte utile n'est pas le
  # même. Les arguments sont les réglages que l'on différencie d'un sport à l'autre ;
  # le reste part sur des valeurs communes, à charge de l'utilisateur de les ajuster.
  def self.sport_defaults(speed:, route_profile:, turn_anomaly_m:, map_style:, climb_detection:)
    {
      # Vitesse moyenne (km/h) — estimation du temps de parcours.
      "speed" => speed,
      # Profil de routage BRouter. Miroir du catalogue front (brouter.ts /
      # PROFILES_BY_SPORT) ; assaini contre ProfilesController::ALLOWED_ROUTE_PROFILES.
      "route_profile" => route_profile,
      # Détection d'amas de virages dans le créateur : diamètre (m) du cercle sous lequel
      # un groupe d'au moins 3 virages BRouter est signalé comme anomalie (typiquement un
      # point d'étape posé à côté de la route, qui fait crocheter le routage). Les sentiers
      # (rando/VTT) enchaînent des virages serrés légitimes (lacets) : un diamètre plus
      # petit y limite les faux positifs.
      "turn_anomaly_m" => turn_anomaly_m,
      # Avertissement « point accroché au loin » dans le créateur : écart (m) au-delà duquel
      # l'écart entre le point cliqué et le tracé obtenu est signalé. BRouter projette chaque
      # point sur la voie routable la plus proche ; un grand écart trahit l'absence de chemin
      # à l'endroit voulu. Commun aux sports faute d'élément justifiant de les différencier :
      # mesuré sur les itinéraires vélo existants, l'écart normal est de 1,2 m (médiane) à
      # 7,2 m (p90), donc 25 m ne signale que les vrais trous — à ajuster si les sentiers
      # (données OSM plus lacunaires) se révèlent trop bavards.
      "snap_warn_m" => 25,
      "map" => {
        "default_style" => map_style,
        "overlays" => [],   # couches transparentes actives (SuisseMobile/swisstopo)
      },
      # Tracé de l'itinéraire dans le créateur (hors mode pente pour la couleur).
      "route" => {
        "color" => "#7c3aed",
        "opacity" => 0.8,   # 0–1, s'applique dans tous les modes
        "width" => 5,       # épaisseur (px)
      },
      "climb_detection" => climb_detection,
      # Navigation guidée : aspect du tracé, indicateurs de direction, et distances/cadences
      # des annonces de virage. Communes à tous les sports par défaut — elles dépendent de la
      # vitesse réelle du moment et du goût de chacun, que l'utilisateur seul connaît — mais
      # réglables séparément : on ne lit pas une carte au guidon comme un sentier à pied.
      "navigation" => {
        "line_width" => 40,         # largeur (px) du tracé sur la carte de navigation
        "line_color" => "#7c3aed",  # couleur du tracé restant
        "line_opacity" => 0.8,      # opacité (0–1) du tracé
        "turn_marker_size" => 25,          # rayon (px) des pastilles de changement de direction
        "turn_marker_color" => "#f97316",  # couleur de la pastille
        "turn_marker_icon_color" => "#ffffff", # couleur de la flèche / du numéro de sortie
        "turn_alert_m" => 100,   # distance à laquelle l'annonce sonore se déclenche
        "turn_hint_m" => 150,    # distance à laquelle l'indicateur visuel apparaît
        "turn_urgent_m" => 50,   # distance à laquelle la card passe en orange
        "turn_now_m" => 15,      # distance avant un virage à partir de laquelle la pastille bascule en confirmation verte (« maintenant »)
        "turn_repeat_ms" => 2000, # intervalle entre deux répétitions du son de virage
        "turn_repeat_urgent_ms" => 1000, # intervalle entre deux répétitions quand le virage est proche (zone orange)
        "turn_green_hold_m" => 100, # distance parcourue après un virage pendant laquelle la confirmation verte reste affichée
        "turn_green_hold_s" => 10,  # durée max (s) d'affichage de la confirmation verte — elle disparaît au premier des deux : distance ou temps
      },
    }
  end

  # Sports gérés, dans leur ordre d'affichage. Miroir du type `Sport` côté front
  # (userPreferences.ts) et de ProfilesController::ALLOWED_SPORTS.
  SPORTS = %w[cycling mtb hiking].freeze

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
    # Navigation guidée (mode GPS) — réglages propres, indépendants du créateur : fond de
    # carte, caméra qui suit le coureur, son et recalcul. L'aspect du tracé, les indicateurs
    # de direction et les distances d'annonce, eux, sont propres au sport (cf. sport_defaults).
    "navigation" => {
      "default_style" => "swissgrau",
      "zoom" => 17,      # zoom de la caméra de suivi
      "pitch" => 0,        # inclinaison 3D (0 = vue du dessus, 70 = très rasante) — 0 par défaut pour économiser la batterie
      "terrain" => false,  # relief 3D (terrain MNT) sous le tracé
      "nav_fps" => 8,      # fréquence de la boucle d'animation (0.5–60 fps)
      "sound_volume" => 100, # volume général des alertes sonores (virages + radar), en % du volume de base
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
      "default_sport" => "cycling",   # cycling | mtb | hiking — sport des pages sans itinéraire
      "show_grade_colors" => true,
      "show_elevation_chart" => true,
      # Widget de cirage de chaîne sur la page d'accueil (n'apparaît de toute façon
      # que si Strava est lié — cf. pages/home.html.erb).
      "show_chain_widget" => true,
      # Widget « plan du jour » (charge d'entraînement) sur l'accueil (n'apparaît que
      # s'il y a des activités — cf. pages/home.html.erb).
      "show_performance_widget" => true,
    },
    # Réglages dépendant de la pratique. Le sport courant est celui de l'itinéraire
    # ouvert (Route#activity), ou `display.default_sport` à défaut — cf. sportPreferences()
    # côté front. Clés de premier niveau : SPORTS.
    #
    # Sur climb_detection, `min_grade` est comparé à la pente LISSÉE point par point (pas à
    # la moyenne du col) : c'est lui qui ouvre et ferme une montée. L'altitude étant
    # quantifiée au mètre, une fenêtre de lissage de w mètres laisse un bruit de pente de
    # ±100/w % ; un `min_grade` sous ce bruit hache la montée en tronçons. D'où le couple
    # (grade_smoothing_m, min_grade) calé partout sur min_grade ≈ 2 × 100/grade_smoothing_m.
    "sports" => {
      # Sur route, tout ce qui dépasse le faux plat (3 %) monte. Les cols enchaînent des
      # rampes séparées de replats parfois longs : on fusionne large (500 m).
      "cycling" => sport_defaults(
        speed: 18, route_profile: "trekking", turn_anomaly_m: 100, map_style: "cyclosm",
        climb_detection: {
          "min_grade" => 3,        # pente lissée au-delà de laquelle « ça monte » (%)
          "min_gain_m" => 50,      # dénivelé positif minimal (m)
          "min_length_m" => 500,   # longueur minimale (m)
          # Fenêtre horizontale (m) de lissage de la pente : l'altitude est quantifiée au
          # mètre, sans lissage la pente entre sommets voisins devient aberrante (cf. front).
          "grade_smoothing_m" => 60,
          # Écart (m) en deçà duquel deux montées consécutives sont fusionnées en un seul col.
          "merge_gap_m" => 500,
        }
      ),
      # Sur chemin, les montées sont plus courtes et plus hachées : on abaisse la longueur
      # minimale et on fusionne moins loin, sous peine d'agréger deux bosses distinctes.
      "mtb" => sport_defaults(
        speed: 14, route_profile: "gravel", turn_anomaly_m: 80, map_style: "topo",
        climb_detection: {
          "min_grade" => 4, "min_gain_m" => 50, "min_length_m" => 300,
          "grade_smoothing_m" => 40, "merge_gap_m" => 300,
        }
      ),
      # À pied, les montées sont bien plus raides (un sentier de montagne tourne autour de
      # 15 %) et bien plus courtes : sans seuils propres, tout le tracé serait un col. Sous
      # 6 % on marche à plat, et une bosse de moins de 100 m de D+ n'est pas une montée.
      "hiking" => sport_defaults(
        speed: 4.5, route_profile: "hiking-mountain", turn_anomaly_m: 60, map_style: "topo",
        climb_detection: {
          "min_grade" => 6, "min_gain_m" => 100, "min_length_m" => 250,
          "grade_smoothing_m" => 30, "merge_gap_m" => 200,
        }
      ),
    },
    # Seuils physiologiques de l'athlète, pour l'analyse d'entraînement (page Performances).
    # `ftp_manual` (watts) surcharge l'estimation automatique de la FTP quand elle est
    # renseignée (ex. issue d'un test officiel) ; `ftp_manual_at` date cette saisie.
    # `weight_kg` sert au calcul des W/kg. Tous nuls par défaut (aucune saisie).
    "athlete" => {
      "ftp_manual" => nil,
      "ftp_manual_at" => nil,
      "weight_kg" => nil,
      # Seuil de fréquence cardiaque (LTHR, bpm) : ancre du hrTSS pour les sorties sans
      # puissance. Estimé automatiquement (cf. TrainingLoad) mais surchargé si renseigné.
      "lthr_manual" => nil,
      "lthr_manual_at" => nil,
    },
  }.freeze

  # Menus de navigation configurables, dans leur ordre par défaut. Source de vérité des
  # clés autorisées : la définition (chemin, icône, libellé) vit côté vue (NavbarHelper)
  # et côté éditeur (UserProfile.vue). Ajouter un menu : une clé ici + l'entrée
  # correspondante dans NavbarHelper::NAVBAR_ITEM_DEFS et UserProfile.vue.
  NAVBAR_ITEM_KEYS = %w[dashboard performance routes new_route free_navigate chains].freeze

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
  # Itinéraires d'autrui ouverts via un lien partagé (cf. OpenedRoute).
  has_many :opened_routes, dependent: :destroy
  has_many :pois, dependent: :destroy
  has_many :imported_activities, dependent: :destroy
  has_many :strava_activities, dependent: :destroy
  has_many :strava_backfill_runs, dependent: :destroy
  has_many :bikes, dependent: :destroy

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
    result = self.class.merge_defaults(DEFAULT_PREFERENCES, preferences)
    # La navbar est une liste ordonnée (pas un simple hash de clés) : on la normalise
    # pour garantir des items valides et complets, même après l'ajout d'un nouveau menu.
    result["navbar"]["items"] = self.class.normalize_navbar_items(result.dig("navbar", "items"))
    result
  end

  # Fusion récursive des valeurs stockées dans le schéma des défauts : seules les clés
  # du schéma survivent (les clés inconnues, héritées d'une ancienne version, sont
  # ignorées) et les valeurs terminales — y compris les tableaux, remplacés en bloc —
  # tombent sur leur défaut quand elles manquent. La récursion est nécessaire depuis que
  # `sports` imbrique trois niveaux (sport → section → réglage).
  def self.merge_defaults(defaults, stored)
    defaults.each_with_object({}) do |(key, default), result|
      value = stored.is_a?(Hash) ? stored[key] : nil
      result[key] = default.is_a?(Hash) ? merge_defaults(default, value) : (value.nil? ? default : value)
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
