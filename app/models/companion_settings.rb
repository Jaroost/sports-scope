# Les profils de sortie de l'application compagnon (dépôt voisin
# `sports-scope-companion`).
#
# Un profil décrit un tableau de bord : ses pages dans l'ordre, ce que chacune
# contient et comment, les jeux de valeurs du bandeau, les capteurs utilisés et les
# réglages radar / éclairage. Le cycliste en choisit un au départ — on sait sur quel
# vélo on monte au moment où l'on monte dessus.
#
# **Le contrat est partagé avec le dépôt voisin** : les clés de composants
# (`metric`, `zones`, …), de modes (`big`, `bar_only`, …) et de mesures (`speed`,
# `power_np`, …) sont celles de `lib/dashboard/` côté Dart. Y toucher demande de
# modifier les deux dépôts.
#
# Ce qui rend l'exercice tenable : **l'appli ne fait jamais confiance à ce
# document**. Elle ignore toute clé qu'elle ne connaît pas, retombe sur son tableau
# de bord intégré si rien n'est exploitable, et garantit elle-même ce que le format
# ne peut pas dire (au plus une carte, quatre cases de bandeau, pas de cellules qui
# se recouvrent). On peut donc servir un profil un peu en avance sur la version
# installée sans casser la sortie de personne.
module CompanionSettings
  module_function

  # La version du document. Sert à l'appli pour décider quoi faire d'un format
  # futur ; elle n'a encore jamais changé.
  VERSION = 1

  # ── Le catalogue ────────────────────────────────────────────────────────────
  #
  # Ce que l'éditeur a le droit de proposer, et ce que `sanitize` a le droit de
  # garder. **Une seule liste pour les deux** : un composant que l'éditeur
  # proposerait sans que l'assainisseur le connaisse disparaîtrait à
  # l'enregistrement, sous les yeux de l'utilisateur et sans un mot.
  #
  # Les libellés n'y sont pas : ils vivent dans `config/locales`, sous
  # `companion.settings.*`. Ce fichier ne décrit que le contrat.

  # Le premier mode de chaque liste est **le mode par défaut** — celui sur lequel
  # l'appli retombe quand elle n'en reconnaît pas un. Même ordre des deux côtés.
  BLOCKS = {
    "metric" => %w[big compact gauge zone],
    "zones" => %w[bar bar_only legend],
    "averages" => %w[cards list],
    "recording" => %w[full compact],
    "nav_state" => %w[full compact],
    "radar" => %w[distance gauge],
    "empty" => []
  }.freeze

  ZONE_SOURCES = %w[hr power].freeze

  PAGE_KINDS = %w[map grid list].freeze

  # Les mesures affichables. Exactement les clés de `MetricId` côté Dart, dans le
  # même ordre : c'est la liste que l'éditeur déroule.
  METRICS = %w[
    duration moving_time distance speed speed_avg speed_max
    heart_rate hr_zone hr_avg hr_max
    power power_zone power_avg power_np power_max
    cadence cadence_avg
    ascent altitude calories gears
    route_remaining route_remaining_gain
  ].freeze

  SENSORS = %w[gps barometer light compass radar power heart_rate cadence gears].freeze

  # Quatre cases au bandeau : au-delà, les chiffres deviennent trop petits pour
  # être lus d'un coup d'œil en roulant, ce qui est son seul usage.
  MAX_BAND_METRICS = 4

  # Six lignes ou colonnes au plus : au-delà, les cases ne portent plus un chiffre
  # lisible. Même borne que `GridPageSpec.maxSide` côté Dart.
  MAX_GRID_SIDE = 6

  # Ce que l'éditeur reçoit en props. Sérialisé tel quel dans la page.
  def catalog
    {
      "page_kinds" => PAGE_KINDS,
      "blocks" => BLOCKS,
      "zone_sources" => ZONE_SOURCES,
      "metrics" => METRICS,
      "sensors" => SENSORS,
      "max_band_metrics" => MAX_BAND_METRICS,
      "max_grid_side" => MAX_GRID_SIDE
    }
  end

  # Ce qu'on sert tant que l'utilisateur n'a rien réglé.
  #
  # Trois profils et pas un seul : c'est l'écart entre les pratiques qui justifie
  # tout ce chantier, et un unique profil par défaut ne le montrerait pas. Le
  # sélecteur de départ ne s'affiche d'ailleurs qu'à partir de deux.
  def defaults
    { "v" => VERSION, "presets" => [ road, mtb, trainer ] }
  end

  # Le document d'un utilisateur, ou les profils par défaut.
  #
  # Un document vide n'est pas un choix : c'est l'état initial de tous les comptes.
  # Servir `{}` obligerait l'appli à distinguer « ce compte n'a pas de profils » de
  # « le site n'a rien su dire », alors que la réponse utile est la même dans les
  # deux cas.
  def for(user)
    stored = user.companion_settings
    return defaults if stored.blank? || stored["presets"].blank?

    stored
  end

  # ── L'assainisseur ──────────────────────────────────────────────────────────
  #
  # Ramène un document composé dans l'éditeur à ce que l'application acceptera.
  #
  # **La règle qui gouverne tout ce qui suit : le serveur peut être plus indulgent
  # que l'application, jamais moins.** Ce qui sort d'ici doit être accepté
  # *entièrement* par le décodeur Dart — sans qu'il ait à retirer quoi que ce soit.
  #
  # C'est ce qui rend l'éditeur honnête. L'appli garantit de son côté qu'un
  # document abîmé ne casse pas une sortie (au plus une carte, quatre cases de
  # bandeau, pas de cellules qui se recouvrent), mais elle le fait *en silence*,
  # sur la route. Si l'éditeur laissait composer une cinquième case ou deux cartes,
  # l'utilisateur verrait sur son écran quelque chose que son téléphone jetterait
  # sans un mot. On applique donc les mêmes règles ici, où elles peuvent encore se
  # voir — et le contrôleur renvoie le document assaini, que l'éditeur réaffiche.
  #
  # D'où deux écarts assumés avec le Dart, tous deux dans le sens indulgent :
  # une clé manquante est **fabriquée** plutôt que de faire perdre le profil, et
  # une clé en double est **suffixée** plutôt que de faire disparaître le profil
  # qu'on vient de dupliquer. Dans les deux cas le résultat est un document que
  # l'appli prend en entier.
  def sanitize(document)
    presets = document.is_a?(Hash) ? document["presets"] : nil
    presets = [] unless presets.is_a?(Array)

    seen = []
    cleaned = presets.filter_map.with_index { |raw, i| sanitize_preset(raw, i, seen) }

    return defaults if cleaned.empty?

    { "v" => VERSION, "presets" => cleaned }
  end

  def sanitize_preset(raw, index, seen)
    return nil unless raw.is_a?(Hash)

    name = raw["name"].to_s.strip
    key = unique_key(raw["key"], name, index, seen)
    pages = sanitize_pages(raw["pages"])
    bands = sanitize_bands(raw["bands"])

    {
      "key" => key,
      "name" => name.presence || key,
      # Un profil vidé de toutes ses pages retombe sur la page Effort : on ne
      # laisse jamais partir un tableau de bord sans contenu, l'appli monterait
      # une coquille vide qu'on ne diagnostique pas au guidon.
      "pages" => pages.presence || [ builtin_effort_page ],
      "bands" => bands.presence || builtin_bands,
      "sensors" => sanitize_sensors(raw["sensors"]),
      "radar" => sanitize_radar(raw["radar"]),
      "lighting" => sanitize_lighting(raw["lighting"]),
      "screen" => sanitize_screen(raw["screen"])
    }.compact
  end

  # Une clé utilisable et unique. Fabriquée au besoin — voir l'entête de
  # `sanitize` : perdre un profil parce qu'on l'a dupliqué serait le pire service
  # à rendre à un éditeur.
  def unique_key(raw, name, index, seen)
    # Le nom sert de repli avant le rang : une clé lisible aide au diagnostic (les
    # journaux de l'appli la citent), et « home-trainer » se reconnaît là où
    # « preset-3 » demande d'aller compter.
    base = raw.to_s.strip.parameterize.presence ||
           name.parameterize.presence ||
           "preset-#{index + 1}"
    key = base
    suffix = 2
    while seen.include?(key)
      key = "#{base}-#{suffix}"
      suffix += 1
    end
    seen << key
    key
  end

  # Au plus une carte, où qu'elle soit : deux cartes voudraient dire deux
  # identités pour un seul WebView, alors que l'instance MapLibre est unique.
  def sanitize_pages(raw)
    return [] unless raw.is_a?(Array)

    map_seen = false
    raw.filter_map do |page|
      next nil unless page.is_a?(Hash)

      case page["kind"]
      when "map"
        next nil if map_seen

        map_seen = true
        { "kind" => "map" }
      when "grid" then sanitize_grid(page)
      when "list" then sanitize_list(page)
      end
    end
  end

  def sanitize_grid(page)
    rows = clamp_side(page["rows"])
    cols = clamp_side(page["cols"])
    cells = place_cells(page["cells"], rows, cols)

    # Une grille sans une seule cellule plaçable n'est pas une page vide, c'est une
    # page qui n'a rien à dire : la retirer vaut mieux que de faire défiler le
    # cycliste jusqu'à un rectangle noir.
    return nil if cells.empty?

    { "kind" => "grid", "title" => page["title"].to_s.presence || "Mesures",
      "rows" => rows, "cols" => cols, "cells" => cells }
  end

  # Les cellules qui tiennent dans la grille et ne se recouvrent pas.
  #
  # Les étendues sont **rognées** (réduire une grille ne doit pas faire disparaître
  # ce qu'on y avait posé), une origine hors grille est **rejetée** (on ne devine
  # pas où l'utilisateur voulait la mettre), et sur un recouvrement **la première
  # posée gagne** — l'ordre du document, donc celui que l'éditeur affiche.
  def place_cells(raw, rows, cols)
    return [] unless raw.is_a?(Array)

    taken = []
    raw.filter_map do |cell|
      next nil unless cell.is_a?(Hash)

      block = sanitize_block(cell["block"])
      next nil if block.nil?

      row = cell["row"].to_i
      col = cell["col"].to_i
      next nil if row.negative? || col.negative? || row >= rows || col >= cols

      row_span = (cell["row_span"] || 1).to_i.clamp(1, rows - row)
      col_span = (cell["col_span"] || 1).to_i.clamp(1, cols - col)
      rect = [ row, col, row + row_span - 1, col + col_span - 1 ]
      next nil if taken.any? { |other| overlap?(rect, other) }

      taken << rect
      { "row" => row, "col" => col, "row_span" => row_span, "col_span" => col_span,
        "block" => block }
    end
  end

  # Deux rectangles se croisent dès qu'ils se chevauchent sur les deux axes à la
  # fois : une comparaison ligne à ligne laisserait passer les diagonales.
  def overlap?(a, b)
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
  end

  def sanitize_list(page)
    blocks = raw_array(page["blocks"]).filter_map { |block| sanitize_block(block) }
    return nil if blocks.empty?

    { "kind" => "list", "title" => page["title"].to_s.presence || "Sortie",
      "blocks" => blocks }
  end

  # Un mode inconnu retombe sur le mode par défaut du composant (le premier de sa
  # liste), jamais sur un refus : c'est déjà ce que fait l'appli, et l'éditeur ne
  # doit pas être plus sévère qu'elle.
  def sanitize_block(raw)
    return nil unless raw.is_a?(Hash)

    kind = raw["kind"]
    modes = BLOCKS[kind]
    return nil if modes.nil?

    block = { "kind" => kind }
    block["mode"] = modes.include?(raw["mode"]) ? raw["mode"] : modes.first if modes.any?

    case kind
    when "metric"
      return nil unless METRICS.include?(raw["metric"])

      block["metric"] = raw["metric"]
    when "zones"
      block["source"] = ZONE_SOURCES.include?(raw["source"]) ? raw["source"] : "hr"
    end

    block
  end

  def sanitize_bands(raw)
    raw_array(raw).filter_map do |band|
      metrics = raw_array(band.is_a?(Hash) ? band["metrics"] : band)
                .select { |metric| METRICS.include?(metric) }
                .first(MAX_BAND_METRICS)
      metrics.empty? ? nil : { "metrics" => metrics }
    end
  end

  # Absent vaut **activé** : un profil écrit à la main, ou venu d'une version
  # antérieure du contrat, ne doit jamais éteindre un capteur en silence. On
  # n'écrit donc que ce qui est explicitement coupé.
  def sanitize_sensors(raw)
    return nil unless raw.is_a?(Hash)

    off = SENSORS.select { |sensor| raw[sensor] == false }
    return nil if off.empty?

    off.index_with(false)
  end

  def sanitize_radar(raw)
    return nil unless raw.is_a?(Hash)

    {
      "close_m" => positive(raw["close_m"], 40),
      "range_m" => positive(raw["range_m"], 140),
      "sounds" => raw["sounds"] != false,
      "wake_screen" => raw["wake_screen"] != false,
      "wake_hold_s" => positive(raw["wake_hold_s"], 5)
    }
  end

  def sanitize_lighting(raw)
    return nil unless raw.is_a?(Hash)

    {
      "night_lux" => positive(raw["night_lux"], 30),
      "day_lux" => positive(raw["day_lux"], 5000),
      "dwell_s" => positive(raw["dwell_s"], 90),
      "alert_distance_m" => positive(raw["alert_distance_m"], 150),
      "flash_at_night" => raw["flash_at_night"] == true,
      "off_in_daylight" => raw["off_in_daylight"] == true,
      "front_day_running" => raw["front_day_running"] != false
    }
  end

  # Jamais sous 1 % : à zéro, certains appareils coupent franchement le
  # rétroéclairage et le bandeau devient illisible même de nuit. L'appli borne de
  # son côté ; borner ici évite d'écrire un document qu'elle corrigera.
  def sanitize_screen(raw)
    return nil unless raw.is_a?(Hash)
    return nil unless raw["dim_level"].is_a?(Numeric)

    { "dim_level" => raw["dim_level"].to_f.clamp(0.01, 1.0) }
  end

  def clamp_side(value)
    value.to_i.clamp(1, MAX_GRID_SIDE)
  end

  def positive(value, fallback)
    return fallback unless value.is_a?(Numeric) && value.positive?

    value
  end

  def raw_array(value)
    value.is_a?(Array) ? value : []
  end

  # La page Effort du tableau de bord intégré, mot pour mot celle du Dart
  # (`RidePreset.builtIn`). Sert de filet quand un profil perd toutes ses pages.
  def builtin_effort_page
    {
      "kind" => "list", "title" => "Effort",
      "blocks" => [
        { "kind" => "recording", "mode" => "full" },
        { "kind" => "zones", "source" => "hr", "mode" => "bar" },
        { "kind" => "zones", "source" => "power", "mode" => "bar" },
        { "kind" => "averages", "mode" => "cards" },
        { "kind" => "nav_state", "mode" => "full" }
      ]
    }
  end

  def builtin_bands
    [
      band(%w[duration distance speed power]),
      band(%w[heart_rate hr_zone power power_zone])
    ]
  end

  # Route : la carte d'abord, l'effort ensuite, les chiffres en grille.
  def road
    {
      "key" => "road",
      "name" => "Route",
      "pages" => [
        { "kind" => "map" },
        {
          "kind" => "list", "title" => "Effort",
          "blocks" => [
            { "kind" => "recording", "mode" => "full" },
            { "kind" => "zones", "source" => "hr", "mode" => "bar" },
            { "kind" => "zones", "source" => "power", "mode" => "bar" },
            { "kind" => "averages", "mode" => "cards" }
          ]
        },
        {
          "kind" => "grid", "title" => "Chiffres", "rows" => 3, "cols" => 3,
          "cells" => [
            { "row" => 0, "col" => 0, "block" => metric("speed", "big") },
            { "row" => 0, "col" => 1, "block" => metric("distance", "compact") },
            { "row" => 0, "col" => 2, "block" => metric("ascent", "compact") },
            # La ligne du milieu fusionnée : la barre des zones garde toute son
            # information sans sa légende, qui ne tiendrait pas dans une cellule.
            { "row" => 1, "col" => 0, "col_span" => 3,
              "block" => { "kind" => "zones", "source" => "power", "mode" => "bar_only" } },
            { "row" => 2, "col" => 0, "block" => metric("power", "zone") },
            { "row" => 2, "col" => 1, "col_span" => 2, "block" => metric("heart_rate", "gauge") }
          ]
        }
      ],
      "bands" => [
        band(%w[duration distance speed power]),
        band(%w[heart_rate hr_zone power power_zone])
      ]
    }
  end

  # VTT : mêmes capteurs, mais un seuil de proximité radar plus court — on n'y roule
  # pas à la même vitesse, et une alerte à 140 m sur un single-track ne veut rien
  # dire. Pas de page de listes : on n'y consulte pas ses moyennes.
  def mtb
    {
      "key" => "mtb",
      "name" => "VTT",
      "pages" => [
        { "kind" => "map" },
        {
          "kind" => "grid", "title" => "Effort", "rows" => 2, "cols" => 2,
          "cells" => [
            { "row" => 0, "col" => 0, "block" => metric("heart_rate", "zone") },
            { "row" => 0, "col" => 1, "block" => metric("ascent", "big") },
            { "row" => 1, "col" => 0, "col_span" => 2,
              "block" => { "kind" => "recording", "mode" => "full" } }
          ]
        }
      ],
      "bands" => [
        band(%w[duration distance speed heart_rate]),
        band(%w[heart_rate hr_zone ascent cadence])
      ],
      "radar" => { "close_m" => 25, "range_m" => 80 }
    }
  end

  # Home-trainer : **pas de page carte du tout**.
  #
  # Ce n'est pas une carte qu'on masque, c'est un WebView qu'on ne charge pas : ni
  # pont, ni tuiles, ni service worker. Et pas de GPS non plus — donc pas de service
  # au premier plan ni de notification, pour une trace qui ne dirait rien. Le
  # baromètre et le radar suivent, pour les mêmes raisons.
  def trainer
    {
      "key" => "trainer",
      "name" => "Home-trainer",
      "pages" => [
        {
          "kind" => "grid", "title" => "Séance", "rows" => 2, "cols" => 2,
          "cells" => [
            { "row" => 0, "col" => 0, "col_span" => 2, "block" => metric("power", "zone") },
            { "row" => 1, "col" => 0, "block" => metric("cadence", "big") },
            { "row" => 1, "col" => 1, "block" => metric("heart_rate", "gauge") }
          ]
        },
        {
          "kind" => "list", "title" => "Séance",
          "blocks" => [
            { "kind" => "recording", "mode" => "full" },
            { "kind" => "zones", "source" => "power", "mode" => "bar" },
            { "kind" => "averages", "mode" => "cards" }
          ]
        }
      ],
      "bands" => [
        band(%w[duration power cadence heart_rate]),
        band(%w[power_avg power_np calories duration])
      ],
      "sensors" => {
        "gps" => false, "barometer" => false, "light" => false,
        "compass" => false, "radar" => false
      }
    }
  end

  def metric(key, mode)
    { "kind" => "metric", "metric" => key, "mode" => mode }
  end

  # Quatre mesures au plus : au-delà, les chiffres du bandeau deviennent trop petits
  # pour être lus d'un coup d'œil en roulant, ce qui est son seul usage. L'appli
  # tronque de son côté ; couper ici évite d'écrire un document qu'elle corrigera.
  def band(metrics)
    { "metrics" => metrics.first(4) }
  end
end
