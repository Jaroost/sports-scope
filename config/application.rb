require_relative "boot"

require "rails"
# Pick the frameworks you want:
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
require "active_storage/engine"
require "action_controller/railtie"
require "action_mailer/railtie"
require "action_mailbox/engine"
require "action_text/engine"
require "action_view/railtie"
require "action_cable/engine"
require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module SportsScope
  class Application < Rails::Application
    config.load_defaults 8.1
    config.autoload_lib(ignore: %w[assets tasks])

    config.i18n.available_locales = [:en, :fr]
    config.i18n.default_locale = :en

    config.generators.system_tests = nil

    # SMTP Google (Gmail / Google Workspace) : STARTTLS sur 587, mot de passe d'application.
    # Sans SMTP_USER, rien n'est configuré plutôt que de planter au démarrage. Commun au dev
    # et à la prod ; les tests gardent le delivery_method :test de leur environnement.
    if ENV["SMTP_USER"].present? && !Rails.env.test?
      config.action_mailer.delivery_method = :smtp
      config.action_mailer.smtp_settings = {
        address: ENV.fetch("SMTP_HOST", "smtp.gmail.com"),
        port: ENV.fetch("SMTP_PORT", 587).to_i,
        user_name: ENV["SMTP_USER"],
        password: ENV["SMTP_PASSWORD"],
        authentication: :plain,
        enable_starttls_auto: true
      }
    end
  end
end
