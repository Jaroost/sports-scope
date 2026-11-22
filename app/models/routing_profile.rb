# Profil de routage nommé par l'utilisateur : un profil BRouter de base + ses réglages,
# stockés sous la forme canonique d'un spec (cf. RoutingProfileSpec). Les itinéraires
# gardent une COPIE du spec (`routes.profile`), pas une référence : modifier ou supprimer
# un profil ne change pas le tracé d'un itinéraire enregistré.
class RoutingProfile < ApplicationRecord
  MAX_PER_USER = 30

  belongs_to :user
  validates :name, presence: true, length: { maximum: 60 }, uniqueness: { scope: :user_id }
  validates :sport, inclusion: { in: Route::ACTIVITIES }
  validate :spec_is_customized_and_allowed
  validate :under_per_user_limit, on: :create

  # Profils de base proposés par sport (miroir de PROFILES_BY_SPORT, brouter.ts).
  def self.bases_for(sport)
    ProfilesController::ALLOWED_ROUTE_PROFILES.fetch(sport, [])
  end

  private

  def spec_is_customized_and_allowed
    canonical = RoutingProfileSpec.normalize(spec, self.class.bases_for(sport))
    if canonical.nil? || !RoutingProfileSpec::PROFILES.key?(RoutingProfileSpec.base(canonical))
      errors.add(:spec, :invalid)
    else
      self.spec = canonical
    end
  end

  def under_per_user_limit
    errors.add(:base, "too many routing profiles") if user && user.routing_profiles.count >= MAX_PER_USER
  end
end
