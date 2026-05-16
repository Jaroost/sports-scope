Rails.application.routes.draw do
  scope "(:locale)", locale: /en|fr/ do
    root "pages#home"
    get "/dashboard", to: "pages#dashboard", as: :dashboard
    get "/activities/:id", to: "activities#show", as: :activity, constraints: { id: /\d+/ }
    get "/routes", to: "pages#routes_index", as: :routes_index
    get "/routes/new", to: "pages#route_builder", as: :new_route
    get "/routes/:id/edit", to: "pages#route_builder", as: :edit_route, constraints: { id: /\d+/ }
  end

  # OmniAuth (POST entry points, GET callbacks)
  post "/auth/:provider", to: "sessions#passthrough", as: :auth_request, constraints: { provider: /keycloak|strava/ }
  match "/auth/:provider/callback", to: "sessions#create", via: [:get, :post]
  get "/auth/failure", to: "sessions#failure"
  delete "/logout", to: "sessions#destroy", as: :logout

  # Strava activities (JSON consumed by Vue components)
  get "/strava/activities", to: "strava#activities", as: :strava_activities
  get "/strava/activities/:id", to: "strava#show", as: :strava_activity, constraints: { id: /\d+/ }
  get "/strava/activities/:id/streams", to: "strava#streams", as: :strava_activity_streams, constraints: { id: /\d+/ }
  get "/strava/activities/:id/photos", to: "strava#photos", as: :strava_activity_photos, constraints: { id: /\d+/ }

  # Route builder (JSON CRUD consumed by Vue components)
  get "/api/routes", to: "routes#index"
  post "/api/routes", to: "routes#create"
  get "/api/routes/:id", to: "routes#show", constraints: { id: /\d+/ }
  patch "/api/routes/:id", to: "routes#update", constraints: { id: /\d+/ }
  delete "/api/routes/:id", to: "routes#destroy", constraints: { id: /\d+/ }
  get "/api/routes/:id/gpx", to: "routes#export_gpx", constraints: { id: /\d+/ }

  # User preferences (JSON consumed by Vue components) — named layout presets
  get "/preferences/chart_layouts", to: "preferences#index"
  post "/preferences/chart_layouts", to: "preferences#create"
  post "/preferences/chart_layouts/last_used", to: "preferences#set_last_used"
  patch "/preferences/chart_layouts/:id", to: "preferences#update", constraints: { id: /\d+/ }
  delete "/preferences/chart_layouts/:id", to: "preferences#destroy", constraints: { id: /\d+/ }

  # Health
  get "up" => "rails/health#show", as: :rails_health_check
end
