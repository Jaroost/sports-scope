# Le service worker ne doit jamais être servi avec une expiration lointaine.
#
# `config.public_file_server.headers` (cf. environments/production.rb) pose un an
# d'expiration sur tout `public/`, ce qui est juste pour des fichiers estampillés
# d'une empreinte — leur URL change à chaque build. `/service-worker.js`, lui, garde
# son nom : avec un an de cache, une correction pouvait mettre jusqu'à 24 h à
# atteindre les appareils (les navigateurs plafonnent d'eux-mêmes le `max-age` du
# script d'un service worker à 24 h, sans quoi ç'aurait été un an sec).
#
# Or ce script décide de tout le reste du cache : le laisser périmé, c'est laisser
# un bug de cache en place sur des appareils par ailleurs à jour — et faire chercher
# « quel cache vider » à celui qui teste.
#
# Le middleware est inséré AVANT ActionDispatch::Static : il l'enveloppe, et voit
# donc passer la réponse du serveur de fichiers pour en corriger l'en-tête.
class ServiceWorkerCacheControl
  PATH = "/service-worker.js".freeze

  def initialize(app)
    @app = app
  end

  def call(env)
    status, headers, body = @app.call(env)
    # `must-revalidate` plutôt que `no-store` : le fichier peut rester en cache, mais
    # sa fraîcheur est revérifiée à chaque fois — un 304 ne coûte presque rien.
    headers["cache-control"] = "public, max-age=0, must-revalidate" if env["PATH_INFO"] == PATH
    [status, headers, body]
  end
end

Rails.application.config.middleware.insert_before ActionDispatch::Static, ServiceWorkerCacheControl
