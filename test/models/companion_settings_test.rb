require "test_helper"

# L'assainisseur des profils de sortie.
#
# Ce qu'il garantit n'est pas de la validation défensive : c'est **l'honnêteté de
# l'éditeur**. L'application applique déjà ces règles de son côté, mais en
# silence et sur la route. Si le site laissait composer une cinquième case de
# bandeau ou deux cartes, l'utilisateur verrait à l'écran quelque chose que son
# téléphone jetterait sans un mot.
#
# La règle qui gouverne tout : **le serveur peut être plus indulgent que
# l'application, jamais moins.** Ce qui sort d'ici doit être accepté *en entier*
# par le décodeur Dart.
class CompanionSettingsTest < ActiveSupport::TestCase
  # Un profil minimal valable, à décorer selon le test.
  def preset(extra = {})
    {
      "key" => "route",
      "name" => "Route",
      "pages" => [ { "kind" => "map" } ],
      "bands" => [ { "metrics" => [ "speed" ] } ]
    }.merge(extra)
  end

  def sanitize(presets)
    CompanionSettings.sanitize({ "presets" => presets })
  end

  def only(presets)
    sanitize(presets)["presets"].first
  end

  # ── le repli ────────────────────────────────────────────────────────────────

  test "un document vide rend les profils par défaut" do
    # Servir un document sans profil obligerait l'appli à distinguer « ce compte
    # n'a rien réglé » de « le site n'a rien su dire », alors que la réponse utile
    # est la même dans les deux cas.
    assert_equal 3, CompanionSettings.sanitize({})["presets"].size
    assert_equal 3, CompanionSettings.sanitize(nil)["presets"].size
    assert_equal 3, sanitize([])["presets"].size
  end

  test "les profils par défaut traversent l'assainisseur sans perte" do
    # S'ils n'en sortaient pas intacts, c'est qu'ils décriraient déjà quelque
    # chose que l'appli corrige — donc que le site servirait un tableau de bord
    # que personne ne verrait jamais.
    before = CompanionSettings.defaults
    after = CompanionSettings.sanitize(before)

    assert_equal before["presets"].size, after["presets"].size
    assert_equal before["presets"].map { |p| p["key"] },
                 after["presets"].map { |p| p["key"] }

    grid = after["presets"].first["pages"].find { |page| page["kind"] == "grid" }
    assert_equal 6, grid["cells"].size, "la grille de Route perd des cellules"
  end

  # ── les clés ────────────────────────────────────────────────────────────────

  test "une clé manquante est fabriquée depuis le nom" do
    # Écart assumé avec le Dart, qui retire le profil : perdre un profil parce
    # qu'on ne lui a pas donné de clé serait le pire service à rendre à un éditeur.
    result = only([ preset("key" => nil, "name" => "Home-trainer") ])

    assert_equal "home-trainer", result["key"]
  end

  test "une clé en double est suffixée, pas écrasée" do
    # C'est exactement ce que produit le bouton « dupliquer » de l'éditeur.
    result = sanitize([ preset, preset("name" => "Route bis") ])["presets"]

    assert_equal %w[route route-2], result.map { |p| p["key"] }
    assert_equal 2, result.size, "le profil dupliqué a disparu"
  end

  test "un profil sans nom prend sa clé pour nom" do
    assert_equal "route", only([ preset("name" => "") ])["name"]
  end

  # ── les pages ───────────────────────────────────────────────────────────────

  test "la deuxième carte est retirée" do
    # Deux cartes voudraient dire deux identités pour un seul WebView, alors que
    # l'instance MapLibre est unique et doit le rester.
    result = only([ preset("pages" => [ { "kind" => "map" }, { "kind" => "map" } ]) ])

    assert_equal 1, result["pages"].size
  end

  test "la carte se place où l'on veut" do
    result = only([ preset("pages" => [
      { "kind" => "list", "blocks" => [ { "kind" => "recording" } ] },
      { "kind" => "map" }
    ]) ])

    assert_equal %w[list map], result["pages"].map { |page| page["kind"] }
  end

  test "un profil sans carte n'en fabrique pas une" do
    # C'est le home-trainer : pas de carte, donc pas de WebView du tout.
    result = only([ preset("pages" => [
      { "kind" => "list", "blocks" => [ { "kind" => "recording" } ] }
    ]) ])

    assert_equal [ "list" ], result["pages"].map { |page| page["kind"] }
  end

  test "un profil vidé de ses pages retombe sur la page Effort" do
    # On ne laisse jamais partir un tableau de bord sans contenu : l'appli
    # monterait une coquille vide, ce qui ne se diagnostique pas au guidon.
    result = only([ preset("pages" => [ { "kind" => "hologramme" },
                                        { "kind" => "list", "blocks" => [] } ]) ])

    assert_equal 1, result["pages"].size
    assert_equal "Effort", result["pages"].first["title"]
  end

  # ── derrière le menu ────────────────────────────────────────────────────────
  #
  # Une page marquée `menu` ne passe plus sous les yeux à chaque glissé : on va
  # la chercher dans le menu d'actions de l'appli. C'est ce qui rend composable
  # une page qu'on ne lit **pas** en roulant — un bilan, des répartitions — sans
  # la mettre à un glissé de la carte.

  test "une page absente de la clé menu reste dans le défilement" do
    # Le sens qui compte : un document plus ancien que la clé garde ses pages là
    # où elles étaient, et une appli plus ancienne l'ignore et les montre toutes.
    # L'erreur va donc toujours vers « visible », jamais vers « introuvable ».
    result = only([ preset("pages" => [ list_page ]) ])

    assert_nil result["pages"].first["menu"]
  end

  test "le rangement derrière le menu traverse l'assainisseur" do
    result = only([ preset("pages" => [
      list_page,
      list_page("menu" => true),
      grid_page(rows: 1, cols: 1, cells: [ cell(0, 0, "speed") ]).merge("menu" => true)
    ]) ])

    assert_equal [ nil, true, true ], result["pages"].map { |page| page["menu"] }
  end

  test "une carte seule ne peut pas porter le menu" do
    # Le piège de cette règle : le défilement n'est pas vide, mais la carte ne
    # dessine aucun en-tête — donc aucun menu. Le bilan serait là, assaini, et
    # atteignable par aucun geste. Il reprend donc sa place.
    result = only([ preset("pages" => [ { "kind" => "map" },
                                        list_page("menu" => true) ]) ])

    assert_equal [ nil, nil ], result["pages"].map { |page| page["menu"] }
  end

  test "une page de données de plus suffit à porter le menu" do
    result = only([ preset("pages" => [ { "kind" => "map" },
                                        list_page,
                                        list_page("menu" => true) ]) ])

    assert_equal [ nil, nil, true ], result["pages"].map { |page| page["menu"] }
  end

  test "une valeur autre que true ne range rien" do
    # `menu` est un drapeau, pas un champ libre : ce qui n'est pas exactement
    # vrai laisse la page où elle est, plutôt que de la faire disparaître du
    # défilement sur une chaîne « false » venue d'un formulaire.
    result = only([ preset("pages" => [ list_page("menu" => "oui"),
                                        list_page("menu" => false) ]) ])

    assert_equal [ nil, nil ], result["pages"].map { |page| page["menu"] }
  end

  test "tout ranger derrière le menu rend la première page au défilement" do
    # Sinon il ne resterait rien à faire défiler, donc aucune page où le menu
    # s'ouvre, donc plus rien du tout — l'écran noir que tout le reste de cet
    # assainisseur s'emploie à éviter. Même règle côté Dart (`ridePages`).
    result = only([ preset("pages" => [ list_page("title" => "Bilan", "menu" => true),
                                        list_page("title" => "Répartitions", "menu" => true) ]) ])

    assert_equal [ nil, true ], result["pages"].map { |page| page["menu"] }
    assert_equal "Bilan", result["pages"].first["title"]
  end

  test "la carte ne se range jamais derrière le menu" do
    # Le WebView est peint au fond de la pile pour toute la sortie : ce n'est pas
    # une page qu'on ouvre et qu'on referme. La page d'effort à côté d'elle porte
    # le menu, donc la troisième peut rester rangée.
    result = only([ preset("pages" => [ { "kind" => "map", "menu" => true },
                                        list_page,
                                        list_page("menu" => true) ]) ])

    assert_equal [ nil, nil, true ], result["pages"].map { |page| page["menu"] }
  end

  # ── la grille ───────────────────────────────────────────────────────────────

  test "une grille trop grande est ramenée à six côtés" do
    result = only([ preset("pages" => [ grid_page(rows: 99, cols: 99, cells: [
      cell(0, 0, "speed")
    ]) ]) ])
    grid = result["pages"].first

    assert_equal CompanionSettings::MAX_GRID_SIDE, grid["rows"]
    assert_equal CompanionSettings::MAX_GRID_SIDE, grid["cols"]
  end

  test "une étendue qui déborde est rognée, pas rejetée" do
    # Réduire une grille dans l'éditeur ne doit pas faire disparaître les
    # composants qu'on y avait posés.
    result = only([ preset("pages" => [ grid_page(rows: 2, cols: 2, cells: [
      cell(0, 1, "speed", col_span: 5)
    ]) ]) ])
    cells = result["pages"].first["cells"]

    assert_equal 1, cells.size
    assert_equal 1, cells.first["col_span"]
  end

  test "une origine hors grille est rejetée" do
    # Contrairement à l'étendue, elle n'a aucune interprétation raisonnable : on
    # ne devine pas où l'utilisateur voulait mettre la cellule.
    result = only([ preset("pages" => [ grid_page(rows: 2, cols: 2, cells: [
      cell(0, 0, "speed"), cell(9, 9, "power")
    ]) ]) ])

    assert_equal 1, result["pages"].first["cells"].size
  end

  test "sur un recouvrement, la première posée gagne" do
    # L'ordre du document tranche, donc l'ordre que l'éditeur affiche. Si la
    # dernière gagnait, poser un composant en ferait disparaître un autre sans
    # aucune explication visible à l'écran.
    result = only([ preset("pages" => [ grid_page(rows: 2, cols: 3, cells: [
      cell(0, 0, "speed", col_span: 3),
      cell(0, 2, "power")
    ]) ]) ])
    cells = result["pages"].first["cells"]

    assert_equal 1, cells.size
    assert_equal "speed", cells.first["block"]["metric"]
  end

  test "un recouvrement en diagonale compte comme un recouvrement" do
    # Deux rectangles se croisent dès qu'ils se chevauchent sur les deux axes à la
    # fois : une comparaison ligne à ligne laisserait passer celui-ci.
    result = only([ preset("pages" => [ grid_page(rows: 3, cols: 3, cells: [
      cell(0, 0, "speed", row_span: 2, col_span: 2),
      cell(1, 1, "power", row_span: 2, col_span: 2)
    ]) ]) ])

    assert_equal 1, result["pages"].first["cells"].size
  end

  test "une grille sans cellule plaçable est retirée comme page" do
    result = only([ preset("pages" => [
      { "kind" => "map" },
      grid_page(rows: 2, cols: 2, cells: [ cell(9, 9, "speed") ])
    ]) ])

    assert_equal [ "map" ], result["pages"].map { |page| page["kind"] }
  end

  # ── les composants ──────────────────────────────────────────────────────────

  test "un mode inconnu retombe sur le mode par défaut" do
    # Le premier de la liste, celui sur lequel l'appli retombe elle aussi : les
    # deux dépôts doivent tomber sur le même.
    result = only([ preset("pages" => [ grid_page(rows: 1, cols: 1, cells: [
      { "row" => 0, "col" => 0,
        "block" => { "kind" => "metric", "metric" => "power", "mode" => "hologramme" } }
    ]) ]) ])

    assert_equal "big", result["pages"].first["cells"].first["block"]["mode"]
  end

  test "une mesure inconnue retire la cellule" do
    # Mieux qu'une case qui afficherait un tiret pour toujours — un tiret
    # permanent se lit comme un capteur en panne.
    result = only([ preset("pages" => [
      { "kind" => "map" },
      grid_page(rows: 1, cols: 1, cells: [ cell(0, 0, "pouls_lunaire") ])
    ]) ])

    assert_equal [ "map" ], result["pages"].map { |page| page["kind"] }
  end

  test "une source de zones inconnue retombe sur le cardio" do
    # C'est la répartition qui existe même sans capteur de puissance.
    result = only([ preset("pages" => [
      { "kind" => "list",
        "blocks" => [ { "kind" => "zones", "source" => "chakras" } ] }
    ]) ])

    assert_equal "hr", result["pages"].first["blocks"].first["source"]
  end

  test "un composant inconnu est retiré, les autres restent" do
    result = only([ preset("pages" => [
      { "kind" => "list", "blocks" => [
        { "kind" => "boussole" }, { "kind" => "recording" }
      ] }
    ]) ])

    assert_equal 1, result["pages"].first["blocks"].size
  end

  # ── le budget de charge ─────────────────────────────────────────────────────
  #
  # Le seul composant dont la donnée ne vient pas des capteurs : elle est calculée
  # par la page de navigation et poussée par le pont. Le contrat n'en porte donc
  # rien de plus qu'un mode — ce que le composant montre est décidé au guidon.

  test "le budget de charge se pose dans ses deux modes" do
    result = only([ preset("pages" => [
      { "kind" => "list", "blocks" => [
        { "kind" => "training_budget", "mode" => "day" },
        { "kind" => "training_budget", "mode" => "week" }
      ] }
    ]) ])

    assert_equal %w[day week], result["pages"].first["blocks"].map { |block| block["mode"] }
  end

  test "un mode de budget inconnu retombe sur la journée" do
    # C'est le mode qui répond à « je continue ou je rentre ? », la question qu'on
    # se pose au guidon — la semaine se regarde à l'arrêt.
    result = only([ preset("pages" => [
      { "kind" => "list", "blocks" => [ { "kind" => "training_budget", "mode" => "mois" } ] }
    ]) ])

    assert_equal "day", result["pages"].first["blocks"].first["mode"]
  end

  test "le budget de charge ne traîne aucune clé de mesure" do
    # L'assainisseur reconstruit à partir des seules clés qu'il connaît : une
    # `metric` recopiée ici serait une clé morte que le décodeur Dart ignorerait,
    # donc un écart entre ce que l'éditeur montre et ce qui part.
    result = only([ preset("pages" => [
      { "kind" => "list",
        "blocks" => [ { "kind" => "training_budget", "mode" => "day", "metric" => "power" } ] }
    ]) ])

    assert_equal({ "kind" => "training_budget", "mode" => "day" },
                 result["pages"].first["blocks"].first)
  end

  # ── le bandeau ──────────────────────────────────────────────────────────────

  test "un jeu de plus de quatre mesures est tronqué" do
    # Au-delà, les chiffres deviennent trop petits pour être lus d'un coup d'œil
    # en roulant, ce qui est le seul usage du bandeau.
    result = only([ preset("bands" => [ { "metrics" => %w[
      duration distance speed power heart_rate cadence
    ] } ]) ])

    assert_equal CompanionSettings::MAX_BAND_METRICS,
                 result["bands"].first["metrics"].size
  end

  test "un jeu sans mesure connue est retiré" do
    result = only([ preset("bands" => [
      { "metrics" => [ "pouls_lunaire" ] }, { "metrics" => [ "power" ] }
    ]) ])

    assert_equal 1, result["bands"].size
  end

  test "sans aucun jeu valable, ceux d'origine reviennent" do
    result = only([ preset("bands" => []) ])

    assert_equal 2, result["bands"].size
  end

  # ── les capteurs ────────────────────────────────────────────────────────────

  test "seuls les capteurs coupés sont écrits" do
    # Absent vaut activé : ne stocker que les coupures garde le document lisible
    # et rend impossible d'éteindre un capteur par omission.
    result = only([ preset("sensors" => {
      "gps" => false, "radar" => false, "power" => true
    }) ])

    assert_equal({ "gps" => false, "radar" => false }, result["sensors"])
  end

  test "un profil qui ne coupe rien n'a pas de bloc capteurs" do
    result = only([ preset("sensors" => { "gps" => true }) ])

    assert_nil result["sensors"]
  end

  # ── les réglages ────────────────────────────────────────────────────────────

  test "la veille ne descend jamais sous 1 %" do
    # À zéro, certains appareils coupent franchement le rétroéclairage, et le
    # bandeau deviendrait illisible même de nuit.
    result = only([ preset("screen" => { "dim_level" => 0 }) ])

    assert_in_delta 0.01, result["screen"]["dim_level"]
  end

  test "un réglage radar absurde retombe sur la valeur de la carte de diagnostic" do
    # Les deux affichages doivent raconter la même chose du même capteur.
    result = only([ preset("radar" => { "close_m" => -5, "sounds" => false }) ])

    assert_equal 40, result["radar"]["close_m"]
    assert_equal false, result["radar"]["sounds"]
  end

  test "l'habillage radar n'est coupé que s'il est explicitement coupé" do
    # Même règle que les capteurs : un profil venu d'une version antérieure du
    # contrat ne connaît pas la clé, et perdrait sinon en silence l'alerte qu'on
    # lit du coin de l'œil.
    assert_equal true, only([ preset("radar" => { "close_m" => 25 }) ])["radar"]["overlay"]
    assert_equal false, only([ preset("radar" => { "overlay" => false }) ])["radar"]["overlay"]
  end

  test "la jauge radar se pose dans les deux sens" do
    # Le mode décide du dessin, et un mode inconnu du contrat retomberait sur
    # « Distance » — c'est-à-dire un composant qu'on n'a pas choisi.
    page = { "kind" => "list", "title" => "Radar", "blocks" => [
      { "kind" => "radar", "mode" => "gauge_vertical" },
      { "kind" => "radar", "mode" => "gauge" },
      { "kind" => "radar", "mode" => "renversée" }
    ] }
    blocks = only([ preset("pages" => [ page ]) ])["pages"].first["blocks"]

    assert_equal %w[gauge_vertical gauge distance], blocks.map { |block| block["mode"] }
  end

  # ── outils ──────────────────────────────────────────────────────────────────

  def list_page(extra = {})
    { "kind" => "list", "title" => "Effort",
      "blocks" => [ { "kind" => "recording" } ] }.merge(extra)
  end

  def grid_page(rows:, cols:, cells:)
    { "kind" => "grid", "title" => "Chiffres", "rows" => rows, "cols" => cols,
      "cells" => cells }
  end

  def cell(row, col, metric, row_span: 1, col_span: 1)
    { "row" => row, "col" => col, "row_span" => row_span, "col_span" => col_span,
      "block" => { "kind" => "metric", "metric" => metric } }
  end
end
