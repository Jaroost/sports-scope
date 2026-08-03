require "test_helper"

# L'objectif d'entraînement et la sortie visée, devenus des réglages de COMPTE.
#
# Ils ont d'abord vécu dans le `localStorage` du navigateur, ce qui allait tant qu'ils
# ne servaient qu'à la page qui les avait écrits. L'app compagnon affiche désormais le
# même budget au guidon, et elle lit le site depuis le WebView de l'appareil : deux
# stockages locaux donneraient deux plafonds de charge pour un seul athlète.
#
# Ce qui se joue ici tient en deux points. D'abord la **préservation** : le formulaire
# de profil n'envoie pas ces clés (elles se règlent sur la page Performances), et un
# enregistrement de profil ne doit pas ramener l'objectif à sa valeur d'usine. Ensuite
# le **tout ou rien de la sortie visée** : l'affûtage se compte en jours et le TSS visé
# se déduit de la distance, donc un événement à moitié rempli ferait dériver la charge
# au lieu de la piloter — il vaut « pas d'objectif daté ».
class TrainingPreferencesTest < ActionDispatch::IntegrationTest
  def sign_in
    user = User.create!(email: "training-#{SecureRandom.hex(4)}@example.com",
                        keycloak_uid: "kc-training-#{SecureRandom.hex(4)}")
    get "/auth/handoff", params: { token: SessionHandoff.issue!(user), next: "/dashboard" }
    user
  end

  def patch_preferences(preferences)
    patch "/api/profile/preferences",
          params: { preferences: preferences }.to_json,
          headers: { "CONTENT_TYPE" => "application/json", "Accept" => "application/json" }
  end

  def training_of(user)
    user.reload.preferences_with_defaults["training"]
  end

  test "un compte neuf vise la progression douce, sans sortie objectif" do
    user = sign_in

    assert_equal({ "goal" => "improve_slow", "event" => nil }, training_of(user))
  end

  test "enregistre l'objectif et la sortie visée" do
    user = sign_in
    patch_preferences(
      "training" => {
        "goal" => "peak",
        "event" => { "date" => "2026-09-12", "distance_km" => 120, "intensity" => "race" }
      }
    )

    assert_response :success
    assert_equal "peak", training_of(user)["goal"]
    assert_equal({ "date" => "2026-09-12", "distance_km" => 120, "intensity" => "race" },
                 training_of(user)["event"])
  end

  test "un objectif inconnu retombe sur la progression douce" do
    user = sign_in
    patch_preferences("training" => { "goal" => "win_the_tour" })

    assert_equal "improve_slow", training_of(user)["goal"]
  end

  test "un enregistrement de profil qui ne parle pas d'entraînement ne l'efface pas" do
    # Le cas normal : UserProfile.vue enregistre les POI, la carte, les sports — et ne
    # connaît pas l'objectif d'entraînement, qui se règle ailleurs.
    user = sign_in
    patch_preferences("training" => { "goal" => "maintain" })
    patch_preferences("display" => { "default_sport" => "mtb" })

    assert_equal "maintain", training_of(user)["goal"]
    assert_equal "mtb", user.reload.preferences_with_defaults.dig("display", "default_sport")
  end

  test "une sortie objectif incomplète vaut pas de sortie objectif" do
    user = sign_in

    patch_preferences("training" => { "event" => { "date" => "2026-09-12" } })
    assert_nil training_of(user)["event"], "sans distance, l'affûtage n'a pas de TSS à viser"

    patch_preferences("training" => { "event" => { "distance_km" => 120 } })
    assert_nil training_of(user)["event"], "sans date, l'affûtage n'a pas de jours à compter"
  end

  test "une date qui n'existe pas ne fait pas une sortie objectif" do
    # « 2026-02-31 » a la bonne forme et n'est pas un jour : c'est ce qu'une expression
    # régulière laisserait passer.
    user = sign_in
    patch_preferences(
      "training" => { "event" => { "date" => "2026-02-31", "distance_km" => 120 } }
    )

    assert_nil training_of(user)["event"]
  end

  test "une intensité inconnue retombe sur tempo plutôt que d'annuler la sortie" do
    # La date et la distance suffisent à piloter l'affûtage : perdre l'objectif pour
    # une intensité mal orthographiée serait plus coûteux que de supposer l'allure.
    user = sign_in
    patch_preferences(
      "training" => { "event" => { "date" => "2026-09-12", "distance_km" => 120, "intensity" => "casual" } }
    )

    assert_equal "tempo", training_of(user).dig("event", "intensity")
  end

  test "retire la sortie objectif quand on l'annule" do
    user = sign_in
    patch_preferences(
      "training" => { "event" => { "date" => "2026-09-12", "distance_km" => 120, "intensity" => "race" } }
    )
    patch_preferences("training" => { "goal" => "improve_fast", "event" => nil })

    assert_nil training_of(user)["event"]
    assert_equal "improve_fast", training_of(user)["goal"]
  end

  test "borne une distance absurde plutôt que de la refuser" do
    user = sign_in
    patch_preferences(
      "training" => { "event" => { "date" => "2026-09-12", "distance_km" => 99_999 } }
    )

    assert_equal 1000, training_of(user).dig("event", "distance_km")
  end
end
