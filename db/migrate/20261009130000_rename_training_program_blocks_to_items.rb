# La colonne ne contient plus seulement des blocs : un élément peut aussi être un
# groupe de répétition (`{ "repeat": n, "blocks": [...] }`). Les blocs déjà enregistrés
# sont des éléments valides tels quels. Les blocs dépliés que lit l'appli sont
# calculés (`TrainingProgram#flat_blocks`), pas stockés.
class RenameTrainingProgramBlocksToItems < ActiveRecord::Migration[8.1]
  def change
    rename_column :training_programs, :blocks, :items
  end
end
