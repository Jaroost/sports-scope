# Les profils de sortie de l'application compagnon : ce que l'appli lit, et ce que
# l'éditeur écrit.
#
# `show` est **authentifié**, contrairement à `/api/companion_version` : ce sont des
# données de compte. L'appli n'a aucun cookie côté Dart — la session vit dans le pot
# partagé de ses WebViews — donc elle appelle cette route depuis un WebView hors
# écran, comme elle le fait déjà pour le catalogue d'itinéraires (`RouteCatalogFetch`).
#
# Le `Accept: application/json` qu'elle envoie est ce qui fait répondre ici un 401
# propre plutôt qu'une redirection HTML vers Keycloak : c'est ce qui lui permet de
# distinguer « pas connecté » — la seule chose que le cycliste puisse corriger — de
# « pas de réseau ».
class CompanionSettingsController < ApplicationController
  before_action :require_login!

  # GET /api/companion_settings
  #
  # Sans cache HTTP : l'appli n'interroge qu'**une fois par lancement** et garde le
  # document sur disque, donc il n'y a aucune rafale à absorber. Un cache poserait en
  # revanche la question du profil qu'on vient de modifier et qui ne redescend pas.
  def show
    record_viewport
    render json: CompanionSettings.for(current_user)
  end

  # PATCH /api/companion_settings
  #
  # **Rend le document assaini**, et l'éditeur se réaligne dessus. Ce n'est pas une
  # politesse : c'est ce qui rend l'éditeur honnête. L'application applique déjà ces
  # règles de son côté (au plus une carte, quatre cases de bandeau, pas de cellules
  # qui se recouvrent), mais en silence et sur la route. Renvoyer ce qu'on a
  # réellement gardé fait voir la correction là où elle peut encore se discuter,
  # plutôt que de la découvrir au départ d'un col.
  def update
    raw = payload
    # Un corps illisible **ne touche à rien**. C'est le piège de cet endpoint :
    # `sanitize` rend les profils par défaut quand il ne trouve rien
    # d'exploitable — ce qui est juste pour *afficher*, et catastrophique pour
    # *écrire*. Une requête tronquée effacerait alors des profils composés à la
    # main pour les remplacer par ceux d'usine, sans que personne l'ait demandé.
    return render json: { error: "malformed" }, status: :bad_request unless raw.is_a?(Hash)

    document = CompanionSettings.sanitize(raw)
    current_user.update!(companion_settings: document)
    render json: document
  end

  # L'écran d'édition. Un îlot Vue : composer une grille demande un état riche
  # (page en cours, cellule sélectionnée) qu'un formulaire rechargé à chaque clic
  # rendrait insupportable.
  def edit
    @document = CompanionSettings.for(current_user)
    @catalog = CompanionSettings.catalog
    @viewport = current_user.companion_viewport
  end

  private

  # La taille de grille que l'appli vient d'annoncer, s'il y en a une.
  #
  # Sur un GET, oui : c'est la requête que l'appli fait de toute façon une fois
  # par lancement, et lui en imposer une seconde pour dire sa taille coûterait un
  # WebView hors écran de plus — une seconde d'attente à l'accueil, pour une
  # information que le site ne lit qu'en ouvrant l'éditeur. L'effet de bord se
  # limite à retenir la géométrie de l'appelant, comme un « vu pour la dernière
  # fois le ».
  #
  # On n'écrit que si ça change : la valeur ne bouge qu'au changement de
  # téléphone, et un `UPDATE` par lancement pour réécrire les mêmes deux nombres
  # ne sert personne.
  def record_viewport
    viewport = CompanionViewport.parse(params[:grid])
    return if viewport.nil? || viewport == current_user.companion_viewport

    current_user.update_column(:companion_viewport, viewport)
  end

  # Le corps brut plutôt que `params` : le document est profondément imbriqué et
  # de forme libre (des grilles dans des pages dans des profils), et le faire
  # traverser `ActionController::Parameters` obligerait à un `to_unsafe_h` à
  # chaque étage de l'assainisseur.
  #
  # C'est sans risque **parce que l'assainisseur est la liste blanche** : il ne
  # recopie rien, il reconstruit un document à partir des seules clés qu'il
  # connaît (`CompanionSettings::BLOCKS`, `METRICS`, `SENSORS`). Ce qui n'y figure
  # pas ne peut pas ressortir.
  # `nil` quand le corps n'est pas un objet JSON — voir `update`, qui refuse
  # alors la requête plutôt que d'écrire quoi que ce soit.
  def payload
    JSON.parse(request.raw_post)
  rescue JSON::ParserError
    nil
  end
end
