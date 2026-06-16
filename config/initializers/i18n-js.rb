return unless defined?(I18nJS)

# Regenerate JSON translation files from Rails locale YAMLs on every boot so
# that the Vite server (dev) and asset precompile (prod) always get fresh files.
# The output is consumed by app/javascript/i18n.ts.
Rails.application.config.after_initialize do
  begin
    I18nJS.call(config_file: Rails.root.join("config/i18n-js.yml"))
  rescue StandardError => e
    Rails.logger.warn("[i18n-js] export failed: #{e.message}")
  end
end
