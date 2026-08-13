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
  #
  # `"metric"` n'a plus de modes : sa mise en page se compose librement dans une
  # grille (`layout`, voir `sanitize_metric_layout`) plutôt que de choisir parmi
  # quelques formes figées. Une liste vide donne une seule vignette dans l'éditeur
  # (`blockChoices`), comme `"lap_selector"` déjà plus bas.
  BLOCKS = {
    "metric" => [],
    "zones" => %w[bar bar_only legend],
    # Les mêmes répartitions/moyennes, mais du tour choisi sur une page `laps`
    # plutôt que de la sortie entière — mêmes modes, aucune table de plus à
    # tenir à jour. `lap_summary` est nouveau (durée, distance, D+, calories,
    # TSS *du tour*), `mark_lap` marque un tour d'une série (`series`, sur
    # n'importe quelle page, pas seulement une page `laps`).
    "lap_zones" => %w[bar bar_only legend],
    "lap_averages" => %w[cards list],
    "lap_summary" => %w[cards list],
    # La liste déroulante qui choisit le tour que les trois composants
    # au-dessus lisent. Plaçable comme eux plutôt qu'imposée en en-tête d'une
    # page `laps` : une page qui la porte tient tout entière dans ce qu'elle
    # déclare (`rows`/`cols`, ou sa liste), rien n'est caché à l'éditeur. Un
    # seul mode — rien à faire varier, contrairement à `mark_lap` qui a une
    # icône seule à proposer en cellule étroite.
    "lap_selector" => [],
    "averages" => %w[cards list],
    "recording" => %w[full compact],
    "mark_lap" => %w[full compact],
    # Deux commandes sur l'itinéraire suivi, posables sur une page plutôt que
    # rangées dans le menu ⋮ : le même geste que « Choisir un autre itinéraire »
    # et « Retirer l'itinéraire », à portée de pouce. Rien à sanitizer au-delà du
    # mode : ce sont des boutons, pas des mesures.
    "change_route" => %w[full compact],
    "clear_route" => %w[full compact],
    # Les deux boutons ci-dessus, combinés en un seul : c'est l'état de la
    # navigation qui décide côté appli lequel des deux gestes il pose — retirer
    # s'il y a déjà un tracé suivi, en choisir un sinon. Gardé à côté des deux
    # commandes séparées plutôt qu'à leur place : un profil déjà composé avec
    # `change_route`/`clear_route` ne doit rien perdre à l'enregistrement.
    "route" => %w[full compact],
    # Met la carte en veille depuis une page de données — voile noir et
    # rétroéclairage à 1 %, exactement comme un appui long sur la carte.
    # L'appli ramène le cycliste sur la carte puis demande la veille au
    # bridge (`sleepEnter`, companionBridge.ts) : même chemin que l'appui
    # long, `toggleScreenOffManual`. Rien à sanitizer au-delà du mode, même
    # raison que `recording`/`change_route` : un bouton, pas une mesure.
    "sleep" => %w[full compact],
    "nav_state" => %w[full compact],
    # La jauge est couchée, à l'échelle d'une cellule large : le sens debout a
    # été retiré côté appli (un seul dessin à garder cohérent avec les bords de
    # la carte).
    "radar" => %w[distance count icons compact gauge],
    # Le budget de charge : ce qu'il reste à faire aujourd'hui, jusqu'où on peut aller
    # sans se cramer, la fatigue et le risque de blessure. `day` répond à « je continue
    # ou je rentre ? », `week` situe la sortie dans la semaine.
    #
    # Seul composant dont la donnée ne vient PAS des capteurs : elle est calculée par la
    # page de navigation et poussée par le pont (cf. companionBridge.ts), puis gardée sur
    # le téléphone. D'où son état vide, qu'aucun autre composant n'a — un profil de
    # home-trainer sans WebView n'en recevra jamais, et il doit le dire.
    "training_budget" => %w[day week],
    # La liste des cols du tracé (D+, longueur, pente moyenne), avec un repère
    # « en cours / prochain » que l'appli calcule elle-même à partir de la
    # distance déjà parcourue (cf. companionBridge.ts::companionRouteClimbs).
    # Comme `training_budget`, ça vient de la page de navigation : un profil
    # de home-trainer sans WebView n'en recevra jamais.
    "climb_list" => %w[full compact],
    # L'heure courante. Seul composant, avec `training_budget`/`climb_list`, à
    # ne rien vérifier au-delà du mode générique — pas de mesure ni de source
    # à valider, comme `radar`/`recording`.
    "clock" => %w[hm hms],
    "empty" => []
  }.freeze

  ZONE_SOURCES = %w[hr power].freeze

  PAGE_KINDS = %w[map grid list laps].freeze

  # Les mesures affichables. Exactement les clés de `MetricId` côté Dart, dans le
  # même ordre : c'est la liste que l'éditeur déroule.
  METRICS = %w[
    duration moving_time pause_time distance speed speed_avg speed_max
    heart_rate hr_zone hr_avg hr_max
    power power_zone power_avg power_np power_max
    cadence cadence_avg cadence_max
    ascent altitude grade grade_avg grade_max
    climb_rate climb_rate_avg climb_rate_max
    calories calories_per_hour tss gears
    chainring_position sprocket_position gear_ratio
    route_remaining route_remaining_gain route_eta
  ].freeze

  # Les commandes qu'une case du bandeau ou de la bande de l'encoche peut
  # porter à la place d'une mesure. Une seule aujourd'hui — un bouton, pas une
  # mesure, même raison que `BLOCKS["sleep"]` sur une page. Liste à part de
  # `METRICS` et non fondue dedans : une case de bandeau reste d'abord un
  # chiffre à lire, l'éditeur doit pouvoir présenter les deux catalogues
  # séparément plutôt que mélangés dans un seul menu déroulant.
  BAND_ACTIONS = %w[sleep].freeze

  # Le radar arrière, en case de bandeau ou d'encoche — un sous-ensemble des
  # modes de `BLOCKS["radar"]` : seuls ceux qui restent lisibles dans une case
  # aussi petite (au plus un quart du bandeau, une moitié de l'encoche).
  # Préfixées `radar_` pour rester des clés à part de `METRICS` et
  # `BAND_ACTIONS` dans le même menu déroulant — voir `BandRadarSlot` côté
  # Dart (`ride_preset.dart`).
  BAND_RADAR_MODES = %w[distance count gauge].freeze
  BAND_RADAR = BAND_RADAR_MODES.map { |mode| "radar_#{mode}" }.freeze

  # Les mesures de durée, seules concernées par le réglage `format` d'un bloc
  # `metric` (HH:MM ou HH:MM:SS) — voir `sanitize_block`.
  DURATION_METRICS = %w[duration moving_time pause_time route_eta].freeze

  # `hm` en tête : c'est le comportement de l'appli avant ce réglage, donc le
  # repli d'un document déjà existant ou malformé.
  DURATION_FORMATS = %w[hm hms].freeze

  # Les mesures éligibles au réglage `min`/`max` d'un bloc `metric` en mode
  # `gauge` (voir `sanitize_block`) — même liste que
  # `RANGE_GAUGE_METRICS` côté site (`companionSettings.ts`) et que le
  # `switch` de `MetricView._gauge` côté appli.
  #
  # Exclues : `heart_rate`/`hr_zone`/`power`/`power_zone`, qui ont déjà une
  # vraie plage (les zones du cycliste) et gardent la jauge existante ; les
  # mesures de durée (`DURATION_METRICS`), qui ont déjà un autre réglage et
  # dont la plage n'a pas le même sens qu'un min/max de chiffre ; `gears`,
  # dont la valeur (« 50 × 15 ») n'est pas un nombre unique.
  RANGE_GAUGE_METRICS = %w[
    distance speed speed_avg speed_max
    hr_avg hr_max power_avg power_np power_max
    cadence cadence_avg cadence_max
    ascent altitude grade grade_avg grade_max
    climb_rate climb_rate_avg climb_rate_max
    calories calories_per_hour tss
    chainring_position sprocket_position gear_ratio
    route_remaining route_remaining_gain
  ].freeze

  # Les mesures éligibles au mode `dynamic_gauge` d'un bloc `metric` — même
  # liste que `DYNAMIC_GAUGE_METRICS` côté site (`companionSettings.ts`) et
  # que le `switch` de `MetricId.liveRangeOf` côté appli.
  #
  # Contrairement à `RANGE_GAUGE_METRICS`, ce mode ne pose pas de `min`/`max`
  # sur le document : la plage n'est pas réglée dans l'éditeur, elle se lit
  # dans la sortie en cours (le min/max observé pour cadence/cardio/
  # puissance/vitesse/pente, la progression vers l'itinéraire chargé pour
  # distance/durée) — voir `MetricId.liveRangeOf` côté appli.
  DYNAMIC_GAUGE_METRICS = %w[cadence heart_rate power speed grade distance duration].freeze

  # Les mesures qui portent une zone d'entraînement (cardio, puissance) — la
  # jauge d'un bloc `metric` posé sur l'une d'elles est toujours celle des zones
  # du cycliste, jamais `RANGE_GAUGE_METRICS`/`DYNAMIC_GAUGE_METRICS` (mêmes
  # exclusions que ces deux listes). Même liste que `MetricId.hasZone` côté
  # appli, nommée ici pour la première fois — avant ce chantier, elle ne
  # s'exprimait qu'en creux (la seule branche qui n'utilisait ni min/max ni
  # plage dynamique).
  ZONE_METRICS = %w[heart_rate hr_zone power power_zone].freeze

  # Les deux natures de jauge pour une mesure sans zones — voir
  # `sanitize_metric_layout`. `range` en tête : c'est le repli d'une mesure
  # éligible aux deux (cadence, vitesse, pente, distance) sans préférence
  # explicite.
  GAUGE_KINDS = %w[range dynamic].freeze

  # ── Disposition d'un bloc `metric` ──────────────────────────────────────────
  #
  # Remplace les cinq anciens `mode` (`big`, `compact`, `zone`, `gauge`,
  # `dynamic_gauge`) par une grille librement composable : chaque élément
  # (`icon`/`label`/`unit`/`value`) se pose dans une case `"<rangée>-<colonne>"`,
  # `gauge` — une barre pleine largeur, pas un texte — sur une rangée entière
  # (`"<rangée>"`, sans colonne). Une rangée sans occupant ne prend aucune place ;
  # `value` est la seule clé obligatoire.
  LAYOUT_COLUMNS = %w[left center right].freeze

  # Au-delà, une case ne serait plus lisible d'un coup d'œil en roulant — même
  # esprit que `MAX_GRID_SIDE` pour la grille de pages.
  MAX_LAYOUT_ROWS = 4

  LAYOUT_ROW_PATTERN = /\A[0-#{MAX_LAYOUT_ROWS - 1}]\z/

  # Le poids d'une rangée dans le partage de la hauteur réelle de la case —
  # voir `sanitize_row_heights`. `"normal"` n'y figure pas : c'est la valeur
  # par défaut d'une rangée absente de `row_heights`, elle n'a donc jamais
  # besoin d'être écrite.
  ROW_HEIGHTS = %w[small large].freeze

  # Combien de dispositions un compte peut enregistrer — voir
  # `sanitize_metric_layouts`. Au-delà, une bibliothèque n'aide plus personne à
  # choisir vite.
  MAX_METRIC_LAYOUTS = 20

  # La disposition qu'un ancien `mode` de bloc `metric` dessinait — utilisée à la
  # fois pour migrer un document enregistré avant ce chantier (`sanitize_block`)
  # et pour l'appli, qui fait le même travail en lecture seule
  # (`MetricBlock.parse`, dépôt voisin) sur un document jamais repassé par
  # l'éditeur depuis. Toutes les positions en colonne `center` : c'était déjà
  # centré partout avant ce réglage.
  LEGACY_LAYOUTS = {
    "big" => { "value" => "0-center", "unit" => "1-center" },
    "compact" => { "icon" => "0-center", "value" => "1-center", "unit" => "2-center" },
    "zone" => { "icon" => "0-center", "label" => "0-center", "value" => "1-center" },
    "gauge" => { "value" => "0-center", "gauge" => "1", "unit" => "2-center" },
    "dynamic_gauge" => { "value" => "0-center", "gauge" => "1", "unit" => "2-center" }
  }.freeze

  # Le repli d'`avant `big`` : chiffre plein cadre, unité en dessous — c'est
  # aussi ce que dessinait le mode par défaut d'un ancien bloc `metric`.
  DEFAULT_METRIC_LAYOUT = { "value" => "0-center", "unit" => "1-center" }.freeze

  # La liste blanche d'icônes personnalisables — voir `sanitize_block`. Mêmes
  # classes FontAwesome que celles déjà utilisées comme icône par défaut d'une
  # mesure (`METRIC_SAMPLES` côté site), plus une quinzaine de génériques.
  # `fa-solid fa-question` n'y est pas : réservée au repli « mesure inconnue »
  # de l'aperçu, elle ne doit jamais devenir un choix.
  ICONS = %w[
    fa-regular\ fa-clock fa-solid\ fa-person-biking fa-regular\ fa-circle-pause
    fa-solid\ fa-ruler-horizontal fa-solid\ fa-gauge-high fa-solid\ fa-heart
    fa-regular\ fa-heart fa-solid\ fa-bolt fa-solid\ fa-rotate
    fa-solid\ fa-arrow-trend-up fa-solid\ fa-mountain fa-solid\ fa-arrow-up-right-dots
    fa-solid\ fa-fire fa-solid\ fa-chart-column fa-solid\ fa-gear
    fa-solid\ fa-circle-notch fa-solid\ fa-record-vinyl fa-solid\ fa-arrows-left-right
    fa-regular\ fa-flag fa-solid\ fa-weight-hanging fa-solid\ fa-star
    fa-solid\ fa-bell fa-solid\ fa-compass fa-solid\ fa-wind fa-solid\ fa-snowflake
    fa-solid\ fa-sun fa-solid\ fa-moon fa-solid\ fa-droplet fa-solid\ fa-battery-full
    fa-solid\ fa-trophy fa-solid\ fa-route fa-solid\ fa-bicycle fa-solid\ fa-map
  ].freeze

  SENSORS = %w[gps barometer light compass radar power heart_rate cadence gears].freeze

  # Les types d'itinéraire auxquels un profil peut être lié — mêmes valeurs que
  # `Route::ACTIVITIES`, réutilisées et non redupliquées : un itinéraire vélo doit
  # rester un itinéraire vélo des deux côtés.
  ACTIVITIES = Route::ACTIVITIES

  # Quatre cases au bandeau : au-delà, les chiffres deviennent trop petits pour
  # être lus d'un coup d'œil en roulant, ce qui est son seul usage.
  MAX_BAND_METRICS = 4

  # Douze lignes ou colonnes au plus : au-delà, les cases ne portent plus un chiffre
  # lisible. Même borne que `GridPageSpec.maxSide` côté Dart.
  MAX_GRID_SIDE = 12

  # La description tient dans le sous-titre d'un `ListTile`, au moment où l'on
  # choisit son profil avant de partir — pas dans un paragraphe.
  MAX_DESCRIPTION_LENGTH = 140

  # Le libellé personnalisé d'un bloc `metric` tient dans une case de grille,
  # déjà tronquée à l'écran par l'appli (`cbp-metric-label`/`Text.ellipsis`
  # côté Dart) : une borne courte évite juste d'enregistrer un texte que
  # personne ne lira jamais en entier, pas de faire perdre le réglage.
  MAX_METRIC_LABEL_LENGTH = 24

  # Ce que l'éditeur reçoit en props. Sérialisé tel quel dans la page.
  def catalog
    {
      "page_kinds" => PAGE_KINDS,
      "blocks" => BLOCKS,
      "zone_sources" => ZONE_SOURCES,
      "metrics" => METRICS,
      "band_actions" => BAND_ACTIONS,
      "band_radar" => BAND_RADAR,
      "sensors" => SENSORS,
      "activities" => ACTIVITIES,
      "max_band_metrics" => MAX_BAND_METRICS,
      "max_grid_side" => MAX_GRID_SIDE,
      "icons" => ICONS
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
    # Un type d'itinéraire n'a qu'un seul profil par défaut : la première
    # revendication rencontrée (l'ordre du document, celui que l'éditeur affiche)
    # gagne — même arbitrage que `unique_key` pour les clés en double.
    default_seen = []
    cleaned = presets.filter_map.with_index { |raw, i| sanitize_preset(raw, i, seen, default_seen) }

    return defaults if cleaned.empty?

    metric_layouts = sanitize_metric_layouts(document.is_a?(Hash) ? document["metric_layouts"] : nil)

    { "v" => VERSION, "presets" => cleaned, "metric_layouts" => metric_layouts.presence }.compact
  end

  def sanitize_preset(raw, index, seen, default_seen)
    return nil unless raw.is_a?(Hash)

    name = raw["name"].to_s.strip
    key = unique_key(raw["key"], name, index, seen)
    pages = sanitize_pages(raw["pages"])
    bands = sanitize_bands(raw["bands"])
    activities = sanitize_activities(raw["activities"])

    {
      "key" => key,
      "name" => name.presence || key,
      # Libre et facultative : ce que l'utilisateur écrit pour se souvenir, au
      # départ, pourquoi ce profil-là plutôt qu'un autre — l'appli l'affiche dans
      # son sélecteur. Tronquée plutôt que rejetée, pour la même raison qu'un mode
      # inconnu retombe sur le défaut : composer une longue description ne doit
      # pas faire perdre le profil, juste sa fin.
      "description" => raw["description"].to_s.strip[0, MAX_DESCRIPTION_LENGTH].presence,
      # Les types d'itinéraire pour lesquels ce profil est proposé. Absent vaut
      # « aucun type particulier » : un profil qui n'a jamais touché à ce réglage
      # continue de se proposer partout, comme avant que la fonctionnalité existe.
      "activities" => activities.presence,
      "default_for" => sanitize_default_for(raw["default_for"], activities, default_seen).presence,
      # Un profil vidé de toutes ses pages retombe sur la page Effort : on ne
      # laisse jamais partir un tableau de bord sans contenu, l'appli monterait
      # une coquille vide qu'on ne diagnostique pas au guidon.
      "pages" => pages.presence || [ builtin_effort_page ],
      "bands" => bands.presence || builtin_bands,
      "notch" => sanitize_notch_sets(raw["notch"]),
      "sensors" => sanitize_sensors(raw["sensors"]),
      "radar" => sanitize_radar(raw["radar"]),
      "lighting" => sanitize_lighting(raw["lighting"]),
      "screen" => sanitize_screen(raw["screen"])
    }.compact
  end

  # Les types d'itinéraire liés à un profil — seulement ceux du catalogue,
  # dédupliqués.
  def sanitize_activities(raw)
    raw_array(raw).select { |activity| ACTIVITIES.include?(activity) }.uniq
  end

  # Le sous-ensemble des types liés pour lesquels ce profil est le défaut. Un
  # type déjà revendiqué par un profil précédent (`default_seen`) est écarté ici
  # plutôt que de faire perdre la revendication au premier profil qui l'a posée —
  # la même règle que `unique_key` : composer en double ne doit jamais faire
  # disparaître ce qui existait déjà.
  def sanitize_default_for(raw, activities, default_seen)
    claimed = raw_array(raw).uniq.select { |activity| activities.include?(activity) && !default_seen.include?(activity) }
    default_seen.concat(claimed)
    claimed
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
  #
  # Et **de quoi joindre ce qui est rangé derrière le menu** : voir
  # `keep_one_swipeable`.
  def sanitize_pages(raw)
    return [] unless raw.is_a?(Array)

    map_seen = false
    pages = raw.filter_map do |page|
      next nil unless page.is_a?(Hash)

      case page["kind"]
      when "map"
        next nil if map_seen

        map_seen = true
        # Sans `menu`, et pas par oubli : la carte est le WebView peint au fond
        # de la pile pour toute la sortie, pas une page qu'on ouvre et qu'on
        # referme. La ranger derrière le menu ne voudrait rien dire.
        { "kind" => "map" }
      when "grid" then sanitize_grid(page)
      when "list" then sanitize_list(page)
      when "laps" then sanitize_laps(page)
      end
    end

    keep_one_swipeable(pages)
  end

  # Une page rangée derrière le menu d'actions plutôt que dans le défilement.
  #
  # C'est ce qui permet une page qu'on ne lit **pas** en roulant — un bilan, des
  # répartitions — sans la mettre à un glissé de la carte, où elle passerait sous
  # les yeux à chaque changement de page. On va la chercher, comme on va chercher
  # « changer d'itinéraire ».
  #
  # **Absent vaut « dans le défilement »**, dans les deux sens : un document plus
  # ancien que l'appli garde toutes ses pages là où elles étaient, et une appli
  # plus ancienne que le site ignore la clé et les montre toutes. L'erreur va donc
  # toujours vers « visible », jamais vers « introuvable ».
  def menu_flag(page)
    true if page["menu"] == true
  end

  # Une page rangée derrière le menu doit rester joignable.
  #
  # Il y faut une page du défilement **qui ne soit pas la carte** : c'est
  # l'en-tête d'une page de données qui porte le menu, et la carte n'en dessine
  # pas — tout ce qu'on y poserait volerait des pixels à ce qu'on y cherche. Deux
  # façons de se retrouver sans rien, donc, et la seconde est la sournoise :
  #
  #  • tout ranger derrière le menu — il ne resterait rien à faire défiler ;
  #  • ne laisser que la carte — le défilement existe, mais aucune de ses pages
  #    n'a de menu, et ce qu'on avait rangé n'est atteignable par aucun geste.
  #
  # Dans les deux cas, la première page rangée reprend sa place. Même règle côté
  # Dart (`RidePreset.ridePages`), et un test de chaque côté.
  def keep_one_swipeable(pages)
    return pages if pages.any? { |page| !page["menu"] && page["kind"] != "map" }

    index = pages.index { |page| page["menu"] }
    return pages if index.nil?

    pages.each_with_index.map { |page, i| i == index ? page.except("menu") : page }
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
      "rows" => rows, "cols" => cols, "cells" => cells,
      "menu" => menu_flag(page) }.compact
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
      "blocks" => blocks, "menu" => menu_flag(page) }.compact
  end

  # Une page de tours : liste déroulante d'un côté, composants du tour choisi
  # de l'autre — en liste défilante ou en grille, comme une page de mesures
  # (`sanitize_list` / `sanitize_grid`). Plus la `series`, qui dit quelle
  # suite de tours cette page-là affiche.
  #
  # `layout` **tranche seul**, et seulement sur `"grid"` : un document plus
  # ancien que ce chantier, ou qui omet la clé, doit retomber sur la liste
  # défilante d'aujourd'hui — jamais sur une grille dont il n'a jamais décrit
  # `rows`/`cols`. Même repli côté Dart (`LapPageLayout.parse`).
  #
  # Aucun filtre sur les blocs qu'elle peut contenir, dans les deux cas :
  # `sanitize_list`/`sanitize_grid` n'en ont pas non plus, et c'est l'appli qui
  # ignore silencieusement ce qui n'a pas de sens sur une page de tours (voir
  # `LapListBody._block`, dépôt voisin) — ajouter la règle ici la ferait
  # respecter *avant* que l'appli, plus stricte que le site, ne le soit jamais.
  def sanitize_laps(page)
    layout = page["layout"] == "grid" ? sanitize_lap_grid(page) : sanitize_lap_blocks(page)
    return nil if layout.nil?

    { "kind" => "laps", "title" => page["title"].to_s.presence || "Tours",
      "series" => sanitize_series(page["series"]),
      "menu" => menu_flag(page) }.merge(layout).compact
  end

  def sanitize_lap_blocks(page)
    blocks = raw_array(page["blocks"]).filter_map { |block| sanitize_block(block) }
    return nil if blocks.empty?

    { "blocks" => blocks }
  end

  # Même géométrie que `sanitize_grid`, `place_cells` compris : une grille de
  # tours ne défile pas plus qu'une grille de mesures, et n'a aucune raison
  # d'obéir à une autre limite de côté.
  def sanitize_lap_grid(page)
    rows = clamp_side(page["rows"])
    cols = clamp_side(page["cols"])
    cells = place_cells(page["cells"], rows, cols)
    return nil if cells.empty?

    { "layout" => "grid", "rows" => rows, "cols" => cols, "cells" => cells }
  end

  # `'default'` sans configuration : c'est aussi la seule série que l'export
  # `.fit` de l'appli sait porter (une seule hiérarchie de tours possible dans
  # le format). Même repli que `LapListPageSpec.parse`/`MarkLapBlock.parse`
  # côté Dart — il faut que les deux tombent sur exactement la même chaîne.
  def sanitize_series(raw)
    raw.is_a?(String) && raw.strip.present? ? raw.strip : "default"
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

      metric = raw["metric"]
      block["metric"] = metric
      if DURATION_METRICS.include?(metric)
        block["format"] = DURATION_FORMATS.include?(raw["format"]) ? raw["format"] : DURATION_FORMATS.first
      end
      block["icon"] = raw["icon"] if ICONS.include?(raw["icon"])
      # Libre et facultatif, comme `description` sur un profil : tronqué plutôt
      # que rejeté, pour ne jamais faire perdre le réglage à cause d'un mot de
      # trop. Absent, le jeton `label` du bloc garde le nom traduit de la
      # mesure (`companion.settings.metrics.<metric>`) — le comportement d'avant
      # ce réglage.
      label = raw["label"].to_s.strip[0, MAX_METRIC_LABEL_LENGTH]
      block["label"] = label if label.present?

      layout = sanitize_layout_positions(raw["layout"], raw["mode"])
      zone_metric = ZONE_METRICS.include?(metric)
      eligible_range = RANGE_GAUGE_METRICS.include?(metric)
      eligible_dynamic = DYNAMIC_GAUGE_METRICS.include?(metric)
      layout.delete("gauge") unless zone_metric || eligible_range || eligible_dynamic
      block["layout"] = layout

      # Seulement quand la jauge est effectivement posée sur une mesure sans
      # zones : une mesure à zones garde la jauge du cycliste, `gauge_kind`
      # ne veut rien dire pour elle. `dynamic_gauge` n'a rien de plus à
      # assainir ici : sa plage se lit dans la sortie en cours
      # (`MetricId.liveRangeOf` côté appli), pas dans le document — poser
      # min/max dessus laisserait une clé morte.
      if layout["gauge"] && !zone_metric
        preferred = raw["layout"].is_a?(Hash) ? raw["gauge_kind"] : legacy_gauge_kind(raw["mode"])
        block["gauge_kind"] =
          if eligible_range && eligible_dynamic
            GAUGE_KINDS.include?(preferred) ? preferred : GAUGE_KINDS.first
          elsif eligible_range
            "range"
          else
            "dynamic"
          end
        if block["gauge_kind"] == "range"
          range = sanitize_range(raw["min"], raw["max"])
          block.merge!(range) if range
        end
      end
    when "clock"
      # Réglable comme un bloc `metric` (icône, étiquette, disposition), mais
      # jamais d'unité ni de jauge : une horloge n'a ni l'une ni l'autre.
      block["icon"] = raw["icon"] if ICONS.include?(raw["icon"])
      layout = sanitize_layout_positions(raw["layout"], nil)
      layout.delete("unit")
      layout.delete("gauge")
      block["layout"] = layout
    when "zones", "lap_zones"
      block["source"] = ZONE_SOURCES.include?(raw["source"]) ? raw["source"] : "hr"
    when "mark_lap"
      block["series"] = sanitize_series(raw["series"])
    end

    color = sanitize_hex_color(raw["color"])
    block["color"] = color if color
    text_color = sanitize_hex_color(raw["text_color"])
    block["text_color"] = text_color if text_color

    block
  end

  # La disposition d'un bloc `metric`, sans encore savoir si sa mesure a droit à
  # une jauge — `sanitize_block` retire `"gauge"` après coup selon la mesure
  # choisie, `sanitize_metric_layouts` (une disposition **enregistrée**, pas
  # encore appliquée à une mesure précise) ne le fait jamais. Migration
  # `mode` → `layout` incluse : un document qui n'a que l'ancien `mode` (jamais
  # rouvert dans l'éditeur depuis ce chantier) retombe sur `LEGACY_LAYOUTS`.
  def sanitize_layout_positions(raw, legacy_mode)
    source = raw.is_a?(Hash) ? raw : (LEGACY_LAYOUTS[legacy_mode] || DEFAULT_METRIC_LAYOUT)
    gauge_row = valid_row(source["gauge"])

    layout = {}
    %w[icon label unit value].each do |token|
      pos = valid_position(source[token])
      next unless pos
      # La jauge est une barre pleine largeur, pas un texte : dès qu'elle
      # occupe une rangée, rien d'autre n'y tient — un document malformé qui
      # les superposerait perd l'autre élément plutôt que la jauge, même
      # arbitrage que partout ailleurs dans ce fichier (la première règle
      # cohérente gagne, rien n'est deviné).
      next if gauge_row && pos.start_with?("#{gauge_row}-")

      layout[token] = pos
    end
    layout["gauge"] = gauge_row if gauge_row
    # Un bloc qui n'affiche pas le chiffre n'a pas de sens — voir
    # `DEFAULT_METRIC_LAYOUT`. Jamais sur la rangée de la jauge : ce serait
    # fabriquer nous-mêmes la collision que la boucle au-dessus vient
    # d'éviter.
    layout["value"] ||= "#{gauge_row == '0' ? 1 : 0}-center"

    row_heights = sanitize_row_heights(source["row_heights"])
    layout["row_heights"] = row_heights if row_heights

    compact_layout_rows(layout)
  end

  # Le poids de chaque rangée, ex. `{"1" => "large"}` pour mettre le chiffre
  # plus en évidence que son étiquette — voir `ROW_HEIGHTS`. Une rangée
  # absente d'ici vaut `"normal"`, jamais écrite pour rester silencieuse.
  def sanitize_row_heights(raw)
    return nil unless raw.is_a?(Hash)

    raw.filter_map do |row, size|
      next nil unless row.is_a?(String) && row.match?(LAYOUT_ROW_PATTERN)
      next nil unless ROW_HEIGHTS.include?(size)

      [ row, size ]
    end.to_h.presence
  end

  def valid_position(value)
    return nil unless value.is_a?(String)

    row, col = value.split("-", 2)
    return nil unless row&.match?(LAYOUT_ROW_PATTERN) && LAYOUT_COLUMNS.include?(col)

    value
  end

  def valid_row(value)
    value if value.is_a?(String) && value.match?(LAYOUT_ROW_PATTERN)
  end

  # Les numéros de rangée utilisés, ramenés à `0, 1, 2…` sans trou — sinon un
  # document composé à la main pourrait accumuler des rangées arbitrairement
  # grandes tout en restant *valide* case par case. `row_heights` n'est pas
  # une position : il ne compte pas pour établir la liste des rangées, mais
  # ses propres clés doivent suivre le même renumérotage.
  def compact_layout_rows(layout)
    rows = layout.filter_map do |token, value|
      next nil if token == "row_heights"
      token == "gauge" ? value.to_i : value.split("-").first.to_i
    end.uniq.sort
    mapping = rows.each_with_index.to_h

    layout.filter_map do |token, value|
      case token
      when "row_heights"
        remapped = value.filter_map { |row, size| [ mapping[row.to_i].to_s, size ] if mapping.key?(row.to_i) }.to_h
        [ token, remapped ] unless remapped.empty?
      when "gauge"
        [ token, mapping[value.to_i].to_s ]
      else
        row, col = value.split("-", 2)
        [ token, "#{mapping[row.to_i]}-#{col}" ]
      end
    end.to_h
  end

  # Le type de jauge qu'un ancien mode dessinait — `dynamic_gauge` seul
  # voulait la plage lue en roulant, tout le reste (y compris `gauge` sur une
  # mesure sans zones) voulait la plage réglée dans l'éditeur.
  def legacy_gauge_kind(mode)
    mode == "dynamic_gauge" ? "dynamic" : "range"
  end

  # Les dispositions que l'utilisateur a enregistrées pour les réutiliser sur
  # une prochaine mesure — un **arrangement**, pas un bloc : ni icône choisie,
  # ni type de jauge, ni min/max, qui sont propres à une mesure précise et pas
  # à sa disposition. `sanitize_layout_positions` ne sait donc pas encore si
  # `"gauge"` a un sens ici — c'est `sanitize_block` qui tranchera, plus tard,
  # une fois la disposition appliquée à une mesure choisie.
  def sanitize_metric_layouts(raw)
    seen = []
    raw_array(raw).first(MAX_METRIC_LAYOUTS).filter_map.with_index do |entry, index|
      next nil unless entry.is_a?(Hash)

      name = entry["name"].to_s.strip
      next nil if name.blank?

      { "key" => unique_key(entry["key"], name, index, seen),
        "name" => name,
        "layout" => sanitize_layout_positions(entry["layout"], nil) }
    end
  end

  # `nil` plutôt qu'un repli : contrairement aux capteurs ou au radar, il n'y a pas
  # de couleur par défaut sensée à imposer — une clé absente laisse simplement
  # l'appli à son calcul habituel (couleur de zone, ou gris des cartes).
  def sanitize_hex_color(value)
    return nil unless value.is_a?(String)

    value.strip.downcase[/\A#[0-9a-f]{6}\z/]
  end

  def sanitize_bands(raw)
    raw_array(raw).filter_map do |band|
      # Une case invalide devient `nil` à sa place plutôt que d'être retirée :
      # sinon tout ce qui suit glisserait, et une case vidée au milieu par
      # l'éditeur se retrouverait toujours en bout de jeu.
      metrics = raw_array(band.is_a?(Hash) ? band["metrics"] : band)
                .first(MAX_BAND_METRICS)
                .map { |metric| metric if band_slot?(metric) }
      metrics.all?(&:nil?) ? nil : { "metrics" => metrics }
    end
  end

  # La bande de l'encoche : plusieurs jeux, une mesure au plus de chaque côté
  # dans chacun — même forme que `bands`, entre lesquels un glissé fait
  # défiler côté appli. Contrairement au bandeau, une liste vide ne retombe
  # jamais sur un contenu par défaut — un profil qui n'a jamais touché ce
  # réglage ne doit rien changer à l'écran.
  #
  # Un `Hash` isolé (l'ancien format, un seul jeu) est accepté comme un
  # tableau à un seul élément : un profil enregistré avant ce changement ne
  # doit pas perdre son jeu déjà configuré.
  def sanitize_notch_sets(raw)
    candidates = raw.is_a?(Array) ? raw : (raw.is_a?(Hash) ? [ raw ] : [])
    candidates.filter_map { |entry| sanitize_notch_set(entry) }.presence
  end

  def sanitize_notch_set(raw)
    return nil unless raw.is_a?(Hash)

    { "left" => sanitize_notch_metric(raw["left"]), "right" => sanitize_notch_metric(raw["right"]) }
      .compact.presence
  end

  def sanitize_notch_metric(raw)
    raw if band_slot?(raw)
  end

  # Une case de bandeau ou de bande de l'encoche : une mesure, une commande
  # (`BAND_ACTIONS`) ou un mode de radar (`BAND_RADAR`).
  def band_slot?(raw)
    METRICS.include?(raw) || BAND_ACTIONS.include?(raw) || BAND_RADAR.include?(raw)
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
      # L'habillage plein écran — les jauges des gouttières, le cadre qui
      # s'embrase, les mètres dans la bande de l'encoche. Coupé, le capteur
      # continue de tourner : les alertes sonores restent, et le radar ne se
      # voit plus que là où on l'a posé (composant `radar`). C'est le réglage de
      # qui veut ses mètres dans une case et un écran par ailleurs intact.
      #
      # Absent vaut **activé**, comme pour les capteurs : un profil venu d'une
      # version antérieure du contrat ne doit pas perdre son alerte en silence,
      # et c'est justement celle qu'on lit du coin de l'œil.
      "overlay" => raw["overlay"] != false,
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

  # `nil` plutôt qu'un repli : contrairement à `positive`, il n'y a pas de
  # valeur par défaut sensée pour la plage d'une jauge, et une plage à moitié
  # inventée (un seul des deux bornes gardée) serait pire qu'aucune plage —
  # `min`/`max` restent alors absents, et le bloc retombe sur le chiffre plein
  # cadre. La pente peut être négative, donc pas de `positive` ici.
  def sanitize_range(min, max)
    return nil unless min.is_a?(Numeric) && max.is_a?(Numeric) && min < max

    { "min" => min.to_f, "max" => max.to_f }
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
      "description" => "Carte, effort et chiffres — la sortie complète.",
      "activities" => %w[cycling],
      "default_for" => %w[cycling],
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
          "kind" => "grid", "title" => "Chiffres", "rows" => 4, "cols" => 3,
          "cells" => [
            { "row" => 0, "col" => 0, "block" => metric("speed", "big") },
            { "row" => 0, "col" => 1, "block" => metric("distance", "compact") },
            { "row" => 0, "col" => 2, "block" => metric("ascent", "compact") },
            # La pente sur toute la largeur, et en gros : c'est en montant qu'on
            # la lit, à 8 km/h, le regard sur la route. Sous le D+ qui la cumule,
            # parce que c'en est l'instant — la ligne du dessus dit le chemin
            # parcouru, celle-ci dit le mètre sous les roues.
            { "row" => 1, "col" => 0, "col_span" => 3, "block" => metric("grade", "big") },
            # La ligne fusionnée : la barre des zones garde toute son information
            # sans sa légende, qui ne tiendrait pas dans une cellule.
            { "row" => 2, "col" => 0, "col_span" => 3,
              "block" => { "kind" => "zones", "source" => "power", "mode" => "bar_only" } },
            { "row" => 3, "col" => 0, "block" => metric("power", "zone") },
            { "row" => 3, "col" => 1, "col_span" => 2, "block" => metric("heart_rate", "gauge") }
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
      "description" => "Carte et effort seulement, radar rapproché.",
      "activities" => %w[mtb],
      "default_for" => %w[mtb],
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
      "description" => "Sans carte ni GPS — pour rouler à l'intérieur.",
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

  # Écrit directement au format final (`layout`, pas `mode`) : ces profils par
  # défaut ne repassent jamais par `sanitize_block`, contrairement à un profil
  # composé dans l'éditeur. `LEGACY_LAYOUTS` porte déjà la traduction de
  # chacun de ces anciens noms de mode — une seule table à tenir à jour pour
  # que ces profils gardent le même aspect qu'avant ce chantier.
  def metric(key, mode)
    { "kind" => "metric", "metric" => key, "layout" => LEGACY_LAYOUTS.fetch(mode) }
  end

  # Quatre mesures au plus : au-delà, les chiffres du bandeau deviennent trop petits
  # pour être lus d'un coup d'œil en roulant, ce qui est son seul usage. L'appli
  # tronque de son côté ; couper ici évite d'écrire un document qu'elle corrigera.
  def band(metrics)
    { "metrics" => metrics.first(4) }
  end
end
