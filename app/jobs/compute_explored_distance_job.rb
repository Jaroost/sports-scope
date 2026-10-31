# Recalcule la distance « nouvelle » (`ExploredDistance`) de tout l'historique d'un
# utilisateur. Enfilé, regroupé, quand le tracé d'une activité change.
class ComputeExploredDistanceJob < ApplicationJob
  queue_as :default

  def perform(user_id)
    user = User.find_by(id: user_id)
    return if user.nil?

    ExploredDistance.call(user)
  end
end
