return unless defined?(I18nJS)

# In development, regenerate the JSON translations on boot so that the Vite
# server picks them up automatically. The output is consumed by
# app/javascript/i18n.js.
if Rails.env.development?
  Rails.application.config.after_initialize do
    begin
      I18nJS.call(config_file: Rails.root.join("config/i18n-js.yml"))
    rescue StandardError => e
      Rails.logger.warn("[i18n-js] export failed: #{e.message}")
    end
  end
end
