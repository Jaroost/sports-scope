require "test_helper"

# Les profils de sortie, du point de vue des deux clients : l'application qui les
# lit, et l'éditeur qui les écrit.
#
# Ce qui compte ici tient en deux points. D'abord le **401 propre** : l'appli
# distingue « pas connecté » — la seule chose que le cycliste puisse corriger — de
# « pas de réseau », et c'est l'en-tête `Accept` qui le lui permet. Ensuite le
# **document assaini rendu à l'écriture** : l'éditeur s'y réaligne, et c'est ce qui
# l'empêche d'afficher autre chose que ce que le téléphone recevra.
class CompanionSettingsApiTest < ActionDispatch::IntegrationTest
  def sign_in
    user = User.create!(email: "settings-#{SecureRandom.hex(4)}@example.com",
                        keycloak_uid: "kc-settings-#{SecureRandom.hex(4)}")
    get "/auth/handoff", params: { token: SessionHandoff.issue!(user), next: "/dashboard" }
    user
  end

  def preset(extra = {})
    {
      "key" => "route", "name" => "Route",
      "pages" => [ { "kind" => "map" } ],
      "bands" => [ { "metrics" => [ "speed" ] } ]
    }.merge(extra)
  end

  def patch_document(presets)
    patch "/api/companion_settings",
          params: { presets: presets }.to_json,
          headers: { "CONTENT_TYPE" => "application/json", "Accept" => "application/json" }
  end

  # ── lecture ─────────────────────────────────────────────────────────────────

  test "un anonyme reçoit un 401 JSON, pas une redirection" do
    # C'est ce qui permet à l'appli de dire « connecte-toi » plutôt que de croire
    # que le réseau est tombé. Sans l'en-tête, Rails renvoie une redirection HTML
    # vers Keycloak, indiscernable d'une panne pour un `fetch`.
    get "/api/companion_settings", headers: { "Accept" => "application/json" }

    assert_response :unauthorized
    assert_equal "application/json", response.media_type
  end

  # ── la taille annoncée par le téléphone ─────────────────────────────────────
  #
  # L'éditeur compose en lignes et en colonnes ; ce qui décide de ce qu'un
  # composant peut y dessiner, ce sont des pixels. Le site les ignorait, et
  # supposait donc un téléphone de référence — un avertissement plausible plutôt
  # que vrai. L'appli l'annonce maintenant sur la requête qu'elle faisait de
  # toute façon.

  test "la grille annoncée par l'appli est retenue" do
    user = sign_in
    get "/api/companion_settings", params: { grid: "384x712" },
        headers: { "Accept" => "application/json" }

    assert_response :success
    assert_equal({ "width" => 384, "height" => 712 }, user.reload.companion_viewport)
  end

  test "une requête sans taille ne touche pas à celle qu'on avait" do
    # Le cas d'une version de l'appli plus ancienne que le site : elle ne dit
    # rien, et ce qu'un autre téléphone a annoncé ne doit pas s'effacer pour
    # autant.
    user = sign_in
    user.update_column(:companion_viewport, { "width" => 328, "height" => 598 })

    get "/api/companion_settings", headers: { "Accept" => "application/json" }

    assert_response :success
    assert_equal({ "width" => 328, "height" => 598 }, user.reload.companion_viewport)
  end

  test "une taille invraisemblable est ignorée plutôt qu'écrite" do
    # Ce n'est pas l'appli qui l'enverrait : c'est n'importe quel appelant
    # authentifié. Une mesure fausse vaut moins qu'une mesure absente, parce que
    # l'éditeur la croirait.
    user = sign_in

    [ "0x0", "12x9999", "grand", "328", "328x598x7" ].each do |raw|
      get "/api/companion_settings", params: { grid: raw },
          headers: { "Accept" => "application/json" }

      assert_response :success
      assert_nil user.reload.companion_viewport, "« #{raw} » n'aurait pas dû être retenu"
    end
  end

  test "un anonyme n'écrit rien" do
    # L'endpoint est authentifié : il n'y a personne à qui attribuer la mesure.
    get "/api/companion_settings", params: { grid: "384x712" },
        headers: { "Accept" => "application/json" }

    assert_response :unauthorized
  end

  test "un compte neuf reçoit les trois profils par défaut" do
    sign_in
    get "/api/companion_settings", headers: { "Accept" => "application/json" }

    assert_response :success
    assert_equal %w[road mtb trainer], response.parsed_body["presets"].map { |p| p["key"] }
  end

  # ── écriture ────────────────────────────────────────────────────────────────

  test "ce qu'on enregistre se relit" do
    sign_in
    patch_document([ preset("name" => "Mon vélo") ])

    assert_response :success

    get "/api/companion_settings", headers: { "Accept" => "application/json" }
    assert_equal "Mon vélo", response.parsed_body["presets"].first["name"]
  end

  test "l'écriture rend le document assaini, pas celui qu'on a envoyé" do
    # Le point de tout l'éditeur : il se réaligne sur cette réponse. Une règle qui
    # corrige quelque chose doit se voir à l'écran, pas au départ d'un col.
    sign_in
    patch_document([ preset(
      "pages" => [ { "kind" => "map" }, { "kind" => "map" } ],
      "bands" => [ { "metrics" => %w[duration distance speed power heart_rate] } ]
    ) ])

    assert_response :success
    body = response.parsed_body["presets"].first
    assert_equal 1, body["pages"].size, "la deuxième carte n'a pas été retirée"
    assert_equal 4, body["bands"].first["metrics"].size
  end

  test "un corps qui n'est pas un objet ne touche à rien" do
    # LE piège de cet endpoint : l'assainisseur rend les profils par défaut quand
    # il ne trouve rien d'exploitable, ce qui est juste pour *afficher* et
    # catastrophique pour *écrire*. Sans ce refus, une requête mal formée
    # remplacerait des profils composés à la main par ceux d'usine.
    #
    # Un corps carrément illisible, lui, n'arrive jamais jusqu'ici : le middleware
    # de Rails répond 400 avant le contrôleur. Ce qui passe et qu'il faut donc
    # refuser soi-même, c'est le JSON valide qui n'est pas un objet.
    sign_in
    patch_document([ preset("name" => "À garder") ])

    patch "/api/companion_settings",
          params: "[]",
          headers: { "CONTENT_TYPE" => "application/json", "Accept" => "application/json" }

    assert_response :bad_request

    get "/api/companion_settings", headers: { "Accept" => "application/json" }
    assert_equal "À garder", response.parsed_body["presets"].first["name"]
  end

  test "un anonyme ne peut rien écrire" do
    patch_document([ preset ])

    assert_response :unauthorized
  end

  # ── l'éditeur ───────────────────────────────────────────────────────────────

  test "la page d'édition sert le document et le catalogue" do
    sign_in
    get "/fr/companion/dashboard"

    assert_response :success
    assert_match "CompanionDashboard", response.body
    # Le catalogue vient du serveur : un composant que l'éditeur proposerait sans
    # que l'assainisseur le connaisse disparaîtrait à l'enregistrement.
    assert_match "max_band_metrics", response.body
  end

  test "la page d'édition demande une session" do
    get "/fr/companion/dashboard"

    assert_response :redirect
  end
end
