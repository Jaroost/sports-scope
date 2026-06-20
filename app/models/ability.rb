# Définit ce que chaque utilisateur a le droit de faire (CanCanCan).
# Utilisé via `can?`/`cannot?` dans les vues, `authorize!` dans les contrôleurs.
#
# Les droits sont pilotés par les rôles attribués dans Keycloak (User#roles).
# Le mapping rôle → permissions vit dans `config/roles.json`. Les rôles sont
# atomiques et cumulables : un compte qui porte plusieurs rôles additionne leurs
# permissions.
class Ability
  include CanCan::Ability

  ROLE_PERMISSIONS = JSON.parse(
    File.read(Rails.root.join("config/roles.json"))
  ).freeze

  # Sujets dont les droits sont restreints aux enregistrements de l'utilisateur.
  OWNED_SUBJECTS = {
    "route"             => Route,
    "imported_activity" => ImportedActivity,
    "chart_layout"      => ChartLayout,
  }.freeze

  def initialize(user)
    # Visiteur non connecté : aucune permission accordée ici. Les pages publiques
    # (itinéraires partagés par token) restent gérées par leurs contrôleurs.
    return unless user

    # Compat : le booléen admin reste un accès total.
    can :manage, :all if user.admin?

    Array(user.roles).each do |role|
      Array(ROLE_PERMISSIONS[role]).each { |perm| grant(perm, user) }
    end
  end

  private

  # Traduit une permission "sujet:action" du JSON en règle CanCanCan.
  def grant(perm, user)
    return can(:manage, :all) if perm == "all"

    subject, action = perm.split(":")
    if (klass = OWNED_SUBJECTS[subject])
      can action.to_sym, klass, user_id: user.id   # ex. "route:manage" -> :manage, Route (les siens)
    else
      can action.to_sym, subject.to_sym            # ex. "strava:link" -> :link, :strava
    end
  end
end
