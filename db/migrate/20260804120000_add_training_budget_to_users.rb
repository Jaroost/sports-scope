# Le budget de charge (cible du jour, plancher de fatigue, cible de semaine, plan
# jour par jour) tel que `useTrainingPlan.ts` l'a calculé — voir CompanionViewport
# pour le même raisonnement : `nil` tant que le navigateur n'a rien envoyé est un
# état distinct de « budget vide », pas une valeur par défaut à deviner ici.
class AddTrainingBudgetToUsers < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :training_budget, :jsonb
  end
end
