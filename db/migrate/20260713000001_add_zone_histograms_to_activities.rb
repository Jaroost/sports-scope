# Histogrammes FC / puissance pré-calculés par activité (secondes passées par palier
# de fréquence cardiaque / de watts). Comme `peak_powers` et `normalized_power`, ce
# sont des dérivés intrinsèques à la sortie (indépendants des seuils de l'athlète) :
# on les stocke une fois, puis on les regroupe en zones À LA LECTURE avec la LTHR /
# FTP courantes — ainsi modifier un seuil ne rend pas les données obsolètes.
# {} = streams sans le canal correspondant (pas de cardio / pas de capteur puissance).
class AddZoneHistogramsToActivities < ActiveRecord::Migration[8.1]
  def change
    add_column :strava_activities, :hr_histogram, :jsonb, default: {}, null: false
    add_column :strava_activities, :power_histogram, :jsonb, default: {}, null: false
    add_column :imported_activities, :hr_histogram, :jsonb, default: {}, null: false
    add_column :imported_activities, :power_histogram, :jsonb, default: {}, null: false
  end
end
