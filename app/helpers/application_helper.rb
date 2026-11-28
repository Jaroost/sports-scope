module ApplicationHelper
  THEMES = %w[light dark auto].freeze

  # Thème choisi sur cet appareil (cookie `theme`, posé par theme.ts). Un réglage
  # d'appareil et non de compte : on veut souvent le sombre sur l'ordinateur le soir
  # sans l'imposer au téléphone, et il doit marcher déconnecté.
  def theme_preference
    THEMES.include?(cookies[:theme]) ? cookies[:theme] : "auto"
  end

  # Valeur de `data-bs-theme` rendue côté serveur (pas de flash au chargement).
  # « auto » n'est tranché que par le script en tête de page (prefers-color-scheme).
  # Les pages de navigation plein écran restent claires : leurs panneaux flottent sur
  # la carte et sont conçus pour être lus en plein soleil.
  def rendered_bs_theme
    return "light" if content_for?(:hide_navbar)

    theme_preference == "auto" ? nil : theme_preference
  end
end
