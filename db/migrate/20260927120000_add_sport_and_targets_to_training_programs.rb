class AddSportAndTargetsToTrainingPrograms < ActiveRecord::Migration[8.1]
  def change
    # Pilote uniquement l'unité d'affichage/saisie de la vitesse cible dans l'éditeur
    # (km/h vs allure min/km) — les jalons eux-mêmes n'ont pas besoin d'un sport
    # par step, un programme reste homogène. Cf. TrainingProgram::SPORTS.
    add_column :training_programs, :sport, :string, null: false, default: "cycling"

    # Cibles/bornes physiologiques ajoutées aux jalons existants
    # (target_power/min_power/max_power, etc.) — cf. TrainingProgram#validate_milestones.
    # Pas de colonne dédiée : ce sont des clés supplémentaires du jsonb `milestones`
    # déjà en place, donc rien à migrer ici pour la structure elle-même.
  end
end
