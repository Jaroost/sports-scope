# Invitation envoyée par mail à une adresse qui n'a pas (encore) de compte.
# Quand un compte se crée avec cette adresse, `User#claim_friend_invitations` la
# transforme en demande d'ami (en attente : l'invité accepte, rien n'est partagé d'avance).
class FriendInvitation < ApplicationRecord
  # Plafonds anti-abus : un même destinataire ne reçoit pas le mail plus d'une fois par
  # jour de la part d'un même invitant, et un invitant n'envoie pas en rafale.
  RESEND_AFTER = 1.day
  DAILY_LIMIT = 20

  belongs_to :inviter, class_name: "User"

  before_validation { self.email = email.to_s.strip.downcase }
  validates :email, presence: true, format: { with: URI::MailTo::EMAIL_REGEXP }

  def self.quota_left?(user)
    where(inviter_id: user.id).where(last_sent_at: 1.day.ago..).count < DAILY_LIMIT
  end
end
