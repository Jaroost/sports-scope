require "test_helper"

# Diffusion de l'app compagnon Android. Ce qui est testé ici, c'est le partage des
# rôles entre les trois actions : la page et le fichier demandent une session, le
# contrôle de version n'en demande pas (l'app n'a aucun cookie côté Dart).
class CompanionTest < ActionDispatch::IntegrationTest
  APK_BODY = "PK\x03\x04 pas un vrai APK, seul le contenu servi est vérifié".b.freeze

  def sign_in
    user = User.create!(email: "companion-#{SecureRandom.hex(4)}@example.com",
                        keycloak_uid: "kc-companion-#{SecureRandom.hex(4)}")
    get "/auth/handoff", params: { token: SessionHandoff.issue!(user), next: "/dashboard" }
    user
  end

  # Chaque test travaille dans son propre dossier : la suite tourne en parallèle
  # (un worker par cœur, cf. test_helper) et un dossier partagé les ferait se marcher
  # dessus.
  def with_release(version_name: "0.2.0", version_code: 2, file: "companion.apk", write_apk: true, manifest: nil)
    dir = Dir.mktmpdir("companion-test")
    File.binwrite(File.join(dir, file), APK_BODY) if write_apk
    payload = manifest || {
      version_name: version_name,
      version_code: version_code,
      file: file,
      size: APK_BODY.bytesize,
      sha256: Digest::SHA256.hexdigest(APK_BODY),
      released_at: "2026-08-02T10:00:00Z",
    }.to_json
    File.write(File.join(dir, "manifest.json"), payload)

    ENV["COMPANION_APK_DIR"] = dir
    yield dir
  ensure
    ENV.delete("COMPANION_APK_DIR")
    FileUtils.remove_entry(dir) if dir && Dir.exist?(dir)
  end

  def with_empty_dir
    dir = Dir.mktmpdir("companion-test-empty")
    ENV["COMPANION_APK_DIR"] = dir
    yield
  ensure
    ENV.delete("COMPANION_APK_DIR")
    FileUtils.remove_entry(dir) if dir && Dir.exist?(dir)
  end

  # ------------------------------------------------------------------ la page

  test "la page annonce la version publiée" do
    with_release do
      sign_in
      get "/companion"

      assert_response :success
      assert_includes response.body, "0.2.0"
      assert_includes response.body, "/companion/download"
    end
  end

  # Le dépôt n'embarque pas rails-i18n et le français n'a pas de section `date:` :
  # une date rendue par `l(..., format: :long)` faisait planter la page, et
  # seulement en français — le défaut de la suite étant `:en`, rien ne le voyait.
  test "la page se rend aussi en français" do
    with_release do
      sign_in
      get "/fr/companion"

      assert_response :success
      assert_includes response.body, "02.08.2026"
    end
  end

  test "la page reste réservée aux comptes connectés" do
    with_release do
      get "/companion"
      assert_response :redirect
    end
  end

  # Tant que rien n'a été poussé dans le volume, la page doit le dire — pas offrir un
  # bouton qui mènerait à une erreur.
  test "sans version publiée, la page le dit sans proposer de téléchargement" do
    with_empty_dir do
      sign_in
      get "/companion"

      assert_response :success
      assert_includes response.body, I18n.t("companion.unavailable")
      assert_not_includes response.body, "/companion/download"
    end
  end

  # ------------------------------------------------------------- le fichier

  test "le fichier est servi en paquet Android" do
    with_release do
      sign_in
      get "/companion/download"

      assert_response :success
      assert_equal "application/vnd.android.package-archive", response.media_type
      assert_match(/attachment/, response.headers["Content-Disposition"])
      assert_equal APK_BODY, response.body.b
    end
  end

  test "le fichier reste réservé aux comptes connectés" do
    with_release do
      get "/companion/download"

      assert_response :redirect
      assert_nil response.headers["Content-Disposition"]
    end
  end

  test "sans version publiée, le téléchargement renvoie sur la page" do
    with_empty_dir do
      sign_in
      get "/companion/download"

      assert_redirected_to companion_path
    end
  end

  # Le manifeste est un fichier du serveur, mais il désigne le chemin servi : un `../`
  # qui s'y glisserait ferait sortir `send_file` du volume.
  test "un chemin échappé dans le manifeste ne sort pas du dossier" do
    escaped = { version_name: "9.9.9", version_code: 99, file: "../../../etc/passwd",
                size: 1, sha256: "x", released_at: "2026-08-02T10:00:00Z" }.to_json
    with_release(manifest: escaped) do
      sign_in
      get "/companion/download"

      assert_redirected_to companion_path
    end
  end

  # ------------------------------------------------------- le contrôle de version

  test "le contrôle de version répond sans session" do
    with_release do
      get "/api/companion_version"

      assert_response :success
      body = JSON.parse(response.body)
      assert_equal 2, body["version_code"]
      assert_equal "0.2.0", body["version_name"]
      assert_equal APK_BODY.bytesize, body["size"]
      assert_includes body["download_url"], "/companion"
    end
  end

  # La réponse est marquée `public` pour que Cloudflare absorbe les rafales. Un
  # `Set-Cookie` sur une réponse partageable, c'est un cache qui garde la session
  # d'un visiteur et la resert au suivant — d'où la session explicitement coupée.
  test "le contrôle de version n'ouvre aucune session" do
    with_release do
      get "/api/companion_version"

      assert_response :success
      assert_match(/public/, response.headers["Cache-Control"].to_s)
      assert_nil response.headers["Set-Cookie"]
    end
  end

  test "sans version publiée, le contrôle de version répond 404" do
    with_empty_dir do
      get "/api/companion_version"
      assert_response :not_found
    end
  end

  # Un manifeste corrompu ne doit pas faire tomber l'endpoint : l'app le consulte au
  # lancement, et une exception ici se lirait comme « pas de réseau ».
  test "un manifeste illisible se comporte comme une absence de version" do
    with_release(manifest: "{ ceci n'est pas du JSON") do
      get "/api/companion_version"
      assert_response :not_found
    end
  end

  # Le binaire annoncé mais absent (envoi interrompu) ne doit pas être proposé.
  test "un manifeste sans binaire ne publie rien" do
    with_release(write_apk: false) do
      get "/api/companion_version"
      assert_response :not_found
    end
  end
end
