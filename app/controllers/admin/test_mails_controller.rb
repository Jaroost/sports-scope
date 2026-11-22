# Page admin pour vérifier l'envoi de mails (SMTP Google en production).
module Admin
  class TestMailsController < ApplicationController
    before_action :require_login!
    before_action :require_full_access!

    # GET /admin/test_mail
    def new
      @to = current_user.email
    end

    # POST /admin/test_mail — envoi synchrone : on veut l'erreur SMTP à l'écran
    # (authentification refusée, expéditeur rejeté…), pas dans un job qui réessaie.
    def create
      @to = params[:to].to_s.strip

      unless @to.match?(URI::MailTo::EMAIL_REGEXP)
        @error = t("test_mailer.invalid_address")
        return render :new, status: :unprocessable_entity
      end

      TestMailer.ping(@to).deliver_now
      redirect_to admin_test_mail_path, notice: t("test_mailer.sent", to: @to)
    rescue StandardError => e
      @error = "#{e.class} : #{e.message}"
      render :new, status: :unprocessable_entity
    end

    # GET /admin/mail_previews/friend_invitation — rendu du mail d'invitation d'ami,
    # sans l'envoyer : l'invitant est l'admin connecté. `?format=text` pour la version texte.
    def friend_invitation
      mail = FriendMailer.invitation(current_user, current_user.email)
      if params[:format_part] == "text"
        render plain: mail.text_part.body.decoded
      else
        render html: mail.html_part.body.decoded.html_safe, layout: false
      end
    end

    private

    def require_full_access!
      authorize! :manage, :all
    end
  end
end
