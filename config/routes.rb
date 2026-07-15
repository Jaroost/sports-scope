Rails.application.routes.draw do
  scope "(:locale)", locale: /en|fr/ do
    root "pages#home"
    get "/dashboard", to: "pages#dashboard", as: :dashboard
    get "/performance", to: "pages#performance", as: :performance
    get "/activities/:id", to: "activities#show", as: :activity, constraints: { id: /\d+/ }
    get "/imported_activities/:id", to: "activities#show_imported", as: :imported_activity, constraints: { id: /\d+/ }
    get "/routes", to: "pages#routes_index", as: :routes_index
    # Navigation unifiée : démarre en navigation libre (carte + GPS + vitesse) et peut
    # charger un itinéraire à la volée. Publique (aucun login requis).
    get "/navigate", to: "pages#free_navigation", as: :free_navigate
    get "/routes/new", to: "pages#route_builder", as: :new_route
    get "/routes/:id/edit", to: "pages#route_builder", as: :edit_route, constraints: { id: /\d+/ }
    # Navigation is addressed by share_token (not id) so the link is shareable
    # and unguessable; the page and its API are public.
    get "/routes/:token/navigate", to: "pages#route_navigation", as: :navigate_route
    # Read-only view of a route inside the builder UI — addressed by share_token,
    # public (works for signed-out recipients).
    get "/routes/:token/view", to: "pages#route_view", as: :view_route
    get "/profile", to: "profiles#show", as: :profile
    delete "/profile/strava", to: "profiles#unlink_strava", as: :unlink_strava
    # Suivi du cirage de chaîne (par vélo)
    get "/chains", to: "pages#chains", as: :chains
  end

  # Web Share Target (Android) : le service worker intercepte normalement ce POST
  # côté client (cf. public/service-worker.js) et n'atteint jamais le serveur. Cette
  # route est un filet de sécurité quand le SW n'intercepte pas (SW obsolète, lancement
  # à froid avant prise de contrôle, navigateur non compatible) : le serveur lit le .gpx
  # partagé et rend le créateur avec le tracé chargé. Hors scope de langue : l'action
  # déclarée dans le manifest est /routes/share-target, sans préfixe de locale.
  post "/routes/share-target", to: "pages#share_target"

  # User preferences profile (JSON consumed by Vue)
  patch "/api/profile/preferences", to: "profiles#update"

  # OmniAuth (POST entry points, GET callbacks)
  post "/auth/:provider", to: "sessions#passthrough", as: :auth_request, constraints: { provider: /keycloak|strava/ }
  match "/auth/:provider/callback", to: "sessions#create", via: [:get, :post]
  get "/auth/failure", to: "sessions#failure"
  delete "/logout", to: "sessions#destroy", as: :logout

  # Strava activities (JSON consumed by Vue components)
  get "/strava/activities", to: "strava#activities", as: :strava_activities
  post "/strava/sync", to: "strava#sync", as: :strava_sync
  post "/strava/refresh", to: "strava#refresh", as: :strava_refresh
  get "/strava/backfill", to: "strava#backfill_status", as: :strava_backfill
  post "/strava/backfill", to: "strava#backfill"
  get "/strava/activities/:id", to: "strava#show", as: :strava_activity, constraints: { id: /\d+/ }
  get "/strava/activities/:id/streams", to: "strava#streams", as: :strava_activity_streams, constraints: { id: /\d+/ }
  get "/strava/activities/:id/peak_power_ranks", to: "strava#peak_power_ranks", as: :strava_activity_peak_power_ranks, constraints: { id: /\d+/ }
  get "/strava/activities/:id/photos", to: "strava#photos", as: :strava_activity_photos, constraints: { id: /\d+/ }

  # Analyse de performance (records / cumuls / courbe de puissance — JSON pour Vue)
  get "/api/performance", to: "performance#show", as: :api_performance
  get "/api/performance/ftp", to: "performance#ftp", as: :api_performance_ftp
  get "/api/performance/training_load", to: "performance#training_load", as: :api_performance_training_load

  # Seuils physiologiques de l'athlète (FTP manuelle, poids — JSON pour Vue)
  patch "/api/athlete", to: "profiles#update_athlete"

  # Maintenance réservée aux administrateurs (déclenchée depuis l'UI)
  namespace :admin do
    post "/maintenance/backfill_derivations", to: "maintenance#backfill_derivations"
  end

  # Geocoding proxy (avoids CORS when calling Nominatim from the browser)
  get "/api/geocode/places", to: "geocodes#places"

  # Météo historique (Open-Meteo) — conditions du jour d'une activité
  get "/api/weather", to: "weather#show"

  # Route builder (JSON CRUD consumed by Vue components)
  get "/api/routes", to: "routes#index"
  post "/api/routes", to: "routes#create"
  get "/api/routes/shared/:token", to: "routes#shared"
  get "/api/routes/shared/:token/gpx", to: "routes#export_gpx_shared"
  get "/api/routes/:id", to: "routes#show", constraints: { id: /\d+/ }
  patch "/api/routes/:id", to: "routes#update", constraints: { id: /\d+/ }
  delete "/api/routes/:id", to: "routes#destroy", constraints: { id: /\d+/ }
  get "/api/routes/:id/gpx", to: "routes#export_gpx", constraints: { id: /\d+/ }
  post "/api/routes/:id/duplicate", to: "routes#duplicate", constraints: { id: /\d+/ }

  # Saved points of interest (JSON consumed by Vue components) — global to the user,
  # rendered in the route builder and in navigation.
  get "/api/pois", to: "pois#index"
  post "/api/pois", to: "pois#create"
  patch "/api/pois/:id", to: "pois#update", constraints: { id: /\d+/ }
  delete "/api/pois/:id", to: "pois#destroy", constraints: { id: /\d+/ }

  # Imported (FIT) activities (JSON consumed by Vue components)
  get "/api/imported_activities", to: "imported_activities#index"
  post "/api/imported_activities", to: "imported_activities#create"
  get "/api/imported_activities/:id", to: "imported_activities#show", constraints: { id: /\d+/ }
  get "/api/imported_activities/:id/streams", to: "imported_activities#streams", constraints: { id: /\d+/ }
  get "/api/imported_activities/:id/peak_power_ranks", to: "imported_activities#peak_power_ranks", constraints: { id: /\d+/ }
  delete "/api/imported_activities/:id", to: "imported_activities#destroy", constraints: { id: /\d+/ }

  # Bike chain waxing tracker (JSON consumed by Vue components)
  get    "/api/bikes", to: "bikes#index"
  patch  "/api/bikes/:id", to: "bikes#update", constraints: { id: /\d+/ }
  post   "/api/bikes/:id/chains", to: "bikes#add_chain", constraints: { id: /\d+/ }
  post   "/api/bikes/:id/mount", to: "bikes#mount", constraints: { id: /\d+/ }
  patch  "/api/chains/:id", to: "chains#update", constraints: { id: /\d+/ }
  delete "/api/chains/:id", to: "chains#destroy", constraints: { id: /\d+/ }
  post   "/api/chains/:id/wax", to: "chains#wax", constraints: { id: /\d+/ }

  # User preferences (JSON consumed by Vue components) — named layout presets
  get "/preferences/chart_layouts", to: "preferences#index"
  post "/preferences/chart_layouts", to: "preferences#create"
  post "/preferences/chart_layouts/last_used", to: "preferences#set_last_used"
  patch "/preferences/chart_layouts/:id", to: "preferences#update", constraints: { id: /\d+/ }
  delete "/preferences/chart_layouts/:id", to: "preferences#destroy", constraints: { id: /\d+/ }

  # Digital Asset Links — lie l'app Android (TWA) au domaine (plein écran sans
  # barre d'URL). Configuré via ANDROID_PACKAGE_NAME / ANDROID_CERT_FINGERPRINTS.
  get "/.well-known/assetlinks.json", to: "well_known#assetlinks"

  # Health
  get "up" => "rails/health#show", as: :rails_health_check
end
