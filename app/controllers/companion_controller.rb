# Diffusion de l'application compagnon Android (dépôt voisin `sports-scope-companion`).
#
# Le partage des rôles est délibéré :
#
# - `show` et `download` sont **réservés aux connectés** : l'app ne sert à rien sans
#   compte sports-scope (itinéraires, seuils, POI passent tous par la session), et un
#   APK en accès libre finit indexé.
# - `version` est **public**. L'app n'a aucun cookie côté Dart — la session vit dans
#   le pot partagé des WebViews — et un endpoint authentifié l'obligerait à passer par
#   le WebView hors écran de `RouteCatalogFetch` pour lire un numéro de version. Il ne
#   contient d'ailleurs aucune donnée d'utilisateur. Bénéfice de bord : la
#   vérification marche encore quand la session a expiré, c'est-à-dire précisément
#   quand on veut qu'elle marche.
class CompanionController < ApplicationController
  before_action :require_login!, only: [ :show, :download ]
  before_action :skip_session, only: :version

  def show
    @release = CompanionRelease.current
  end

  def download
    release = CompanionRelease.current
    if release.nil?
      redirect_to companion_path, alert: t("companion.unavailable") and return
    end

    # `disposition: attachment` plutôt qu'inline : Chrome Android n'a rien à afficher
    # d'un APK, et un inline le ferait tomber dans un visualiseur au lieu du
    # gestionnaire de téléchargement qui enchaîne sur l'installation.
    send_file release.path,
      filename: release.filename,
      type: "application/vnd.android.package-archive",
      disposition: "attachment"
  end

  def version
    release = CompanionRelease.current
    if release.nil?
      render json: { error: "no_release" }, status: :not_found and return
    end

    # Courte fraîcheur publique : le fichier ne change que quand on en pousse un, et
    # l'app n'interroge qu'au lancement. `public` autorise Cloudflare à absorber les
    # rafales sans que la publication d'une version mette des heures à se voir.
    expires_in 5.minutes, public: true
    render json: release.as_json.merge(download_url: companion_url)
  end

  private

  # `set_locale` (ApplicationController) écrit dans la session à chaque requête, ce
  # qui pose un `Set-Cookie` — y compris ici. Or cette réponse est marquée
  # `cache-control: public` pour que Cloudflare absorbe les rafales : un cache
  # partagé qui garderait la réponse garderait le cookie avec, et le resservirait au
  # visiteur suivant. Aucune session n'a de sens sur un endpoint public qui ne rend
  # qu'un numéro de version — on n'en ouvre donc pas.
  def skip_session
    request.session_options[:skip] = true
  end
end
