# Vignette PNG d'un itinéraire, pour la balise `og:image` de la page de partage.
#
# Pourquoi du dessin à la main plutôt qu'un rendu de carte : les crawlers d'aperçu
# (WhatsApp, Slack, Signal, iMessage) n'exécutent pas de JS — MapLibre est donc hors
# jeu — et n'acceptent pas le SVG, qui est pourtant le format de l'aperçu déjà stocké
# (`routes.preview_segments`). On redessine donc la polyligne en PNG, en Ruby pur
# (chunky_png) : aucune dépendance système à ajouter aux images Docker, et un rendu
# identique à la vignette de la liste — tracé coloré par pente, sans fond de carte.
#
# Le texte du résumé (km, D+, durée) n'est PAS incrusté dans l'image : chunky_png ne
# sait pas rendre de police. Il vit dans `og:description`, que toutes les cibles
# affichent sous la vignette.
class RoutePreviewImage
  # Format d'aperçu attendu par les réseaux sociaux et les messageries (ratio 1.91:1).
  WIDTH = 1200
  HEIGHT = 630
  # Marge autour du tracé, en pixels de l'image finale.
  PADDING = 60
  # Épaisseur du trait (px). Dessinée en empilant des lignes décalées : chunky_png
  # ne trace que des lignes de 1 px.
  STROKE = 7

  BACKGROUND = ChunkyPNG::Color.rgb(33, 37, 41)      # bg-dark Bootstrap — le thème de l'app
  # Couleurs de pente — mêmes valeurs que gradeColor() côté front (RoutesList.vue).
  COLORS = {
    0 => ChunkyPNG::Color.rgb(154, 160, 166),        # plat
    1 => ChunkyPNG::Color.rgb(224, 80, 63),          # montée
    2 => ChunkyPNG::Color.rgb(47, 143, 237),         # descente
  }.freeze

  # Retourne le PNG (binaire) ou nil si la géométrie ne permet pas d'aperçu — le
  # contrôleur retombe alors sur l'icône de l'application.
  def self.render(route)
    new(route).render
  end

  def initialize(route)
    @route = route
  end

  def render
    runs = Route.preview_runs(@route.geometry, width: WIDTH.to_f, height: HEIGHT.to_f, padding: PADDING.to_f)
    return nil unless runs

    canvas = ChunkyPNG::Canvas.new(WIDTH, HEIGHT, BACKGROUND)

    runs.each do |run|
      color = COLORS.fetch(run[:cat], COLORS[0])
      run[:points].each_cons(2) do |a, b|
        draw_thick_line(canvas, a[0], a[1], b[0], b[1], color)
      end
    end

    canvas.to_datastream(color_mode: ChunkyPNG::COLOR_TRUECOLOR).to_blob
  end

  private

  # Trait épais : on empile des lignes anti-aliasées décalées perpendiculairement au
  # segment. chunky_png ne trace que du 1 px, et le pas d'un demi-pixel évite l'effet
  # d'escalier que laissent des décalages entiers sur les segments obliques.
  def draw_thick_line(canvas, x1, y1, x2, y2, color)
    dx = x2 - x1
    dy = y2 - y1
    len = Math.sqrt(dx * dx + dy * dy)
    # Segment dégénéré (deux points projetés au même pixel) : un point suffit.
    if len < 0.5
      canvas.circle(x1.round, y1.round, STROKE / 2, color, color)
      return
    end
    nx = -dy / len
    ny = dx / len

    half = STROKE / 2.0
    (-half).step(half, 0.5) do |i|
      ox = nx * i
      oy = ny * i
      canvas.line_xiaolin_wu((x1 + ox).round, (y1 + oy).round, (x2 + ox).round, (y2 + oy).round, color)
    end
  end
end
