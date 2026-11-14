class RouteShare < ApplicationRecord
  # Un itinéraire partagé explicitement avec un ami (le destinataire est `user`).
  belongs_to :route
  belongs_to :user

  validates :user_id, uniqueness: { scope: :route_id }
  validate :recipient_is_friend

  private

  def recipient_is_friend
    errors.add(:user, :invalid) unless route && user && route.user.friends_with?(user)
  end
end
