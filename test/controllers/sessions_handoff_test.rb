require "test_helper"

# Le bout de chaîne visible : l'appli ouvre `/auth/handoff?token=…&next=…`, doit en
# ressortir connectée et posée sur la page demandée — sans que ce point d'entrée
# devienne une redirection ouverte.
class SessionsHandoffTest < ActionDispatch::IntegrationTest
  def user(suffix = "ctrl")
    User.create!(email: "handoff-#{suffix}@example.com", keycloak_uid: "kc-handoff-#{suffix}")
  end

  test "un jeton valide ouvre la session et mène à la destination" do
    owner = user
    token = SessionHandoff.issue!(owner)

    get "/auth/handoff", params: { token: token, next: "/routes/abc/navigate" }

    assert_redirected_to "/routes/abc/navigate"
    assert_equal owner.id, session[:user_id]
  end

  test "un jeton déjà utilisé mène quand même à la destination, en anonyme" do
    # La navigation partagée est publique : refuser la page ferait perdre la sortie
    # pour un confort qui n'a pas marché.
    token = SessionHandoff.issue!(user)
    get "/auth/handoff", params: { token: token, next: "/routes/abc/navigate" }
    reset!

    get "/auth/handoff", params: { token: token, next: "/routes/abc/navigate" }

    assert_redirected_to "/routes/abc/navigate"
    assert_nil session[:user_id]
  end

  test "un jeton absent n'ouvre pas de session" do
    get "/auth/handoff", params: { next: "/navigate" }

    assert_redirected_to "/navigate"
    assert_nil session[:user_id]
  end

  test "une destination externe est refusée" do
    # Sinon le point d'entrée deviendrait une redirection ouverte : ouvrir une
    # session ici puis expédier l'utilisateur ailleurs.
    token = SessionHandoff.issue!(user)

    get "/auth/handoff", params: { token: token, next: "https://evil.example.com/" }

    assert_redirected_to "/"
  end

  test "une destination protocol-relative est refusée" do
    # `//evil.example.com` est une URL absolue déguisée en chemin.
    token = SessionHandoff.issue!(user)

    get "/auth/handoff", params: { token: token, next: "//evil.example.com/" }

    assert_redirected_to "/"
  end

  test "sans destination, on atterrit à l'accueil" do
    token = SessionHandoff.issue!(user)

    get "/auth/handoff", params: { token: token }

    assert_redirected_to "/"
    assert_equal user_id_of(token), session[:user_id]
  end

  test "l'émission d'un jeton demande une session" do
    post "/api/session_handoff", headers: { "Accept" => "application/json" }

    assert_response :unauthorized
  end

  test "connecté, la page de partage marque le lien comme portant une session" do
    # Bout à bout : c'est cet attribut que companionBridge cherche au tap pour
    # décider d'aller demander un jeton. Sans lui, le lien s'ouvre tel quel.
    owner = user("share")
    route = Route.create!(user: owner, name: "Tour du lac", waypoints: [[6.6, 46.5], [6.7, 46.6]])
    get "/auth/handoff", params: { token: SessionHandoff.issue!(owner), next: "/" }

    get "/routes/#{route.share_token}"

    assert_response :success
    assert_match "data-companion-handoff", response.body
  end

  test "anonyme, le lien ne porte aucune session à passer" do
    route = Route.create!(user: user("anon"), name: "Tour du lac", waypoints: [[6.6, 46.5], [6.7, 46.6]])

    get "/routes/#{route.share_token}"

    assert_response :success
    assert_match "data-companion-link", response.body
    assert_no_match(/data-companion-handoff/, response.body)
  end

  private

  # Le jeton est consommé au moment du GET : on retrouve son propriétaire par la
  # ligne, seule trace qui subsiste.
  def user_id_of(token)
    SessionHandoff.find_by(token_digest: SessionHandoff.digest(token)).user_id
  end
end
