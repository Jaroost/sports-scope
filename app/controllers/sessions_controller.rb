class SessionsController < ApplicationController
  skip_before_action :verify_authenticity_token, only: [:create, :passthrough]

  # Fallback for OmniAuth request phase; normally OmniAuth's middleware
  # intercepts these requests before they reach this action.
  def passthrough
    raise ActionController::RoutingError.new("Not Found")
  end

  def create
    auth = request.env["omniauth.auth"]

    case auth.provider.to_s
    when "keycloak", "openid_connect"
      user = User.from_keycloak(auth)
      session[:user_id] = user.id
      redirect_to root_path, notice: t("auth.signed_in")
    when "strava"
      unless current_user
        redirect_to root_path, alert: t("auth.login_first") and return
      end
      authorize! :link, :strava
      current_user.attach_strava!(auth)
      redirect_to root_path, notice: t("auth.strava_linked")
    else
      redirect_to root_path, alert: "Unknown provider: #{auth.provider}"
    end
  end

  # Émet un jeton de passage pour l'utilisateur connecté.
  #
  # Appelé au moment du tap sur « ouvrir dans l'application », et pas au rendu de la
  # page : le jeton ne vit que quelques minutes, et une page de partage peut rester
  # ouverte bien plus longtemps que ça avant qu'on la touche.
  def create_handoff
    return render(json: { error: t("auth.login_required") }, status: :unauthorized) unless user_signed_in?

    render json: { token: SessionHandoff.issue!(current_user) }
  end

  # Échange le jeton d'un lien « ouvrir dans l'application » contre une session, puis
  # renvoie sur la page demandée. C'est ce qui évite de se connecter deux fois, une
  # fois dans le navigateur et une fois dans l'appli (cf. SessionHandoff).
  #
  # Un jeton refusé (périmé, déjà utilisé, forgé) n'est pas une erreur à afficher : on
  # poursuit vers la destination en anonyme. La navigation partagée est publique, elle
  # fonctionnera — en mode dégradé, ce que la page dit déjà elle-même.
  def handoff
    if (user = SessionHandoff.claim!(params[:token]))
      # Session neuve à l'ouverture de session, par principe : rien de ce qui
      # traînait dans celle du visiteur anonyme ne doit suivre. La langue, elle,
      # est un réglage de confort sans rapport avec l'identité — la reperdre ferait
      # basculer la navigation dans l'autre langue en pleine sortie.
      locale = session[:locale]
      reset_session
      session[:locale] = locale
      session[:user_id] = user.id
    end

    redirect_to safe_handoff_destination(params[:next]), allow_other_host: false
  end

  def failure
    redirect_to root_path, alert: "Auth failure: #{params[:message]}"
  end

  def destroy
    session.clear
    kc_logout_url = "#{ENV.fetch('KEYCLOAK_BASE_URL', 'http://localhost:8080')}/realms/#{ENV.fetch('KEYCLOAK_REALM', 'sports-scope')}/protocol/openid-connect/logout"
    redirect_to "#{kc_logout_url}?post_logout_redirect_uri=#{CGI.escape(root_url)}&client_id=#{ENV.fetch('KEYCLOAK_CLIENT_ID', 'rails-app')}", allow_other_host: true
  end

  private

  # Le paramètre `next` vient du lien, donc de l'extérieur : il ne peut désigner
  # qu'un chemin de ce site. Un chemin absolu (`https://…`) ou protocol-relative
  # (`//ailleurs`) ferait de cette action une redirection ouverte — le jeton
  # servirait alors à ouvrir une session ici puis à envoyer l'utilisateur ailleurs.
  def safe_handoff_destination(path)
    return root_path if path.blank?
    return root_path unless path.start_with?("/")
    return root_path if path.start_with?("//", "/\\")

    path
  end
end
