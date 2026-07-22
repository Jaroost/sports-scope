source "https://rubygems.org"

# Bundle edge Rails instead: gem "rails", github: "rails/rails", branch: "main"
gem "rails", "~> 8.1.3"
# The modern asset pipeline for Rails [https://github.com/rails/propshaft]
gem "propshaft"
# Use postgresql as the database for Active Record
gem "pg", "~> 1.1"
# Use the Puma web server [https://github.com/puma/puma]
gem "puma", ">= 5.0"
# Use Redis adapter to run Action Cable in production
# gem "redis", ">= 4.0.1"

# Use Active Model has_secure_password [https://guides.rubyonrails.org/active_model_basics.html#securepassword]
# gem "bcrypt", "~> 3.1.7"

# Windows does not include zoneinfo files, so bundle the tzinfo-data gem
gem "tzinfo-data", platforms: %i[ windows jruby ]

# Add HTTP asset caching/compression and X-Sendfile acceleration to Puma [https://github.com/basecamp/thruster/]
gem "thruster", require: false

# Use Active Storage variants [https://guides.rubyonrails.org/active_storage_overview.html#transforming-images]
gem "image_processing", "~> 1.2"

# Asset bundling with Vite + pnpm
gem "vite_rails", "~> 3.0"

# Authentication via Keycloak (OpenID Connect) + Strava OAuth
gem "omniauth", "~> 2.1"
gem "omniauth_openid_connect", "~> 0.8"
gem "omniauth-rails_csrf_protection", "~> 1.0"
gem "omniauth-oauth2", "~> 1.8"

# Authorization (rôles : utilisateur simple / administrateur)
gem "cancancan", "~> 3.6"

# Share Rails translations with JS
gem "i18n-js", "~> 4.2"

# HTTP client for Keycloak broker / Strava API calls
gem "faraday", "~> 2.9"

# Génération de PNG en Ruby pur (aucune dépendance système) — vignette Open Graph
# des itinéraires partagés, cf. RoutePreviewImage.
gem "chunky_png", "~> 1.4"

group :development, :test do
  # Load .env files in dev/test
  gem "dotenv-rails", "~> 3.1"

  # See https://guides.rubyonrails.org/debugging_rails_applications.html#debugging-with-the-debug-gem
  gem "debug", platforms: %i[ mri windows ], require: "debug/prelude"

  # Audits gems for known security defects (use config/bundler-audit.yml to ignore issues)
  gem "bundler-audit", require: false

  # Static analysis for security vulnerabilities [https://brakemanscanner.org/]
  gem "brakeman", require: false

  # Omakase Ruby styling [https://github.com/rails/rubocop-rails-omakase/]
  gem "rubocop-rails-omakase", require: false
end

group :development do
  # Use console on exceptions pages [https://github.com/rails/web-console]
  gem "web-console"
end
