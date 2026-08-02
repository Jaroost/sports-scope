require "test_helper"

# Filet de sécurité du Web Share Target : ce que le SERVEUR fait d'un fichier partagé
# quand le service worker n'a pas intercepté le POST (SW obsolète, lancement à froid,
# navigateur non compatible). Le jumeau côté client est testé dans
# `app/javascript/serviceWorker.test.ts` — les deux doivent aiguiller pareil, sans quoi
# le même partage ouvrirait deux pages différentes selon qui a répondu.
class ShareTargetTest < ActionDispatch::IntegrationTest
  # En-tête `.fit` minimal : 12 octets dont « .FIT » en 8..11.
  FIT_HEADER = ([ 12, 0, 0, 0, 0, 0, 0, 0 ].pack("C8") + ".FIT").freeze
  GPX_BODY = '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' \
             '<trkpt lat="46.2" lon="6.14"/><trkpt lat="46.3" lon="6.15"/>' \
             "</trkseg></trk></gpx>".freeze

  def sign_in
    owner = User.create!(email: "share-target@example.com", keycloak_uid: "kc-share-target")
    get "/auth/handoff", params: { token: SessionHandoff.issue!(owner), next: "/dashboard" }
    owner
  end

  def upload(content, filename, type)
    file = Tempfile.new([ "share", File.extname(filename) ], binmode: true)
    file.write(content)
    file.rewind
    Rack::Test::UploadedFile.new(file.path, type, true, original_filename: filename)
  end

  test "un .fit partagé mène à la page d'atterrissage" do
    sign_in
    post "/routes/share-target", params: { fit: upload(FIT_HEADER, "sortie.fit", "application/vnd.ant.fit") }

    assert_response :success
    assert_includes response.body, 'data-vue-component="ImportFitLanding"'
  end

  # Le cas qui motive le reniflage : le paramètre `gpx` du manifest accepte
  # `application/octet-stream`, sous lequel Android partage très souvent un `.fit`.
  # Se fier au nom du champ enverrait la sortie dans le créateur d'itinéraire, qui n'y
  # verrait qu'un XML illisible et ouvrirait une carte vide sans un mot.
  test "un .fit arrivé par le champ gpx en octet-stream est reconnu" do
    sign_in
    post "/routes/share-target", params: { gpx: upload(FIT_HEADER, "sortie.fit", "application/octet-stream") }

    assert_response :success
    assert_includes response.body, 'data-vue-component="ImportFitLanding"'
  end

  test "un .gpx partagé mène au créateur d'itinéraire" do
    sign_in
    post "/routes/share-target", params: { gpx: upload(GPX_BODY, "trace.gpx", "application/gpx+xml") }

    assert_response :success
    assert_includes response.body, 'data-vue-component="RouteBuilder"'
  end

  # Un fichier trop court pour porter un en-tête ne doit pas faire échouer le partage :
  # on retombe sur le créateur, qui sait déjà s'ouvrir vierge.
  test "un fichier inexploitable retombe sur le créateur" do
    sign_in
    post "/routes/share-target", params: { gpx: upload("abc", "vide.bin", "application/octet-stream") }

    assert_response :success
    assert_includes response.body, 'data-vue-component="RouteBuilder"'
  end

  # Voie du gestionnaire de fichiers (File Handling API) : l'OS ouvre l'URL nue et
  # livre le fichier par `launchQueue`, sans rien poster. La page doit donc se rendre
  # seule, prête à recevoir.
  test "la page d'atterrissage se rend sans fichier" do
    sign_in
    get "/import/fit"

    assert_response :success
    assert_includes response.body, 'data-vue-component="ImportFitLanding"'
  end

  test "le partage reste réservé aux comptes connectés" do
    post "/routes/share-target", params: { fit: upload(FIT_HEADER, "sortie.fit", "application/vnd.ant.fit") }

    assert_response :redirect
  end
end
