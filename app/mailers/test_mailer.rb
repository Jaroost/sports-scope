# Mail de contrôle de la configuration SMTP, envoyé depuis la page admin
# (Admin::TestMailsController). Il ne sert qu'à vérifier que le serveur accepte
# l'envoi et que l'expéditeur est bien celui attendu.
class TestMailer < ApplicationMailer
  def ping(to)
    @sent_at = Time.current
    @from = ApplicationMailer.default_params[:from]
    @smtp_host = ActionMailer::Base.smtp_settings[:address]

    mail(to: to, subject: t("test_mailer.subject"))
  end
end
