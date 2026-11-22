# Mail envoyé à une personne qu'un utilisateur invite à devenir son ami.
# Envoyé par FriendsController#create pour une adresse sans compte ; aperçu dans la page
# admin de test de mail (Admin::TestMailsController#friend_invitation).
class FriendMailer < ApplicationMailer
  def invitation(inviter, to, locale: I18n.locale)
    I18n.with_locale(locale) do
      @inviter_name = inviter.display_name.presence || inviter.email
      @invite_url = friend_invite_url(token: inviter.friend_invite_token.presence || "TOKEN")

      mail(to: to, subject: t("friend_mailer.invitation.subject", name: @inviter_name))
    end
  end
end
