class Friendship < ApplicationRecord
  STATUSES = %w[pending accepted].freeze

  belongs_to :requester, class_name: "User"
  belongs_to :addressee, class_name: "User"

  validates :status, inclusion: { in: STATUSES }
  validate :not_self
  validate :pair_not_taken, on: :create

  scope :accepted, -> { where(status: "accepted") }
  scope :pending, -> { where(status: "pending") }
  scope :involving, ->(user) { where(requester_id: user.id).or(where(addressee_id: user.id)) }

  # La paire (dans un sens ou dans l'autre), quel que soit son statut.
  def self.between(a, b)
    where(requester_id: a.id, addressee_id: b.id).or(where(requester_id: b.id, addressee_id: a.id)).first
  end

  def accepted? = status == "accepted"

  def pending? = status == "pending"

  def other_user(user) = user.id == requester_id ? addressee : requester

  def accept!
    update!(status: "accepted", accepted_at: Time.current)
  end

  # Rompre l'amitié retire aussi les partages d'itinéraires dans les deux sens.
  after_destroy :drop_route_shares

  private

  def not_self
    errors.add(:addressee_id, :invalid) if requester_id == addressee_id
  end

  def pair_not_taken
    errors.add(:base, :taken) if requester && addressee && Friendship.between(requester, addressee)
  end

  def drop_route_shares
    RouteShare.joins(:route).where(user_id: addressee_id, routes: { user_id: requester_id })
              .or(RouteShare.joins(:route).where(user_id: requester_id, routes: { user_id: addressee_id }))
              .destroy_all
  end
end
