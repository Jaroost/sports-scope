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

    private

    def require_full_access!
      authorize! :manage, :all
    end
  end
end
