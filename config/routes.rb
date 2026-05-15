Rails.application.routes.draw do
  scope "(:locale)", locale: /en|fr/ do
    root "pages#home"
    get "/dashboard", to: "pages#dashboard", as: :dashboard
    get "/activities/:id", to: "activities#show", as: :activity, constraints: { id: /\d+/ }
  end

  # OmniAuth (POST entry points, GET callbacks)
  post "/auth/:provider", to: "sessions#passthrough", as: :auth_request, constraints: { provider: /keycloak|strava/ }
  match "/auth/:provider/callback", to: "sessions#create", via: [:get, :post]
  get "/auth/failure", to: "sessions#failure"
  delete "/logout", to: "sessions#destroy", as: :logout

  # Strava activities (JSON consumed by Vue components)
  get "/strava/activities", to: "strava#activities", as: :strava_activities
  get "/strava/activities/:id", to: "strava#show", as: :strava_activity, constraints: { id: /\d+/ }

  # Health
  get "up" => "rails/health#show", as: :rails_health_check
end
