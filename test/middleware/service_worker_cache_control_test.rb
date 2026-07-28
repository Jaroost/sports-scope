require "test_helper"

# Le service worker doit rester revalidé à chaque fois, alors que tout le reste de
# `public/` porte un an d'expiration. C'est ce qui fait qu'une correction du cache
# atteint les appareils tout de suite au lieu d'attendre jusqu'à 24 h.
class ServiceWorkerCacheControlTest < ActiveSupport::TestCase
  def response_for(path, upstream_headers = { "cache-control" => "public, max-age=31556952" })
    app = ->(_env) { [200, upstream_headers.dup, ["ok"]] }
    ServiceWorkerCacheControl.new(app).call("PATH_INFO" => path)
  end

  test "le service worker est revalidé à chaque requête" do
    _status, headers, _body = response_for("/service-worker.js")

    assert_equal "public, max-age=0, must-revalidate", headers["cache-control"]
  end

  test "les autres fichiers gardent leur expiration lointaine" do
    # Ils sont estampillés d'une empreinte : leur URL change à chaque build, donc
    # les cacher un an est exactement ce qu'on veut.
    _status, headers, _body = response_for("/vite/assets/application-abc123.js")

    assert_equal "public, max-age=31556952", headers["cache-control"]
  end

  test "la réponse passe inchangée pour le reste" do
    status, _headers, body = response_for("/routes/abc/navigate")

    assert_equal 200, status
    assert_equal ["ok"], body
  end
end
