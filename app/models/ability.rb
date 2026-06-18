# Définit ce que chaque utilisateur a le droit de faire (CanCanCan).
# Utilisé via `can?`/`cannot?` dans les vues, `authorize!` dans les contrôleurs.
class Ability
  include CanCan::Ability

  def initialize(user)
    # Visiteur non connecté : aucune permission accordée ici. Les pages publiques
    # (itinéraires partagés par token) restent gérées par leurs contrôleurs.
    return unless user

    if user.admin?
      # Administrateur : accès total.
      can :manage, :all
    else
      # Utilisateur simple : gère uniquement ses propres ressources.
      can :manage, Route, user_id: user.id
      can :manage, ImportedActivity, user_id: user.id
      can :manage, ChartLayout, user_id: user.id
    end
  end
end
